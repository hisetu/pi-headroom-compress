#!/usr/bin/env node
import assert from "node:assert/strict";
import { preprocessToolOutput } from "../src/request-text.ts";

const line = JSON.stringify({ id: 1, value: "same" });
const repeated = Array.from({ length: 12 }, () => line).join("\n");
const processed = preprocessToolOutput(repeated);
assert.equal(processed, repeated);

const prose = Array.from({ length: 12 }, (_, index) => `line ${index}`).join("\n");
const deduped = preprocessToolOutput(prose + "\nline 0\nline 0\nline 0\nline 0");
assert.match(deduped, /identical lines omitted/);

console.log("Tool output preprocessing test passed");
