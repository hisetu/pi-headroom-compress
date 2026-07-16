/** Model-aware savings estimation, aligned with Headroom's pricing logic. */

export const FALLBACK_INPUT_COST_PER_1M = 3;
const CHARS_PER_TOKEN = 4;

export interface PricingModel {
  id?: string;
  provider?: string;
  cost?: {
    input?: number;
    tiers?: Array<{
      inputTokensAbove: number;
      input: number;
    }>;
  };
}

export interface SavingsEstimate {
  model: string;
  provider: string;
  tokensBefore: number;
  tokensAfter: number;
  tokensSaved: number;
  inputCostPer1M: number;
  costUsd: number;
  pricingSource: "model" | "model-tier" | "fallback";
}

/**
 * Match Pi's own context estimation and Headroom's estimator fallback.
 * Exact provider tokenizers are not exposed to before_provider_request.
 */
export function estimateTextTokens(chars: number): number {
  return Math.ceil(Math.max(0, chars) / CHARS_PER_TOKEN);
}

export function resolveInputPricePer1M(
  model: PricingModel | undefined,
  totalInputTokens: number,
): { price: number; source: SavingsEstimate["pricingSource"] } {
  const basePrice = Number(model?.cost?.input);
  let price = Number.isFinite(basePrice) && basePrice > 0
    ? basePrice
    : FALLBACK_INPUT_COST_PER_1M;
  let source: SavingsEstimate["pricingSource"] = price === FALLBACK_INPUT_COST_PER_1M && !(basePrice > 0)
    ? "fallback"
    : "model";

  const tiers = model?.cost?.tiers ?? [];
  const matchingTiers = tiers
    .filter(tier => Number.isFinite(tier.inputTokensAbove) && totalInputTokens > tier.inputTokensAbove)
    .sort((a, b) => b.inputTokensAbove - a.inputTokensAbove);
  const tierPrice = Number(matchingTiers[0]?.input);
  if (Number.isFinite(tierPrice) && tierPrice > 0) {
    price = tierPrice;
    source = "model-tier";
  }

  return { price, source };
}

export function estimateCompressionSavings(
  originalChars: number,
  compressedChars: number,
  model?: PricingModel,
): SavingsEstimate {
  const tokensBefore = estimateTextTokens(originalChars);
  const tokensAfter = estimateTextTokens(compressedChars);
  const tokensSaved = Math.max(0, tokensBefore - tokensAfter);
  const { price, source } = resolveInputPricePer1M(model, tokensBefore);

  return {
    model: model?.id || "unknown",
    provider: model?.provider || "unknown",
    tokensBefore,
    tokensAfter,
    tokensSaved,
    inputCostPer1M: price,
    costUsd: tokensSaved * price / 1_000_000,
    pricingSource: source,
  };
}
