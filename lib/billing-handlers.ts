import { NextRequest, NextResponse } from "next/server";
import { currentStaffEmail } from "../app/api/integrations/google/_lib";
import { publicOrigin } from "./public-url";
import { getEntitlements } from "./db";
import {
  configuredStripe,
  createBillingCheckout,
  createCustomerPortal,
  getAccountBilling,
  processVerifiedStripeEvent,
  setAccountComped,
  type StripeClient,
} from "./billing";
import { ensureBillingPrices } from "./billing-setup";

type StaffGetter = () => Promise<string | null>;
type StripeFactory = () => StripeClient;

function accountId(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 160) : "default";
}

function checkoutInput(body: { includeAiAddon?: unknown; trialDays?: unknown; accountId?: unknown }) {
  if (typeof body.includeAiAddon !== "boolean") throw new Error("includeAiAddon must be true or false");
  if (body.trialDays !== 0 && body.trialDays !== 14) throw new Error("trialDays must be 0 or 14");
  return { accountId: accountId(body.accountId), includeAiAddon: body.includeAiAddon, trialDays: body.trialDays as 0 | 14 };
}

async function requireStaff(getter: StaffGetter) {
  const email = await getter();
  return email || null;
}

export function createBillingCheckoutHandler(dependencies: { currentStaff?: StaffGetter; stripeFactory?: StripeFactory; priceResolver?: (stripe: StripeClient) => Promise<{ basePriceId: string; aiAddonPriceId: string }> } = {}) {
  return async function checkout(request: NextRequest) {
    if (!await requireStaff(dependencies.currentStaff ?? currentStaffEmail)) return NextResponse.json({ error: "Administrator sign-in required" }, { status: 401 });
    try {
      const input = checkoutInput(await request.json() as { includeAiAddon?: unknown; trialDays?: unknown; accountId?: unknown });
      const stripe = (dependencies.stripeFactory ?? configuredStripe)();
      const priceIds = await (dependencies.priceResolver ?? ensureBillingPrices)(stripe);
      const result = await createBillingCheckout({
        ...input,
        origin: publicOrigin(request),
        stripe,
        priceIds,
      });
      return NextResponse.json(result, { status: result.action === "checkout_created" ? 201 : 200 });
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to create the billing checkout" }, { status: 400 });
    }
  };
}

export function createBillingPortalHandler(dependencies: { currentStaff?: StaffGetter; stripeFactory?: StripeFactory } = {}) {
  return async function portal(request: NextRequest) {
    if (!await requireStaff(dependencies.currentStaff ?? currentStaffEmail)) return NextResponse.json({ error: "Administrator sign-in required" }, { status: 401 });
    try {
      const body = await request.json().catch(() => ({})) as { accountId?: unknown };
      const result = await createCustomerPortal({
        accountId: accountId(body.accountId),
        origin: publicOrigin(request),
        stripe: (dependencies.stripeFactory ?? configuredStripe)(),
      });
      return NextResponse.json(result);
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to create the billing portal" }, { status: 400 });
    }
  };
}

export function createBillingStatusHandler(dependencies: { currentStaff?: StaffGetter } = {}) {
  return async function status() {
    if (!await requireStaff(dependencies.currentStaff ?? currentStaffEmail)) return NextResponse.json({ error: "Administrator sign-in required" }, { status: 401 });
    const billing = await getAccountBilling();
    const entitlements = await getEntitlements();
    return NextResponse.json({
      billing: {
        status: billing.status,
        aiAddonActive: billing.ai_addon_active,
        operationsAgentEnabled: entitlements.operationsAgent,
        trialDays: billing.trial_days,
        currentPeriodEnd: billing.current_period_end,
        hasCustomer: Boolean(billing.stripe_customer_id),
        hasSubscription: Boolean(billing.stripe_subscription_id),
      },
    });
  };
}

export function createStripeWebhookHandler(dependencies: { stripeFactory?: StripeFactory; webhookSecret?: string | undefined; priceResolver?: (stripe: StripeClient) => Promise<{ basePriceId: string; aiAddonPriceId: string }> } = {}) {
  return async function webhook(request: Request) {
    const signature = request.headers.get("stripe-signature");
    const secret = dependencies.webhookSecret ?? process.env.STRIPE_WEBHOOK_SECRET;
    if (!signature || !secret) return NextResponse.json({ error: "Webhook signature verification failed" }, { status: 400 });
    const rawBody = await request.text();
    let event;
    try {
      event = (dependencies.stripeFactory ?? configuredStripe)().webhooks.constructEvent(rawBody, signature, secret);
    } catch {
      return NextResponse.json({ error: "Webhook signature verification failed" }, { status: 400 });
    }
    try {
      const stripe = (dependencies.stripeFactory ?? configuredStripe)();
      const priceIds = await (dependencies.priceResolver ?? ensureBillingPrices)(stripe);
      const result = await processVerifiedStripeEvent(event, stripe, priceIds.aiAddonPriceId);
      return NextResponse.json({ received: true, result });
    } catch (error) {
      console.error("Verified Stripe webhook processing failed", error);
      return NextResponse.json({ error: "Verified webhook could not be processed" }, { status: 500 });
    }
  };
}

export function createCompedBillingHandler(dependencies: { currentStaff?: StaffGetter; internalEmail?: string | undefined } = {}) {
  return async function comped(request: NextRequest) {
    const email = await requireStaff(dependencies.currentStaff ?? currentStaffEmail);
    const allowedEmail = dependencies.internalEmail ?? process.env.GOOGLE_WORKSPACE_ACCOUNT ?? "admin@truecosmic.com";
    if (!email || email.toLowerCase() !== allowedEmail.toLowerCase()) {
      return NextResponse.json({ error: "Internal billing administrator access is required" }, { status: 403 });
    }
    try {
      const body = await request.json().catch(() => ({})) as { accountId?: unknown };
      const result = await setAccountComped(accountId(body.accountId));
      return NextResponse.json(result);
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to comp this account" }, { status: 400 });
    }
  };
}
