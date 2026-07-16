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

const model = {
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

assert.deepEqual(resolveInputPricePer1M(model, 500), {
  price: 5,
  source: "model",
});
assert.deepEqual(resolveInputPricePer1M(model, 20_000), {
  price: 9,
  source: "model-tier",
});

assert.deepEqual(estimateCompressionSavings(4000, 2000, model), {
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
