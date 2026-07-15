#!/usr/bin/env node
/**
 * End-to-end benchmark using the real TypeScript compressor and installed
 * Python Headroom transforms.
 *
 * Usage: node benchmark/compare.mjs
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const benchmarkDir = dirname(fileURLToPath(import.meta.url));
const python = join(homedir(), ".local/share/uv/tools/headroom-ai/bin/python");
const workDir = mkdtempSync(join(tmpdir(), "pi-headroom-bench-"));
const inputPath = join(workDir, "input.json");

const samples = [
  {
    name: "JSON array (50 items)",
    type: "json_array",
    content: JSON.stringify(Array.from({ length: 50 }, (_, i) => ({
      file: `/src/m${i}.ts`,
      line: i * 10,
      content: `export function h${i}() { return ${i}; }`,
      score: ((i * 37) % 1000 / 1000).toFixed(3),
    })), null, 2),
    required: ["/src/m0.ts", "h0", "/src/m49.ts", "h49"],
  },
  {
    name: "Python source (~80 lines)",
    type: "source_code",
    content: Array.from({ length: 80 }, (_, i) => i % 20 === 0
      ? `\nclass Svc${Math.floor(i / 20)}:\n    pass\n`
      : i % 5 === 0
        ? `    def method_${i}(self, data):\n        result = []\n        for k,v in data.items():\n            result.append(f"{k}={v}")\n        return result\n`
        : `    # step ${i}\n    x = data.get("f${i}")\n`).join(""),
    required: ["class Svc0", "def method_5", "class Svc3", "def method_75"],
  },
  {
    name: "Build log (100 lines)",
    type: "build",
    content: Array.from({ length: 100 }, (_, i) => {
      if (i === 23) return "ERROR: Module not found: ./missing";
      if (i === 24) return "  at resolve (/node_modules/webpack/lib/Resolver.js:331)";
      if (i === 50) return "WARNING: Circular dep in utils.ts";
      if (i === 75) return "ERROR: Type mismatch at line 42";
      if (i === 99) return "Build failed with 2 errors and 1 warning";
      return `[${String(i).padStart(3, "0")}] INFO: Compiling module ${i}... (${(i * 47) % 500}ms)`;
    }).join("\n"),
    required: ["Module not found", "Resolver.js:331", "Circular dep", "Type mismatch", "Build failed"],
  },
  {
    name: "Git diff (5 files)",
    type: "diff",
    content: Array.from({ length: 5 }, (_, file) =>
      `diff --git a/src/f${file}.ts b/src/f${file}.ts\nindex abc..def 100644\n--- a/src/f${file}.ts\n+++ b/src/f${file}.ts\n` +
      Array.from({ length: 6 }, (_, hunk) =>
        `@@ -${hunk * 20},5 +${hunk * 20},7 @@\n ctx\n ctx\n-old line\n+new line\n+added\n ctx\n ctx\n ctx\n ctx\n ctx\n`).join("")
    ).join(""),
    required: ["a/src/f0.ts", "b/src/f4.ts", "-old line", "+new line", "+added"],
  },
  {
    name: "Search results (80 lines)",
    type: "search",
    content: Array.from({ length: 80 }, (_, i) =>
      `src/mod${i % 10}.ts:${i * 3 + 1}:  const r = await handler(req);`).join("\n"),
    // Search compressors intentionally cap result groups; validate query-relevant
    // structure rather than requiring every source file to survive.
    required: ["src/mod0.ts", "handler(req)"],
  },
  {
    name: "Plain text (3KB)",
    type: "text",
    content: Array.from({ length: 30 }, (_, i) =>
      `Section ${i}: Detailed explanation of feature ${i}. Uses caching, lazy eval, memoization for performance. Requires config via settings panel.`).join("\n\n"),
    required: ["Section 0", "caching", "Section 29", "settings panel"],
  },
];

function invoke(command, args) {
  try {
    return JSON.parse(execFileSync(command, args, {
      cwd: benchmarkDir,
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 10 * 1024 * 1024,
    }));
  } catch (error) {
    return { error: String(error.message ?? error).slice(0, 300) };
  }
}

function quality(result, required) {
  if (result.error || typeof result.compressedContent !== "string") return null;
  const retained = required.filter(marker => result.compressedContent.includes(marker));
  return {
    retained: retained.length,
    total: required.length,
    percent: retained.length / required.length * 100,
    missing: required.filter(marker => !retained.includes(marker)),
  };
}

function savedPercent(result) {
  return result.error ? null : (1 - result.compressed / result.original) * 100;
}

const rows = [];
try {
  for (const sample of samples) {
    writeFileSync(inputPath, JSON.stringify(sample));
    const headroom = invoke(python, [join(benchmarkDir, "run-headroom.py"), inputPath]);
    const ours = invoke(process.execPath, ["--experimental-strip-types", join(benchmarkDir, "run-ours.mjs"), inputPath]);
    rows.push({
      ...sample,
      headroom,
      ours,
      headroomQuality: quality(headroom, sample.required),
      oursQuality: quality(ours, sample.required),
    });
  }
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

const pct = value => value === null ? "ERR" : `${value.toFixed(1)}%`;
const q = value => value === null ? "ERR" : `${value.retained}/${value.total}`;

console.log("\npi-headroom-compress vs Headroom — real implementation benchmark\n");
console.log("Sample                         Headroom   Ours       Gap       Quality H/O");
console.log("─────────────────────────────────────────────────────────────────────────");
for (const row of rows) {
  const headroomSaved = savedPercent(row.headroom);
  const oursSaved = savedPercent(row.ours);
  const gap = headroomSaved === null || oursSaved === null ? null : oursSaved - headroomSaved;
  console.log(
    `${row.name.padEnd(30)} ${pct(headroomSaved).padStart(8)}   ${pct(oursSaved).padStart(8)}   ` +
    `${pct(gap).padStart(8)}   ${`${q(row.headroomQuality)}/${q(row.oursQuality)}`.padStart(11)}`
  );
}

const valid = rows.filter(row => !row.headroom.error && !row.ours.error);
const totalOriginal = valid.reduce((sum, row) => sum + row.content.length, 0);
const headroomCompressed = valid.reduce((sum, row) => sum + row.headroom.compressed, 0);
const oursCompressed = valid.reduce((sum, row) => sum + row.ours.compressed, 0);
const headroomWeighted = (1 - headroomCompressed / totalOriginal) * 100;
const oursWeighted = (1 - oursCompressed / totalOriginal) * 100;

console.log("─────────────────────────────────────────────────────────────────────────");
console.log(`Weighted by characters: Headroom ${pct(headroomWeighted)}, Ours ${pct(oursWeighted)}, Gap ${pct(oursWeighted - headroomWeighted)}`);

console.log("\nStrategies and missing required markers:");
for (const row of rows) {
  console.log(`- ${row.name}: H=${row.headroom.strategy ?? "ERROR"}; O=${row.ours.strategy ?? "ERROR"}`);
  if (row.headroomQuality?.missing.length) console.log(`  Headroom missing: ${row.headroomQuality.missing.join(", ")}`);
  if (row.oursQuality?.missing.length) console.log(`  Ours missing: ${row.oursQuality.missing.join(", ")}`);
  if (row.headroom.error) console.log(`  Headroom error: ${row.headroom.error}`);
  if (row.ours.error) console.log(`  Ours error: ${row.ours.error}`);
}

const qualityFailures = rows.filter(row =>
  row.headroomQuality === null || row.oursQuality === null ||
  row.headroomQuality.percent < 100 || row.oursQuality.percent < 100
);
if (qualityFailures.length) {
  console.error(`\nQuality gate failed for ${qualityFailures.length} sample(s).`);
  process.exitCode = 1;
} else {
  console.log("\nQuality gate passed: all required markers were retained by both implementations.");
}
