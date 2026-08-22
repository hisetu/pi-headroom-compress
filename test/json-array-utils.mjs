#!/usr/bin/env node
import assert from "node:assert/strict";
import { decodeConcatenatedJson, normalizeConcatenatedJson, tryParseJsonArray } from "../src/json-array-utils.ts";

const single = '{"id": 1}';
assert.equal(decodeConcatenatedJson(single)?.length, 1);
assert.equal(normalizeConcatenatedJson(single), null);
assert.equal(tryParseJsonArray(single), null);

const concatenated = '{"title":"A","url":"https://a.example"} {"title":"B","url":"https://b.example"}';
const parsed = tryParseJsonArray(concatenated);
assert.equal(parsed?.items.length, 2);
assert.equal(parsed?.isDictArray, true);
assert.equal(parsed?.concatenated, true);

const normalized = normalizeConcatenatedJson(concatenated);
assert.ok(normalized);
assert.equal(JSON.parse(normalized).length, 2);

assert.equal(decodeConcatenatedJson('{"a":1} {"b":2} [3,4]'), null);
assert.equal(decodeConcatenatedJson(`{"a":1} ${"9".repeat(5000)}`), null);
assert.equal(tryParseJsonArray(`{"a":1} "tail"`), null);

console.log("JSON array utils test passed");
