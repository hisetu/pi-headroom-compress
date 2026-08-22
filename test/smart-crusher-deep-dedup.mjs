#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CCRStore } from "../src/ccr-store.ts";
import { smartCrush, DEFAULT_CONFIG } from "../src/smart-crusher.ts";

function buildDeepArrayJson(depth, itemCount = 6) {
  let object = '{"leaf":1}';
  for (let i = 0; i < depth; i++) object = `{"nested":${object}}`;
  return `[${Array.from({ length: itemCount }, () => object).join(",")}]`;
}

const deep = buildDeepArrayJson(25_000);
const deepResult = smartCrush(deep, "", DEFAULT_CONFIG);
assert.equal(deepResult.wasModified, false);
assert.equal(deepResult.strategy, "passthrough");
assert.equal(deepResult.compressed, deep);

const directory = mkdtempSync(join(tmpdir(), "pi-headroom-dedup-omit-"));
const databasePath = join(directory, "ccr.db");

try {
  const store = new CCRStore(30_000, databasePath);
  const items = [
    ...Array.from({ length: 10 }, () => ({ tag: "dup", n: 1, blob: "x".repeat(40) })),
    ...Array.from({ length: 15 }, (_, index) => ({ tag: "uniq", n: index, extra: `field-${index}`, blob: "y".repeat(40) })),
  ];
  const crushed = smartCrush(JSON.stringify(items), "", DEFAULT_CONFIG, store);
  assert.match(crushed.strategy, /^row_drop:/);
  const parsed = JSON.parse(crushed.compressed);
  const retained = parsed.filter((entry) => !entry?._ccr_dropped).length;
  const omitted = items.length - retained;
  assert.equal(Number(crushed.strategy.split(":")[1]), omitted);
  assert.match(String(parsed.find((entry) => entry?._ccr_dropped)?._ccr_dropped), new RegExp(`${omitted} items stored`));
} finally {
  rmSync(directory, { recursive: true, force: true });
}

console.log("SmartCrusher deep nesting and dedup omission tests passed");
