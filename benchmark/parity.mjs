#!/usr/bin/env node
/** Golden fixture parity report. Differences are reported, not hidden. */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parityFixtures } from "./parity-fixtures.mjs";

const directory = dirname(fileURLToPath(import.meta.url));
const python = join(homedir(), ".local/share/uv/tools/headroom-ai/bin/python");
const temporary = mkdtempSync(join(tmpdir(), "pi-headroom-parity-"));
const fixturePath = join(temporary, "fixture.json");

function run(command, args) {
  try {
    return JSON.parse(execFileSync(command, args, {
      cwd: directory,
      encoding: "utf8",
      timeout: 60_000,
      maxBuffer: 10 * 1024 * 1024,
    }));
  } catch (error) {
    return { error: String(error.message ?? error).slice(0, 300) };
  }
}

function normalizedStrategy(strategy = "") {
  if (/lossless|smart|tabular_compaction|row_drop/.test(strategy)) return "smart-crusher";
  if (/^code|ast_compressor|code_compressor/.test(strategy)) return "code";
  if (/log/.test(strategy)) return "log";
  if (/diff/.test(strategy)) return "diff";
  if (/search/.test(strategy)) return "search";
  if (/html/.test(strategy)) return "html";
  if (/tabular/.test(strategy)) return "tabular";
  if (/kompress/.test(strategy)) return "kompress";
  return "passthrough";
}

function retained(result, markers) {
  if (typeof result.compressedContent !== "string") return { count: 0, missing: markers };
  const missing = markers.filter(marker => !result.compressedContent.includes(marker));
  return { count: markers.length - missing.length, missing };
}

function savings(result) {
  if (!result.originalChars || result.error) return null;
  return (1 - result.compressedChars / result.originalChars) * 100;
}

const results = [];
try {
  for (const fixture of parityFixtures) {
    writeFileSync(fixturePath, JSON.stringify(fixture));
    const headroom = run(python, [join(directory, "run-headroom-parity.py"), fixturePath]);
    const ours = run(process.execPath, [
      "--no-warnings",
      "--experimental-strip-types",
      join(directory, "run-ours-parity.mjs"),
      fixturePath,
    ]);
    const headroomQuality = retained(headroom, fixture.required);
    const oursQuality = retained(ours, fixture.required);
    const oursStrategy = normalizedStrategy(ours.strategy);
    results.push({
      name: fixture.name,
      required: fixture.required,
      expectedOurs: fixture.expectedOurs,
      headroom,
      ours,
      comparison: {
        detectionMatch: headroom.detection?.type === ours.detection?.type,
        strategyMatch: normalizedStrategy(headroom.strategy) === normalizedStrategy(ours.strategy),
        outputIdentical: headroom.compressedContent === ours.compressedContent,
        headroomSavingsPercent: savings(headroom),
        oursSavingsPercent: savings(ours),
        headroomQuality,
        oursQuality,
        oursDetectionExpected: ours.detection?.type === fixture.expectedOurs.detection,
        oursStrategyExpected: oursStrategy === fixture.expectedOurs.strategy,
      },
    });
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}

const percent = value => value === null ? "ERR" : `${value.toFixed(1)}%`;

console.log("\nHeadroom ↔ pi-headroom-compress golden parity report\n");
console.log("Fixture                 Detection H/O       Strategy H/O              Save H/O       Markers H/O");
console.log("────────────────────────────────────────────────────────────────────────────────────────────────");
for (const result of results) {
  const hType = result.headroom.detection?.type ?? "ERR";
  const oType = result.ours.detection?.type ?? "ERR";
  const hStrategy = normalizedStrategy(result.headroom.strategy);
  const oStrategy = normalizedStrategy(result.ours.strategy);
  const hQuality = `${result.comparison.headroomQuality.count}/${result.required.length}`;
  const oQuality = `${result.comparison.oursQuality.count}/${result.required.length}`;
  console.log(
    `${result.name.padEnd(23)} ${`${hType}/${oType}`.padEnd(19)} ` +
    `${`${hStrategy}/${oStrategy}`.padEnd(25)} ` +
    `${`${percent(result.comparison.headroomSavingsPercent)}/${percent(result.comparison.oursSavingsPercent)}`.padEnd(14)} ` +
    `${hQuality}/${oQuality}`
  );
}

const detectionMatches = results.filter(result => result.comparison.detectionMatch).length;
const strategyMatches = results.filter(result => result.comparison.strategyMatch).length;
const identicalOutputs = results.filter(result => result.comparison.outputIdentical).length;
const headroomMarkerFailures = results.filter(result => result.comparison.headroomQuality.missing.length);
const oursMarkerFailures = results.filter(result => result.comparison.oursQuality.missing.length);
const runnerErrors = results.filter(result => result.headroom.error || result.ours.error);
const regressions = results.filter(result =>
  !result.comparison.oursDetectionExpected ||
  !result.comparison.oursStrategyExpected ||
  result.comparison.oursQuality.missing.length > 0
);

console.log("────────────────────────────────────────────────────────────────────────────────────────────────");
console.log(`Detection parity: ${detectionMatches}/${results.length}`);
console.log(`Strategy-family parity: ${strategyMatches}/${results.length}`);
console.log(`Byte-identical output: ${identicalOutputs}/${results.length}`);
console.log(`Critical-marker failures: Headroom ${headroomMarkerFailures.length}, Ours ${oursMarkerFailures.length}`);
console.log(`Pi regression gate: ${regressions.length === 0 ? "PASS" : `FAIL (${regressions.length})`}`);

for (const result of results) {
  const notes = [];
  if (!result.comparison.detectionMatch) notes.push(`detection ${result.headroom.detection?.type} != ${result.ours.detection?.type}`);
  if (!result.comparison.strategyMatch) notes.push(`strategy ${normalizedStrategy(result.headroom.strategy)} != ${normalizedStrategy(result.ours.strategy)}`);
  if (result.comparison.headroomQuality.missing.length) notes.push(`Headroom missing [${result.comparison.headroomQuality.missing.join(", ")}]`);
  if (result.comparison.oursQuality.missing.length) notes.push(`Ours missing [${result.comparison.oursQuality.missing.join(", ")}]`);
  if (!result.comparison.oursDetectionExpected) notes.push(`Ours detection regression: expected ${result.expectedOurs.detection}`);
  if (!result.comparison.oursStrategyExpected) notes.push(`Ours strategy regression: expected ${result.expectedOurs.strategy}`);
  if (result.headroom.error) notes.push(`Headroom error: ${result.headroom.error}`);
  if (result.ours.error) notes.push(`Ours error: ${result.ours.error}`);
  if (notes.length) console.log(`- ${result.name}: ${notes.join("; ")}`);
}

const jsonIndex = process.argv.indexOf("--json");
if (jsonIndex >= 0 && process.argv[jsonIndex + 1]) {
  writeFileSync(process.argv[jsonIndex + 1], JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2));
}

if (runnerErrors.length || regressions.length) process.exitCode = 1;
