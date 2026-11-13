// End-to-end tests for the "Claude for Zen" helper add-on (ZEN_HELPER_ADDON=1):
// the user's Zen runs normally, without remote debugging, and Claude switches
// remote control on through the add-on without restarting it, then off again.
// Zen only: Firefox release builds refuse unsigned add-ons with experiment APIs.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startFixtureServer, startMcp, sleep } from "./helpers.js";
import { loadConfig } from "../../src/config.js";
import {
  findBinary,
  findProfileOwner,
  isPortOpen,
  isZenBinary,
  prepareProfile,
  existingProfilePrefs,
  processCommand,
  quitGracefully,
  waitForProfileRelease,
} from "../../src/launcher.js";
import { addonInfo, addonState, sideloadAddon, waitForAddonState } from "../../src/addon.js";

let binary = null;
try {
  binary = findBinary(loadConfig());
} catch {}
const skip = !binary || !isZenBinary(binary) ? "needs Zen (Firefox release refuses unsigned add-ons)" : false;
const AGENT_PORT = 9222; // the port Firefox's runtime-started remote agent always uses

describe("helper add-on: no restart (e2e)", { timeout: 600000, skip }, () => {
  let fx;
  let tmp;
  let dir;
  let pid;
  let mcp;
  const env = () => ({ ZEN_PROFILE_MODE: "existing", ZEN_PROFILE: dir, ZEN_HELPER_ADDON: "1", ZEN_BIDI_PORT: "9479" });

  before(async () => {
    fx = await startFixtureServer();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cfz-e2e-addon-"));
    dir = path.join(tmp, "everyday-profile");
    fs.mkdirSync(dir);
    // A used profile; autoDisableScopes=14 stands in for the user clicking
    // "Enable" when Zen announces the new add-on.
    fs.writeFileSync(
      path.join(dir, "user.js"),
      ['"zen.welcome-screen.seen", true', '"browser.aboutwelcome.enabled", false', '"browser.startup.homepage_override.mstone", "ignore"', '"trailhead.firstrun.didSeeAboutWelcome", true', '"extensions.autoDisableScopes", 14']
        .map((p) => `user_pref(${p});`)
        .join("\n") + "\n",
    );
    // What `claude-for-zen install --no-restart` does while Zen is closed.
    prepareProfile(dir, existingProfilePrefs({ helperAddon: true }), { create: false });
    assert.ok(sideloadAddon(dir));
    assert.equal(await isPortOpen("127.0.0.1", AGENT_PORT), false, `port ${AGENT_PORT} must be free for this test`);
  });

  after(async () => {
    await mcp?.close();
    const owner = findProfileOwner(dir);
    if (owner?.pid) {
      try {
        process.kill(owner.pid, "SIGKILL");
      } catch {}
    }
    await sleep(800);
    fs.rmSync(tmp, { recursive: true, force: true });
    fx?.server.close();
  });

  it("Zen started normally loads the add-on, with remote control off", async () => {
    const args = ["-profile", dir, "-no-remote"];
    if (!process.env.E2E_HEADED) args.push("-headless");
    args.push(`${fx.base}/popup.html?everyday=1`);
    spawn(binary, args, { detached: true, stdio: "ignore" }).unref();
    for (let i = 0; i < 160 && !pid; i++) {
      await sleep(250);
      pid = findProfileOwner(dir)?.pid;
    }
    assert.ok(pid);
    const state = await waitForAddonState(dir, pid, 30000);
    assert.ok(state, "the add-on wrote its state file");
    let info = null;
    for (let i = 0; i < 50 && !info?.active; i++) {
      info = addonInfo(dir); // extensions.json is written shortly after startup
      if (!info?.active) await sleep(200);
    }
    assert.equal(info?.active, true, "Zen records the add-on as enabled");
    assert.equal(await isPortOpen("127.0.0.1", AGENT_PORT), false, "remote control is off until Claude needs it");
    assert.doesNotMatch(processCommand(pid), /remote-debugging-port/);
  });

  it("Claude switches remote control on without restarting Zen", async () => {
    mcp = await startMcp(env());
    const r = await mcp.call("tabs_context", { all: true });
    assert.doesNotMatch(r.text, /restart/i);
    assert.equal(findProfileOwner(dir)?.pid, pid, "same Zen process: no restart");
    assert.ok(await isPortOpen("127.0.0.1", AGENT_PORT));

    const created = await mcp.call("tabs_create", { url: `${fx.base}/main.html` });
    const tab = Number(created.text.match(/Created tab (\d+)/)[1]);
    assert.match(created.text, /CFZ Test Page/);
    const shot = await mcp.call("computer", { action: "screenshot", tabId: tab });
    assert.equal(shot.images.length, 1);
    assert.equal(await mcp.js(tab, "navigator.webdriver"), false, "pages don't see automation");
  });

  it("switches remote control off when Claude is done, and on again for the next session", async () => {
    await mcp.close();
    mcp = null;
    let off = false;
    for (let i = 0; i < 30 && !off; i++) {
      await sleep(200);
      off = !(await isPortOpen("127.0.0.1", AGENT_PORT));
    }
    assert.ok(off, "remote control is off again");
    assert.equal(findProfileOwner(dir)?.pid, pid, "Zen keeps running");

    mcp = await startMcp(env());
    const again = await mcp.call("tabs_context", { createIfEmpty: true });
    assert.match(again.text, /Created tab/);
    assert.equal(findProfileOwner(dir)?.pid, pid);
    await mcp.close();
    mcp = null;
  });

  it("opens Zen without the remote debugging flag when it is not running", async () => {
    assert.ok(await quitGracefully(pid, { timeoutMs: 20000 }));
    assert.ok(await waitForProfileRelease(dir, 10000));
    mcp = await startMcp({ ...env(), ZEN_HEADLESS: process.env.E2E_HEADED ? "0" : "1" });
    const r = await mcp.call("tabs_create", { url: `${fx.base}/main.html?fresh=1` });
    assert.match(r.text, /CFZ Test Page/);
    const owner = findProfileOwner(dir);
    assert.ok(owner?.pid && owner.pid !== pid);
    assert.doesNotMatch(processCommand(owner.pid), /remote-debugging-port/, "started like from the Dock");
    assert.equal(addonState(dir)?.pid, owner.pid);
    await mcp.close();
    mcp = null;
    await sleep(1000);
    assert.equal(await isPortOpen("127.0.0.1", AGENT_PORT), false);
    assert.equal(findProfileOwner(dir)?.pid, owner.pid, "the user's Zen keeps running");
  });
});
