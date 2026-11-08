import { test } from "node:test";
import assert from "node:assert/strict";
import { formatRemoteValue, remoteToJs, formatException } from "../../src/remote-value.js";

test("primitives", () => {
  assert.equal(formatRemoteValue({ type: "string", value: "hi" }), "hi");
  assert.equal(formatRemoteValue({ type: "number", value: 42 }), "42");
  assert.equal(formatRemoteValue({ type: "number", value: "NaN" }), "NaN");
  assert.equal(formatRemoteValue({ type: "boolean", value: false }), "false");
  assert.equal(formatRemoteValue({ type: "undefined" }), "undefined");
  assert.equal(formatRemoteValue({ type: "null" }), "null");
  assert.equal(formatRemoteValue({ type: "bigint", value: "10" }), "10n");
});

test("objects, arrays and maps", () => {
  const v = {
    type: "object",
    value: [
      ["a", { type: "number", value: 1 }],
      ["list", { type: "array", value: [{ type: "string", value: "x" }, { type: "null" }] }],
      ["m", { type: "map", value: [[{ type: "string", value: "k" }, { type: "boolean", value: true }]] }],
    ],
  };
  assert.deepEqual(remoteToJs(v), { a: 1, list: ["x", null], m: { k: true } });
  assert.equal(formatRemoteValue({ type: "object" }), "[Object]");
});

test("nodes and special values", () => {
  assert.equal(
    formatRemoteValue({ type: "node", value: { nodeType: 1, localName: "button", attributes: { id: "go", class: "primary" } } }),
    '<button id="go" class="primary">',
  );
  assert.equal(formatRemoteValue({ type: "window" }), "[Window]");
  assert.equal(formatRemoteValue({ type: "function" }), "[Function]");
  assert.equal(formatRemoteValue({ type: "regexp", value: { pattern: "a+", flags: "g" } }), "/a+/g");
  assert.equal(formatRemoteValue({ type: "date", value: "2026-01-01T00:00:00.000Z" }), "2026-01-01T00:00:00.000Z");
});

test("exceptions include page stack frames", () => {
  const msg = formatException({
    text: "Error: kaboom",
    stackTrace: { callFrames: [{ functionName: "f", url: "https://x.test/app.js", lineNumber: 9, columnNumber: 4 }] },
  });
  assert.match(msg, /Error: kaboom/);
  assert.match(msg, /at f \(https:\/\/x\.test\/app\.js:10:5\)/);
});
