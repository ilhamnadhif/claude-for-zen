// MCP server exposing Claude-in-Chrome style browser tools for Zen.

import fs from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ZenBrowser, UserError } from "./browser.js";
import { BidiError, BidiTimeoutError } from "./bidi.js";
import { loadConfig } from "./config.js";
import { GifRecording } from "./gif.js";
import { encodePng, resize } from "./image.js";
import { parseKeySequence, parseModifiers, keyActionsForSequence, keyActionsForText } from "./keys.js";
import { formatRemoteValue, formatException } from "./remote-value.js";
import { toReplExpression } from "./repl.js";
import { VERSION } from "./version.js";
import { redactUrl, formatBytes, timeOf, normalizeUrl } from "./util.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const INSTRUCTIONS = `Tools for controlling the Zen web browser (Firefox-based) on the user's computer, equivalent to Claude in Chrome.

Workflow:
- Call tabs_context first. Each conversation should open its own tab with tabs_create (or navigate without a tabId) instead of reusing tabs, unless the user asks to work in an existing tab.
- Look before acting: take a screenshot (computer action "screenshot") or use read_page / find to get element refs. Prefer clicking by ref; refs survive scrolling and work inside iframes.
- Screenshot coordinates: every screenshot reports its WxH frame; pass coordinates in that frame.
- Close tabs you opened with tabs_close when you are finished, unless the user wants them kept.
- If a tool reports an open JavaScript dialog (alert/confirm/prompt), resolve it with handle_dialog before anything else.
- Never enter passwords, payment details or other secrets on the user's behalf, and confirm with the user before irreversible actions (sending, purchasing, deleting, submitting).`;

function text(t) {
  return { type: "text", text: t };
}

function image(buf, mimeType = "image/jpeg") {
  return { type: "image", data: buf.toString("base64"), mimeType };
}

function fmtPoint([x, y]) {
  return `(${Math.round(x)}, ${Math.round(y)})`;
}

function compileRegex(pattern) {
  if (!pattern) return null;
  try {
    return new RegExp(pattern, "i");
  } catch (e) {
    throw new UserError(`Invalid regex pattern: ${e.message}`);
  }
}

const tabIdSchema = z.coerce.number().int().describe("Tab ID from tabs_context / tabs_create.");
const pointSchema = z.array(z.coerce.number()).length(2);

