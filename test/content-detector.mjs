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

const twoLineSearch = [
  "src/first.ts:12: firstMatch()",
  "src/second.ts:34: secondMatch()",
].join("\n");
assert.equal(detectContentType(twoLineSearch).type, "search");

assert.notEqual(detectContentType("src/only.ts:12: oneMatch()").type, "search");

const datetimeWrapper = [
  "<current_datetime>09:57:59</current_datetime>",
  "Keep this user instruction intact.",
].join("\n");
assert.notEqual(detectContentType(datetimeWrapper).type, "search");

const keyValueLog = [
  "request_id=value:12: processing",
  "status=ready:34: continuing",
].join("\n");
assert.notEqual(detectContentType(keyValueLog).type, "search");

const syslog = Array.from({ length: 30 }, (_, index) =>
  `Aug 16 11:${String(index).padStart(2, "0")}:22 web-01 systemd[3397]: Starting worker ${index}`
).join("\n");
assert.notEqual(detectContentType(syslog).type, "search");

const slashDateLog = Array.from({ length: 30 }, (_, index) =>
  `09/21/2026 14:${String(index).padStart(2, "0")}:10 [INFO] worker ${index}`
).join("\n");
assert.notEqual(detectContentType(slashDateLog).type, "search");

const grepContext = Array.from({ length: 30 }, (_, index) => {
  const separator = index % 3 === 1 ? ":" : "-";
  return `src/context-file.ts${separator}${index + 1}${separator}const value${index} = ${index};`;
}).join("\n");
assert.equal(detectContentType(grepContext).type, "search");
const compressedGrepContext = compressContent(grepContext, "value");
assert.equal(compressedGrepContext.wasModified, true);
assert.equal(compressedGrepContext.strategy, "search_compressor");
assert.match(compressedGrepContext.compressed, /src\/context-file\.ts-\d+-/);

const dashContextWithBodyReferences = Array.from({ length: 30 }, (_, index) =>
  `app/settings.py-${476 + index}-a:7:b:8:c`
).join("\n");
const compressedDashContext = compressContent(dashContextWithBodyReferences);
assert.equal(compressedDashContext.strategy, "search_compressor");
assert.match(compressedDashContext.compressed, /1 files total/);
assert.doesNotMatch(compressedDashContext.compressed, /30 files total/);

assert.notEqual(detectContentType("2026-09-14-release-notes-here").type, "search");
assert.notEqual(detectContentType("version-2-release").type, "search");

const fixedWidth = [
  `${"NAME".padEnd(18)}${"READY".padEnd(10)}${"STATUS".padEnd(14)}AGE`,
  `${"api-7d9f".padEnd(18)}${"1/1".padEnd(10)}${"Running".padEnd(14)}2d`,
  `${"worker-a2c".padEnd(18)}${"1/1".padEnd(10)}${"Running".padEnd(14)}5h`,
  `${"db-0".padEnd(18)}${"1/1".padEnd(10)}${"Running".padEnd(14)}9d`,
].join("\n");
assert.equal(detectContentType(fixedWidth).type, "tabular");
assert.equal(detectContentType(fixedWidth).metadata.delimiter, "fixed_width");

const proseWithIndentedParagraphs = Array.from({ length: 8 }, (_, index) =>
  `  Paragraph ${index} explains why aligned prose should remain ordinary text.`
).join("\n");
assert.equal(detectContentType(proseWithIndentedParagraphs).type, "text");

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

const largeHtml = `<!doctype html><html><body>${"<div>important cell</div>".repeat(1000)}</body></html>`;
const largeHtmlResult = compressContent(largeHtml);
assert.equal(largeHtmlResult.wasModified, false);
assert.equal(largeHtmlResult.strategy, "passthrough");

const largeTable = ["id,name,status", ...Array.from({ length: 1200 }, (_, index) => `${index},item-${index},ok`)].join("\n");
const largeTableResult = compressContent(largeTable);
assert.equal(largeTableResult.wasModified, false);
assert.equal(largeTableResult.strategy, "passthrough");

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

const pytestLog = [
  ...Array.from({ length: 80 }, (_, index) => `[12:00:${String(index % 60).padStart(2, "0")}] INFO setup line ${index}`),
  "=========================== short test summary info ============================",
  ...Array.from({ length: 12 }, (_, index) => `FAILED tests/test_feature.py::test_case_${index} - AssertionError: marker-${index}`),
  "======================== 12 failed, 80 passed in 1.00s =========================",
].join("\n");
const compressedPytestLog = compressContent(pytestLog).compressed;
assert.match(compressedPytestLog, /test_case_0/);
assert.match(compressedPytestLog, /test_case_11/);

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
