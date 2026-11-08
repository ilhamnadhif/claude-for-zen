import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { prepareProfile, MANAGED_PREFS, findBinary, binaryCandidates } from "../../src/launcher.js";
import { loadConfig, endpointUrl } from "../../src/config.js";

test("prepareProfile writes the managed block and keeps user prefs", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cfz-unit-"));
  fs.writeFileSync(path.join(dir, "user.js"), 'user_pref("my.own.pref", 1);\n');
  prepareProfile(dir);
  prepareProfile(dir); // idempotent
  const text = fs.readFileSync(path.join(dir, "user.js"), "utf8");
  assert.equal((text.match(/claude-for-zen managed prefs \(do not edit/g) || []).length, 1);
  assert.match(text, /user_pref\("remote\.prefs\.recommended", false\);/);
  assert.match(text, /user_pref\("dom\.successive_dialog_time_limit", 0\);/);
  assert.match(text, /user_pref\("my\.own\.pref", 1\);/);
  assert.equal(MANAGED_PREFS["remote.prefs.recommended"], false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("findBinary rejects an invalid ZEN_BINARY", () => {
  assert.throws(() => findBinary({ binary: "/definitely/not/here/zen" }), /not an executable/);
  assert.ok(Array.isArray(binaryCandidates()));
});

test("config defaults and overrides", () => {
  const c = loadConfig({});
  assert.equal(c.port, 9333);
  assert.equal(c.connectOnly, false);
  assert.equal(c.hideWebdriver, true);
  assert.equal(endpointUrl(c), "ws://127.0.0.1:9333/session");
  const d = loadConfig({ ZEN_BIDI_URL: "ws://127.0.0.1:1234/session", ZEN_HEADLESS: "1", ZEN_HIDE_WEBDRIVER: "0" });
  assert.equal(d.connectOnly, true);
  assert.equal(d.headless, true);
  assert.equal(d.hideWebdriver, false);
  assert.equal(endpointUrl(d), "ws://127.0.0.1:1234/session");
});
