import { test } from "node:test";
import assert from "node:assert/strict";
import { toReplExpression } from "../../src/repl.js";

const run = async (code) => (0, eval)(toReplExpression(code));

test("returns the last expression", async () => {
  assert.equal(await run("1 + 1"), 2);
  assert.equal(await run("const a = 20; a * 2 + 2"), 42);
  assert.equal(await run("let x = 1;\nx += 2;\nx // trailing comment"), 3);
});

test("supports top-level await", async () => {
  assert.equal(await run("await Promise.resolve(7)"), 7);
  assert.equal(await run("const v = await new Promise(r => setTimeout(() => r('ok'), 5)); v + '!'"), "ok!");
});

test("statements without a trailing expression return undefined", async () => {
  assert.equal(await run("const a = 1;"), undefined);
  assert.equal(await run("if (true) { 5 }"), undefined);
});

test("explicit return still works", async () => {
  assert.equal(await run("return 9"), 9);
});

test("syntax errors are reported as SyntaxError", () => {
  assert.throws(() => toReplExpression("let = = 1"), SyntaxError);
});
