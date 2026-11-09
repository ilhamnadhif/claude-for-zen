// End-to-end tests for ZEN_PROFILE_MODE=existing: Claude uses the user's own,
// already running browser. A throwaway profile plays the user's everyday Zen:
// it is started normally (no remote debugging), then Claude has to ask before
// restarting it, restarts it with the user's tabs, and opens its tab in the
// user's window.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { startFixtureServer, startMcp, freePort, sleep, readMozLz4 } from "./helpers.js";
import { loadConfig } from "../../src/config.js";
import { findBinary, findProfileOwner, quitGracefully } from "../../src/launcher.js";

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

  it("asks before restarting the user's running Zen", async () => {
    const r = await mcp.call("tabs_context", {}, { expectError: true });
    assert.match(r.text, /remote control .* is off/);
    assert.match(r.text, /Ask the user/);
    assert.match(r.text, /restartBrowser: true/);
    assert.match(r.text, /come back/);
    assert.ok(alive(userPid), "Zen must not be touched without permission");
    // Other tools give the same answer instead of launching a second Zen.
    const n = await mcp.call("tabs_create", { url: `${fx.base}/main.html` }, { expectError: true });
    assert.match(n.text, /restartBrowser: true/);
    assert.ok(alive(userPid));
  });

  it("restarts Zen once allowed, with the user's profile and tabs", async (t) => {
    const r = await mcp.call("tabs_context", { restartBrowser: true, all: true });
    assert.match(r.text, /Zen was restarted with remote control on/);
    assert.ok(!alive(userPid), "the old process quit");
    const owner = findProfileOwner(dir);
    assert.ok(owner?.pid && owner.pid !== userPid, "the same profile is open in the restarted Zen");

    const userJs = fs.readFileSync(path.join(dir, "user.js"), "utf8");
    assert.match(userJs, /remote\.prefs\.recommended", false/);
    assert.match(userJs, /zen\.welcome-screen\.seen/, "the user's own prefs are kept");
    assert.doesNotMatch(userJs, /focusmanager\.testmode|resume_session_once/);

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

  it("opens Claude's tab in the user's window and works normally", async () => {
    const created = await mcp.call("tabs_create", { url: `${fx.base}/main.html` });
    tab = Number(created.text.match(/Created tab (\d+)/)[1]);
    assert.match(created.text, /CFZ Test Page/);

    const shot = await mcp.call("computer", { action: "screenshot", tabId: tab });
    assert.equal(shot.images.length, 1);

    await mcp.js(tab, 'console.log("cfz-existing-log"); fetch("/api/data?page=existing").then(r => r.json())');
    await sleep(500);
    const logs = await mcp.call("read_console_messages", { tabId: tab, pattern: "cfz-existing" });
    assert.match(logs.text, /cfz-existing-log/);
    const net = await mcp.call("read_network_requests", { tabId: tab, urlPattern: "/api/data" });
    assert.match(net.text, /api\/data\?page=existing/);

    const mine = parseTabs((await mcp.call("tabs_context", {})).text);
    assert.deepEqual(mine.tabs.map((t) => t.tabId), [tab], "only Claude's tab is listed by default");
  });

  it("leaves the user's Zen running and lets the next session connect without a restart", async (t) => {
    const pidBefore = findProfileOwner(dir)?.pid;
    await mcp.close();
    mcp = null;
    await sleep(500);
    assert.ok(pidBefore && alive(pidBefore), "the user's Zen keeps running after Claude disconnects (even with ZEN_KILL_ON_EXIT=1)");

    const windows = await bidi(port, async (send) => {
      const tree = await send("browsingContext.getTree", { maxDepth: 0 });
      return { urls: tree.contexts.map((c) => c.url), windows: new Set(tree.contexts.map((c) => c.clientWindow).filter(Boolean)) };
    });
    t.diagnostic(`top-level contexts: ${windows.urls.join(" | ")}; windows: ${windows.windows.size}`);
    assert.ok(windows.urls.some((u) => u.includes("/main.html")), "Claude's tab is still open");
    if (windows.windows.size) assert.equal(windows.windows.size, 1, "no extra window was opened");

    mcp = await startMcp({ ZEN_PROFILE_MODE: "existing", ZEN_PROFILE: dir, ZEN_BIDI_PORT: String(port) });
    const r = await mcp.call("tabs_context", { all: true });
    assert.doesNotMatch(r.text, /restarted/);
    assert.equal(findProfileOwner(dir)?.pid, pidBefore, "no restart the second time");
  });

  it("kept the user's tab through the restart (session after a normal quit)", async () => {
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
  });
});