export function createServer(config = loadConfig(), { log } = {}) {
  const logger = log || ((m) => config.debug && process.stderr.write(`[claude-for-zen] ${m}\n`));
  const browser = new ZenBrowser(config, (m) => logger(m));
  const recordings = new Map(); // tabId → GifRecording

  const server = new McpServer({ name: "claude-for-zen", version: VERSION }, { instructions: INSTRUCTIONS });

  // One tool call at a time: input actions must never interleave.
  let queue = Promise.resolve();
  const serialize = (fn) => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => {});
    return run;
  };

  const handlers = {};

  function errorResult(e) {
    if (e instanceof UserError || e?.userFacing) return { content: [text(e.message)], isError: true };
    if (e instanceof BidiTimeoutError) return { content: [text(`The browser did not respond in time (${e.message}).`)], isError: true };
    if (e instanceof BidiError) return { content: [text(`Browser error: ${e.message}`)], isError: true };
    logger(`unexpected error: ${e?.stack || e}`);
    return { content: [text(`Error: ${e?.message || e}`)], isError: true };
  }

  function register(name, def, handler) {
    handlers[name] = handler;
    server.registerTool(name, def, (args) =>
      serialize(async () => {
        try {
          return await handler(args || {});
        } catch (e) {
          return errorResult(e);
        }
      }),
    );
  }

  async function recordFrame(tabId, top, marker) {
    const rec = recordings.get(Number(tabId));
    if (!rec || !rec.recording) return;
    try {
      const shot = await browser.screenshot(top);
      rec.addFrame(shot.frame, { marker });
    } catch (e) {
      logger(`gif frame failed: ${e.message}`);
    }
  }

  function ownedSnapshot() {
    return new Set([...browser.owned].filter((c) => browser.topLevel.has(c)));
  }

  async function afterAction(top, before, startedAt) {
    // Give handlers a moment; if the action started a navigation, wait for it.
    await sleep(120);
    const notes = [];
    const nav = browser.navStart.get(top) || 0;
    if (nav >= startedAt - 50) {
      await browser.waitForLoad(top, 8000);
      notes.push(`The page navigated to ${redactUrl(browser.urls.get(top) || "")}.`);
    }
    const p = browser.promptFor(top);
    if (p) notes.push(`A ${p.type} dialog opened: ${JSON.stringify(p.message)}. Use handle_dialog to accept or dismiss it.`);
    if (before) {
      for (const c of ownedSnapshot()) {
        if (!before.has(c)) notes.push(`A new tab opened (tabId ${browser.tabIdFor(c)}).`);
      }
    }
    return notes.length ? " " + notes.join(" ") : "";
  }

  // ------------------------------------------------------------------ tabs

  register(
    "tabs_context",
    {
      title: "List Zen tabs",
      description:
        "Get the tabs Claude is working with in Zen. Returns tab IDs, titles and URLs. CRITICAL: call this at least once before other browser tools so you know which tabs exist. " +
        "Each new conversation should create its own tab (tabs_create) rather than reuse tabs, unless the user explicitly asks to use an existing tab. Pass all=true to list every open tab in the browser.",
      inputSchema: {
        createIfEmpty: z.boolean().optional().describe("If Claude has no tabs yet, open a new empty tab for this conversation."),
        all: z.boolean().optional().describe("List every open tab in the browser, not only the tabs Claude opened."),
      },
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    async ({ createIfEmpty, all }) => {
      let res = await browser.listTabs({ all: !!all });
      let created = null;
      if (createIfEmpty && !res.tabs.some((t) => t.owned)) {
        created = await browser.createTab();
        res = await browser.listTabs({ all: !!all });
      }
      const payload = {
        tabs: res.tabs.map((t) => ({ tabId: t.tabId, title: t.title, url: redactUrl(t.url), ...(all ? { openedByClaude: t.owned } : {}) })),
        totalOpenTabs: res.totalOpen,
      };
      let note = "";
      if (created != null) note = `\nCreated tab ${created} for this conversation.`;
      else if (!res.tabs.length) note = "\nNo Claude tabs yet. Use tabs_create (or tabs_context with createIfEmpty) to open one.";
      return { content: [text(JSON.stringify(payload, null, 2) + note)] };
    },
  );

  register(
    "tabs_create",
    {
      title: "Open a new Zen tab",
      description:
        "Open a new tab for this conversation and return its tab ID. Tabs you create are yours to clean up: close each one with tabs_close when you no longer need it, unless the user wants it kept open.",
      inputSchema: {
        url: z.string().optional().describe("Optional URL to load in the new tab."),
      },
    },
    async ({ url }) => {
      const tabId = await browser.createTab(url ? normalizeUrl(url) : undefined);
      const top = await browser.contextFor(tabId);
      const info = await browser.tabSummary(top);
      return { content: [text(`Created tab ${tabId}.${url ? ` Loaded ${redactUrl(info.url)} — "${info.title}".` : ""}`)] };
    },
  );

  register(
    "tabs_close",
    {
      title: "Close a Zen tab",
      description: "Close a tab Claude opened. Use it to clean up tabs you are done with. Closing a tab Claude did not open requires force=true and should only be done when the user asks.",
      inputSchema: {
        tabId: tabIdSchema,
        force: z.boolean().optional().describe("Allow closing a tab that Claude did not open (only when the user asked)."),
      },
      annotations: { destructiveHint: true },
    },
    async ({ tabId, force }) => {
      const top = await browser.contextFor(tabId);
      if (!browser.owned.has(top) && !force) {
        throw new UserError(`Tab ${tabId} was not opened by Claude in this session. Only close it if the user asked (pass force=true).`);
      }
      await browser.closeTab(top);
      recordings.delete(Number(tabId));
      return { content: [text(`Closed tab ${tabId}.`)] };
    },
  );

  // ------------------------------------------------------------- navigation

  register(
    "navigate",
    {
      title: "Navigate",
      description:
        'Navigate a tab to a URL, or go "back"/"forward" in its history. If tabId is omitted for a URL, Claude\'s first tab is used (one is created if needed) and the tab list is appended to the result. ' +
        "A tab opened for you this way is yours to clean up with tabs_close.",
      inputSchema: {
        url: z.string().describe('URL to load (protocol optional, defaults to https://), or "back" / "forward".'),
        tabId: tabIdSchema.optional(),
      },
    },
    async ({ url, tabId: requestedTab }) => {
      const dir = String(url).trim().toLowerCase();
      let tabId = requestedTab;
      let top;
      let createdNote = "";
      if (tabId == null) {
        if (dir === "back" || dir === "forward") throw new UserError('tabId is required for "back"/"forward".');
        const list = await browser.listTabs();
        const mine = list.tabs.find((t) => t.owned);
        tabId = mine ? mine.tabId : await browser.createTab();
        if (!mine) createdNote = `Created tab ${tabId}. `;
      }
      top = await browser.contextFor(tabId);
      let note = "";
      if (dir === "back" || dir === "forward") {
        await browser.traverse(top, dir === "back" ? -1 : 1);
      } else {
        const r = await browser.navigate(top, normalizeUrl(url));
        if (r.timedOut) note = " The page is still loading (gave up waiting); take a screenshot to check its state.";
      }
      const p = browser.promptFor(top);
      if (p) note += ` A ${p.type} dialog is open: ${JSON.stringify(p.message)} — use handle_dialog.`;
      const info = await browser.tabSummary(top).catch(() => ({ title: "", url: "" }));
      await recordFrame(tabId, top);
      let out = `${createdNote}Tab ${tabId}: ${redactUrl(info.url)} — "${info.title}".${note}`;
      if (requestedTab == null) {
        const list = await browser.listTabs();
        out += `\n\nTabs: ${JSON.stringify(list.tabs.map((t) => ({ tabId: t.tabId, title: t.title, url: redactUrl(t.url) })))}`;
      }
      return { content: [text(out)] };
    },
  );

  // --------------------------------------------------------------- computer

  register(
    "computer",
    {
      title: "Mouse, keyboard and screenshots",
      description:
        "Use a mouse and keyboard to interact with the page in a Zen tab, and take screenshots. If you don't have a valid tab ID, use tabs_context first.\n" +
        "* Before clicking, consult a screenshot to find coordinates, or use a ref from read_page/find (preferred: refs are scrolled into view automatically and work inside iframes).\n" +
        "* Click in the centre of elements, not on their edges.\n" +
        "* Coordinates are in the pixel frame of the latest screenshot (its size is reported with every screenshot).",
      inputSchema: {
        action: z
          .enum(["left_click", "right_click", "double_click", "triple_click", "type", "key", "screenshot", "wait", "scroll", "scroll_to", "left_click_drag", "hover", "zoom"])
          .describe(
            "left_click/right_click/double_click/triple_click: click at coordinate or ref. type: type text. key: press keys (space separated, e.g. \"ctrl+a Backspace\"; use cmd on macOS). " +
              "screenshot: capture the viewport. wait: pause for duration seconds. scroll: wheel-scroll at coordinate. scroll_to: scroll a ref into view. " +
              "left_click_drag: drag from start_coordinate to coordinate. hover: move the mouse to coordinate or ref. zoom: capture a region at full resolution.",
          ),
        tabId: tabIdSchema,
        coordinate: pointSchema.optional().describe("(x, y) in screenshot pixels. Required for coordinate clicks and scroll; end point for left_click_drag."),
        start_coordinate: pointSchema.optional().describe("(x, y) start point for left_click_drag."),
        ref: z.string().optional().describe('Element ref from read_page/find (e.g. "ref_12"). Alternative to coordinate for clicks/hover; required for scroll_to.'),
        text: z.string().optional().describe("Text to type (type) or keys to press (key)."),
        modifiers: z.string().optional().describe('Modifier keys held during a click: "ctrl", "shift", "alt", "cmd"/"meta", combinable with "+" (e.g. "ctrl+shift").'),
        scroll_direction: z.enum(["up", "down", "left", "right"]).optional(),
        scroll_amount: z.coerce.number().min(1).max(30).optional().describe("Wheel ticks (default 3, ≈100px each)."),
        duration: z.coerce.number().min(0).max(10).optional().describe("Seconds to wait (wait action, max 10)."),
        repeat: z.coerce.number().int().min(1).max(100).optional().describe("Repeat count for key."),
        region: z.array(z.coerce.number()).length(4).optional().describe("(x0, y0, x1, y1) region for zoom, in screenshot pixels."),
        scale: z.coerce.number().min(0.1).max(1).optional().describe("screenshot/zoom: shrink the returned image (coordinates stay in the full frame)."),
        save_to_disk: z.boolean().optional().describe("screenshot/zoom: also save the image to disk and return its path."),
        action_summary: z.string().optional().describe("A few words describing the effect of this action (shown in logs)."),
      },
    },
    async (a) => {
      const top = await browser.contextFor(a.tabId);
      if (a.action_summary) logger(`tab ${a.tabId}: ${a.action_summary}`);
      const act = a.action;

      if (act === "screenshot") {
        const shot = await browser.screenshot(top, { scale: a.scale });
        const jpeg = ZenBrowser.jpeg(shot.out, 80);
        const rec = recordings.get(Number(a.tabId));
        if (rec?.recording) rec.addFrame(shot.frame);
        let msg = `Screenshot of tab ${a.tabId} — ${shot.frameW}x${shot.frameH} frame (use this frame for coordinates). ${redactUrl(shot.vp.url)}`;
        if (shot.outW !== shot.frameW) msg += `\nImage shrunk to ${shot.outW}x${shot.outH}; coordinates remain in the ${shot.frameW}x${shot.frameH} frame.`;
        const p = browser.promptFor(top);
        if (p) msg += `\nA ${p.type} dialog is open: ${JSON.stringify(p.message)}.`;
        if (a.save_to_disk) msg += `\nSaved to ${saveImage(jpeg, "screenshot", "jpg")}`;
        return { content: [text(msg), image(jpeg)] };
      }

      if (act === "zoom") {
        if (!a.region) throw new UserError("zoom requires region [x0, y0, x1, y1].");
        let img = await browser.zoom(top, a.region);
        const k = a.scale && a.scale < 1 ? a.scale : 1;
        if (k < 1) img = resize(img, img.width * k, img.height * k);
        const png = encodePng(img);
        let msg = `Zoomed region ${JSON.stringify(a.region)} of tab ${a.tabId} (${img.width}x${img.height}). Do not use this image's pixels as click coordinates.`;
        if (a.save_to_disk) msg += `\nSaved to ${saveImage(png, "zoom", "png")}`;
        return { content: [text(msg), image(png, "image/png")] };
      }

      if (act === "wait") {
        const secs = Math.min(10, Math.max(0, a.duration ?? 1));
        await sleep(secs * 1000);
        return { content: [text(`Waited ${secs}s.`)] };
      }

      const vp = await browser.prepareTab(top);
      const before = ownedSnapshot();
      const startedAt = Date.now();

      // Resolve a ref or screenshot coordinate to {ctx, x, y} (point in ctx's viewport),
      // routing into the iframe under the point so out-of-process frames get the input.
      const resolveTarget = async () => {
        if (a.ref) {
          const p = await browser.refPoint(top, a.ref);
          const frame = await browser.toFrame(top, [p.absX, p.absY]);
          const note = p.occludedBy ? ` Warning: ${p.target} may be covered by ${p.occludedBy}.` : "";
          return { ctx: p.ctx, x: p.x, y: p.y, frame, label: `${a.ref} (${p.target})`, note };
        }
        if (a.coordinate) {
          const [vx, vy] = await browser.toViewport(top, a.coordinate, vp);
          const route = await browser.routePoint(top, vx, vy);
          let label = fmtPoint(a.coordinate);
          try {
            const d = await browser.runtime(route.ctx, "describeAt", { x: route.x, y: route.y });
            label += ` on ${d.target}${route.ctx !== top ? " (in iframe)" : ""}`;
          } catch {}
          return { ...route, frame: a.coordinate, label, note: "" };
        }
        throw new UserError(`${act} requires coordinate or ref.`);
      };

      switch (act) {
        case "left_click":
        case "right_click":
        case "double_click":
        case "triple_click": {
          const t = await resolveTarget();
          const button = act === "right_click" ? 2 : 0;
          const count = act === "double_click" ? 2 : act === "triple_click" ? 3 : 1;
          const modifiers = parseModifiers(a.modifiers);
          await browser.click(t, { button, count, modifiers, vp });
          const notes = await afterAction(top, before, startedAt);
          await recordFrame(a.tabId, top, { x: t.frame[0], y: t.frame[1] });
          const verb = { left_click: "Clicked", right_click: "Right-clicked", double_click: "Double-clicked", triple_click: "Triple-clicked" }[act];
          return { content: [text(`${verb}${a.modifiers ? ` with ${a.modifiers}` : ""} ${t.label}.${t.note}${notes}`)] };
        }
        case "hover": {
          const t = await resolveTarget();
          await browser.hover(t, vp);
          await sleep(150);
          await recordFrame(a.tabId, top, { x: t.frame[0], y: t.frame[1] });
          return { content: [text(`Moved the mouse to ${t.label}.${t.note}`)] };
        }
        case "type": {
          if (a.text == null) throw new UserError("type requires text.");
          await browser.keyActions(top, keyActionsForText(a.text));
          const notes = await afterAction(top, before, startedAt);
          await recordFrame(a.tabId, top);
          return { content: [text(`Typed ${Array.from(a.text).length} characters.${notes}`)] };
        }
        case "key": {
          if (!a.text) throw new UserError('key requires text, e.g. "Enter" or "ctrl+a".');
          const seq = parseKeySequence(a.text);
          await browser.keyActions(top, keyActionsForSequence(seq, a.repeat || 1));
          const notes = await afterAction(top, before, startedAt);
          await recordFrame(a.tabId, top);
          return { content: [text(`Pressed ${a.text}${a.repeat > 1 ? ` ×${a.repeat}` : ""}.${notes}`)] };
        }
        case "scroll": {
          const dir = a.scroll_direction;
          if (!dir) throw new UserError("scroll requires scroll_direction.");
          const ticks = a.scroll_amount ?? 3;
          let t;
          if (a.coordinate || a.ref) t = await resolveTarget();
          else t = { ctx: top, x: vp.w / 2, y: vp.h / 2, frame: await browser.toFrame(top, [vp.w / 2, vp.h / 2]) };
          const px = ticks * 100;
          const dx = dir === "left" ? -px : dir === "right" ? px : 0;
          const dy = dir === "up" ? -px : dir === "down" ? px : 0;
          await browser.scroll(t, dx, dy, vp);
          await sleep(250);
          const after = await browser.runtime(top, "viewport");
          await recordFrame(a.tabId, top);
          const moved = Math.round(after.sx) !== Math.round(vp.sx) || Math.round(after.sy) !== Math.round(vp.sy);
          return {
            content: [
              text(
                `Scrolled ${dir} ${ticks} ticks at ${fmtPoint(t.frame)}. ` +
                  `Page scroll position: ${Math.round(after.sx)},${Math.round(after.sy)} (page ${after.sw}x${after.sh}).` +
                  (moved ? "" : " The page itself did not scroll (an inner scrollable element or iframe may have, or the end was reached)."),
              ),
            ],
          };
        }
        case "scroll_to": {
          if (!a.ref) throw new UserError("scroll_to requires ref.");
          const p = await browser.refPoint(top, a.ref);
          await recordFrame(a.tabId, top);
          const frame = await browser.toFrame(top, [p.absX, p.absY]);
          return { content: [text(`Scrolled ${a.ref} (${p.target}) into view; its centre is now at ${fmtPoint(frame)}.`)] };
        }
        case "left_click_drag": {
          if (!a.start_coordinate || !a.coordinate) throw new UserError("left_click_drag requires start_coordinate and coordinate.");
          const from = await browser.toViewport(top, a.start_coordinate, vp);
          const to = await browser.toViewport(top, a.coordinate, vp);
          const route = await browser.routePoint(top, from[0], from[1]);
          // Both points are expressed in the start point's frame.
          const ox = route.x - from[0];
          const oy = route.y - from[1];
          await browser.drag(route.ctx, [route.x, route.y], [to[0] + ox, to[1] + oy], vp);
          const notes = await afterAction(top, before, startedAt);
          await recordFrame(a.tabId, top, { x: a.coordinate[0], y: a.coordinate[1] });
          return { content: [text(`Dragged from ${fmtPoint(a.start_coordinate)} to ${fmtPoint(a.coordinate)}.${notes}`)] };
        }
        default:
          throw new UserError(`Unknown action ${act}`);
      }
    },
  );

  function saveImage(buf, kind, ext) {
    fs.mkdirSync(config.screenshotDir, { recursive: true });
    const file = path.join(config.screenshotDir, `${kind}-${new Date().toISOString().replace(/[:.]/g, "-")}.${ext}`);
    fs.writeFileSync(file, buf);
    return file;
  }

  // ------------------------------------------------------------ page reading

  register(
    "read_page",
    {
      title: "Read page structure",
      description:
        "Get an accessibility-tree style outline of the page with element refs (ref_N) usable by computer, form_input, scroll_to and file_upload. Includes the contents of iframes. " +
        "By default returns all elements (non-visible ones are marked hidden); filter='interactive' returns only visible buttons/links/inputs. Output is limited to max_chars (default 50000).",
      inputSchema: {
        tabId: tabIdSchema,
        filter: z.enum(["interactive", "all"]).optional().describe('"interactive" for visible buttons/links/inputs only, "all" (default) for everything.'),
        depth: z.coerce.number().int().min(1).max(100).optional().describe("Maximum tree depth (default 15)."),
        ref_id: z.string().optional().describe("Only return this element and its descendants."),
        max_chars: z.coerce.number().int().min(1000).optional().describe("Maximum output characters (default 50000)."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ tabId, filter, depth, ref_id, max_chars }) => {
      const top = await browser.contextFor(tabId);
      const out = await browser.readPage(top, { filter: filter || "all", depth: depth || 15, refId: ref_id, maxChars: max_chars || 50000 });
      return { content: [text(out)] };
    },
  );

  register(
    "find",
    {
      title: "Find elements",
      description:
        'Find elements by what they are or what they say (e.g. "search bar", "login button", "add to cart", "price"). Matches roles, labels, placeholders, text and attributes, including inside iframes. ' +
        "Returns up to 20 matches with refs usable by other tools.",
      inputSchema: {
        tabId: tabIdSchema,
        query: z.string().describe('What to look for, e.g. "search bar" or "Sign in button".'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ tabId, query }) => {
      const top = await browser.contextFor(tabId);
      const res = await browser.findElements(top, query, 20);
      if (!res.matches.length) {
        return { content: [text(`No elements found matching ${JSON.stringify(query)}. Try different words, read_page with filter="interactive", or a screenshot.`)] };
      }
      let out = res.matches.join("\n");
      if (res.total > res.matches.length) out += `\n\n(${res.total} matches; showing the best ${res.matches.length}. Use a more specific query to narrow it down.)`;
      return { content: [text(out)] };
    },
  );

  register(
    "get_page_text",
    {
      title: "Get page text",
      description: "Extract the readable text of the page (prioritising the main article content) as plain text. Ideal for reading articles and text-heavy pages.",
      inputSchema: {
        tabId: tabIdSchema,
        max_chars: z.coerce.number().int().min(1000).optional().describe("Maximum characters (default 100000)."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ tabId, max_chars }) => {
      const top = await browser.contextFor(tabId);
      browser.assertNoPrompt(top);
      const r = await browser.runtime(top, "pageText", { maxChars: max_chars || 100000 });
      let out = `Title: ${r.title}\nURL: ${redactUrl(r.url)}\nSource: <${r.source}>\n\n${r.text || "(no text)"}`;
      if (r.truncated) out += `\n\n[Truncated: showing ${max_chars || 100000} of ${r.length} characters.]`;
      return { content: [text(out)] };
    },
  );

  // -------------------------------------------------------------- forms

  register(
    "form_input",
    {
      title: "Set a form value",
      description:
        "Set the value of a form element by ref (from read_page/find): text inputs and textareas (string), selects (option value or visible text), checkboxes/radios/switches (boolean), contenteditable editors (string). " +
        "Fires the input/change events frameworks like React and Vue listen to.",
      inputSchema: {
        tabId: tabIdSchema,
        ref: z.string().describe('Element ref, e.g. "ref_7".'),
        value: z.union([z.string(), z.boolean(), z.number()]).describe("Value to set."),
        action_summary: z.string().optional(),
      },
    },
    async ({ tabId, ref, value }) => {
      const top = await browser.contextFor(tabId);
      browser.assertNoPrompt(top);
      const r = browser.resolveRef(top, ref);
      const res = await browser.runtime(r.context, "formInput", { id: r.localId, token: r.token, value });
      await recordFrame(tabId, top);
      return { content: [text(res.message)] };
    },
  );

  register(
    "file_upload",
    {
      title: "Upload files",
      description: "Set the files of an <input type=file> element (by ref) to local file paths, as if the user picked them. Use computer screenshot save_to_disk to upload a screenshot.",
      inputSchema: {
        tabId: tabIdSchema,
        ref: z.string().describe("Ref of the file input."),
        paths: z.array(z.string()).min(1).describe("Absolute paths of local files."),
      },
    },
    async ({ tabId, ref, paths }) => {
      const top = await browser.contextFor(tabId);
      browser.assertNoPrompt(top);
      const files = paths.map((p) => path.resolve(p));
      for (const f of files) {
        if (!fs.existsSync(f) || !fs.statSync(f).isFile()) throw new UserError(`File not found: ${f}`);
      }
      await browser.setFiles(top, ref, files);
      return { content: [text(`Set ${files.length} file(s) on ${ref}: ${files.map((f) => path.basename(f)).join(", ")}`)] };
    },
  );

  // --------------------------------------------------------- javascript

  register(
    "javascript_tool",
    {
      title: "Run JavaScript",
      description:
        "Execute JavaScript in the page's context (DOM, window, page variables). REPL semantics: top-level await works and the value of the last expression is returned — write the expression you want " +
        "(e.g. `document.title` or `await fetch(url).then(r => r.json())`) rather than `return ...`.",
      inputSchema: {
        tabId: tabIdSchema,
        text: z.string().describe("JavaScript code to run."),
        action: z.string().optional().describe("'javascript_exec' (accepted for compatibility)."),
      },
    },
    async ({ tabId, text: code }) => {
      const top = await browser.contextFor(tabId);
      browser.assertNoPrompt(top);
      let expr;
      try {
        expr = toReplExpression(code);
      } catch (e) {
        throw new UserError(`SyntaxError: ${e.message}`);
      }
      const evalPromise = browser.evaluate(top, expr, { awaitPromise: true, userActivation: true, timeoutMs: 30000 });
      let res;
      for (;;) {
        const r = await Promise.race([evalPromise.then((v) => ({ v }), (err) => ({ err })), sleep(200).then(() => null)]);
        if (r) {
          if (r.err) {
            if (r.err instanceof BidiTimeoutError) throw new UserError("The script did not finish within 30 seconds.");
            throw r.err;
          }
          res = r.v;
          break;
        }
        const p = browser.promptFor(top);
        if (p) {
          evalPromise.catch(() => {});
          return { content: [text(`The script opened a ${p.type} dialog: ${JSON.stringify(p.message)}. Use handle_dialog to accept or dismiss it; the script resumes afterwards.`)] };
        }
      }
      if (res.type === "exception") return { content: [text(`Error: ${formatException(res.exceptionDetails)}`)], isError: true };
      let out = formatRemoteValue(res.result);
      if (out.length > 50000) out = out.slice(0, 50000) + `\n[Truncated: ${out.length} characters]`;
      return { content: [text(out)] };
    },
  );

  // ----------------------------------------------------- console / network

  register(
    "read_console_messages",
    {
      title: "Read console messages",
      description:
        "Read console messages (console.log/warn/error, uncaught exceptions) from a tab, captured while connected. Messages from a previous site are dropped when the tab navigates to another origin. " +
        "Always provide a pattern to filter out noise.",
      inputSchema: {
        tabId: tabIdSchema,
        pattern: z.string().optional().describe("Case-insensitive regex the message must match."),
        onlyErrors: z.boolean().optional().describe("Only errors and uncaught exceptions."),
        clear: z.boolean().optional().describe("Clear the returned messages after reading."),
        limit: z.coerce.number().int().min(1).max(2000).optional().describe("Maximum messages (default 100, most recent)."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ tabId, pattern, onlyErrors, clear, limit }) => {
      const top = await browser.contextFor(tabId);
      const re = compileRegex(pattern);
      let entries = browser.consoleFor(top);
      if (onlyErrors) entries = entries.filter((e) => e.level === "error" || e.type === "exception");
      if (re) entries = entries.filter((e) => re.test(e.text) || re.test(e.where));
      const n = limit || 100;
      const shown = entries.slice(-n);
      if (clear) browser.clearConsole(top);
      if (!shown.length) {
        return { content: [text(`No console messages${pattern ? ` matching /${pattern}/i` : ""}${onlyErrors ? " (errors only)" : ""}. Messages are captured while claude-for-zen is connected; reload the page to capture messages logged during load.`)] };
      }
      const lines = shown.map((e) => `[${timeOf(e.ts)}] [${e.type === "exception" ? "exception" : e.level}]${e.frame ? " [iframe]" : ""} ${e.text}${e.where ? `  (${e.where})` : ""}`);
      let out = lines.join("\n");
      if (entries.length > shown.length) out += `\n(${entries.length - shown.length} older messages not shown)`;
      return { content: [text(out)] };
    },
  );

  register(
    "read_network_requests",
    {
      title: "Read network requests",
      description:
        "Read HTTP requests (documents, XHR/fetch, scripts, images, …) made by a tab, including cross-origin ones, captured while connected. Requests from a previous site are dropped when the tab navigates to another origin. " +
        "Sensitive query values are shown as REDACTED.",
      inputSchema: {
        tabId: tabIdSchema,
        urlPattern: z.string().optional().describe('Substring the URL must contain, e.g. "/api/".'),
        clear: z.boolean().optional().describe("Clear the returned requests after reading."),
        limit: z.coerce.number().int().min(1).max(2000).optional().describe("Maximum requests (default 100, most recent)."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ tabId, urlPattern, clear, limit }) => {
      const top = await browser.contextFor(tabId);
      let entries = browser.networkFor(top).map((e) => ({ ...e, shownUrl: redactUrl(e.url) }));
      if (urlPattern) entries = entries.filter((e) => e.shownUrl.includes(urlPattern) || e.url.includes(urlPattern));
      const n = limit || 100;
      const shown = entries.slice(-n);
      if (clear) browser.clearNetwork(top);
      if (!shown.length) {
        return { content: [text(`No network requests${urlPattern ? ` matching "${urlPattern}"` : ""}. Requests are captured while claude-for-zen is connected; reload the page to capture requests made during load.`)] };
      }
      const lines = shown.map((e) => {
        const status = e.error ? `FAILED (${e.error})` : e.status == null ? "pending" : `${e.status}${e.statusText ? " " + e.statusText : ""}`;
        const meta = [e.type, e.mimeType, formatBytes(e.size), e.fromCache ? "cache" : ""].filter(Boolean).join(", ");
        return `${e.method} ${status} ${e.shownUrl}${meta ? `  (${meta})` : ""}`;
      });
      let out = lines.join("\n");
      if (entries.length > shown.length) out += `\n(${entries.length - shown.length} older requests not shown)`;
      return { content: [text(out)] };
    },
  );

  // ----------------------------------------------------------------- dialogs

  register(
    "handle_dialog",
    {
      title: "Handle a JavaScript dialog",
      description: "Accept or dismiss an open alert/confirm/prompt/beforeunload dialog in a tab. For prompt dialogs, text is entered before accepting.",
      inputSchema: {
        tabId: tabIdSchema,
        action: z.enum(["accept", "dismiss"]),
        text: z.string().optional().describe("Text to enter into a prompt() dialog before accepting."),
      },
    },
    async ({ tabId, action, text: userText }) => {
      const top = await browser.contextFor(tabId);
      const p = await browser.handlePrompt(top, action === "accept", userText);
      await sleep(150);
      return { content: [text(`${action === "accept" ? "Accepted" : "Dismissed"} the ${p.type} dialog ${JSON.stringify(p.message)}.`)] };
    },
  );

  // ---------------------------------------------------------------- window

  register(
    "resize_window",
    {
      title: "Resize window",
      description: "Resize the Zen window containing a tab (outer size in pixels), e.g. to test responsive layouts.",
      inputSchema: {
        tabId: tabIdSchema,
        width: z.coerce.number().int().min(200).max(10000),
        height: z.coerce.number().int().min(200).max(10000),
      },
    },
    async ({ tabId, width, height }) => {
      const top = await browser.contextFor(tabId);
      const vp = await browser.resizeWindow(top, width, height);
      return { content: [text(`Resized the window to ${width}x${height}. Viewport is now ${vp.w}x${vp.h}.`)] };
    },
  );

  // ------------------------------------------------------------------- gif

  register(
    "gif_creator",
    {
      title: "Record a GIF",
      description:
        "Record browser actions in a tab as an animated GIF. start_recording captures a frame after every action (clicks are marked); stop_recording stops; export writes the GIF to disk and returns its path; clear discards the recording. " +
        "Capture extra screenshots before and after important actions for smoother playback.",
      inputSchema: {
        action: z.enum(["start_recording", "stop_recording", "export", "clear"]),
        tabId: tabIdSchema,
        filename: z.string().optional().describe('File name for export, e.g. "checkout_flow.gif".'),
      },
    },
    async ({ action, tabId, filename }) => {
      const id = Number(tabId);
      const top = await browser.contextFor(id);
      if (action === "start_recording") {
        const rec = new GifRecording();
        recordings.set(id, rec);
        await recordFrame(id, top);
        return { content: [text(`Recording tab ${id}. Every action now adds a frame; call gif_creator stop_recording / export when done.`)] };
      }
      const rec = recordings.get(id);
      if (!rec) throw new UserError(`No recording for tab ${id}. Start one with action=start_recording.`);
      if (action === "clear") {
        recordings.delete(id);
        return { content: [text(`Discarded the recording for tab ${id}.`)] };
      }
      if (action === "stop_recording") {
        await recordFrame(id, top);
        rec.recording = false;
        return { content: [text(`Stopped recording tab ${id} (${rec.frames} frames). Use action=export to save it.`)] };
      }
      // export
      if (rec.recording) await recordFrame(id, top);
      rec.recording = false;
      if (!rec.frames) throw new UserError("The recording has no frames.");
      const bytes = rec.finish();
      recordings.delete(id);
      let name = (filename || `zen-recording-${new Date().toISOString().replace(/[:.]/g, "-")}.gif`).replace(/[\\/]/g, "_");
      if (!name.toLowerCase().endsWith(".gif")) name += ".gif";
      fs.mkdirSync(config.gifDir, { recursive: true });
      const file = path.join(config.gifDir, name);
      fs.writeFileSync(file, bytes);
      return { content: [text(`Saved ${rec.frames}-frame GIF (${formatBytes(bytes.length)}) to ${file}${rec.dropped ? ` (${rec.dropped} frames dropped after the frame limit)` : ""}.`)] };
    },
  );

  // ----------------------------------------------------------------- batch

  register(
    "browser_batch",
    {
      title: "Run several browser actions",
      description:
        "Run a short sequence of browser tool calls in order (e.g. click, type, key, screenshot) and return all their results. Stops at the first error. Every action needs an explicit tabId.",
      inputSchema: {
        actions: z
          .array(
            z.object({
              tool: z.string().describe('Tool name, e.g. "computer", "navigate", "form_input", "find".'),
              input: z.record(z.string(), z.any()).describe("That tool's arguments."),
            }),
          )
          .min(1)
          .max(25),
      },
    },
    async ({ actions }) => {
      const content = [];
      for (let i = 0; i < actions.length; i++) {
        const { tool, input } = actions[i];
        if (tool === "browser_batch" || !handlers[tool]) {
          content.push(text(`[${i + 1}] ${tool}: unknown or not allowed in a batch.`));
          return { content, isError: true };
        }
        let res;
        try {
          res = await handlers[tool](input || {});
        } catch (e) {
          res = errorResult(e);
        }
        for (const c of res.content) content.push(c.type === "text" ? text(`[${i + 1}] ${tool}: ${c.text}`) : c);
        if (res.isError) {
          content.push(text(`Batch stopped at action ${i + 1} of ${actions.length}.`));
          return { content, isError: true };
        }
      }
      return { content };
    },
  );

  return { server, browser, handlers };
}

export async function runStdioServer(config = loadConfig()) {
  const { server, browser } = createServer(config, {
    log: (m) => {
      if (config.debug || /^launch|^BiDi session|unexpected error/.test(m)) process.stderr.write(`[claude-for-zen] ${m}\n`);
    },
  });
  const transport = new StdioServerTransport();
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    await Promise.race([browser.shutdown(), sleep(3000)]);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.stdin.on("end", shutdown);
  process.stdin.on("close", shutdown);
  await server.connect(transport);
}
