#!/usr/bin/env node
import assert from "node:assert/strict";
import { compressContent, detectContentType } from "../index.ts";
import { tryParseJsonArray } from "../src/json-array-utils.ts";
import { computeSignature } from "../src/toin.ts";

const html = "<!doctype html><html><head></head><body><main>content</main><nav>menu</nav><script>noise</script></body></html>";
assert.equal(detectContentType(html).type, "html");

const csv = ["id,name,status", "1,alpha,ok", "2,beta,error", "3,gamma,ok"].join("\n");
assert.equal(detectContentType(csv).type, "tabular");

const prose = Array.from({ length: 20 }, (_, index) =>
  `Section ${index}. This documentation covers architecture, deployment, monitoring, and recovery.`
).join("\n");
assert.equal(detectContentType(prose).type, "text");

const clockLog = Array.from({ length: 30 }, (_, index) =>
  `[12:00:${String(index).padStart(2, "0")}] INFO compiling module-${index}`
).join("\n");
assert.equal(detectContentType(clockLog).type, "build");

const search = Array.from({ length: 30 }, (_, index) =>
  `src/module-${index % 3}.ts:${index + 1}: handleRequest(input)`
).join("\n");
assert.equal(detectContentType(search).type, "search");

const longPreambleDiff = [
  ...Array.from({ length: 300 }, (_, index) => `commit message line ${index}`),
  "diff --git a/file.ts b/file.ts",
  "--- a/file.ts",
  "+++ b/file.ts",
  "@@ -1,1 +1,1 @@",
  "-old",
  "+new",
].join("\n");
assert.equal(detectContentType(longPreambleDiff).type, "diff");

const java = `public class Service {
  private final String name;
  public Service(String name) {
    this.name = name;
  }
  public String getName() {
    return name;
  }
}`;
assert.equal(detectContentType(java).metadata.language, "java");

const cSource = `#include <stdio.h>
#define LIMIT 10
struct Item { int value; };
int process(int value) {
  return value * LIMIT;
}`;
assert.equal(detectContentType(cSource).metadata.language, "c");

const searchWithLateError = Array.from({ length: 60 }, (_, index) =>
  `src/module-${index % 8}.ts:${index + 1}: ${index === 31 ? "ERROR CRITICAL_MARKER" : "handleRequest(input)"}`
).join("\n");
assert.match(compressContent(searchWithLateError).compressed, /CRITICAL_MARKER/);

const concatenatedJson = Array.from({ length: 6 }, (_, index) =>
  JSON.stringify({ title: `Result ${index}`, url: `https://example/${index}` })
).join(" ");
assert.equal(detectContentType(concatenatedJson).type, "json_array");
assert.equal(detectContentType(concatenatedJson).metadata.concatenated, true);

const invalidJsonArray = "[{\"id\": 1, \"broken\": ";
assert.notEqual(detectContentType(invalidJsonArray).type, "json_array");

const orphanedDiffTarget = "+++ b/orphan.ts\nadded line without source header\n";
assert.notEqual(detectContentType(orphanedDiffTarget).type, "diff");

const pythonWithLiterals = `def build_payload():
    return {
        "items": [1, 2, 3],
        "meta": {"ok": True},
    }

class Worker:
    def run(self):
        return build_payload()
`;
assert.equal(detectContentType(pythonWithLiterals).type, "source_code");

const largeConcatenated = Array.from({ length: 20 }, (_, index) =>
  JSON.stringify({
    id: index,
    marker: index === 0 ? "FIRST_MARKER" : index === 19 ? "LAST_MARKER" : `payload-${index}`,
    blob: "x".repeat(30),
  })
).join(" ");
assert.ok(largeConcatenated.length > 500);
assert.equal(detectContentType(largeConcatenated).type, "json_array");
const concatenatedCompressed = compressContent(largeConcatenated);
assert.equal(concatenatedCompressed.wasModified, true);
assert.match(concatenatedCompressed.strategy, /row_drop|dedup|tabular|smart/);
assert.match(concatenatedCompressed.compressed, /FIRST_MARKER/);
assert.match(concatenatedCompressed.compressed, /LAST_MARKER/);

const concatenatedParsed = tryParseJsonArray(largeConcatenated);
assert.ok(concatenatedParsed);
assert.notEqual(computeSignature(concatenatedParsed.items).structureHash, "text");

console.log("Content detector test passed");
