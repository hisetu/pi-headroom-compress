#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CCRStore } from "../src/ccr-store.ts";
import { applyReadLifecycle, DEFAULT_READ_LIFECYCLE_CONFIG } from "../src/read-lifecycle.ts";

const directory = mkdtempSync(join(tmpdir(), "pi-headroom-read-store-"));
const databasePath = join(directory, "ccr.db");

try {
  const store = new CCRStore(30_000, databasePath);
  const readOutput = "x".repeat(600);
  const items = [
    { type: "function_call", name: "Read", call_id: "read-1", arguments: JSON.stringify({ file_path: "src/a.ts" }) },
    { type: "function_call_output", call_id: "read-1", output: readOutput },
    { type: "function_call", name: "Edit", call_id: "edit-1", arguments: JSON.stringify({ file_path: "src/a.ts" }) },
    { type: "function_call_output", call_id: "edit-1", output: "ok" },
  ];

  const withoutStore = applyReadLifecycle(items, DEFAULT_READ_LIFECYCLE_CONFIG);
  const markerWithoutStore = String(withoutStore.items.find((item) => item.type === "function_call_output" && item.call_id === "read-1")?.output ?? "");
  assert.doesNotMatch(markerWithoutStore, /headroom-retrieve unknown/);

  const first = applyReadLifecycle(items, DEFAULT_READ_LIFECYCLE_CONFIG, store);
  const marker = String(first.items.find((item) => item.type === "function_call_output" && item.call_id === "read-1")?.output ?? "");
  const hashMatch = marker.match(/preview \/headroom-retrieve ([0-9a-f]{24})/);
  assert.ok(hashMatch);
  const hash = hashMatch[1];
  assert.equal(store.retrieve(hash)?.original, readOutput);

  const createdAt = store.retrieve(hash)?.createdAt;
  applyReadLifecycle(items, DEFAULT_READ_LIFECYCLE_CONFIG, store);
  assert.equal(store.retrieve(hash)?.createdAt, createdAt);
} finally {
  rmSync(directory, { recursive: true, force: true });
}

console.log("Read lifecycle store marker test passed");
