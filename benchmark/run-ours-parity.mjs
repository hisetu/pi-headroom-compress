#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { compressContent, detectContentType } from "../index.ts";

const fixture = JSON.parse(readFileSync(process.argv[2], "utf8"));
const detection = detectContentType(fixture.content);
const result = compressContent(fixture.content, fixture.query ?? "");

process.stdout.write(JSON.stringify({
  detection,
  strategy: result.strategy,
  originalChars: fixture.content.length,
  compressedChars: result.compressed.length,
  compressedContent: result.compressed,
  error: null,
}));
