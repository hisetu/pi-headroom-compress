#!/usr/bin/env node
import assert from "node:assert/strict";
import { smartCrush, DEFAULT_CONFIG } from "../src/smart-crusher.ts";

const config = { ...DEFAULT_CONFIG, maxItemsAfterCrush: 50, minItemsToAnalyze: 3, losslessMinSavingsRatio: 0.05 };

const withRare = Array.from({ length: 10 }, (_, index) => ({
  id: index,
  status: "ok",
  value: "x".repeat(20),
  ...(index === 5 ? { error_detail: "boom" } : {}),
}));
const rareResult = smartCrush(JSON.stringify(withRare), "", config);
assert.notEqual(rareResult.strategy, "tabular_compaction");
assert.match(rareResult.compressed, /error_detail/);

const nullVsEmpty = [
  { name: "alpha", note: null },
  { name: "beta", note: "" },
  { name: "gamma", note: "ok" },
];
assert.notEqual(smartCrush(JSON.stringify(nullVsEmpty), "", config).strategy, "tabular_compaction");

const weirdFields = [
  { "field,with\rcomma": "a", plain: "1" },
  { "field,with\rcomma": "b", plain: "2" },
  { "field,with\rcomma": "c", plain: "3" },
];
const weirdResult = smartCrush(JSON.stringify(weirdFields), "", config);
if (weirdResult.strategy === "tabular_compaction") {
  assert.match(weirdResult.compressed, /"field,with\rcomma"/);
}

console.log("SmartCrusher tabular field-set test passed");
