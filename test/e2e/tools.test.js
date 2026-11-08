// End-to-end tests: a real Zen/Firefox (headless by default), driven through the
// MCP server over stdio exactly like Claude Code does.
//   npm run test:e2e                 (uses the auto-detected Zen)
//   ZEN_BINARY=/usr/bin/firefox npm run test:e2e
//   E2E_HEADED=1 npm run test:e2e    (watch it)

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import jpeg from "jpeg-js";
import { startFixtureServer, startMcp, refFor, sleep } from "./helpers.js";

const SELECT_ALL = process.platform === "darwin" ? "cmd+a" : "ctrl+a";
const parseTabs = (text) => JSON.parse(text.slice(0, text.lastIndexOf("}") + 1));

describe("claude-for-zen tools (e2e)", { timeout: 600000 }, () => {
  let fx;
  let mcp;
  let tab;
  let base;

  before(async () => {
    fx = await startFixtureServer();
    base = fx.base;
    mcp = await startMcp();
  });

  after(async () => {
    await mcp?.close();
    fx?.server.close();
  });

  const call = (...a) => mcp.call(...a);
  const js = (...a) => mcp.js(...a);

  async function frameScale() {
    const shot = await call("computer", { action: "screenshot", tabId: tab });
    const [, w, h] = shot.text.match(/(\d+)x(\d+) frame/);
    const vw = await js(tab, "innerWidth");
    return { s: Number(w) / vw, w: Number(w), h: Number(h) };
  }

  async function centerOf(selector) {
    return js(tab, `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  }

  async function freshTree(filter = "all") {
    return (await call("read_page", { tabId: tab, filter })).text;
  }

  it("lists all tools", async () => {
    const { tools } = await mcp.client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "browser_batch", "computer", "file_upload", "find", "form_input", "get_page_text", "gif_creator", "handle_dialog",
      "javascript_tool", "navigate", "read_console_messages", "read_network_requests", "read_page", "resize_window",
      "tabs_close", "tabs_context", "tabs_create",
    ]);
  });

  it("tabs_context launches Zen and creates a tab on request", async () => {
    const empty = await call("tabs_context", {});
    assert.match(empty.text, /No Claude tabs yet/);
    const created = await call("tabs_context", { createIfEmpty: true });
    assert.match(created.text, /Created tab \d+/);
    const t = parseTabs(created.text).tabs;
    assert.equal(t.length, 1);
    const all = await call("tabs_context", { all: true });
    assert.ok(parseTabs(all.text).totalOpenTabs >= 1);
  });

  it("tabs_create opens a page; navigate works incl. back/forward", async () => {
    const r = await call("tabs_create", { url: `${base}/main.html` });
    tab = Number(r.text.match(/Created tab (\d+)/)[1]);
    assert.match(r.text, /CFZ Test Page/);
    const n = await call("navigate", { tabId: tab, url: `${base}/popup.html` });
    assert.match(n.text, /Popup Page/);
    const back = await call("navigate", { tabId: tab, url: "back" });
    assert.match(back.text, /CFZ Test Page/);
    const fwd = await call("navigate", { tabId: tab, url: "forward" });
    assert.match(fwd.text, /Popup Page/);
    await call("navigate", { tabId: tab, url: `${base}/main.html` });
    assert.equal(await js(tab, "document.title"), "CFZ Test Page");
  });

  it("navigator.webdriver is false in pages", async () => {
    assert.equal(await js(tab, "navigator.webdriver"), false);
  });

  it("screenshot returns a correctly sized JPEG", async () => {
    const shot = await call("computer", { action: "screenshot", tabId: tab });
    assert.equal(shot.images.length, 1);
    assert.equal(shot.images[0].mimeType, "image/jpeg");
    const [, w, h] = shot.text.match(/(\d+)x(\d+) frame/).map(Number);
    const img = jpeg.decode(Buffer.from(shot.images[0].data, "base64"));
    assert.equal(img.width, w);
    assert.equal(img.height, h);
    assert.ok(w <= 1568 && h <= 1568 && w * h <= 1_150_000 + 2000);
    const small = await call("computer", { action: "screenshot", tabId: tab, scale: 0.5 });
    const simg = jpeg.decode(Buffer.from(small.images[0].data, "base64"));
    assert.ok(Math.abs(simg.width - w / 2) <= 1);
    assert.match(small.text, /coordinates remain/);
    const saved = await call("computer", { action: "screenshot", tabId: tab, save_to_disk: true });
    const file = saved.text.match(/Saved to (.+\.jpg)/)[1];
    assert.ok(fs.existsSync(file));
  });

  it("read_page returns an accessibility tree with refs, including iframes", async () => {
    await sleep(500);
    const tree = await freshTree();
    assert.match(tree, /heading "CFZ Test Page" \[ref_\d+\] level=1/);
    assert.match(tree, /button "Click me" \[ref_\d+\]/);
    assert.match(tree, /textbox "Search query" \[ref_\d+\] placeholder="Type here"/);
    assert.match(tree, /combobox "Favorite color" \[ref_\d+\] value="Red"/);
    assert.match(tree, /option "Blue" \[ref_\d+\] value="b"/);
    assert.match(tree, /checkbox "I agree" \[ref_\d+\] unchecked/);
    assert.match(tree, /link "Open popup" \[ref_\d+\] href=/);
    assert.match(tree, /button "Hidden button" \[ref_\d+\] \(hidden\)/);
    assert.match(tree, /iframe "Same origin frame"/);
    assert.equal((tree.match(/button "Frame button"/g) || []).length, 2, "both iframes' content is included");
    const inter = await freshTree("interactive");
    assert.doesNotMatch(inter, /heading/);
    assert.doesNotMatch(inter, /Hidden button/);
    assert.match(inter, /button "Custom role button"/);
    assert.match(inter, /Pointer div clickable/);
    const sub = await call("read_page", { tabId: tab, ref_id: refFor(tree, /navigation "Main"/) });
    assert.match(sub.text, /link "Home"/);
    assert.doesNotMatch(sub.text, /Click me/);
    const tiny = await call("read_page", { tabId: tab, max_chars: 1000 });
    assert.match(tiny.text, /Output truncated/);
  });

  it("left_click by ref and by coordinate produce trusted clicks", async () => {
    const tree = await freshTree("interactive");
    const r = await call("computer", { action: "left_click", tabId: tab, ref: refFor(tree, /button "Click me"/), action_summary: "Clicks the test button" });
    assert.match(r.text, /Clicked ref_\d+ \(button "Click me"\)/);
    assert.equal(await js(tab, "document.getElementById('count').textContent"), 1);
    const { s } = await frameScale();
    const c = await centerOf("#btn");
    const r2 = await call("computer", { action: "left_click", tabId: tab, coordinate: [c.x * s, c.y * s] });
    assert.match(r2.text, /on button "Click me"/);
    assert.equal(await js(tab, "document.getElementById('count').textContent"), 2);
    const ev = await js(tab, "window.__events.filter(e => e.type === 'click' && e.id === 'btn')");
    assert.ok(ev.length === 2 && ev.every((e) => e.trusted === true), JSON.stringify(ev));
  });

  it("modifier clicks, double, triple and right clicks", async () => {
    const tree = await freshTree("all");
    await js(tab, "window.__events.length = 0");
    await call("computer", { action: "left_click", tabId: tab, ref: refFor(tree, /button "Click me"/), modifiers: "shift" });
    let ev = await js(tab, "window.__events.filter(e => e.type === 'click')");
    assert.equal(ev.at(-1).shift, true);
    const { s } = await frameScale();
    const d = await centerOf("#dbl");
    await call("computer", { action: "double_click", tabId: tab, coordinate: [d.x * s, d.y * s] });
    ev = await js(tab, "window.__events.filter(e => e.type === 'dblclick')");
    assert.equal(ev.length, 1);
    assert.equal(ev[0].id, "dbl");
    await js(tab, "window.__events.length = 0");
    await call("computer", { action: "triple_click", tabId: tab, coordinate: [d.x * s, d.y * s] });
    ev = await js(tab, "window.__events.filter(e => e.type === 'click')");
    assert.equal(ev.at(-1).detail, 3);
    const c = await centerOf("#ctx");
    await call("computer", { action: "right_click", tabId: tab, coordinate: [c.x * s, c.y * s] });
    ev = await js(tab, "window.__events.filter(e => e.type === 'contextmenu')");
    assert.equal(ev.at(-1).id, "ctx");
    assert.equal(ev.at(-1).button, 2);
  });

  it("hover and drag", async () => {
    await js(tab, "window.__events.length = 0");
    const found = await call("find", { tabId: tab, query: "Hover me" });
    const hov = refFor(found.text, /"Hover me"/);
    await call("computer", { action: "hover", tabId: tab, ref: hov });
    let ev = await js(tab, "window.__events.filter(e => e.type === 'mouseover' && e.id === 'hover-target')");
    assert.ok(ev.length >= 1);
    const { s } = await frameScale();
    const area = await js(tab, "(() => { const r = document.getElementById('drag-area').getBoundingClientRect(); return { l: r.left, t: r.top, w: r.width, h: r.height }; })()");
    const from = [(area.l + 20) * s, (area.t + area.h / 2) * s];
    const to = [(area.l + area.w - 20) * s, (area.t + area.h / 2) * s];
    await js(tab, "window.__events.length = 0");
    await call("computer", { action: "left_click_drag", tabId: tab, start_coordinate: from, coordinate: to });
    ev = await js(tab, "window.__events.filter(e => ['mousedown','mousemove','mouseup'].includes(e.type))");
    const down = ev.find((e) => e.type === "mousedown");
    const up = ev.find((e) => e.type === "mouseup");
    assert.ok(down && up, JSON.stringify(ev));
    assert.ok(Math.abs(down.x - (area.l + 20)) <= 2);
    assert.ok(Math.abs(up.x - (area.l + area.w - 20)) <= 2);
    assert.ok(ev.filter((e) => e.type === "mousemove").length >= 2);
  });

  it("type and key: unicode text, select-all, Enter submits", async () => {
    const tree = await freshTree("interactive");
    await call("computer", { action: "left_click", tabId: tab, ref: refFor(tree, /textbox "Search query"/) });
    await call("computer", { action: "type", tabId: tab, text: "héllo wörld 👋 ok" });
    assert.equal(await js(tab, "document.getElementById('q').value"), "héllo wörld 👋 ok");
    await call("computer", { action: "key", tabId: tab, text: `${SELECT_ALL} Backspace` });
    assert.equal(await js(tab, "document.getElementById('q').value"), "");
    await call("computer", { action: "type", tabId: tab, text: "zen" });
    await call("computer", { action: "key", tabId: tab, text: "ArrowLeft", repeat: 3 });
    await call("computer", { action: "type", tabId: tab, text: ">" });
    assert.equal(await js(tab, "document.getElementById('q').value"), ">zen");
    await call("computer", { action: "key", tabId: tab, text: "Enter" });
    assert.equal(await js(tab, "document.getElementById('result').textContent"), "submitted:>zen");
    const bad = await call("computer", { action: "key", tabId: tab, text: "ctrl+nonsense" }, { expectError: true });
    assert.match(bad.text, /Unknown key/);
  });

  it("form_input sets selects, checkboxes, textareas, passwords, framework inputs and contenteditable", async () => {
    const tree = await freshTree("all");
    let r = await call("form_input", { tabId: tab, ref: refFor(tree, /combobox "Favorite color"/), value: "Blue" });
    assert.match(r.text, /Selected "Blue"/);
    assert.equal(await js(tab, "document.getElementById('color').value"), "b");
    await call("form_input", { tabId: tab, ref: refFor(tree, /combobox "Favorite color"/), value: "g" });
    assert.equal(await js(tab, "document.getElementById('color').value"), "g");
    r = await call("form_input", { tabId: tab, ref: refFor(tree, /checkbox "I agree"/), value: true });
    assert.equal(await js(tab, "document.getElementById('agree').checked"), true);
    await call("form_input", { tabId: tab, ref: refFor(tree, /checkbox "I agree"/), value: false });
    assert.equal(await js(tab, "document.getElementById('agree').checked"), false);
    await call("form_input", { tabId: tab, ref: refFor(tree, /textbox "Notes"/), value: "line one" });
    assert.equal(await js(tab, "document.getElementById('notes').value"), "line one");
    r = await call("form_input", { tabId: tab, ref: refFor(tree, /textbox "Password"/), value: "hunter2" });
    assert.doesNotMatch(r.text, /hunter2/);
    await call("form_input", { tabId: tab, ref: refFor(tree, /textbox "Tracked input"/), value: "react style" });
    assert.equal(await js(tab, "document.getElementById('tracked').value"), "react style");
    assert.equal(await js(tab, "window.__trackedChanged"), true, "framework value tracker sees the change");
    await call("form_input", { tabId: tab, ref: refFor(tree, /textbox "Rich editor"/), value: "rich text here" });
    assert.equal(await js(tab, "document.getElementById('editor').innerText.trim()"), "rich text here");
    const after = await freshTree("all");
    assert.match(after, /textbox "Password" \[ref_\d+\] type=password value="••••••"/);
    const bad = await call("form_input", { tabId: tab, ref: refFor(tree, /combobox "Favorite color"/), value: "Purple" }, { expectError: true });
    assert.match(bad.text, /No option matching/);
  });

  it("find locates elements by description, including inside iframes", async () => {
    const r = await call("find", { tabId: tab, query: "search query field" });
    assert.match(r.text.split("\n")[0], /textbox "Search query"/);
    const f = await call("find", { tabId: tab, query: "frame button" });
    assert.ok((f.text.match(/button "Frame button"/g) || []).length >= 2, f.text);
    const none = await call("find", { tabId: tab, query: "zzqx nonexistent widget" });
    assert.match(none.text, /No elements found/);
  });

  it("clicks inside same-origin and cross-origin iframes by ref", async () => {
    const tree = await freshTree("interactive");
    const refs = tree.split("\n").filter((l) => /button "Frame button"/.test(l)).map((l) => l.match(/\[(ref_\d+)\]/)[1]);
    assert.equal(refs.length, 2);
    for (const ref of refs) await call("computer", { action: "left_click", tabId: tab, ref });
    await sleep(300);
    const msgs = await js(tab, "window.__frameMsgs");
    assert.ok(msgs.includes("clicked:127.0.0.1"), JSON.stringify(msgs));
    assert.ok(msgs.includes("clicked:localhost"), JSON.stringify(msgs));
    // Typing into an iframe input
    const t2 = await freshTree("interactive");
    const inputRef = refFor(t2, /textbox "Frame input"/);
    await call("computer", { action: "left_click", tabId: tab, ref: inputRef });
    await call("computer", { action: "type", tabId: tab, text: "in frame" });
    assert.equal(await js(tab, "document.getElementById('same-frame').contentDocument.getElementById('frame-input').value"), "in frame");
  });

  it("scroll, scroll_to and zoom", async () => {
    await js(tab, "scrollTo(0, 0)");
    await call("computer", { action: "scroll", tabId: tab, scroll_direction: "down", scroll_amount: 5 });
    const y = Number(await js(tab, "scrollY"));
    assert.ok(y > 100, `scrollY ${y}`);
    const tree = await freshTree("all");
    const r = await call("computer", { action: "scroll_to", tabId: tab, ref: refFor(tree, /button "Bottom button"/) });
    assert.match(r.text, /into view/);
    const inView = await js(tab, "(() => { const r = document.getElementById('bottom-btn').getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; })()");
    assert.equal(inView, true);
    // clicking an off-screen ref scrolls it into view automatically
    await js(tab, "scrollTo(0, 0)");
    await call("computer", { action: "left_click", tabId: tab, ref: refFor(tree, /button "Bottom button"/) });
    const ev = await js(tab, "window.__events.filter(e => e.type === 'click' && e.id === 'bottom-btn').length");
    assert.equal(ev, 1);
    const z = await call("computer", { action: "zoom", tabId: tab, region: [0, 0, 200, 100] });
    assert.equal(z.images[0].mimeType, "image/png");
    await js(tab, "scrollTo(0, 0)");
  });

  it("get_page_text returns readable text", async () => {
    const r = await call("get_page_text", { tabId: tab });
    assert.match(r.text, /Title: CFZ Test Page/);
    assert.match(r.text, /quick brown fox/);
  });

  it("javascript_tool has REPL semantics and reports errors", async () => {
    assert.equal(await js(tab, "document.title"), "CFZ Test Page");
    assert.equal(await js(tab, "const a = 20; a * 2 + 2"), 42);
    assert.equal(await js(tab, "await new Promise(r => setTimeout(() => r('later'), 50))"), "later");
    assert.deepEqual(await js(tab, "({ n: 1, list: [1, 'two', null], nested: { ok: true } })"), { n: 1, list: [1, "two", null], nested: { ok: true } });
    assert.match(await js(tab, "document.getElementById('btn')"), /<button id="btn">/);
    const e = await call("javascript_tool", { tabId: tab, text: "throw new Error('kaboom')" }, { expectError: true });
    assert.match(e.text, /kaboom/);
    const se = await call("javascript_tool", { tabId: tab, text: "let = = 1" }, { expectError: true });
    assert.match(se.text, /SyntaxError/);
    assert.equal(await js(tab, "undefined"), "undefined");
  });

  it("read_console_messages captures logs, errors and uncaught exceptions", async () => {
    const tree = await freshTree("interactive");
    await call("computer", { action: "left_click", tabId: tab, ref: refFor(tree, /button "Log stuff"/) });
    await sleep(500);
    const r = await call("read_console_messages", { tabId: tab, pattern: "hello-log" });
    assert.match(r.text, /\[info\].*hello-log from page|\[log\].*hello-log/);
    const errs = await call("read_console_messages", { tabId: tab, onlyErrors: true });
    assert.match(errs.text, /bad-thing happened/);
    assert.match(errs.text, /boom-uncaught/);
    assert.doesNotMatch(errs.text, /hello-log/);
    await call("read_console_messages", { tabId: tab, clear: true });
    const empty = await call("read_console_messages", { tabId: tab, pattern: "hello-log" });
    assert.match(empty.text, /No console messages/);
  });

  it("read_network_requests captures requests and redacts secrets", async () => {
    const tree = await freshTree("interactive");
    await call("computer", { action: "left_click", tabId: tab, ref: refFor(tree, /button "Fetch data"/) });
    await sleep(600);
    const r = await call("read_network_requests", { tabId: tab, urlPattern: "/api/" });
    assert.match(r.text, /GET 200 .*\/api\/data\?token=REDACTED&page=2/);
    assert.doesNotMatch(r.text, /secret123/);
    const all = await call("read_network_requests", { tabId: tab });
    assert.match(all.text, /main\.html/);
  });

  it("dialogs: alert, confirm and prompt are surfaced and handled", async () => {
    const tree = await freshTree("interactive");
    const a = await call("computer", { action: "left_click", tabId: tab, ref: refFor(tree, /button "Alert"/) });
    assert.match(a.text, /alert dialog opened: "Hello alert"/);
    const blocked = await call("read_page", { tabId: tab }, { expectError: true });
    assert.match(blocked.text, /dialog is open/);
    const h = await call("handle_dialog", { tabId: tab, action: "accept" });
    assert.match(h.text, /Accepted the alert/);

    await call("computer", { action: "left_click", tabId: tab, ref: refFor(tree, /button "Confirm"/) });
    await call("handle_dialog", { tabId: tab, action: "dismiss" });
    assert.equal(await js(tab, "window.__confirm"), false);

    await call("computer", { action: "left_click", tabId: tab, ref: refFor(tree, /button "Prompt"/) });
    await call("handle_dialog", { tabId: tab, action: "accept", text: "Ilham" });
    assert.equal(await js(tab, "window.__prompt"), "Ilham");

    const viaJs = await call("javascript_tool", { tabId: tab, text: "alert('from js'); 1" });
    assert.match(viaJs.text, /opened a alert dialog|opened an? alert dialog/);
    await call("handle_dialog", { tabId: tab, action: "accept" });
    const none = await call("handle_dialog", { tabId: tab, action: "accept" }, { expectError: true });
    assert.match(none.text, /no open dialog/);
  });

  it("links that open new tabs are reported and adopted", async () => {
    const tree = await freshTree("interactive");
    const r = await call("computer", { action: "left_click", tabId: tab, ref: refFor(tree, /link "Open popup"/) });
    await sleep(800);
    const ctx = await call("tabs_context", {});
    const tabs = parseTabs(ctx.text).tabs;
    const popup = tabs.find((t) => /popup\.html/.test(t.url));
    assert.ok(popup, `popup tab adopted; click said: ${r.text}; tabs: ${ctx.text}`);
    await call("tabs_close", { tabId: popup.tabId });
  });

  it("file_upload sets files on a file input", async () => {
    const file = path.join(mcp.tmp, "upload-me.txt");
    fs.writeFileSync(file, "hello upload");
    const tree = await freshTree("all");
    const r = await call("file_upload", { tabId: tab, ref: refFor(tree, /button "Upload file"/), paths: [file] });
    assert.match(r.text, /upload-me\.txt/);
    assert.equal(await js(tab, "document.getElementById('file').files[0].name"), "upload-me.txt");
    const missing = await call("file_upload", { tabId: tab, ref: refFor(tree, /button "Upload file"/), paths: ["/nope/missing.txt"] }, { expectError: true });
    assert.match(missing.text, /File not found/);
  });

  it("resize_window changes the viewport", async () => {
    const r = await call("resize_window", { tabId: tab, width: 1000, height: 700 });
    assert.match(r.text, /Viewport is now \d+x\d+/);
    const w = Number(await js(tab, "outerWidth"));
    assert.ok(Math.abs(w - 1000) <= 40, `outerWidth ${w}`);
  });

  it("gif_creator records actions and exports a GIF", async () => {
    await call("gif_creator", { action: "start_recording", tabId: tab });
    const tree = await freshTree("interactive");
    await call("computer", { action: "left_click", tabId: tab, ref: refFor(tree, /button "Click me"/) });
    await call("computer", { action: "screenshot", tabId: tab });
    await call("gif_creator", { action: "stop_recording", tabId: tab });
    const r = await call("gif_creator", { action: "export", tabId: tab, filename: "e2e.gif" });
    const file = r.text.match(/to (.+\.gif)/)[1];
    const head = fs.readFileSync(file).subarray(0, 6).toString();
    assert.equal(head, "GIF89a");
    assert.match(r.text, /\d+-frame GIF/);
  });

  it("browser_batch runs several actions in order", async () => {
    const tree = await freshTree("interactive");
    const before = Number(await js(tab, "document.getElementById('count').textContent"));
    const r = await call("browser_batch", {
      actions: [
        { tool: "computer", input: { action: "left_click", tabId: tab, ref: refFor(tree, /button "Click me"/) } },
        { tool: "computer", input: { action: "left_click", tabId: tab, ref: refFor(tree, /button "Click me"/) } },
        { tool: "javascript_tool", input: { tabId: tab, text: "document.getElementById('count').textContent" } },
        { tool: "computer", input: { action: "screenshot", tabId: tab } },
      ],
    });
    assert.match(r.text, new RegExp(`\\[3\\] javascript_tool: ${before + 2}`));
    assert.equal(r.images.length, 1);
    const bad = await call("browser_batch", { actions: [{ tool: "computer", input: { action: "left_click", tabId: 9999, coordinate: [1, 1] } }] }, { expectError: true });
    assert.match(bad.text, /Tab 9999 not found/);
  });

  it("refs go stale after navigation with a helpful error", async () => {
    const tree = await freshTree("interactive");
    const ref = refFor(tree, /button "Click me"/);
    await call("navigate", { tabId: tab, url: `${base}/main.html?reload=1` });
    const r = await call("computer", { action: "left_click", tabId: tab, ref }, { expectError: true });
    assert.match(r.text, /Stale ref/);
  });

  it("tabs_close refuses tabs Claude did not open unless forced, and errors on unknown tabs", async () => {
    const all = parseTabs((await call("tabs_context", { all: true })).text);
    const foreign = all.tabs.find((t) => !t.openedByClaude);
    if (foreign) {
      const r = await call("tabs_close", { tabId: foreign.tabId }, { expectError: true });
      assert.match(r.text, /not opened by Claude/);
    }
    await call("tabs_close", { tabId: tab });
    const gone = await call("computer", { action: "screenshot", tabId: tab }, { expectError: true });
    assert.match(gone.text, /not found/);
  });

  it("navigate without tabId creates a tab and lists tabs", async () => {
    // Close every Claude tab so navigate has to create one.
    const mine = parseTabs((await call("tabs_context", {})).text).tabs;
    for (const t of mine) await call("tabs_close", { tabId: t.tabId });
    const r = await call("navigate", { url: `${base}/popup.html` });
    assert.match(r.text, /Created tab \d+/);
    assert.match(r.text, /Tabs: \[/);
    const id = Number(r.text.match(/Created tab (\d+)/)[1]);
    const again = await call("navigate", { url: `${base}/main.html` });
    assert.match(again.text, new RegExp(`Tab ${id}: .*CFZ Test Page`), "reuses Claude's tab");
    await call("tabs_close", { tabId: id });
  });

  it("navigation errors are explained and bare host:port URLs get http://", async () => {
    const r = await call("tabs_create", {});
    const id = Number(r.text.match(/Created tab (\d+)/)[1]);
    const bad = await call("navigate", { tabId: id, url: "https://this-host-does-not-exist.invalid/" }, { expectError: true });
    assert.match(bad.text, /could not be found|NS_ERROR_UNKNOWN_HOST/);
    const bare = await call("navigate", { tabId: id, url: base.replace("http://", "") + "/popup.html" });
    assert.match(bare.text, /Popup Page/);
    await call("tabs_close", { tabId: id });
  });

  it("recovers when Zen is killed: the next call relaunches it", { skip: process.platform === "win32" }, async () => {
    const out = execFileSync("ps", ["-eww", "-o", "pid=,command="], { encoding: "utf8" });
    const pids = out
      .split("\n")
      .filter((l) => l.includes(mcp.env.ZEN_PROFILE) && /-profile/.test(l) && !/-parentBuildID|plugin-container|helper/i.test(l))
      .map((l) => Number(l.trim().split(/\s+/)[0]));
    assert.ok(pids.length >= 1, "found the browser process");
    for (const pid of pids) process.kill(pid, "SIGKILL");
    await sleep(2000);
    const r = await call("tabs_create", { url: `${base}/popup.html` });
    assert.match(r.text, /Popup Page/);
    const id = Number(r.text.match(/Created tab (\d+)/)[1]);
    await call("tabs_close", { tabId: id });
  });
});
