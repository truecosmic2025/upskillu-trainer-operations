import { createStripeWebhookHandler } from "../../../../lib/billing-handlers";

export const runtime = "nodejs";
export const POST = createStripeWebhookHandler();
