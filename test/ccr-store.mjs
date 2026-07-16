#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CCRStore } from "../src/ccr-store.ts";

const directory = mkdtempSync(join(tmpdir(), "pi-headroom-ccr-test-"));
const databasePath = join(directory, "ccr.db");

try {
  const first = new CCRStore(30_000, databasePath);
  const hash = first.store("original content", "compressed", "test", "test_strategy");
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
  assert.equal(second.retrieve(hash)?.original, "original content");
  assert.deepEqual(second.getGlobalSavings(), {
    tokensSaved: 400,
    costUsd: 0.002,
    eventCount: 1,
  });

  console.log("CCR persistence and global savings test passed");
} finally {
  rmSync(directory, { recursive: true, force: true });
}
