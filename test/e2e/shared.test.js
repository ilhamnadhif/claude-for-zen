// Several Claude Code sessions using the same Zen at the same time: each
// claude-for-zen server talks to a shared session broker, gets its own tabs,
// and the browser session ends only when the last one leaves.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { startFixtureServer, startMcp, sleep } from "./helpers.js";
import { findProfileOwner, isPortOpen } from "../../src/launcher.js";

const parseTabs = (text) => JSON.parse(text.slice(0, text.indexOf("\n}") + 2));

describe("two Claude Code sessions share one Zen (e2e)", { timeout: 600000 }, () => {
  let fx;
  let a;
  let b;
  let c;
  let tabA;
  let tabB;
  let sameBrowser;

  before(async () => {
    fx = await startFixtureServer();
    a = await startMcp();
    sameBrowser = { ZEN_PROFILE: a.env.ZEN_PROFILE, ZEN_BIDI_PORT: String(a.port) };
  });

  after(async () => {
    for (const m of [c, b]) await m?.close({ keepBrowser: true });
    await a?.close();
    const owner = fs.existsSync(sameBrowser.ZEN_PROFILE) ? findProfileOwner(sameBrowser.ZEN_PROFILE) : null;
    if (owner?.pid) {
      try {
        process.kill(owner.pid, "SIGKILL");
      } catch {}
    }
    fx?.server.close();
  });

  it("both sessions work at the same time, each with its own tabs", async () => {
    tabA = Number((await a.call("tabs_create", { url: `${fx.base}/main.html?who=a` })).text.match(/Created tab (\d+)/)[1]);
    b = await startMcp(sameBrowser);
    const created = await b.call("tabs_create", { url: `${fx.base}/main.html?who=b` });
    assert.doesNotMatch(created.text, /Another/);
    tabB = Number(created.text.match(/Created tab (\d+)/)[1]);

    // Interleaved input in both sessions.
    const typeInto = async (m, tab, text) => {
      await m.js(tab, "document.getElementById('q').focus()");
      for (const word of text.split(" ")) {
        await m.call("computer", { action: "type", tabId: tab, text: word + " " });
      }
    };
    await Promise.all([typeInto(a, tabA, "alpha beta gamma delta"), typeInto(b, tabB, "one two three four")]);
    assert.equal(await a.js(tabA, "document.getElementById('q').value"), "alpha beta gamma delta ");
    assert.equal(await b.js(tabB, "document.getElementById('q').value"), "one two three four ");

    // Each session lists its own tabs; both see the other's with all=true.
    assert.deepEqual(parseTabs((await a.call("tabs_context", {})).text).tabs.map((t) => t.url.includes("who=a")), [true]);
    assert.deepEqual(parseTabs((await b.call("tabs_context", {})).text).tabs.map((t) => t.url.includes("who=b")), [true]);
    const all = parseTabs((await a.call("tabs_context", { all: true })).text).tabs;
    assert.ok(all.some((t) => t.url.includes("who=b") && t.openedByClaude === false));

    // Console messages stay with their tab, once.
    await a.js(tabA, 'console.log("only-in-a")');
    await sleep(300);
    const logsA = await a.call("read_console_messages", { tabId: tabA, pattern: "only-in-a" });
    assert.equal((logsA.text.match(/only-in-a/g) || []).length, 1);
    const logsB = await b.call("read_console_messages", { tabId: tabB, pattern: "only-in-a" });
    assert.match(logsB.text, /^No console messages/);
  });

  it("one session ending doesn't affect the other", async () => {
    await a.close({ keepBrowser: true });
    a = null;
    await sleep(500);
    const shot = await b.call("computer", { action: "screenshot", tabId: tabB });
    assert.equal(shot.images.length, 1);
    const nav = await b.call("navigate", { tabId: tabB, url: `${fx.base}/popup.html?still=1` });
    assert.match(nav.text, /Popup Page/);
    assert.ok(await isPortOpen("127.0.0.1", Number(sameBrowser.ZEN_BIDI_PORT)), "the browser keeps running");
  });

  it("a new session joins, and the browser closes only after the last one leaves", async () => {
    c = await startMcp(sameBrowser);
    const joined = await c.call("tabs_context", { createIfEmpty: true });
    assert.match(joined.text, /Created tab/);
    await c.close({ keepBrowser: true });
    c = null;
    await sleep(500);
    assert.ok(await isPortOpen("127.0.0.1", Number(sameBrowser.ZEN_BIDI_PORT)), "b still uses it");
    await b.call("computer", { action: "screenshot", tabId: tabB });

    await b.close({ keepBrowser: true });
    b = null;
    if (process.env.E2E_PROFILE_MODE === "existing") {
      // The user's own Zen is never quit, even by the last session.
      await sleep(1500);
      assert.ok(findProfileOwner(sameBrowser.ZEN_PROFILE)?.pid, "the user's Zen keeps running");
      return;
    }
    // ZEN_KILL_ON_EXIT=1 (set by the test helper): the last session to leave quits Claude's Zen.
    let closed = false;
    for (let i = 0; i < 50 && !closed; i++) {
      await sleep(200);
      closed = !(await isPortOpen("127.0.0.1", Number(sameBrowser.ZEN_BIDI_PORT)));
    }
    assert.ok(closed, "Claude's Zen quit once no session uses it");
  });
});
