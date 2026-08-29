import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { NextRequest } from "next/server";
import { GET as bookingsGet, PATCH as bookingsPatch } from "../app/api/bookings/route";
import { createBillingCheckoutHandler, createStripeWebhookHandler } from "../lib/billing-handlers";
import { db, ensureBookingTables, getEntitlements } from "../lib/db";
import type { StripeClient } from "../lib/billing";
import { AI_ADDON_LOOKUP_KEY, BASE_LOOKUP_KEY, ensureBillingPrices, resetBillingPriceCacheForTests } from "../lib/billing-setup";

const hasDatabase = Boolean(process.env.DATABASE_URL);
const dbTest = hasDatabase ? test : test.skip;
const priceIds = { basePriceId: "price_base_119", aiAddonPriceId: "price_ai_39" };

function event(type: string, object: Record<string, unknown>) {
  return { id: `evt_${randomUUID()}`, type, data: { object } } as unknown as import("stripe").default.Event;
}

function mockStripe(input: { subscription?: Record<string, unknown>; event?: import("stripe").default.Event; capture?: Array<Record<string, unknown>>; existingPrices?: Array<{id:string;lookup_key?:string|null}>; priceListCaptures?: Array<Record<string, unknown>>; productCaptures?: Array<Record<string, unknown>>; priceCaptures?: Array<Record<string, unknown>> } = {}): StripeClient {
  return {
    products: { create: async (params) => { input.productCaptures?.push(params); return { id: `prod_${input.productCaptures?.length ?? 1}` }; } },
    prices: {
      list: async (params) => { input.priceListCaptures?.push(params); return { data: input.existingPrices ?? [] }; },
      create: async (params) => { input.priceCaptures?.push(params); return { id: `price_created_${input.priceCaptures?.length ?? 1}`, lookup_key: typeof params.lookup_key === "string" ? params.lookup_key : null }; },
    },
    customers: { create: async () => ({ id: "cus_checkout" }) },
    checkout: { sessions: { create: async (params) => { input.capture?.push(params); return { id: `cs_${input.capture?.length ?? 1}`, url: "https://checkout.stripe.test/session" }; } } },
    subscriptions: { retrieve: async () => input.subscription as never },
    subscriptionItems: { create: async () => ({ id: "si_addon" }) },
    billingPortal: { sessions: { create: async () => ({ url: "https://billing.stripe.test/portal" }) } },
    webhooks: { constructEvent: (payload, signature) => {
      if (signature !== "valid_signature") throw new Error("Invalid signature");
      return input.event ?? JSON.parse(String(payload)) as import("stripe").default.Event;
    } },
  };
}

async function cleanAccount(accountId: string) {
  await db().query(`DELETE FROM account_entitlements WHERE account_id=$1`, [accountId]);
  await db().query(`DELETE FROM account_billing WHERE account_id=$1`, [accountId]);
}

dbTest("signed checkout completion synchronizes billing and the Operations Agent entitlement with and without AI add-on", async () => {
  await ensureBookingTables();
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const withAddon = `billing_addon_${suffix}`;
  const withoutAddon = `billing_base_${suffix}`;
  try {
    const scenarios = [
      { accountId: withAddon, hasAddon: true, status: "trialing", prices: [priceIds.basePriceId, priceIds.aiAddonPriceId] },
      { accountId: withoutAddon, hasAddon: false, status: "active", prices: [priceIds.basePriceId] },
    ] as const;
    for (const scenario of scenarios) {
      const checkout = event("checkout.session.completed", {
        id: `cs_${scenario.accountId}`,
        customer: `cus_${scenario.accountId}`,
        subscription: `sub_${scenario.accountId}`,
        client_reference_id: scenario.accountId,
        metadata: { accountId: scenario.accountId },
      });
      const stripe = mockStripe({
        event: checkout,
        subscription: {
          id: `sub_${scenario.accountId}`,
          customer: `cus_${scenario.accountId}`,
          status: scenario.status,
          current_period_end: 1_800_000_000,
          items: { data: scenario.prices.map((id) => ({ price: { id } })) },
        },
      });
      const handler = createStripeWebhookHandler({ stripeFactory: () => stripe, webhookSecret: "whsec_test", priceResolver: async () => priceIds });
      const response = await handler(new Request("http://localhost/api/billing/webhook", {
        method: "POST",
        headers: { "stripe-signature": "valid_signature" },
        body: JSON.stringify(checkout),
      }));
      assert.equal(response.status, 200);
      const billing = await db().query(`SELECT * FROM account_billing WHERE account_id=$1`, [scenario.accountId]);
      assert.equal(billing.rows[0].status, scenario.status);
      assert.equal(billing.rows[0].ai_addon_active, scenario.hasAddon);
      assert.equal(billing.rows[0].stripe_customer_id, `cus_${scenario.accountId}`);
      const entitlements = await getEntitlements(scenario.accountId);
      assert.equal(entitlements.operationsAgent, scenario.hasAddon);
    }
  } finally {
    await cleanAccount(withAddon);
    await cleanAccount(withoutAddon);
  }
});

