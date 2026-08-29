import Stripe from "stripe";
import { db, ensureBookingTables } from "./db";

export type BillingStatus = "inactive" | "trialing" | "active" | "past_due" | "canceled" | "comped";
export type BillingRecord = {
  account_id: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  stripe_checkout_session_id: string | null;
  status: BillingStatus;
  ai_addon_active: boolean;
  trial_days: number;
  current_period_end: string | Date | null;
  updated_at: string | Date;
};

export type StripeSubscriptionLike = {
  id: string;
  customer?: string | { id: string } | null;
  status?: string;
  current_period_end?: number | null;
  items?: { data?: Array<{ price?: { id?: string | null } | null }> };
};

export type StripeClient = {
  products: { create: (params: Record<string, unknown>) => Promise<{ id: string }> };
  prices: {
    list: (params: Record<string, unknown>) => Promise<{ data: Array<{ id: string; lookup_key?: string | null }> }>;
    create: (params: Record<string, unknown>) => Promise<{ id: string; lookup_key?: string | null }>;
  };
  customers: { create: (params: Record<string, unknown>) => Promise<{ id: string }> };
  checkout: { sessions: { create: (params: Record<string, unknown>) => Promise<{ id: string; url: string | null }> } };
  subscriptions: { retrieve: (id: string) => Promise<StripeSubscriptionLike> };
  subscriptionItems: { create: (params: Record<string, unknown>) => Promise<unknown> };
  billingPortal: { sessions: { create: (params: Record<string, unknown>) => Promise<{ url: string }> } };
  webhooks: { constructEvent: (payload: string | Buffer, signature: string, secret: string) => Stripe.Event };
};

const ALLOWED_BILLING_STATUSES = new Set<BillingStatus>(["inactive", "trialing", "active", "past_due", "canceled", "comped"]);

export function configuredStripe(): StripeClient {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("Billing is not configured. Add STRIPE_SECRET_KEY to the Railway service variables.");
  return new Stripe(key) as unknown as StripeClient;
}

export async function getAccountBilling(accountId = "default"): Promise<BillingRecord> {
  await ensureBookingTables();
  await db().query(`INSERT INTO account_billing (account_id) VALUES ($1) ON CONFLICT (account_id) DO NOTHING`, [accountId]);
  const result = await db().query<BillingRecord>(`SELECT * FROM account_billing WHERE account_id=$1`, [accountId]);
  return result.rows[0];
}

export function isActiveBillingStatus(status: BillingStatus) {
  return status === "active" || status === "trialing" || status === "comped";
}

function toBillingStatus(status: string | undefined): BillingStatus {
  return ALLOWED_BILLING_STATUSES.has(status as BillingStatus) ? status as BillingStatus : "inactive";
}

function stripeId(value: string | { id: string } | null | undefined) {
  return typeof value === "string" ? value : value?.id ?? null;
}

function dateFromEpoch(epoch: number | null | undefined) {
  return typeof epoch === "number" ? new Date(epoch * 1000) : null;
}

export function subscriptionHasAiAddon(subscription: StripeSubscriptionLike, aiPriceId: string) {
  return Boolean(subscription.items?.data?.some((item) => item.price?.id === aiPriceId));
}

/** Updates the one route-level entitlement source of truth from an authoritative Stripe subscription. */
export async function setOperationsAgentEntitlement(accountId: string, enabled: boolean) {
  await ensureBookingTables();
  await db().query(`INSERT INTO account_entitlements (account_id) VALUES ($1) ON CONFLICT (account_id) DO NOTHING`, [accountId]);
  await db().query(
    `UPDATE account_entitlements
     SET features = features || jsonb_build_object('operationsAgent', $2::boolean), updated_at=CURRENT_TIMESTAMP
     WHERE account_id=$1`,
    [accountId, enabled],
  );
}

/** Syncs billing state from a verified Stripe subscription unless the account is manually comped. */
export async function syncSubscriptionBilling(input: {
  accountId: string;
  subscription: StripeSubscriptionLike;
  aiPriceId: string;
  customerId?: string | null;
  checkoutSessionId?: string | null;
  trialDays?: number;
}) {
  const current = await getAccountBilling(input.accountId);
  if (current.status === "comped") return { skipped: true, billing: current };
  const status = toBillingStatus(input.subscription.status);
  const aiAddonActive = subscriptionHasAiAddon(input.subscription, input.aiPriceId);
  const customerId = input.customerId ?? stripeId(input.subscription.customer) ?? current.stripe_customer_id;
  await db().query(
    `UPDATE account_billing
     SET stripe_customer_id=$2, stripe_subscription_id=$3,
         stripe_checkout_session_id=COALESCE($4, stripe_checkout_session_id), status=$5,
         ai_addon_active=$6, trial_days=COALESCE($7, trial_days), current_period_end=$8,
         updated_at=CURRENT_TIMESTAMP
     WHERE account_id=$1`,
    [
      input.accountId,
      customerId,
      input.subscription.id,
      input.checkoutSessionId ?? null,
      status,
      aiAddonActive,
      input.trialDays ?? null,
      dateFromEpoch(input.subscription.current_period_end),
    ],
  );
  await setOperationsAgentEntitlement(input.accountId, aiAddonActive);
  return { skipped: false, billing: await getAccountBilling(input.accountId) };
}

