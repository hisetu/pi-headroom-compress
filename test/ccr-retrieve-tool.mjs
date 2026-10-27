#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compressContent, isProtectedToolOutput } from "../index.ts";
import { CCRStore, formatCCRMarker } from "../src/ccr-store.ts";
import {
  DEFAULT_CCR_RETRIEVE_LIMIT,
  MAX_CCR_RETRIEVE_LIMIT,
  formatCCRRetrievedContent,
  isCCRRetrievedContent,
  registerHeadroomRetrieveTool,
  retrieveCCRSegment,
} from "../src/ccr-retrieve.ts";

const directory = mkdtempSync(join(tmpdir(), "pi-headroom-retrieve-tool-"));
const databasePath = join(directory, "ccr.db");

try {
  const store = new CCRStore(30_000, databasePath);
  const original = Array.from({ length: 2_000 }, (_, index) => `line-${index}:${"x".repeat(8)}`).join("\n");
  const hash = store.store(original, "compressed", "read", "smart_crusher");

  assert.equal(formatCCRMarker(hash, 2), `⟨ccr:${hash} 2 items stored — use headroom_retrieve to access⟩`);

  const invalidHash = retrieveCCRSegment(store, { hash: "not-a-hash" });
  assert.equal(invalidHash.ok, false);
  assert.equal(invalidHash.code, "invalid_hash");

  const invalidRange = retrieveCCRSegment(store, { hash, offset: -1 });
  assert.equal(invalidRange.ok, false);
  assert.equal(invalidRange.code, "invalid_range");

  const first = retrieveCCRSegment(store, { hash });
  assert.equal(first.ok, true);
  assert.equal(first.offset, 0);
  assert.equal(first.returnedChars, DEFAULT_CCR_RETRIEVE_LIMIT);
  assert.equal(first.hasMore, true);
  assert.equal(first.nextOffset, DEFAULT_CCR_RETRIEVE_LIMIT);
  assert.equal(first.toolName, "read");
  assert.equal(first.strategy, "smart_crusher");

  const oversized = retrieveCCRSegment(store, { hash, limit: MAX_CCR_RETRIEVE_LIMIT + 5_000 });
  assert.equal(oversized.ok, true);
  assert.equal(oversized.returnedChars, MAX_CCR_RETRIEVE_LIMIT);

  const pages = [];
  let offset = 0;
  for (;;) {
    const page = retrieveCCRSegment(store, { hash, offset, limit: 777 });
    assert.equal(page.ok, true);
    pages.push(page.content);
    if (!page.hasMore) break;
    offset = page.nextOffset;
  }
  assert.equal(pages.join(""), original);

  const pastEnd = retrieveCCRSegment(store, { hash, offset: original.length + 100, limit: 100 });
  assert.equal(pastEnd.ok, true);
  assert.equal(pastEnd.offset, original.length);
  assert.equal(pastEnd.content, "");
  assert.equal(pastEnd.hasMore, false);

  const envelope = formatCCRRetrievedContent(first);
  assert.equal(isCCRRetrievedContent(envelope), true);
  assert.equal(isProtectedToolOutput(envelope), true);
  assert.equal(compressContent(envelope).strategy, "ccr_retrieved_passthrough");
  assert.equal(compressContent(envelope).compressed, envelope);
  assert.equal(isCCRRetrievedContent(envelope.replace(`returned=${first.returnedChars}`, "returned=1")), false);
  assert.equal(isCCRRetrievedContent(envelope.replace(`⟨/ccr-retrieved:${hash}⟩`, `⟨/ccr-retrieved:${"f".repeat(24)}⟩`)), false);
  assert.equal(isCCRRetrievedContent(`documentation mentions ${envelope}`), false);

  const registered = [];
  registerHeadroomRetrieveTool({ registerTool: (tool) => registered.push(tool) }, store);
  assert.equal(registered.length, 1);
  const tool = registered[0];
  assert.equal(tool.name, "headroom_retrieve");
  assert.equal(tool.exposure, "direct");
  assert.deepEqual(tool.annotations, {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  });

  const toolResult = await tool.execute(
    "call-1",
    { hash, offset: 10, limit: 123 },
    new AbortController().signal,
    undefined,
    {},
  );
  assert.equal(toolResult.isError, undefined);
  assert.equal(toolResult.details.offset, 10);
  assert.equal(toolResult.details.returnedChars, 123);
  assert.equal(isCCRRetrievedContent(toolResult.content[0].text), true);

  const unavailable = await tool.execute(
    "call-2",
    { hash: "f".repeat(24) },
    new AbortController().signal,
    undefined,
    {},
  );
  assert.equal(unavailable.isError, true);
  assert.equal(unavailable.details.code, "unavailable");
} finally {
  rmSync(directory, { recursive: true, force: true });
}

console.log("CCR model retrieval tool test passed");
