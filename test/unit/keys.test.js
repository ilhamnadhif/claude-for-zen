import { test } from "node:test";
import assert from "node:assert/strict";
import { KEY, keyValue, parseKeySequence, parseModifiers, keyActionsForSequence, keyActionsForText, KeyError } from "../../src/keys.js";

test("named keys and aliases", () => {
  assert.equal(keyValue("Enter"), KEY.Enter);
  assert.equal(keyValue("Return"), KEY.Enter);
  assert.equal(keyValue("KP_Enter"), KEY.Enter);
  assert.equal(keyValue("Page_Down"), KEY.PageDown);
  assert.equal(keyValue("pagedown"), KEY.PageDown);
  assert.equal(keyValue("ArrowLeft"), KEY.ArrowLeft);
  assert.equal(keyValue("esc"), KEY.Escape);
  assert.equal(keyValue("F5"), "");
  assert.equal(keyValue("F12"), "");
  assert.equal(keyValue("Shift_L"), KEY.Shift);
  assert.equal(keyValue("super_r"), KEY.Meta);
  assert.equal(keyValue("control"), KEY.Control);
  assert.equal(keyValue("space"), " ");
  assert.equal(keyValue("a"), "a");
  assert.equal(keyValue("é"), "é");
});

test("unknown keys raise a user-facing error", () => {
  assert.throws(() => keyValue("nonsense"), (e) => e instanceof KeyError && e.userFacing === true && /Unknown key "nonsense"/.test(e.message));
});

test("parseKeySequence handles combos, plus key and sequences", () => {
  assert.deepEqual(parseKeySequence("ctrl+a Backspace"), [
    { modifiers: [KEY.Control], key: "a" },
    { modifiers: [], key: KEY.Backspace },
  ]);
  assert.deepEqual(parseKeySequence("cmd+shift+t"), [{ modifiers: [KEY.Meta, KEY.Shift], key: "t" }]);
  assert.deepEqual(parseKeySequence("ctrl++"), [{ modifiers: [KEY.Control], key: "+" }]);
  assert.deepEqual(parseKeySequence("+"), [{ modifiers: [], key: "+" }]);
  assert.throws(() => parseKeySequence("a+b"), /only shift\/ctrl\/alt\/cmd/);
  assert.throws(() => parseKeySequence("   "), /No keys/);
});

test("parseModifiers", () => {
  assert.deepEqual(parseModifiers("ctrl+shift"), [KEY.Control, KEY.Shift]);
  assert.deepEqual(parseModifiers("cmd"), [KEY.Meta]);
  assert.deepEqual(parseModifiers(""), []);
  assert.throws(() => parseModifiers("a"), /not a modifier/);
});

test("key actions press and release in order", () => {
  const acts = keyActionsForSequence(parseKeySequence("ctrl+a"), 2);
  assert.deepEqual(acts.slice(0, 4), [
    { type: "keyDown", value: KEY.Control },
    { type: "keyDown", value: "a" },
    { type: "keyUp", value: "a" },
    { type: "keyUp", value: KEY.Control },
  ]);
  assert.equal(acts.length, 8);
});

test("typing text maps newlines/tabs and keeps astral characters whole", () => {
  const acts = keyActionsForText("a\r\nb\t👋");
  const downs = acts.filter((a) => a.type === "keyDown").map((a) => a.value);
  assert.deepEqual(downs, ["a", KEY.Enter, "b", KEY.Tab, "👋"]);
});
