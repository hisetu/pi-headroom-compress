#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CCRStore, extractCCRHash } from "../src/ccr-store.ts";

const directory = mkdtempSync(join(tmpdir(), "pi-headroom-ccr-test-"));
const databasePath = join(directory, "ccr.db");

try {
  const first = new CCRStore(30_000, databasePath);
  const hash = first.store("original content", "compressed", "test", "test_strategy");
  assert.equal(hash.length, 24);
  assert.equal(extractCCRHash(`⟨ccr:${hash} stored⟩`), hash);
  assert.equal(extractCCRHash("⟨ccr:123456789abc legacy⟩"), "123456789abc");
  first.recordSavingsEvent({
    timestamp: 1,
    model: "gpt-test",
    provider: "test",
    tokensBefore: 1000,
    tokensAfter: 600,
    tokensSaved: 400,
    costUsd: 0.002,
    inputCostPer1M: 5,
    pricingSource: "model",
  });

  const second = new CCRStore(30_000, databasePath);
  const firstRetrieval = second.retrieve(hash);
  assert.equal(firstRetrieval?.original, "original content");
  assert.equal(firstRetrieval?.retrievalCount, 1);
  const createdAt = firstRetrieval?.createdAt;

  second.store("original content", "compressed again", "test-again", "repeat_strategy");
  const secondRetrieval = second.retrieve(hash);
  assert.equal(secondRetrieval?.retrievalCount, 2);
  assert.equal(secondRetrieval?.compressed, "compressed again");
  assert.equal(secondRetrieval?.toolName, "test-again");
  assert.equal(secondRetrieval?.createdAt, createdAt);

  const shortDb = join(directory, "short.db");
  const shortTtl = new CCRStore(1, shortDb);
  const shortHash = shortTtl.store("original content", "compressed");
  const start = Date.now();
  while (Date.now() - start < 5) {}
  const recreatedStore = new CCRStore(30_000, shortDb);
  recreatedStore.store("original content", "recreated");
  assert.equal(recreatedStore.retrieve(shortHash)?.compressed, "recreated");

  assert.deepEqual(second.getGlobalSavings(), {
    tokensSaved: 400,
    costUsd: 0.002,
    eventCount: 1,
  });

  console.log("CCR persistence and global savings test passed");
} finally {
  rmSync(directory, { recursive: true, force: true });
}