dbTest("an unsigned or invalid webhook is rejected without creating billing state", async () => {
  await ensureBookingTables();
  const accountId = `billing_invalid_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const checkout = event("checkout.session.completed", { id: "cs_invalid", client_reference_id: accountId, subscription: "sub_invalid" });
  const stripe = mockStripe({ event: checkout });
  const handler = createStripeWebhookHandler({ stripeFactory: () => stripe, webhookSecret: "whsec_test", priceResolver: async () => priceIds });
  const unsigned = await handler(new Request("http://localhost/api/billing/webhook", {
    method: "POST",
    body: JSON.stringify(checkout),
  }));
  assert.equal(unsigned.status, 400);
  const response = await handler(new Request("http://localhost/api/billing/webhook", {
    method: "POST",
    headers: { "stripe-signature": "invalid_signature" },
    body: JSON.stringify(checkout),
  }));
  assert.equal(response.status, 400);
  const billing = await db().query(`SELECT * FROM account_billing WHERE account_id=$1`, [accountId]);
  assert.equal(billing.rows.length, 0);
});

dbTest("a verified Stripe webhook never overrides an internal comped billing status", async () => {
  await ensureBookingTables();
  const accountId = `billing_comped_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  try {
    await db().query(`INSERT INTO account_billing (account_id, status, ai_addon_active) VALUES ($1,'comped',TRUE)`, [accountId]);
    await db().query(`INSERT INTO account_entitlements (account_id, features) VALUES ($1,'{"operationsAgent":true}'::jsonb)`, [accountId]);
    const checkout = event("checkout.session.completed", { id: "cs_comped", customer: "cus_comped", subscription: "sub_comped", client_reference_id: accountId, metadata: { accountId } });
    const stripe = mockStripe({ event: checkout, subscription: { id: "sub_comped", customer: "cus_comped", status: "canceled", items: { data: [{ price: { id: priceIds.basePriceId } }] } } });
    const handler = createStripeWebhookHandler({ stripeFactory: () => stripe, webhookSecret: "whsec_test", priceResolver: async () => priceIds });
    const response = await handler(new Request("http://localhost/api/billing/webhook", { method: "POST", headers: { "stripe-signature": "valid_signature" }, body: JSON.stringify(checkout) }));
    assert.equal(response.status, 200);
    const billing = await db().query(`SELECT status, ai_addon_active FROM account_billing WHERE account_id=$1`, [accountId]);
    assert.equal(billing.rows[0].status, "comped");
    assert.equal(billing.rows[0].ai_addon_active, true);
  } finally {
    await cleanAccount(accountId);
  }
});

