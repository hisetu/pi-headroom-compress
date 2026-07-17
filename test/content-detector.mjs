#!/usr/bin/env node
import assert from "node:assert/strict";
import { compressContent, detectContentType } from "../index.ts";

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

console.log("Content detector test passed");
