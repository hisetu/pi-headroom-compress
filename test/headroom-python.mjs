#!/usr/bin/env node
import assert from "node:assert/strict";
import { resolveHeadroomPython } from "../benchmark/headroom-python.mjs";

assert.equal(
  resolveHeadroomPython({ env: { HEADROOM_PYTHON: "/custom/python" } }),
  "/custom/python",
);

assert.equal(
  resolveHeadroomPython({
    env: { UV_TOOL_DIR: "/opt/uv-tools" },
    platform: "linux",
    home: "/home/test",
  }),
  "/opt/uv-tools/headroom-ai/bin/python",
);

assert.equal(
  resolveHeadroomPython({
    env: { UV_TOOL_DIR: "C:\\uv-tools" },
    platform: "win32",
    home: "C:\\Users\\test",
  }),
  "C:\\uv-tools\\headroom-ai\\Scripts\\python.exe",
);

console.log("Headroom python resolver test passed");