dbTest("booking mutations are paused for past_due billing, but reads continue and active or comped accounts can mutate", async () => {
  await ensureBookingTables();
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const clientId = `client_billing_${suffix}`;
  const bookingId = `booking_billing_${suffix}`;
  try {
    await db().query(`INSERT INTO clients (id, name) VALUES ($1,$2)`, [clientId, `Billing Test Client ${suffix}`]);
    await db().query(`INSERT INTO bookings (id, client_id, session_type, proposed_dates) VALUES ($1,$2,'Billing Test','[]'::jsonb)`, [bookingId, clientId]);
    await db().query(`INSERT INTO post_session_pipeline (booking_id) VALUES ($1)`, [bookingId]);
    await db().query(`INSERT INTO account_billing (account_id, status) VALUES ('default','past_due') ON CONFLICT (account_id) DO UPDATE SET status='past_due'`);

    const pastDuePatch = await bookingsPatch(new NextRequest("http://localhost/api/bookings", { method: "PATCH", body: JSON.stringify({ id: bookingId, action: "update", venue: "Paused venue" }), headers: { "content-type": "application/json" } }));
    assert.equal(pastDuePatch.status, 403);
    const pastDueRead = await bookingsGet();
    assert.equal(pastDueRead.status, 200);

    await db().query(`UPDATE account_billing SET status='active' WHERE account_id='default'`);
    const activePatch = await bookingsPatch(new NextRequest("http://localhost/api/bookings", { method: "PATCH", body: JSON.stringify({ id: bookingId, action: "update", venue: "Active venue" }), headers: { "content-type": "application/json" } }));
    assert.equal(activePatch.status, 200);

    await db().query(`UPDATE account_billing SET status='comped' WHERE account_id='default'`);
    const compedPatch = await bookingsPatch(new NextRequest("http://localhost/api/bookings", { method: "PATCH", body: JSON.stringify({ id: bookingId, action: "update", venue: "Comped venue" }), headers: { "content-type": "application/json" } }));
    assert.equal(compedPatch.status, 200);
  } finally {
    await db().query(`DELETE FROM bookings WHERE id=$1`, [bookingId]);
    await db().query(`DELETE FROM clients WHERE id=$1`, [clientId]);
    await db().query(`DELETE FROM account_billing WHERE account_id='default'`);
    await db().query(`DELETE FROM account_entitlements WHERE account_id='default'`);
  }
});

dbTest("Checkout creates a 14-day subscription trial only when requested and omits trials for immediate billing", async () => {
  await ensureBookingTables();
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const delayedAccount = `billing_trial_${suffix}`;
  const immediateAccount = `billing_now_${suffix}`;
  const captures: Array<Record<string, unknown>> = [];
  const stripe = mockStripe({ capture: captures });
  try {
    const handler = createBillingCheckoutHandler({
      currentStaff: async () => "admin@truecosmic.com",
      stripeFactory: () => stripe,
      priceResolver: async () => priceIds,
    });
    const delayed = await handler(new NextRequest("http://localhost/api/billing/checkout", {
      method: "POST",
      headers: { "content-type": "application/json", host: "portal.example.test" },
      body: JSON.stringify({ accountId: delayedAccount, includeAiAddon: true, trialDays: 14 }),
    }));
    assert.equal(delayed.status, 201);
    assert.deepEqual(captures[0].subscription_data, { trial_period_days: 14, metadata: { accountId: delayedAccount } });
    assert.equal((captures[0].line_items as Array<unknown>).length, 2);

    const immediate = await handler(new NextRequest("http://localhost/api/billing/checkout", {
      method: "POST",
      headers: { "content-type": "application/json", host: "portal.example.test" },
      body: JSON.stringify({ accountId: immediateAccount, includeAiAddon: false, trialDays: 0 }),
    }));
    assert.equal(immediate.status, 201);
    assert.equal("subscription_data" in captures[1], false);
    assert.equal((captures[1].line_items as Array<unknown>).length, 1);
  } finally {
    await cleanAccount(delayedAccount);
    await cleanAccount(immediateAccount);
  }
});


