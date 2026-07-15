#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_TOIN_CONFIG, TOIN } from "../src/toin.ts";

const directory = mkdtempSync(join(tmpdir(), "pi-headroom-toin-test-"));
const storagePath = join(directory, "toin.json");

try {
  writeFileSync(storagePath, JSON.stringify({
    patterns: {
      legacy: {
        tool_signature_hash: "legacy",
        total_compressions: 3,
        total_items_seen: 30,
        total_items_kept: 12,
        avg_compression_ratio: 0.4,
        avg_token_reduction: 18,
        optimal_strategy: "default",
        strategy_success_rates: { default: 0.8 },
        optimal_max_items: 12,
        confidence: 0.7,
        last_updated: 123,
      },
      malformed: {
        totalCompressions: "not-a-number",
        optimalStrategy: null,
      },
    },
  }));

  const toin = new TOIN({ ...DEFAULT_TOIN_CONFIG, storagePath });
  assert.deepEqual(toin.stats(), {
    patternCount: 2,
    totalCompressions: 3,
    topStrategies: { default: 2 },
  });

  console.log("TOIN migration and stats test passed");
} finally {
  rmSync(directory, { recursive: true, force: true });
}
