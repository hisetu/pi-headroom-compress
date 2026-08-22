#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CCRStore } from "../src/ccr-store.ts";
import { smartCrush, DEFAULT_CONFIG } from "../src/smart-crusher.ts";

const compact = Array.from({ length: 20 }, (_, index) =>
  JSON.stringify({ i: index, v: index, d: { x: 1 } })
).join(" ");

const directory = mkdtempSync(join(tmpdir(), "pi-headroom-size-guard-"));
const databasePath = join(directory, "ccr.db");

try {
  const store = new CCRStore(30_000, databasePath);
  const result = smartCrush(compact, "", DEFAULT_CONFIG, store);
  assert.equal(result.wasModified, false);
  assert.equal(result.strategy, "passthrough");
  assert.equal(result.compressed, compact);
  assert.equal(store.size, 0);
} finally {
  rmSync(directory, { recursive: true, force: true });
}

console.log("SmartCrusher size guard test passed");
