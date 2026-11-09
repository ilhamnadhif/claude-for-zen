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

test("defaultProfileFromIni prefers the install default, then Default=1, then the first profile", async () => {
  const { defaultProfileFromIni } = await import("../../src/launcher.js");
  const root = "/root/zen";
  const ini = `[Install6ED35B3CA1B5D3AF]\nDefault=Profiles/ix7lni7p.Default (release)\nLocked=1\n\n[Profile1]\nName=Default Profile\nIsRelative=1\nPath=Profiles/tnb73yp1.Default Profile\nDefault=1\n\n[Profile0]\nName=Default (release)\nIsRelative=1\nPath=Profiles/ix7lni7p.Default (release)\n\n[General]\nStartWithLastProfile=1\nVersion=2\n`;
  assert.equal(defaultProfileFromIni(ini, root), path.join(root, "Profiles/ix7lni7p.Default (release)"));
  const legacy = `[General]\nStartWithLastProfile=1\r\n[Profile0]\r\nName=a\r\nIsRelative=1\r\nPath=Profiles/a\r\n[Profile1]\r\nName=b\r\nIsRelative=0\r\nPath=/abs/b\r\nDefault=1\r\n`;
  assert.equal(defaultProfileFromIni(legacy, root), "/abs/b");
  assert.equal(defaultProfileFromIni(`[Profile0]\nPath=Profiles/only\n`, root), path.join(root, "Profiles/only"));
  assert.equal(defaultProfileFromIni(`[General]\nVersion=2\n`, root), null);
});

test("readProfilePref / restoresTabs read prefs.js and user.js (user.js wins)", async () => {
  const { readProfilePref, restoresTabs } = await import("../../src/launcher.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cfz-unit-"));
  const zen = "/Applications/Zen.app/Contents/MacOS/zen";
  assert.equal(readProfilePref(dir, "browser.startup.page"), undefined);
  assert.equal(restoresTabs(dir, zen), true); // Zen default: restore session
  assert.equal(restoresTabs(dir, "/usr/bin/firefox"), false); // Firefox default: home page
  fs.writeFileSync(path.join(dir, "prefs.js"), 'user_pref("browser.startup.page", 1);\nuser_pref("some.string", "a)b");\n');
  assert.equal(readProfilePref(dir, "browser.startup.page"), 1);
  assert.equal(restoresTabs(dir, zen), false);
  fs.writeFileSync(path.join(dir, "user.js"), 'user_pref("browser.startup.page", 3);\n');
  assert.equal(readProfilePref(dir, "browser.startup.page"), 3);
  assert.equal(restoresTabs(dir, zen), true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("isZenBinary", async () => {
  const { isZenBinary } = await import("../../src/launcher.js");
  for (const p of ["/Applications/Zen.app/Contents/MacOS/zen", "/Applications/Zen Twilight.app/Contents/MacOS/zen", "/opt/zen-browser-bin/zen-bin", "/usr/bin/zen-browser", "C:\\Program Files\\Zen Browser\\zen.exe"]) {
    assert.equal(isZenBinary(p), true, p);
  }
  for (const p of ["/usr/bin/firefox", "/Applications/Firefox.app/Contents/MacOS/firefox", "C:\\Program Files\\Mozilla Firefox\\firefox.exe"]) {
    assert.equal(isZenBinary(p), false, p);
  }
});

test("existing-profile prefs replace the managed block without touching the user's prefs", async () => {
  const { EXISTING_PROFILE_PREFS } = await import("../../src/launcher.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cfz-unit-"));
  fs.writeFileSync(path.join(dir, "user.js"), 'user_pref("my.own.pref", "x");\n');
  prepareProfile(dir, EXISTING_PROFILE_PREFS, { create: false });
  prepareProfile(dir, { ...EXISTING_PROFILE_PREFS, "browser.sessionstore.resume_session_once": true }, { create: false });
  prepareProfile(dir, EXISTING_PROFILE_PREFS, { create: false });
  const text = fs.readFileSync(path.join(dir, "user.js"), "utf8");
  assert.equal((text.match(/claude-for-zen managed prefs \(do not edit/g) || []).length, 1);
  assert.match(text, /remote\.prefs\.recommended", false/);
  assert.doesNotMatch(text, /focusmanager\.testmode|resume_session_once|warnOnQuit/);
  assert.match(text, /user_pref\("my\.own\.pref", "x"\);/);
  assert.throws(() => prepareProfile(path.join(dir, "missing"), EXISTING_PROFILE_PREFS, { create: false }));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("profile mode configuration", () => {
  const a = loadConfig({});
  assert.equal(a.profileMode, "dedicated");
  assert.match(a.profileDir, /\.claude-for-zen[\\/]profile$/);
  assert.equal(a.restart, "ask");
  const b = loadConfig({ ZEN_PROFILE_MODE: "existing" });
  assert.equal(b.profileMode, "existing");
  assert.equal(b.profileDir, null);
  const c = loadConfig({ ZEN_PROFILE_MODE: "Existing", ZEN_PROFILE: "/tmp/p", ZEN_RESTART: "auto" });
  assert.equal(c.profileDir, path.resolve("/tmp/p"));
  assert.equal(c.restart, "auto");
  assert.throws(() => loadConfig({ ZEN_PROFILE_MODE: "mine" }), /ZEN_PROFILE_MODE/);
  assert.throws(() => loadConfig({ ZEN_RESTART: "sometimes" }), /ZEN_RESTART/);
});
