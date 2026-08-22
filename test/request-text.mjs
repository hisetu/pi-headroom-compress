#!/usr/bin/env node
import assert from "node:assert/strict";
import { getItemText, setItemText } from "../src/request-text.ts";

const item = {
  type: "function_call_output",
  content: [
    { type: "output_text", text: "first block" },
    { type: "output_text", text: "second block" },
    { type: "tool_result_image", text: "image bytes" },
  ],
};

const updated = setItemText(item, "replacement");
assert.equal(getItemText(updated), "replacement");
assert.deepEqual(updated.content, [
  { type: "output_text", text: "replacement" },
  { type: "tool_result_image", text: "image bytes" },
]);

const textBlocks = {
  type: "message",
  content: [
    { type: "text", text: "first" },
    { type: "text", text: "second" },
    { type: "image", source: "image-data" },
  ],
};
assert.deepEqual(setItemText(textBlocks, "combined").content, [
  { type: "text", text: "combined" },
  { type: "image", source: "image-data" },
]);

const imageOnly = { type: "message", content: [{ type: "image", source: "image-data" }] };
assert.equal(setItemText(imageOnly, "ignored"), imageOnly);

console.log("Request text helper test passed");