export async function markSubscriptionCanceled(input: { accountId: string; subscriptionId?: string | null }) {
  const current = await getAccountBilling(input.accountId);
  if (current.status === "comped") return { skipped: true, billing: current };
  await db().query(
    `UPDATE account_billing
     SET stripe_subscription_id=COALESCE($2, stripe_subscription_id), status='canceled', ai_addon_active=FALSE, updated_at=CURRENT_TIMESTAMP
     WHERE account_id=$1`,
    [input.accountId, input.subscriptionId ?? null],
  );
  await setOperationsAgentEntitlement(input.accountId, false);
  return { skipped: false, billing: await getAccountBilling(input.accountId) };
}

async function ensureStripeCustomer(accountId: string, billing: BillingRecord, stripe: StripeClient) {
  if (billing.stripe_customer_id) return billing.stripe_customer_id;
  const customer = await stripe.customers.create({ metadata: { accountId } });
  await db().query(`UPDATE account_billing SET stripe_customer_id=$2, updated_at=CURRENT_TIMESTAMP WHERE account_id=$1`, [accountId, customer.id]);
  return customer.id;
}

export async function createBillingCheckout(input: {
  accountId: string;
  includeAiAddon: boolean;
  trialDays: 0 | 14;
  origin: string;
  stripe: StripeClient;
  priceIds: { basePriceId: string; aiAddonPriceId: string };
}) {
  const billing = await getAccountBilling(input.accountId);
  if (billing.stripe_subscription_id) {
    if (!input.includeAiAddon) throw new Error("This account already has a subscription. Use the billing portal to manage the base subscription.");
    // Stripe Checkout always creates a new subscription. To preserve the required one-subscription,
    // two-item model, add the add-on to the existing subscription using Stripe's subscription-item API.
    await input.stripe.subscriptionItems.create({
      subscription: billing.stripe_subscription_id,
      price: input.priceIds.aiAddonPriceId,
      quantity: 1,
      proration_behavior: "create_prorations",
    });
    return { action: "ai_addon_added_pending_webhook" as const, url: null, sessionId: null };
  }

  const customerId = await ensureStripeCustomer(input.accountId, billing, input.stripe);
  const session = await input.stripe.checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    client_reference_id: input.accountId,
    metadata: { accountId: input.accountId, includeAiAddon: String(input.includeAiAddon) },
    line_items: [
      { price: input.priceIds.basePriceId, quantity: 1 },
      ...(input.includeAiAddon ? [{ price: input.priceIds.aiAddonPriceId, quantity: 1 }] : []),
    ],
    ...(input.trialDays === 14 ? { subscription_data: { trial_period_days: 14, metadata: { accountId: input.accountId } } } : {}),
    success_url: `${input.origin}/?billing=success`,
    cancel_url: `${input.origin}/?billing=cancelled`,
  });
  await db().query(
    `UPDATE account_billing SET stripe_checkout_session_id=$2, trial_days=$3, updated_at=CURRENT_TIMESTAMP WHERE account_id=$1`,
    [input.accountId, session.id, input.trialDays],
  );
  return { action: "checkout_created" as const, url: session.url, sessionId: session.id };
}

export async function createCustomerPortal(input: { accountId: string; origin: string; stripe: StripeClient }) {
  const billing = await getAccountBilling(input.accountId);
  if (!billing.stripe_customer_id) throw new Error("No Stripe customer exists for this account yet.");
  const portal = await input.stripe.billingPortal.sessions.create({
    customer: billing.stripe_customer_id,
    return_url: `${input.origin}/?billing=return`,
  });
  return { url: portal.url };
}

function accountIdFromStripeObject(object: { metadata?: Record<string, string> | null; client_reference_id?: string | null }) {
  return object.metadata?.accountId || object.client_reference_id || "default";
}

export async function processVerifiedStripeEvent(event: Stripe.Event, stripe: StripeClient, aiPriceId: string) {
  if (event.type === "checkout.session.completed") {
    const session = event.data.object as Stripe.Checkout.Session;
    const subscriptionId = stripeId(session.subscription as string | { id: string } | null);
    if (!subscriptionId) return { ignored: true, reason: "checkout has no subscription" };
    const accountId = accountIdFromStripeObject(session);
    const subscription = await stripe.subscriptions.retrieve(subscriptionId);
    return syncSubscriptionBilling({
      accountId,
      subscription,
      aiPriceId,
      customerId: stripeId(session.customer as string | { id: string } | null),
      checkoutSessionId: session.id,
    });
  }
  if (event.type === "customer.subscription.updated") {
    const subscription = event.data.object as unknown as StripeSubscriptionLike & { metadata?: Record<string, string> };
    const accountId = subscription.metadata?.accountId || (await accountIdForSubscription(subscription.id)) || "default";
    return syncSubscriptionBilling({ accountId, subscription, aiPriceId });
  }
  if (event.type === "customer.subscription.deleted") {
    const subscription = event.data.object as unknown as StripeSubscriptionLike & { metadata?: Record<string, string> };
    const accountId = subscription.metadata?.accountId || (await accountIdForSubscription(subscription.id)) || "default";
    return markSubscriptionCanceled({ accountId, subscriptionId: subscription.id });
  }
  return { ignored: true, reason: "event type not handled" };
}

async function accountIdForSubscription(subscriptionId: string) {
  await ensureBookingTables();
  const result = await db().query<{ account_id: string }>(`SELECT account_id FROM account_billing WHERE stripe_subscription_id=$1`, [subscriptionId]);
  return result.rows[0]?.account_id ?? null;
}

export async function setAccountComped(accountId = "default") {
  const current = await getAccountBilling(accountId);
  await db().query(
    `UPDATE account_billing SET status='comped', updated_at=CURRENT_TIMESTAMP WHERE account_id=$1`,
    [accountId],
  );
  return { billing: await getAccountBilling(accountId), previousStatus: current.status };
}
