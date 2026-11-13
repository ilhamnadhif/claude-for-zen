// End-to-end tests for ZEN_PROFILE_MODE=existing: Claude uses the user's own,
// already running browser. A throwaway profile plays the user's everyday Zen:
// it is started normally (no remote debugging). On macOS Claude has to ask
// before restarting it and restarts it with the user's tabs; elsewhere it asks
// the user to quit it and reopens it. Either way Claude's tabs go into a window
// of their own (same profile; in Zen an unsynced window) and the browser is
// left running.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { startFixtureServer, startMcp, freePort, sleep, readMozLz4 } from "./helpers.js";
import { loadConfig } from "../../src/config.js";
import { findBinary, findProfileOwner, quitGracefully, CAN_RESTART_BROWSER, waitForProfileRelease } from "../../src/launcher.js";

const parseTabs = (text) => JSON.parse(text.slice(0, text.indexOf("\n}") + 2));

// A used profile: no first-run pages.
const USER_PREFS = {
  "browser.shell.checkDefaultBrowser": false,
  "browser.aboutwelcome.enabled": false,
  "browser.startup.homepage_override.mstone": "ignore",
  "startup.homepage_welcome_url": "",
  "startup.homepage_welcome_url.additional": "",
  "zen.welcome-screen.seen": true,
  "datareporting.policy.dataSubmissionPolicyBypassNotification": true,
  "trailhead.firstrun.didSeeAboutWelcome": true,
};

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function bidi(port, fn) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/session`);
  await new Promise((res, rej) => {
    ws.once("open", res);
    ws.once("error", rej);
  });
  let id = 0;
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const myId = ++id;
      const onMsg = (d) => {
        const m = JSON.parse(d);
        if (m.id !== myId) return;
        ws.off("message", onMsg);
        if (m.type === "error") rej(new Error(`${m.error}: ${m.message}`));
        else res(m.result);
      };
      ws.on("message", onMsg);
      ws.send(JSON.stringify({ id: myId, method, params }));
    });
  try {
    await send("session.new", { capabilities: {} });
    return await fn(send);
  } finally {
    try {
      await send("session.end");
    } catch {}
    ws.close();
  }
}

describe("existing profile mode (e2e)", { timeout: 600000 }, () => {
  let fx;
  let tmp;
  let dir;
  let port;
  let userPid;
  let mcp;
  let tab;

  before(async () => {
    fx = await startFixtureServer();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cfz-e2e-existing-"));
    dir = path.join(tmp, "everyday-profile");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "user.js"), Object.entries(USER_PREFS).map(([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});`).join("\n") + "\n");
    port = await freePort();

    // The user's Zen, started the normal way: no remote debugging.
    const args = ["-profile", dir, "-no-remote"];
    if (!process.env.E2E_HEADED) args.push("-headless");
    args.push(`${fx.base}/popup.html?everyday=1`);
    const child = spawn(findBinary(loadConfig()), args, { detached: true, stdio: "ignore" });
    child.unref();
    for (let i = 0; i < 160 && !userPid; i++) {
      await sleep(250);
      userPid = findProfileOwner(dir)?.pid;
    }
    assert.ok(userPid, "the everyday browser should hold its profile lock");
    await sleep(6000); // load the page and write the session

    mcp = await startMcp({ ZEN_PROFILE_MODE: "existing", ZEN_PROFILE: dir, ZEN_BIDI_PORT: String(port) });
  });

  after(async () => {
    await mcp?.close();
    for (const pid of [findProfileOwner(dir)?.pid, userPid]) {
      if (pid && alive(pid)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
    }
    await sleep(800);
    fs.rmSync(tmp, { recursive: true, force: true });
    fx?.server.close();
  });

  it("asks before touching the user's running Zen", async () => {
    const r = await mcp.call("tabs_context", {}, { expectError: true });
    assert.match(r.text, /remote control .* is off/);
    assert.match(r.text, /Ask the user/);
    if (CAN_RESTART_BROWSER) {
      assert.match(r.text, /restartBrowser: true/);
      assert.match(r.text, /come back/);
    } else {
      assert.match(r.text, /quit Zen/);
      assert.doesNotMatch(r.text, /restartBrowser/);
      // Even if asked to, Claude never kills the browser where it can't quit it cleanly.
      await mcp.call("tabs_context", { restartBrowser: true }, { expectError: true });
    }
    assert.ok(alive(userPid), "Zen must not be touched without permission");
    // Other tools give the same answer instead of launching a second Zen.
    const n = await mcp.call("tabs_create", { url: `${fx.base}/main.html` }, { expectError: true });
    assert.match(n.text, /remote control .* is off/);
    assert.ok(alive(userPid));
  });

  it(CAN_RESTART_BROWSER ? "restarts Zen once allowed, with the user's profile and tabs" : "reopens the user's Zen after they quit it", async (t) => {
    if (CAN_RESTART_BROWSER) {
      const r = await mcp.call("tabs_context", { restartBrowser: true, all: true });
      assert.match(r.text, /Zen was restarted with remote control on/);
      assert.ok(!alive(userPid), "the old process quit");
    } else {
      process.kill(userPid, "SIGKILL"); // the user quits Zen
      assert.ok(await waitForProfileRelease(dir, 10000));
      const r = await mcp.call("tabs_context", { all: true });
      assert.doesNotMatch(r.text, /restarted/);
    }
    const owner = findProfileOwner(dir);
    assert.ok(owner?.pid && owner.pid !== userPid, "the same profile is open in Zen again, with remote control");

    const userJs = fs.readFileSync(path.join(dir, "user.js"), "utf8");
    assert.match(userJs, /remote\.prefs\.recommended", false/);
    assert.match(userJs, /zen\.welcome-screen\.seen/, "the user's own prefs are kept");
    assert.doesNotMatch(userJs, /focusmanager\.testmode|resume_session_once/);
    if (!CAN_RESTART_BROWSER) return;

    // Restored tabs may load lazily (no browsing context until selected); the
    // last test checks the session itself.
    let restored = null;
    for (let i = 0; i < 6 && !restored; i++) {
      const all = parseTabs((await mcp.call("tabs_context", { all: true })).text);
      restored = all.tabs.find((tb) => /everyday=1/.test(tb.url));
      if (!restored) await sleep(500);
    }
    t.diagnostic(restored ? `restored tab is live: ${restored.url}` : "restored tab is lazy");
  });

  it("opens Claude's tabs in a window of their own and works normally", async () => {
    const created = await mcp.call("tabs_create", { url: `${fx.base}/main.html` });
    tab = Number(created.text.match(/Created tab (\d+)/)[1]);
    assert.match(created.text, /CFZ Test Page/);
    // A second tab joins Claude's window instead of opening another one.
    const second = await mcp.call("tabs_create", { url: `${fx.base}/frame.html?second=1` });
    assert.match(second.text, /Created tab \d+/);

    const shot = await mcp.call("computer", { action: "screenshot", tabId: tab });
    assert.equal(shot.images.length, 1);

    await mcp.js(tab, 'console.log("cfz-existing-log"); fetch("/api/data?page=existing").then(r => r.json())');
    await sleep(500);
    const logs = await mcp.call("read_console_messages", { tabId: tab, pattern: "cfz-existing" });
    assert.match(logs.text, /cfz-existing-log/);
    const net = await mcp.call("read_network_requests", { tabId: tab, urlPattern: "/api/data" });
    assert.match(net.text, /api\/data\?page=existing/);

    const mine = parseTabs((await mcp.call("tabs_context", {})).text);
    assert.equal(mine.tabs.length, 2, "only Claude's tabs are listed by default");
  });

  it("leaves the user's Zen running and lets the next session connect without a restart", async (t) => {
    const pidBefore = findProfileOwner(dir)?.pid;
    await mcp.close();
    mcp = null;
    await sleep(500);
    assert.ok(pidBefore && alive(pidBefore), "the user's Zen keeps running after Claude disconnects (even with ZEN_KILL_ON_EXIT=1)");

    const contexts = await bidi(port, async (send) => (await send("browsingContext.getTree", { maxDepth: 0 })).contexts);
    t.diagnostic(`top-level contexts: ${contexts.map((c) => `${(c.clientWindow || "?").slice(0, 6)} ${c.url}`).join(" | ")}`);
    const main = contexts.find((c) => c.url.includes("/main.html"));
    const second = contexts.find((c) => c.url.includes("second=1"));
    assert.ok(main && second, "Claude's tabs are still open");
    if (main.clientWindow) {
      assert.equal(second.clientWindow, main.clientWindow, "Claude's tabs share one window");
      const userWindows = new Set(contexts.filter((c) => c !== main && c !== second && c.clientWindow !== main.clientWindow).map((c) => c.clientWindow));
      assert.ok(userWindows.size >= 1, "the user's window is a different one");
      const strangers = contexts.filter((c) => c.clientWindow === main.clientWindow && c !== main && c !== second && c.url !== "about:blank");
      assert.deepEqual(strangers.map((c) => c.url), [], "none of the user's pages are in Claude's window");
    }

    mcp = await startMcp({ ZEN_PROFILE_MODE: "existing", ZEN_PROFILE: dir, ZEN_BIDI_PORT: String(port) });
    const r = await mcp.call("tabs_context", { all: true });
    assert.doesNotMatch(r.text, /restarted/);
    assert.equal(findProfileOwner(dir)?.pid, pidBefore, "no restart the second time");
  });

  it("kept the user's tab through the restart (session after a normal quit)", { skip: !CAN_RESTART_BROWSER && "automatic restart is macOS-only" }, async () => {
    await mcp?.close();
    mcp = null;
    const pid = findProfileOwner(dir)?.pid;
    assert.ok(await quitGracefully(pid, { timeoutMs: 20000 }), "Zen quits normally");
    await sleep(500);
    const main = ["zen-sessions.jsonlz4", "sessionstore.jsonlz4"].map((f) => path.join(dir, f)).filter((f) => fs.existsSync(f));
    assert.ok(main.length, "a session file was written");
    const text = main.map((f) => readMozLz4(f)).join("\n");
    assert.match(text, /everyday=1/, "the tab the user had open before the restart is still in their session");
    assert.match(text, /main\.html/, "Claude's tab is in the same session");
    // Claude's window is kept apart from the user's (Zen: an unsynced window).
    const store = path.join(dir, "sessionstore.jsonlz4");
    if (fs.existsSync(store)) {
      const urlsOf = (w) => w.tabs.map((tb) => (tb.entries?.[tb.index - 1] || tb.entries?.at(-1) || {}).url || "");
      const wins = JSON.parse(readMozLz4(store)).windows.map(urlsOf);
      const claudeWin = wins.find((u) => u.some((x) => x.includes("/main.html")));
      const userWin = wins.find((u) => u.some((x) => x.includes("everyday=1")));
      assert.ok(claudeWin && userWin && claudeWin !== userWin, `separate windows: ${JSON.stringify(wins)}`);
      assert.ok(!userWin.some((x) => x.includes("/main.html")), "Claude's tabs are not mirrored into the user's window");
      assert.ok(!claudeWin.some((x) => x.includes("everyday=1")), "the user's tabs are not mirrored into Claude's window");
    }
  });
});
