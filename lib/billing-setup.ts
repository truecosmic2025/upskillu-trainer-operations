import type { StripeClient } from "./billing";

export const BASE_LOOKUP_KEY = "upskillu_base_monthly_119";
export const AI_ADDON_LOOKUP_KEY = "upskillu_ai_addon_monthly_39";
export const BASE_PRICE_USD_CENTS = 11_900;
export const AI_ADDON_USD_CENTS = 3_900;

type ResolvedBillingPrices = { basePriceId: string; aiAddonPriceId: string };
type ExistingPrice = { id: string; lookup_key?: string | null };

let cachedPrices: Promise<ResolvedBillingPrices> | null = null;

async function createMissingPrice(input: {
  stripe: StripeClient;
  name: string;
  lookupKey: string;
  amount: number;
}) {
  const product = await input.stripe.products.create({ name: input.name });
  return input.stripe.prices.create({
    product: product.id,
    lookup_key: input.lookupKey,
    unit_amount: input.amount,
    currency: "usd",
    recurring: { interval: "month" },
  });
}

async function resolveBillingPrices(stripe: StripeClient): Promise<ResolvedBillingPrices> {
  const prices = await stripe.prices.list({
    lookup_keys: [BASE_LOOKUP_KEY, AI_ADDON_LOOKUP_KEY],
    active: true,
    expand: ["data.product"],
  });
  const current = new Map((prices.data as ExistingPrice[]).map((price) => [price.lookup_key, price.id]));
  const basePriceId = current.get(BASE_LOOKUP_KEY) ?? (await createMissingPrice({
    stripe,
    name: "UpskillU Trainer Operations — Base plan",
    lookupKey: BASE_LOOKUP_KEY,
    amount: BASE_PRICE_USD_CENTS,
  })).id;
  const aiAddonPriceId = current.get(AI_ADDON_LOOKUP_KEY) ?? (await createMissingPrice({
    stripe,
    name: "UpskillU Trainer Operations — AI add-on",
    lookupKey: AI_ADDON_LOOKUP_KEY,
    amount: AI_ADDON_USD_CENTS,
  })).id;
  return { basePriceId, aiAddonPriceId };
}

/**
 * Resolve the two platform Prices lazily. Lookup keys make a cold start or deploy idempotent,
 * while the cached promise prevents repeated Stripe reads during the process lifetime.
 */
export async function ensureBillingPrices(stripe: StripeClient): Promise<ResolvedBillingPrices> {
  if (!cachedPrices) {
    cachedPrices = resolveBillingPrices(stripe).catch((error) => {
      cachedPrices = null;
      throw error;
    });
  }
  return cachedPrices;
}

/** Test-only cache reset; production callers use the process-lifetime cache above. */
export function resetBillingPriceCacheForTests() {
  cachedPrices = null;
}
