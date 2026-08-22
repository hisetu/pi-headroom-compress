#!/usr/bin/env node
import assert from "node:assert/strict";
import { isValidCCRHash, extractCCRHash } from "../src/ccr-store.ts";

assert.equal(isValidCCRHash("123456789abc"), true);
assert.equal(isValidCCRHash("a".repeat(24)), true);
assert.equal(isValidCCRHash("a".repeat(12)), true);

assert.equal(isValidCCRHash("abc"), false);
assert.equal(isValidCCRHash("a".repeat(11)), false);
assert.equal(isValidCCRHash("a".repeat(13)), false);
assert.equal(isValidCCRHash("a".repeat(23)), false);
assert.equal(isValidCCRHash("a".repeat(25)), false);
assert.equal(isValidCCRHash("G".repeat(12)), false);
assert.equal(isValidCCRHash(""), false);

assert.equal(extractCCRHash(`⟨ccr:${"a".repeat(25)} 1 items stored — use headroom_retrieve to access⟩`), null);
assert.equal(extractCCRHash(`⟨ccr:${"a".repeat(24)} 1 items stored — use headroom_retrieve to access⟩`), "a".repeat(24));
assert.equal(extractCCRHash("⟨ccr:123456789abc legacy⟩"), "123456789abc");

console.log("CCR retrieve hash validation test passed");
