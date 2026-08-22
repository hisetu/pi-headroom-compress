#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compressContent } from "../index.ts";
import { CCRStore, formatCCRMarker, isCCRReferenceContent } from "../src/ccr-store.ts";
import { smartCrush } from "../src/smart-crusher.ts";

const markerHash = "a".repeat(24);
const marker = formatCCRMarker(markerHash, 3);

assert.equal(isCCRReferenceContent(marker), true);
assert.equal(isCCRReferenceContent("[Read content stale: src/a.ts was modified after this read — re-read the file for current content]"), true);
assert.equal(isCCRReferenceContent("plain tool output"), false);
assert.equal(
  isCCRReferenceContent("prefix text\n[Read content stale: src/a.ts was modified after this read]"),
  false,
);
assert.equal(
  isCCRReferenceContent(`Log note: ${marker} appears in documentation only`),
  false,
);

const directory = mkdtempSync(join(tmpdir(), "pi-headroom-ccr-guard-"));
const databasePath = join(directory, "ccr.db");

try {
  const store = new CCRStore(30_000, databasePath);
  const largeArray = JSON.stringify(Array.from({ length: 20 }, (_, index) => ({
    id: index,
    nested: { token: `item-${index}`, blob: "x".repeat(200) },
  })));
  const crushed = smartCrush(largeArray, "query", undefined, store);
  assert.equal(crushed.wasModified, true);
  assert.equal(store.size, 1);
  assert.equal(isCCRReferenceContent(crushed.compressed), true);

  const markerOnly = smartCrush(marker, "query", undefined, store);
  assert.equal(markerOnly.wasModified, false);
  assert.equal(store.size, 1);

  const reCrushed = smartCrush(crushed.compressed, "query", undefined, store);
  assert.equal(reCrushed.wasModified, false);
  assert.equal(reCrushed.strategy, "ccr_reference_passthrough");
  assert.equal(reCrushed.compressed, crushed.compressed);
  assert.equal(store.size, 1);

  const viaRouter = compressContent(crushed.compressed);
  assert.equal(viaRouter.wasModified, false);
  assert.equal(viaRouter.strategy, "ccr_reference_passthrough");
  assert.equal(viaRouter.compressed, crushed.compressed);
  assert.equal(store.size, 1);
} finally {
  rmSync(directory, { recursive: true, force: true });
}

console.log("CCR marker guard test passed");
