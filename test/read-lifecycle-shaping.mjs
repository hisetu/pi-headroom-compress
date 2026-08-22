#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyLifecycleAndOutputShaping } from "../index.ts";
import { CCRStore } from "../src/ccr-store.ts";

const readOutput = "x".repeat(600);
const payload = {
  input: [
    { role: "developer", content: "Base system prompt" },
    { type: "function_call", name: "Read", call_id: "read-1", arguments: JSON.stringify({ file_path: "src/a.ts" }) },
    { type: "function_call_output", call_id: "read-1", output: readOutput },
    { type: "function_call", name: "Edit", call_id: "edit-1", arguments: JSON.stringify({ file_path: "src/a.ts" }) },
    { type: "function_call_output", call_id: "edit-1", output: "ok" },
  ],
};

const directory = mkdtempSync(join(tmpdir(), "pi-headroom-read-shape-"));
const databasePath = join(directory, "ccr.db");

try {
  const store = new CCRStore(30_000, databasePath);
  const result = applyLifecycleAndOutputShaping(payload, undefined, undefined, store);
  const readItem = result.items.find((item) => item.type === "function_call_output" && item.call_id === "read-1");
  assert.match(String(readItem?.output ?? ""), /\[Read content stale: src\/a\.ts was modified after this read/);
  assert.match(String(readItem?.output ?? ""), /preview \/headroom-retrieve [0-9a-f]{24}/);
  assert.match(String(result.items.find((item) => item.role === "developer")?.content ?? ""), /<headroom_output_shaping>/);
} finally {
  rmSync(directory, { recursive: true, force: true });
}

console.log("Read lifecycle + output shaping test passed");
