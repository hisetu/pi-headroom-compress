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

function readValidPrice(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return value;
}

export function resolveInputPricePer1M(
  model: PricingModel | undefined,
  totalInputTokens: number,
): { price: number; source: SavingsEstimate["pricingSource"] } {
  const basePrice = readValidPrice(model?.cost?.input);
  let price: number;
  let source: SavingsEstimate["pricingSource"];

  if (basePrice !== null) {
    price = basePrice;
    source = "model";
  } else {
    price = FALLBACK_INPUT_COST_PER_1M;
    source = "fallback";
  }

  if (!Number.isFinite(totalInputTokens) || totalInputTokens < 0) {
    return { price, source };
  }

  const rawTiers: unknown[] = Array.isArray(model?.cost?.tiers) ? model.cost.tiers : [];
  const matchingTiers = rawTiers.flatMap((tier) => {
    if (typeof tier !== "object" || tier === null) return [];
    const candidate = tier as { inputTokensAbove?: unknown; input?: unknown };
    const threshold = candidate.inputTokensAbove;
    const tierPrice = readValidPrice(candidate.input);
    if (
      typeof threshold !== "number" ||
      !Number.isFinite(threshold) ||
      threshold < 0 ||
      totalInputTokens <= threshold ||
      tierPrice === null
    ) {
      return [];
    }
    return [{ threshold, price: tierPrice }];
  }).sort((a, b) => b.threshold - a.threshold);

  if (matchingTiers.length > 0) {
    price = matchingTiers[0].price;
    source = "model-tier";
  }

  return { price, source };
}

function estimateRequestCost(tokens: number, model?: PricingModel): number {
  const { price } = resolveInputPricePer1M(model, tokens);
  return tokens * price / 1_000_000;
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
  const costBefore = estimateRequestCost(tokensBefore, model);
  const costAfter = estimateRequestCost(tokensAfter, model);

  return {
    model: model?.id || "unknown",
    provider: model?.provider || "unknown",
    tokensBefore,
    tokensAfter,
    tokensSaved,
    inputCostPer1M: price,
    costUsd: Math.max(0, costBefore - costAfter),
    pricingSource: source,
  };
}
