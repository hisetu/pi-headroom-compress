#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { compressContent } from "../index.ts";

const inputPath = process.argv[2];
if (!inputPath) {
  console.error("Usage: node --experimental-strip-types benchmark/run-ours.mjs <input.json>");
  process.exit(2);
}

const { content, query = "" } = JSON.parse(readFileSync(inputPath, "utf8"));
const result = compressContent(content, query);

process.stdout.write(JSON.stringify({
  original: content.length,
  compressed: result.compressed.length,
  compressedContent: result.compressed,
  strategy: result.strategy,
  modified: result.wasModified,
}));
