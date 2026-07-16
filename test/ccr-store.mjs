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
  first.setGlobalSavedChars(12_345);

  const second = new CCRStore(30_000, databasePath);
  assert.equal(second.retrieve(hash)?.original, "original content");
  assert.equal(second.getGlobalSavedChars(), 12_345);

  second.setGlobalSavedChars(Number.NaN);
  assert.equal(second.getGlobalSavedChars(), 0);

  console.log("CCR persistence and global savings test passed");
} finally {
  rmSync(directory, { recursive: true, force: true });
}