dbTest("subscription update and deletion webhooks synchronize billing status and revoke the AI entitlement", async () => {
  await ensureBookingTables();
  const accountId = `billing_lifecycle_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  try {
    const update = event("customer.subscription.updated", {
      id: `sub_${accountId}`,
      customer: `cus_${accountId}`,
      status: "past_due",
      current_period_end: 1_800_000_000,
      metadata: { accountId },
      items: { data: [{ price: { id: priceIds.basePriceId } }] },
    });
    const stripe = mockStripe({ event: update });
    const handler = createStripeWebhookHandler({ stripeFactory: () => stripe, webhookSecret: "whsec_test", priceResolver: async () => priceIds });
    const updateResponse = await handler(new Request("http://localhost/api/billing/webhook", { method: "POST", headers: { "stripe-signature": "valid_signature" }, body: JSON.stringify(update) }));
    assert.equal(updateResponse.status, 200);
    let billing = await db().query(`SELECT status, ai_addon_active FROM account_billing WHERE account_id=$1`, [accountId]);
    assert.deepEqual(billing.rows[0], { status: "past_due", ai_addon_active: false });
    let entitlements = await getEntitlements(accountId);
    assert.equal(entitlements.operationsAgent, false);

    const deletion = event("customer.subscription.deleted", {
      id: `sub_${accountId}`,
      customer: `cus_${accountId}`,
      status: "canceled",
      metadata: { accountId },
      items: { data: [] },
    });
    const deletionStripe = mockStripe({ event: deletion });
    const deleteHandler = createStripeWebhookHandler({ stripeFactory: () => deletionStripe, webhookSecret: "whsec_test", priceResolver: async () => priceIds });
    const deleteResponse = await deleteHandler(new Request("http://localhost/api/billing/webhook", { method: "POST", headers: { "stripe-signature": "valid_signature" }, body: JSON.stringify(deletion) }));
    assert.equal(deleteResponse.status, 200);
    billing = await db().query(`SELECT status, ai_addon_active FROM account_billing WHERE account_id=$1`, [accountId]);
    assert.deepEqual(billing.rows[0], { status: "canceled", ai_addon_active: false });
    entitlements = await getEntitlements(accountId);
    assert.equal(entitlements.operationsAgent, false);
  } finally {
    await cleanAccount(accountId);
  }
});


test("ensureBillingPrices reuses both active lookup-key Prices without creating products or Prices", async () => {
  resetBillingPriceCacheForTests();
  const productCaptures: Array<Record<string, unknown>> = [];
  const priceCaptures: Array<Record<string, unknown>> = [];
  const priceListCaptures: Array<Record<string, unknown>> = [];
  const stripe = mockStripe({
    existingPrices: [
      { id: "price_existing_base", lookup_key: BASE_LOOKUP_KEY },
      { id: "price_existing_ai", lookup_key: AI_ADDON_LOOKUP_KEY },
    ],
    productCaptures,
    priceCaptures,
    priceListCaptures,
  });
  try {
    const prices = await ensureBillingPrices(stripe);
    assert.deepEqual(prices, { basePriceId: "price_existing_base", aiAddonPriceId: "price_existing_ai" });
    assert.equal(productCaptures.length, 0);
    assert.equal(priceCaptures.length, 0);
    assert.deepEqual(priceListCaptures[0], { lookup_keys: [BASE_LOOKUP_KEY, AI_ADDON_LOOKUP_KEY], active: true, expand: ["data.product"] });
  } finally {
    resetBillingPriceCacheForTests();
  }
});

test("ensureBillingPrices creates exactly the two required monthly USD Prices when lookup keys are absent", async () => {
  resetBillingPriceCacheForTests();
  const productCaptures: Array<Record<string, unknown>> = [];
  const priceCaptures: Array<Record<string, unknown>> = [];
  const stripe = mockStripe({ existingPrices: [], productCaptures, priceCaptures });
  try {
    const prices = await ensureBillingPrices(stripe);
    assert.deepEqual(prices, { basePriceId: "price_created_1", aiAddonPriceId: "price_created_2" });
    assert.equal(productCaptures.length, 2);
    assert.equal(priceCaptures.length, 2);
    assert.deepEqual(priceCaptures.map(({ product, lookup_key, unit_amount, currency, recurring }) => ({ product, lookup_key, unit_amount, currency, recurring })), [
      { product: "prod_1", lookup_key: BASE_LOOKUP_KEY, unit_amount: 11900, currency: "usd", recurring: { interval: "month" } },
      { product: "prod_2", lookup_key: AI_ADDON_LOOKUP_KEY, unit_amount: 3900, currency: "usd", recurring: { interval: "month" } },
    ]);
  } finally {
    resetBillingPriceCacheForTests();
  }
});
