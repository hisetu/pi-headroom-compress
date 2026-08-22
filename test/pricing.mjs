#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  estimateCompressionSavings,
  estimateTextTokens,
  resolveInputPricePer1M,
} from "../src/pricing.ts";

assert.equal(estimateTextTokens(400), 100);

assert.deepEqual(resolveInputPricePer1M(undefined, 100), {
  price: 3,
  source: "fallback",
});
assert.deepEqual(resolveInputPricePer1M({ cost: {} }, 100), {
  price: 3,
  source: "fallback",
});

assert.deepEqual(resolveInputPricePer1M({ cost: { input: null } }, 100), {
  price: 3,
  source: "fallback",
});

const stringPricedModel = {
  cost: {
    input: "5",
    tiers: [{ inputTokensAbove: 1000, input: 7 }],
  },
};
assert.deepEqual(resolveInputPricePer1M(stringPricedModel, 500), {
  price: 3,
  source: "fallback",
});
assert.deepEqual(resolveInputPricePer1M(stringPricedModel, 20_000), {
  price: 7,
  source: "model-tier",
});

const nullTierModel = {
  cost: {
    input: 5,
    tiers: [{ inputTokensAbove: 1000, input: null }],
  },
};
assert.deepEqual(resolveInputPricePer1M(nullTierModel, 20_000), {
  price: 5,
  source: "model",
});

const freeModel = {
  id: "free-model",
  provider: "test-provider",
  cost: { input: 0 },
};
assert.deepEqual(resolveInputPricePer1M(freeModel, 100), {
  price: 0,
  source: "model",
});
assert.deepEqual(estimateCompressionSavings(4000, 2000, freeModel), {
  model: "free-model",
  provider: "test-provider",
  tokensBefore: 1000,
  tokensAfter: 500,
  tokensSaved: 500,
  inputCostPer1M: 0,
  costUsd: 0,
  pricingSource: "model",
});

const tieredFreeModel = {
  id: "tiered-free",
  provider: "test-provider",
  cost: {
    input: 5,
    tiers: [{ inputTokensAbove: 1000, input: 0 }],
  },
};
assert.deepEqual(resolveInputPricePer1M(tieredFreeModel, 500), {
  price: 5,
  source: "model",
});
assert.deepEqual(resolveInputPricePer1M(tieredFreeModel, 20_000), {
  price: 0,
  source: "model-tier",
});

const partiallyMalformedTiers = {
  cost: {
    input: 2,
    tiers: [
      { inputTokensAbove: 1000, input: 7 },
      { inputTokensAbove: 10_000, input: null },
      null,
    ],
  },
};
assert.deepEqual(resolveInputPricePer1M(partiallyMalformedTiers, 20_000), {
  price: 7,
  source: "model-tier",
});

assert.deepEqual(resolveInputPricePer1M({ cost: { input: 4, tiers: "invalid" } }, 20_000), {
  price: 4,
  source: "model",
});

const tierModel = {
  id: "gpt-test",
  provider: "test-provider",
  cost: {
    input: 5,
    tiers: [
      { inputTokensAbove: 1000, input: 7 },
      { inputTokensAbove: 10_000, input: 9 },
    ],
  },
};

assert.deepEqual(resolveInputPricePer1M(tierModel, 500), {
  price: 5,
  source: "model",
});
assert.deepEqual(resolveInputPricePer1M(tierModel, 20_000), {
  price: 9,
  source: "model-tier",
});

assert.deepEqual(resolveInputPricePer1M({ cost: { input: 5, tiers: [{ inputTokensAbove: 1000, input: 2 }] } }, 1000), {
  price: 5,
  source: "model",
});
assert.deepEqual(resolveInputPricePer1M({ cost: { input: 5, tiers: [{ inputTokensAbove: 1000, input: 2 }] } }, 1001), {
  price: 2,
  source: "model-tier",
});

assert.deepEqual(resolveInputPricePer1M({
  cost: { input: 5, tiers: [{ inputTokensAbove: -100, input: 1 }] },
}, 20_000), {
  price: 5,
  source: "model",
});

assert.deepEqual(resolveInputPricePer1M({
  cost: { input: 5, tiers: [{ inputTokensAbove: 100, input: 1 }] },
}, Number.NaN), {
  price: 5,
  source: "model",
});

const crossingModel = {
  cost: { input: 5, tiers: [{ inputTokensAbove: 1000, input: 2 }] },
};
const crossing = estimateCompressionSavings(8000, 2000, crossingModel);
assert.equal(crossing.tokensBefore, 2000);
assert.equal(crossing.tokensAfter, 500);
assert.equal(crossing.inputCostPer1M, 2);
assert.equal(crossing.pricingSource, "model-tier");
assert.equal(crossing.costUsd, 0.0015);

assert.deepEqual(estimateCompressionSavings(4000, 2000, tierModel), {
  model: "gpt-test",
  provider: "test-provider",
  tokensBefore: 1000,
  tokensAfter: 500,
  tokensSaved: 500,
  inputCostPer1M: 5,
  costUsd: 0.0025,
  pricingSource: "model",
});

console.log("Model-aware pricing test passed");
