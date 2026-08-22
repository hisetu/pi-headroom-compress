#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compressContent } from "../index.ts";
import { CCRStore, capCompressedOutput, extractPreservableCCRMarker, isCCRReferenceContent } from "../src/ccr-store.ts";
import { smartCrush } from "../src/smart-crusher.ts";

const directory = mkdtempSync(join(tmpdir(), "pi-headroom-ccr-cap-"));
const databasePath = join(directory, "ccr.db");

try {
  const store = new CCRStore(30_000, databasePath);
  const input = JSON.stringify(Array.from({ length: 20 }, (_, index) => ({
    id: index,
    nested: { token: `item-${index}`, blob: "x".repeat(200) },
  })));
  const crushed = smartCrush(input, "query", undefined, store);
  assert.ok(crushed.compressed.length > 100);
  const marker = extractPreservableCCRMarker(crushed.compressed);
  assert.ok(marker);
  const capped = capCompressedOutput(crushed.compressed, 100);
  assert.equal(capped, marker);
  assert.equal(isCCRReferenceContent(capped), true);

  const viaRouter = compressContent(capped);
  assert.equal(viaRouter.wasModified, false);
  assert.equal(viaRouter.strategy, "ccr_reference_passthrough");

  const plain = "a".repeat(1_000);
  const plainCapped = capCompressedOutput(plain, 100);
  assert.ok(plainCapped.length <= 100);
  const omittedMatch = plainCapped.match(/⟨(\d+) chars omitted⟩/);
  assert.ok(omittedMatch);
  assert.equal(Number(omittedMatch[1]), plain.length - plainCapped.replace(/\n⟨\d+ chars omitted⟩\n/, "").length);
} finally {
  rmSync(directory, { recursive: true, force: true });
}

console.log("CCR cap preservation test passed");
