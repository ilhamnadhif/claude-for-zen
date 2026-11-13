// Browser controller: owns the WebDriver BiDi session with Zen and exposes the
// primitives the MCP tools are built from.

import { BidiClient, BidiError, BidiTimeoutError } from "./bidi.js";
import { endpointUrl, defaultHome } from "./config.js";
import {
  launchBrowser,
  isPortOpen,
  findBinary,
  findDefaultProfile,
  findProfileOwner,
  findPortListener,
  processCommand,
  quitGracefully,
  waitForProfileRelease,
  restoresTabs,
  isZenBinary,
  CAN_RESTART_BROWSER,
  macBundleId,
  closeMacWindowByName,
  activateMacApp,
} from "./launcher.js";
import { installRuntime } from "./page/runtime.js";
import { KEY } from "./keys.js";
import { decodePng, encodeJpeg, fitScale, resize, MAX_EDGE, MAX_PIXELS } from "./image.js";
import { formatException } from "./remote-value.js";

const SANDBOX = "claude-for-zen";
const RUNTIME_SRC = installRuntime.toString();
const CALL_FN = `function (op, arg) {
  (${RUNTIME_SRC})();
  const a = arg ? JSON.parse(arg) : {};
  try { return JSON.stringify(globalThis.__cz[op](a)); }
  catch (e) { return JSON.stringify({ __error: String((e && e.message) || e) }); }
}`;
const ELEMENT_FN = `function (arg) { (${RUNTIME_SRC})(); return globalThis.__cz.elementOf(JSON.parse(arg)); }`;
const FRAME_WINDOW_FN = `function (arg) { (${RUNTIME_SRC})(); return globalThis.__cz.elementOf(JSON.parse(arg)).contentWindow; }`;

// Make navigator.webdriver report false, as it does for a person using the
// browser. The getter stays a native function (wrapped in a Proxy), so pages
// see the same shape as in a normal session.
const HIDE_WEBDRIVER_FN = `() => {
  try {
    const proto = Object.getPrototypeOf(navigator);
    const desc = Object.getOwnPropertyDescriptor(proto, "webdriver");
    if (desc && desc.get) {
      Object.defineProperty(proto, "webdriver", { ...desc, get: new Proxy(desc.get, { apply: () => false }) });
    }
  } catch (e) {}
}`;

// Tab bookkeeping: always subscribed for the whole browser.
const CONTEXT_EVENTS = [
  "browsingContext.contextCreated",
  "browsingContext.contextDestroyed",
  "browsingContext.navigationStarted",
  "browsingContext.navigationCommitted",
  "browsingContext.load",
  "browsingContext.userPromptOpened",
  "browsingContext.userPromptClosed",
];
// Console and network: in the user's everyday profile only for the tabs Claude
// works with, so the rest of their browsing never reaches this process.
const TAB_EVENTS = ["log.entryAdded", "network.beforeRequestSent", "network.responseCompleted", "network.fetchError"];

const MAX_CONSOLE = 2000;
const MAX_NETWORK = 2000;

/** An error whose message is meant for the model, verbatim. */
export class UserError extends Error {
  constructor(message) {
    super(message);
    this.name = "UserError";
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function originOf(url) {
  try {
    const u = new URL(url);
    return u.origin === "null" ? u.protocol + u.pathname : u.origin;
  } catch {
    return url || "";
  }
}

const NET_ERRORS = {
  NS_ERROR_UNKNOWN_HOST: "the server's domain name could not be found (DNS lookup failed)",
  NS_ERROR_CONNECTION_REFUSED: "the server refused the connection",
  NS_ERROR_NET_TIMEOUT: "the connection timed out",
  NS_ERROR_NET_RESET: "the connection was reset",
  NS_ERROR_NET_INTERRUPT: "the connection was interrupted",
  NS_ERROR_OFFLINE: "the browser is offline",
  NS_ERROR_PROXY_CONNECTION_REFUSED: "the proxy server refused the connection",
  NS_ERROR_UNKNOWN_PROTOCOL: "the URL scheme is not supported",
  NS_ERROR_MALFORMED_URI: "the URL is malformed",
  NS_ERROR_ABORT: "the navigation was aborted",
  NS_BINDING_ABORTED: "the navigation was aborted (another navigation started)",
};

function describeNetError(message) {
  const code = (String(message).match(/NS_[A-Z_]+/) || [])[0];
  if (code && NET_ERRORS[code]) return `${NET_ERRORS[code]} (${code})`;
  if (/SSL|SEC_ERROR|CERT/i.test(message)) return `a secure connection could not be established (${code || message})`;
  return message;
}

function isMissingContext(err) {
  return err instanceof BidiError && (err.code === "no such frame" || err.code === "no such window");
}

export class ZenBrowser {
  constructor(config, log = () => {}) {
    this.config = config;
    this.log = log;
    this.client = null;
    this.connecting = null;
    this.sessionId = null;
    this.launched = null;
    this.capabilities = null;
    this.restarted = false; // the user's Zen was restarted to enable remote debugging
    this._reset();
  }

  _reset() {
    this.tabIds = new Map(); // context → tabId
    this.tabContexts = new Map(); // tabId → context
    this.nextTabId = 1;
    this.owned = new Set(); // contexts created by / for Claude in this session
    this.parents = new Map(); // child context → parent context
    this.topLevel = new Set();
    this.urls = new Map(); // top context → last committed url
    this.navStart = new Map(); // top context → timestamp of last navigation start
    this.consoleBuf = new Map();
    this.networkBuf = new Map();
    this.prompts = new Map(); // top context → prompt info
    this.refs = new Map(); // "ref_N" → {context, token, localId}
    this.refKeys = new Map(); // `${context}|${token}|${localId}` → "ref_N"
    this.nextRef = 1;
    this.frameInfo = new Map(); // child context → {parent, token, localId}
    this.ctxToken = new Map(); // context → token of its current document
    this.coordScale = new Map(); // top context → {s, cssW, cssH, frameW, frameH}
    this.watched = new Set(); // top contexts subscribed to TAB_EVENTS (existing profile)
    this.ctxWindow = new Map(); // top context → clientWindow id
    this.claudeWindow = null; // the window Claude opened for its tabs (everyday profile)
    this.preloadId = null;
  }

  /** Everyday profile (or connect-only): Claude works next to the user's own browsing. */
  get everydayProfile() {
    return this.config.profileMode === "existing" || this.config.connectOnly;
  }

  /** Should Claude's tabs live in a window of their own? */
  get useOwnWindow() {
    return this.everydayProfile && this.config.ownWindow;
  }

  get existingProfile() {
    return this.config.profileMode === "existing" && !this.config.connectOnly;
  }

  /** Subscribe to console/network for every tab, or only for the tabs Claude uses. */
  get watchAll() {
    return this.config.profileMode !== "existing";
  }

  // ---------------------------------------------------------------- connection

  get connected() {
    return !!this.client && this.client.connected && !!this.sessionId;
  }

  /**
   * Connect (launching Zen if needed).
   * @param {{allowRestart?: boolean}} opts allowRestart: the user agreed to
   *   restart their running Zen so remote debugging can be turned on.
   */
  async ensure(opts = {}) {
    if (this.connected) return;
    if (!this.connecting) {
      this.connecting = this._connect(opts).finally(() => {
        this.connecting = null;
      });
    }
    await this.connecting;
  }

  async _connect(opts = {}) {
    const { config } = this;
    const url = endpointUrl(config);

    if (!config.connectOnly) {
      if (this.existingProfile) {
        await this.startExistingProfile(opts);
      } else if (!(await isPortOpen(config.host, config.port))) {
        this.launched = await launchBrowser(config, this.log);
        this.log(`launched Zen (pid ${this.launched.pid})`);
      }
    }

    const client = new BidiClient(url, { commandTimeoutMs: config.commandTimeoutMs, log: this.log });
    try {
      await client.connect(5000);
    } catch (e) {
      if (config.connectOnly) {
        throw new UserError(
          `Could not connect to Zen at ${url} (${e.message}). Start Zen with remote debugging enabled, e.g.\n` +
            `  /Applications/Zen.app/Contents/MacOS/zen --remote-debugging-port ${config.port}\n` +
            `or unset ZEN_BIDI_URL / ZEN_CONNECT_ONLY to let claude-for-zen launch its own Zen profile.`,
        );
      }
      throw new UserError(`Could not connect to Zen's WebDriver BiDi endpoint at ${url}: ${e.message}`);
    }

    let session;
    const deadline = Date.now() + 8000;
    for (;;) {
      try {
        session = await client.send(
          "session.new",
          {
            capabilities: {
              alwaysMatch: {
                // Never auto-accept/dismiss dialogs; Claude handles them explicitly.
                unhandledPromptBehavior: { default: "ignore" },
              },
            },
          },
          { timeoutMs: 15000 },
        );
        break;
      } catch (e) {
        const busy = e instanceof BidiError && /session not created/i.test(e.code) && /maximum|active session/i.test(e.bidiMessage);
        if (busy && Date.now() < deadline) {
          await sleep(500);
          continue;
        }
        client.close();
        if (busy) {
          throw new UserError(
            "Another client is already controlling this Zen instance (WebDriver BiDi allows one session at a time). " +
              "Close the other Claude Code session that is using Zen, or give each session its own instance with a different ZEN_BIDI_PORT and ZEN_PROFILE.",
          );
        }
        throw e;
      }
    }

    this._reset();
    this.client = client;
    this.sessionId = session.sessionId;
    this.capabilities = session.capabilities;
    this.log(`BiDi session ${session.sessionId} with ${session.capabilities?.browserName} ${session.capabilities?.browserVersion}`);

    client.on("event", (msg) => this._onEvent(msg));
    client.on("close", () => {
      this.log("browser connection closed");
      this.sessionId = null;
    });

    await this._subscribe(this.watchAll ? [...CONTEXT_EVENTS, ...TAB_EVENTS] : CONTEXT_EVENTS);

    if (config.hideWebdriver) {
      try {
        const r = await client.send("script.addPreloadScript", { functionDeclaration: HIDE_WEBDRIVER_FN });
        this.preloadId = r.script;
      } catch (e) {
        this.log(`preload script failed: ${e.message}`);
      }
    }

    await this.refreshTree();

    if (config.hideWebdriver) {
      await Promise.all(
        [...this.topLevel].map((ctx) =>
          client
            .send("script.callFunction", { functionDeclaration: HIDE_WEBDRIVER_FN, target: { context: ctx }, awaitPromise: false, resultOwnership: "none" }, { timeoutMs: 3000 })
            .catch(() => {}),
        ),
      );
    }
  }

  /** Subscribe to events; one by one if needed, so an event unknown to an older browser does not fail the rest. */
  async _subscribe(events, contexts) {
    const params = contexts ? { events, contexts } : { events };
    try {
      await this.client.send("session.subscribe", params);
    } catch {
      for (const ev of events) {
        try {
          await this.client.send("session.subscribe", { ...params, events: [ev] });
        } catch (e) {
          this.log(`could not subscribe to ${ev}: ${e.message}`);
        }
      }
    }
  }

  /** Start collecting console and network events for a tab Claude works with. */
  async watch(ctx) {
    if (this.watchAll || !ctx || this.watched.has(ctx) || !this.connected) return;
    this.watched.add(ctx);
    await this._subscribe(TAB_EVENTS, [ctx]);
  }

  /**
   * Everyday-profile mode: make sure the user's own Zen is running with remote
   * debugging, launching it or (with permission) restarting it.
   */
  async startExistingProfile({ allowRestart = false } = {}) {
    const { config } = this;
    let profileDir;
    try {
      profileDir = findDefaultProfile(config);
    } catch (e) {
      throw new UserError(e.message);
    }
    let binary = null;
    try {
      binary = findBinary(config);
    } catch (e) {
      throw new UserError(e.message);
    }

    let owner = findProfileOwner(profileDir);
    if (await isPortOpen(config.host, config.port)) {
      const listener = findPortListener(config.port);
      if (listener == null || (owner && (owner.pid == null || owner.pid === listener))) return; // the user's Zen is listening
      const cmd = processCommand(listener);
      if (cmd.includes(defaultHome())) {
        // Claude's separate profile from dedicated mode is holding the port: it's ours, close it.
        this.log(`closing Claude's separate Zen profile (pid ${listener}) that holds port ${config.port}`);
        if (!(await quitGracefully(listener, { timeoutMs: 15000 }))) {
          throw new UserError(`Claude's separate Zen window (pid ${listener}) is using port ${config.port} and did not close. Quit it and try again.`);
        }
      } else {
        throw new UserError(
          `Port ${config.port} is used by another program (pid ${listener}${cmd ? `: ${cmd.slice(0, 120)}` : ""}), not by your Zen. ` +
            `Set ZEN_BIDI_PORT to a free port.`,
        );
      }
      owner = findProfileOwner(profileDir);
    }

    if (!owner) {
      this.launched = await launchBrowser(config, this.log, { profileDir, existing: true });
      this.log(`opened your Zen profile (pid ${this.launched.pid ?? "?"})`);
      return;
    }

    // Zen is open without remote debugging, which can only be enabled at startup.
    const policy = allowRestart ? "auto" : config.restart;
    const comesBack = restoresTabs(profileDir, binary)
      ? "all windows and tabs come back automatically (as when the user quits and reopens Zen), but anything typed into a page and not yet saved may be lost"
      : "Zen is set to open a home page at startup, so only pinned tabs and Essentials come back; other open tabs will be closed";
    if (owner.pid == null || !CAN_RESTART_BROWSER) {
      throw new UserError(
        "Zen is open, but its remote control (WebDriver BiDi) is off, so Claude can't use it yet, and on this system Claude can't restart Zen without risking the user's tabs. " +
          `Ask the user to quit Zen (${process.platform === "darwin" ? "Cmd" : "Ctrl"}+Q), then call tabs_context again: Claude will reopen Zen with their profile and remote control on.`,
      );
    }
    if (policy === "never") {
      throw new UserError(
        `Zen is open, but its remote control (WebDriver BiDi) is off, so Claude can't use it. ` +
          `Ask the user to quit Zen and start it with "claude-for-zen launch" (or set ZEN_RESTART=ask to let Claude restart it).`,
      );
    }
    if (policy !== "auto") {
      throw new UserError(
        `Zen is open, but its remote control (WebDriver BiDi) is off, so Claude can't use it yet. ` +
          `Turning it on needs a one-time restart of Zen: ${comesBack}. ` +
          `Ask the user whether Zen may be restarted now. If they agree, call tabs_context with restartBrowser: true.`,
      );
    }
    this.log(`restarting Zen (pid ${owner.pid}) with remote debugging on port ${config.port}`);
    if (!(await quitGracefully(owner.pid, { timeoutMs: 20000 }))) {
      throw new UserError(
        "Zen did not quit within 20 seconds. It is probably asking for confirmation (for example about closing tabs or a download in progress). " +
          "Ask the user to answer that prompt or quit Zen, then call tabs_context with restartBrowser: true again.",
      );
    }
    if (!(await waitForProfileRelease(profileDir, 10000))) {
      throw new UserError("Zen quit but its profile is still locked. Wait a moment and call tabs_context with restartBrowser: true again.");
    }
    // Firefox restores the session for this one start; Zen restores per its own startup setting.
    const oneShotPrefs = isZenBinary(binary) ? null : { "browser.sessionstore.resume_session_once": true };
    this.launched = await launchBrowser(config, this.log, { profileDir, existing: true, oneShotPrefs });
    this.restarted = true;
    this.log(`restarted Zen (pid ${this.launched.pid ?? "?"})`);
  }

  async send(method, params, opts) {
    await this.ensure();
    try {
      return await this.client.send(method, params, opts);
    } catch (e) {
      if (isMissingContext(e)) throw new UserError("That tab or frame no longer exists. Call tabs_context to get current tab IDs.");
      throw e;
    }
  }

  async shutdown() {
    const client = this.client;
    if (client && client.connected) {
      try {
        await client.send("session.end", {}, { timeoutMs: 2000 });
      } catch {}
      client.close();
    }
    // Never quit the user's everyday browser.
    if (this.config.killOnExit && this.launched?.pid && this.config.profileMode !== "existing") {
      try {
        process.kill(this.launched.pid, "SIGTERM");
      } catch {}
    }
  }

  // ------------------------------------------------------------------- events

  topOf(ctx) {
    let c = ctx;
    for (let i = 0; i < 50 && this.parents.has(c); i++) c = this.parents.get(c);
    return c;
  }

  _registerContextTree(info, parent = null) {
    if (parent) this.parents.set(info.context, parent);
    else {
      this.topLevel.add(info.context);
      if (!this.urls.has(info.context)) this.urls.set(info.context, info.url);
      if (info.clientWindow) this.ctxWindow.set(info.context, info.clientWindow);
    }
    for (const child of info.children || []) this._registerContextTree(child, info.context);
  }

  _onEvent({ method, params }) {
    switch (method) {
      case "browsingContext.contextCreated": {
        if (params.parent) {
          this.parents.set(params.context, params.parent);
        } else {
          this.topLevel.add(params.context);
          this.urls.set(params.context, params.url);
          if (params.clientWindow) this.ctxWindow.set(params.context, params.clientWindow);
          const opener = params.originalOpener;
          if (opener && this.owned.has(this.topOf(opener))) {
            this.owned.add(params.context);
            this.tabIdFor(params.context);
            this.watch(params.context).catch(() => {});
          }
        }
        break;
      }
      case "browsingContext.contextDestroyed": {
        const ctx = params.context;
        this.topLevel.delete(ctx);
        this.parents.delete(ctx);
        this.frameInfo.delete(ctx);
        this.owned.delete(ctx);
        this.watched.delete(ctx);
        this.ctxWindow.delete(ctx);
        this.consoleBuf.delete(ctx);
        this.networkBuf.delete(ctx);
        this.prompts.delete(ctx);
        this.urls.delete(ctx);
        this.coordScale.delete(ctx);
        this.ctxToken.delete(ctx);
        this.pruneRefs(ctx);
        const id = this.tabIds.get(ctx);
        if (id != null) {
          this.tabIds.delete(ctx);
          this.tabContexts.delete(id);
        }
        for (const child of params.children || []) this._onEvent({ method, params: child });
        break;
      }
      case "browsingContext.navigationStarted": {
        if (!params.context || this.parents.has(params.context)) break;
        this.navStart.set(params.context, params.timestamp || Date.now());
        break;
      }
      case "browsingContext.navigationCommitted":
      case "browsingContext.load": {
        const ctx = params.context;
        if (!ctx || this.parents.has(ctx)) break;
        const prev = this.urls.get(ctx);
        this.urls.set(ctx, params.url);
        if (prev && originOf(prev) !== originOf(params.url)) {
          const since = this.navStart.get(ctx) || 0;
          const c = this.consoleBuf.get(ctx);
          if (c) this.consoleBuf.set(ctx, c.filter((e) => e.ts >= since));
          const n = this.networkBuf.get(ctx);
          if (n) for (const [k, v] of n) if (v.ts < since) n.delete(k);
        }
        break;
      }
      case "browsingContext.userPromptOpened": {
        const top = this.topOf(params.context);
        this.log(`dialog opened (${params.type}) in ${params.context} → tab context ${top}`);
        this.prompts.set(top, { context: params.context, type: params.type, message: params.message || "", defaultValue: params.defaultValue });
        break;
      }
      case "browsingContext.userPromptClosed": {
        this.prompts.delete(this.topOf(params.context));
        break;
      }
      case "log.entryAdded": {
        const ctx = params.source?.context;
        if (!ctx) break;
        const top = this.topOf(ctx);
        let buf = this.consoleBuf.get(top);
        if (!buf) this.consoleBuf.set(top, (buf = []));
        const frame = params.stackTrace?.callFrames?.[0];
        buf.push({
          level: params.level,
          type: params.type === "javascript" ? "exception" : params.method || "log",
          text: params.text ?? "",
          ts: params.timestamp || Date.now(),
          where: frame?.url ? `${frame.url}:${frame.lineNumber + 1}` : "",
          frame: ctx !== top,
        });
        if (buf.length > MAX_CONSOLE) buf.splice(0, buf.length - MAX_CONSOLE);
        break;
      }
      case "network.beforeRequestSent": {
        const ctx = params.context;
        if (!ctx) break;
        const top = this.topOf(ctx);
        let buf = this.networkBuf.get(top);
        if (!buf) this.networkBuf.set(top, (buf = new Map()));
        const r = params.request || {};
        const key = `${r.request}:${params.redirectCount || 0}`;
        buf.set(key, {
          method: r.method,
          url: r.url,
          type: r.destination || r.initiatorType || params.initiator?.type || "",
          ts: params.timestamp || Date.now(),
          status: null,
          statusText: "",
          mimeType: "",
          size: null,
          fromCache: false,
          error: null,
        });
        if (buf.size > MAX_NETWORK) {
          const drop = buf.size - MAX_NETWORK;
          let i = 0;
          for (const k of buf.keys()) {
            if (i++ >= drop) break;
            buf.delete(k);
          }
        }
        break;
      }
      case "network.responseCompleted":
      case "network.fetchError": {
        const ctx = params.context;
        if (!ctx) break;
        const buf = this.networkBuf.get(this.topOf(ctx));
        const r = params.request || {};
        const entry = buf?.get(`${r.request}:${params.redirectCount || 0}`);
        if (!entry) break;
        if (method === "network.fetchError") {
          entry.error = params.errorText || "failed";
        } else {
          const res = params.response || {};
          entry.status = res.status;
          entry.statusText = res.statusText || "";
          entry.mimeType = res.mimeType || "";
          entry.size = res.content?.size ?? res.bodySize ?? res.bytesReceived ?? null;
          entry.fromCache = !!res.fromCache;
        }
        break;
      }
      default:
        break;
    }
  }

  // --------------------------------------------------------------------- tabs

  async refreshTree() {
    const tree = await this.client.send("browsingContext.getTree", {});
    this.topLevel.clear();
    for (const info of tree.contexts) this._registerContextTree(info);
    for (const [ctx, id] of [...this.tabIds]) {
      if (!this.topLevel.has(ctx)) {
        this.tabIds.delete(ctx);
        this.tabContexts.delete(id);
        this.owned.delete(ctx);
      }
    }
    return tree.contexts;
  }

  tabIdFor(ctx) {
    let id = this.tabIds.get(ctx);
    if (id == null) {
      id = this.nextTabId++;
      this.tabIds.set(ctx, id);
      this.tabContexts.set(id, ctx);
    }
    return id;
  }

  /** Resolve a tabId to a live top-level context. */
  async contextFor(tabId) {
    await this.ensure();
    const id = Number(tabId);
    const ctx = this.tabContexts.get(id);
    if (!ctx || !this.topLevel.has(ctx)) {
      throw new UserError(`Tab ${tabId} not found. Call tabs_context to get valid tab IDs (or tabs_create to open a new tab).`);
    }
    await this.watch(ctx);
    return ctx;
  }

  async tabSummary(ctx) {
    let title = "";
    let url = this.urls.get(ctx) || "";
    try {
      const vp = await this.runtime(ctx, "viewport", {}, { timeoutMs: 2500 });
      title = vp.title;
      url = vp.url;
    } catch {}
    return { tabId: this.tabIdFor(ctx), title, url };
  }

  async listTabs({ all = false } = {}) {
    await this.ensure();
    await this.refreshTree();
    const contexts = [...this.topLevel].filter((c) => all || this.owned.has(c));
    const tabs = await Promise.all(contexts.map(async (c) => ({ ...(await this.tabSummary(c)), owned: this.owned.has(c) })));
    tabs.sort((a, b) => a.tabId - b.tabId);
    return { tabs, totalOpen: this.topLevel.size };
  }

  async createTab(url) {
    await this.ensure();
    await this.refreshTree();
    const ownedNow = [...this.owned].filter((c) => this.topLevel.has(c));
    let params;
    if (this.useOwnWindow) {
      // Claude's tabs go into a window of its own (same profile, so the user's
      // logins work). In Zen it is an unsynced window: the user's tabs don't
      // appear in it and Claude's tabs don't appear in the user's windows.
      const inOwnWindow = ownedNow.filter((c) => this.claudeWindow && this.ctxWindow.get(c) === this.claudeWindow);
      if (inOwnWindow.length) {
        params = { type: "tab", background: false, referenceContext: inOwnWindow[inOwnWindow.length - 1] };
      } else {
        const ctx = await this._openOwnWindow();
        // Without a URL, don't leave the window-opening marker in the address.
        if (ctx) return this._adoptTab(ctx, url || ((this.urls.get(ctx) || "").includes("claude-for-zen=") ? "about:blank" : undefined), { ownWindow: true });
        // Could not open a window: fall back to a tab in the user's window.
        params = { type: "tab", background: false };
      }
    } else {
      params = { type: "tab", background: false };
      if (ownedNow.length) {
        // Keep Claude's tabs next to each other.
        params.referenceContext = ownedNow[ownedNow.length - 1];
      } else if (!this.everydayProfile && this.topLevel.size) {
        params.referenceContext = [...this.topLevel][0];
      }
      // Otherwise (the user's own profile) Zen puts the tab in the window they used last.
    }
    let res;
    try {
      res = await this.send("browsingContext.create", params);
    } catch (e) {
      if (e instanceof UserError) throw e;
      if (params.referenceContext) {
        delete params.referenceContext;
        res = await this.send("browsingContext.create", params);
      } else if (params.type !== "window") {
        // No browser window is open (e.g. all closed on macOS): open one.
        res = await this.send("browsingContext.create", { type: "window", background: false });
      } else throw e;
    }
    return this._adoptTab(res.context, url, { ownWindow: params.type === "window" });
  }

  /** Register a new tab as Claude's, optionally as the first tab of Claude's window, and load `url`. */
  async _adoptTab(ctx, url, { ownWindow = false } = {}) {
    this.topLevel.add(ctx);
    this.owned.add(ctx);
    if (!this.ctxWindow.has(ctx)) await this.refreshTree();
    if (ownWindow) this.claudeWindow = this.ctxWindow.get(ctx) || null;
    await this.watch(ctx);
    const tabId = this.tabIdFor(ctx);
    if (url) await this.navigate(ctx, url);
    return tabId;
  }

  /**
   * Open a browser window for Claude in the profile it is connected to and
   * bring it to the front. Returns the context of its tab, or null.
   */
  async _openOwnWindow() {
    let ctx = null;
    try {
      // Firefox: WebDriver BiDi opens windows directly.
      ctx = (await this.send("browsingContext.create", { type: "window", background: false })).context;
    } catch (e) {
      if (e instanceof UserError) throw e;
      if (!(e instanceof BidiError && /unsupported operation/i.test(e.code))) this.log(`window create failed: ${e.message}`);
      // Zen: the remote agent only opens windows for Firefox. Do what a person
      // would: Shift+click a link, which Zen opens in a new window kept
      // separate from the user's synced windows.
      ctx = await this._openWindowByShiftClick();
    }
    if (!ctx) return null;
    try {
      await this.send("browsingContext.activate", { context: ctx });
    } catch {}
    if (!this.config.headless) activateMacApp(findPortListener(this.config.port));
    return ctx;
  }

  async _openWindowByShiftClick() {
    const token = Math.random().toString(36).slice(2, 12);
    const marker = `about:blank?claude-for-zen=${token}`;
    let host;
    try {
      // A throwaway background tab hosts the link, so no page of the user's is touched.
      host = (await this.send("browsingContext.create", { type: "tab", background: true })).context;
    } catch (e) {
      this.log(`could not open a host tab: ${e.message}`);
      return null;
    }
    try {
      await this.send(
        "script.evaluate",
        {
          expression: `(() => { const a = document.createElement("a"); a.href = ${JSON.stringify(marker)}; a.textContent = "Claude"; a.style.cssText = "position:fixed;inset:0;display:block"; document.body.appendChild(a); })()`,
          target: { context: host },
          awaitPromise: false,
          resultOwnership: "none",
        },
        { timeoutMs: 5000 },
      );
      await this.send("input.performActions", {
        context: host,
        actions: [
          { type: "key", id: "cfz-kbd", actions: [{ type: "keyDown", value: KEY.Shift }, { type: "pause", duration: 0 }, { type: "pause", duration: 0 }, { type: "pause", duration: 0 }, { type: "keyUp", value: KEY.Shift }] },
          {
            type: "pointer",
            id: "cfz-mouse",
            parameters: { pointerType: "mouse" },
            actions: [{ type: "pause", duration: 0 }, { type: "pointerMove", x: 20, y: 20 }, { type: "pointerDown", button: 0 }, { type: "pointerUp", button: 0 }, { type: "pause", duration: 0 }],
          },
        ],
      });
      await this.send("input.releaseActions", { context: host }).catch(() => {});
      const deadline = Date.now() + 8000;
      for (let i = 1; Date.now() < deadline; i++) {
        await sleep(100);
        let found = [...this.topLevel].find((c) => (this.urls.get(c) || "").includes(token));
        if (!found && i % 10 === 0) {
          // Events can lag behind; ask for the tree once a second.
          const tree = await this.send("browsingContext.getTree", { maxDepth: 0 });
          const hit = tree.contexts.find((c) => (c.url || "").includes(token));
          if (hit) {
            this._registerContextTree(hit);
            this.urls.set(hit.context, hit.url);
            found = hit.context;
          }
        }
        if (found) return found;
      }
      this.log("no window appeared after the Shift+click");
      return null;
    } catch (e) {
      this.log(`opening a window failed: ${e.message}`);
      return null;
    } finally {
      await this.send("browsingContext.close", { context: host, promptUnload: false }).catch(() => {});
    }
  }

  /**
   * Close a tab. When it is the last tab of Claude's own window, close that
   * window too: Zen keeps a window open (with an empty tab) when its last tab
   * closes, and WebDriver BiDi has no command to close a window.
   * @returns {Promise<{windowClosed: boolean}>}
   */
  async closeTab(ctx) {
    await this.refreshTree();
    const win = this.ctxWindow.get(ctx);
    // Zen keeps an empty about:blank tab in every window; it doesn't count.
    const others = [...this.topLevel].filter(
      (c) => c !== ctx && this.ctxWindow.get(c) === win && (this.owned.has(c) || (this.urls.get(c) || "about:blank") !== "about:blank"),
    );
    const lastInOwnWindow = this.useOwnWindow && win && win === this.claudeWindow && others.length === 0;
    if (lastInOwnWindow && (await this._closeOwnWindow(ctx))) {
      this.claudeWindow = null;
      return { windowClosed: true };
    }
    await this.send("browsingContext.close", { context: ctx, promptUnload: false });
    return { windowClosed: false };
  }

  /** macOS: close the window holding `ctx` through the app's AppleScript support. */
  async _closeOwnWindow(ctx) {
    if (process.platform !== "darwin" || this.config.headless) return false;
    let bundleId = null;
    try {
      bundleId = macBundleId(findBinary(this.config));
    } catch {}
    if (!bundleId) return false;
    // AppleScript knows windows by title, which is the selected tab's title:
    // give the tab a unique one first.
    const token = `claude-for-zen-close-${Math.random().toString(36).slice(2, 10)}`;
    try {
      const r = await this.send(
        "script.evaluate",
        { expression: `document.title = ${JSON.stringify(token)}`, target: { context: ctx }, awaitPromise: false, resultOwnership: "none" },
        { timeoutMs: 3000 },
      );
      if (r.type === "exception") return false;
    } catch {
      return false;
    }
    const deadline = Date.now() + 1500;
    let outcome = "none";
    while (Date.now() < deadline) {
      outcome = closeMacWindowByName(bundleId, token);
      if (outcome !== "none") break;
      await sleep(100);
    }
    if (outcome !== "closed") return false;
    // Wait for the browser to report the tab gone (a beforeunload prompt keeps it open).
    const until = Date.now() + 3000;
    while (Date.now() < until) {
      if (!this.topLevel.has(ctx)) return true;
      await sleep(100);
    }
    await this.refreshTree();
    return !this.topLevel.has(ctx);
  }

  // -------------------------------------------------------------- page access

  /** Call an op of the sandboxed page runtime in `ctx`. */
  async runtime(ctx, op, arg = {}, { timeoutMs } = {}) {
    const res = await this.send(
      "script.callFunction",
      {
        functionDeclaration: CALL_FN,
        arguments: [
          { type: "string", value: op },
          { type: "string", value: JSON.stringify(arg) },
        ],
        target: { context: ctx, sandbox: SANDBOX },
        awaitPromise: false,
        resultOwnership: "none",
      },
      { timeoutMs: timeoutMs ?? 30000 },
    );
    if (res.type === "exception") throw new UserError(formatException(res.exceptionDetails));
    const raw = res.result?.value;
    let out;
    try {
      out = JSON.parse(raw);
    } catch {
      throw new Error(`Unexpected runtime result for ${op}`);
    }
    if (out && out.__error) {
      const msg = out.__error;
      if (msg.startsWith("STALE")) {
        throw new UserError(`${msg.replace(/^STALE:\s*/, "Stale ref: ")}. Call read_page or find again to get fresh refs.`);
      }
      throw new UserError(msg);
    }
    return out;
  }

  /** Evaluate JavaScript in the page's own realm. */
  async evaluate(ctx, expression, { awaitPromise = true, userActivation = true, timeoutMs } = {}) {
    return this.send(
      "script.evaluate",
      {
        expression,
        target: { context: ctx },
        awaitPromise,
        userActivation,
        resultOwnership: "none",
        serializationOptions: { maxDomDepth: 0, maxObjectDepth: 6, includeShadowTree: "none" },
      },
      { timeoutMs: timeoutMs ?? 30000 },
    );
  }

  assertNoPrompt(top) {
    const p = this.prompts.get(top);
    if (p) {
      throw new UserError(
        `A JavaScript ${p.type} dialog is open on this tab: ${JSON.stringify(p.message)}. ` +
          `Use handle_dialog (accept or dismiss) before doing anything else on this tab.`,
      );
    }
  }

  /** Make sure the tab is the selected one in its window (so it renders and receives input). */
  async prepareTab(top) {
    this.assertNoPrompt(top);
    let vp = await this.runtime(top, "viewport");
    if (vp.vis !== "visible") {
      try {
        await this.send("browsingContext.activate", { context: top });
        await sleep(150);
        vp = await this.runtime(top, "viewport");
      } catch (e) {
        this.log(`activate failed: ${e.message}`);
      }
    }
    return vp;
  }

  // --------------------------------------------------------------------- refs

  globalRef(context, token, localId) {
    const key = `${context}|${token}|${localId}`;
    let ref = this.refKeys.get(key);
    if (!ref) {
      ref = `ref_${this.nextRef++}`;
      this.refKeys.set(key, ref);
      this.refs.set(ref, { context, token, localId });
    }
    return ref;
  }

  /** Forget refs that belong to documents a context no longer shows. */
  pruneRefs(context, keepToken = null) {
    for (const [ref, r] of this.refs) {
      if (r.context === context && r.token !== keepToken) {
        this.refs.delete(ref);
        this.refKeys.delete(`${r.context}|${r.token}|${r.localId}`);
      }
    }
  }

  rewriteRefs(context, token, text) {
    if (this.ctxToken.get(context) !== token) {
      if (this.ctxToken.has(context)) this.pruneRefs(context, token);
      this.ctxToken.set(context, token);
    }
    return text.replace(/\[@(\d+)\]/g, (_, id) => `[${this.globalRef(context, token, Number(id))}]`);
  }

  resolveRef(top, ref) {
    const key = String(ref).trim().replace(/^\[|\]$/g, "");
    const r = this.refs.get(key);
    if (!r) {
      throw new UserError(`Unknown or expired ref "${ref}". Refs expire when the page navigates or reloads; use one from the latest read_page or find output.`);
    }
    if (this.topOf(r.context) !== top) throw new UserError(`Ref ${key} belongs to a different tab.`);
    return r;
  }

  async frameContext(parentCtx, token, localId) {
    const res = await this.send(
      "script.callFunction",
      {
        functionDeclaration: FRAME_WINDOW_FN,
        arguments: [{ type: "string", value: JSON.stringify({ id: localId, token }) }],
        target: { context: parentCtx, sandbox: SANDBOX },
        awaitPromise: false,
        resultOwnership: "none",
      },
      { timeoutMs: 10000 },
    );
    if (res.type !== "success" || res.result?.type !== "window") return null;
    const child = res.result.value?.context;
    if (child) {
      this.parents.set(child, parentCtx);
      this.frameInfo.set(child, { parent: parentCtx, token, localId });
    }
    return child || null;
  }

  async elementReference(ref, top) {
    const r = this.resolveRef(top, ref);
    const res = await this.send("script.callFunction", {
      functionDeclaration: ELEMENT_FN,
      arguments: [{ type: "string", value: JSON.stringify({ id: r.localId, token: r.token }) }],
      target: { context: r.context, sandbox: SANDBOX },
      awaitPromise: false,
      resultOwnership: "none",
    });
    if (res.type === "exception") {
      const text = res.exceptionDetails?.text || "";
      if (/STALE/.test(text)) throw new UserError("Stale ref: the element is no longer on the page. Call read_page or find again.");
      throw new UserError(formatException(res.exceptionDetails));
    }
    const sharedId = res.result?.sharedId;
    if (!sharedId) throw new UserError(`Could not get a reference to ${ref}`);
    return { context: r.context, sharedId };
  }

  // ------------------------------------------------------------ read / find

  async snapshotTree(ctx, arg, frameDepth = 0) {
    const res = await this.runtime(ctx, "snapshot", arg, { timeoutMs: 45000 });
    let text = this.rewriteRefs(ctx, res.token, res.text);
    for (const localId of res.frames) {
      const re = new RegExp(`^( *)@@FRAME:${localId}@@$`, "m");
      const m = text.match(re);
      if (!m) continue;
      const indent = m[1];
      let replacement;
      try {
        const child = frameDepth < 4 ? await this.frameContext(ctx, res.token, localId) : null;
        if (!child) {
          replacement = "";
        } else {
          const childText = await this.snapshotTree(child, { filter: arg.filter, depth: arg.depth, maxLines: arg.maxLines }, frameDepth + 1);
          replacement = childText
            .split("\n")
            .filter((l) => l.length)
            .map((l) => indent + l)
            .join("\n");
        }
      } catch (e) {
        replacement = `${indent}- (frame content not accessible: ${String(e.message).split("\n")[0]})`;
      }
      text = text.replace(re, () => replacement);
    }
    return text.replace(/\n{2,}/g, "\n");
  }

  async readPage(top, { filter = "all", depth = 15, refId, maxChars = 50000 } = {}) {
    this.assertNoPrompt(top);
    let ctx = top;
    const arg = { filter, depth, maxLines: 8000 };
    if (refId) {
      const r = this.resolveRef(top, refId);
      ctx = r.context;
      arg.id = r.localId;
      arg.token = r.token;
    }
    const vp = await this.runtime(top, "viewport");
    let tree = await this.snapshotTree(ctx, arg);
    if (!tree.trim()) tree = filter === "interactive" ? "(no visible interactive elements)" : "(empty page)";
    const header = `Page: ${vp.title || "(untitled)"}\nURL: ${vp.url}\nViewport: ${vp.w}x${vp.h}, scroll ${Math.round(vp.sx)},${Math.round(vp.sy)} of ${vp.sw}x${vp.sh}\n\n`;
    let out = header + tree;
    if (out.length > maxChars) {
      const cut = out.lastIndexOf("\n", maxChars);
      const full = out.length;
      out = out.slice(0, cut > 0 ? cut : maxChars) + `\n\n[Output truncated at ${maxChars} of ${full} characters. Pass a larger max_chars, use filter="interactive", a smaller depth, or ref_id to focus on part of the page.]`;
    }
    return out;
  }

  async findElements(top, query, limit = 20) {
    this.assertNoPrompt(top);
    const all = [];
    let total = 0;
    const visit = async (ctx, depth) => {
      const res = await this.runtime(ctx, "find", { query, limit: 50 }, { timeoutMs: 45000 });
      total += res.total;
      for (const m of res.matches) all.push({ score: m.score, line: this.rewriteRefs(ctx, res.token, m.line) });
      if (depth >= 3) return;
      for (const localId of res.frames) {
        try {
          const child = await this.frameContext(ctx, res.token, localId);
          if (child) await visit(child, depth + 1);
        } catch {}
      }
    };
    await visit(top, 0);
    all.sort((a, b) => b.score - a.score);
    return { total, matches: all.slice(0, limit).map((m) => m.line) };
  }

  /**
   * Point at the centre of a ref'd element, scrolling it into view.
   * Returns the innermost context that contains it (input must be dispatched
   * there for out-of-process iframes), the point in that context's viewport,
   * and the same point in top-level viewport coordinates.
   */
  async refPoint(top, ref) {
    const r = this.resolveRef(top, ref);
    const chain = [];
    let c = r.context;
    while (c !== top) {
      const fi = this.frameInfo.get(c);
      if (!fi) throw new UserError(`Lost track of the frame containing ${ref}. Call read_page or find again.`);
      chain.unshift({ ctx: fi.parent, token: fi.token, id: fi.localId });
      c = fi.parent;
    }
    for (const link of chain) await this.runtime(link.ctx, "frameOffset", { id: link.id, token: link.token, ensureVisible: true });
    const p = await this.runtime(r.context, "point", { id: r.localId, token: r.token });
    let absX = p.x;
    let absY = p.y;
    for (const link of [...chain].reverse()) {
      const off = await this.runtime(link.ctx, "frameOffset", { id: link.id, token: link.token });
      absX += off.x;
      absY += off.y;
    }
    if (chain.length) {
      const vp = await this.runtime(top, "viewport");
      if (absY < 0 || absY > vp.h - 1) {
        const dy = absY - vp.h / 2;
        await this.runtime(top, "scrollBy", { dy });
        absY -= dy;
      }
    }
    return { ctx: r.context, x: p.x, y: p.y, absX, absY, target: p.target, occludedBy: p.occludedBy, inFrame: chain.length > 0 };
  }

  /** Route a top-level viewport point to the innermost frame under it. */
  async routePoint(top, x, y) {
    let ctx = top;
    let cx = x;
    let cy = y;
    for (let depth = 0; depth < 6; depth++) {
      let f;
      try {
        f = await this.runtime(ctx, "frameAt", { x: cx, y: cy }, { timeoutMs: 5000 });
      } catch {
        break;
      }
      if (!f || f.id == null) break;
      const child = await this.frameContext(ctx, f.token, f.id).catch(() => null);
      if (!child) break;
      cx -= f.x;
      cy -= f.y;
      ctx = child;
    }
    return { ctx, x: cx, y: cy };
  }

  /** The innermost context holding keyboard focus (follows focused iframes). */
  async focusedContext(top) {
    let ctx = top;
    for (let depth = 0; depth < 6; depth++) {
      let f;
      try {
        f = await this.runtime(ctx, "activeFrame", {}, { timeoutMs: 5000 });
      } catch {
        break;
      }
      if (!f || f.id == null) break;
      const child = await this.frameContext(ctx, f.token, f.id).catch(() => null);
      if (!child) break;
      ctx = child;
    }
    return ctx;
  }

  // ---------------------------------------------------------------- screenshots

  async captureRaw(top, clip) {
    const params = { context: top, origin: "viewport", format: { type: "image/png" } };
    if (clip) params.clip = { type: "box", ...clip };
    const res = await this.send("browsingContext.captureScreenshot", params, { timeoutMs: 30000 });
    return decodePng(Buffer.from(res.data, "base64"));
  }

  /**
   * Screenshot the viewport, scaled so that one image pixel maps linearly to the
   * viewport and the image fits Claude's vision limits. Coordinates the model
   * reads off this image are converted back with `toViewport`.
   */
  async screenshot(top, { scale = 1 } = {}) {
    const vp = await this.prepareTab(top);
    const raw = await this.captureRaw(top);
    const dpr = raw.width / vp.w > 0.5 ? raw.width / vp.w : vp.dpr;
    const cssW = raw.width / dpr;
    const cssH = raw.height / dpr;
    const s = fitScale(cssW, cssH);
    const frameW = Math.max(1, Math.round(cssW * s));
    const frameH = Math.max(1, Math.round(cssH * s));
    const frame = resize(raw, frameW, frameH);
    this.coordScale.set(top, { s, cssW, cssH, frameW, frameH });
    let out = frame;
    const k = Math.min(1, Math.max(0.1, Number(scale) || 1));
    if (k < 1) out = resize(frame, frameW * k, frameH * k);
    return { frame, out, frameW, frameH, outW: out.width, outH: out.height, vp };
  }

  async zoom(top, region) {
    const vp = await this.prepareTab(top);
    const sc = await this.scaleFor(top, vp);
    let [x0, y0, x1, y1] = region.map(Number);
    if (x1 < x0) [x0, x1] = [x1, x0];
    if (y1 < y0) [y0, y1] = [y1, y0];
    const box = {
      x: Math.max(0, x0 / sc.s),
      y: Math.max(0, y0 / sc.s),
      width: Math.max(1, (x1 - x0) / sc.s),
      height: Math.max(1, (y1 - y0) / sc.s),
    };
    const raw = await this.captureRaw(top, box);
    const s = fitScale(raw.width, raw.height, MAX_EDGE, MAX_PIXELS);
    return s < 1 ? resize(raw, raw.width * s, raw.height * s) : raw;
  }

  async scaleFor(top, vp) {
    const known = this.coordScale.get(top);
    vp = vp || (await this.runtime(top, "viewport"));
    if (known && Math.abs(known.cssW - vp.w) < 24 && Math.abs(known.cssH - vp.h) < 24) return known;
    const s = fitScale(vp.w, vp.h);
    const sc = { s, cssW: vp.w, cssH: vp.h, frameW: Math.round(vp.w * s), frameH: Math.round(vp.h * s) };
    this.coordScale.set(top, sc);
    return sc;
  }

  /** Convert screenshot coordinates to viewport CSS pixels. */
  async toViewport(top, [x, y], vp) {
    const sc = await this.scaleFor(top, vp);
    return [x / sc.s, y / sc.s];
  }

  async toFrame(top, [x, y]) {
    const sc = await this.scaleFor(top);
    return [x * sc.s, y * sc.s];
  }

  static jpeg(img, quality = 80) {
    return encodeJpeg(img, quality);
  }

  // -------------------------------------------------------------------- input

  /**
   * Resolve when `promise` settles, or early with {prompt} if a JavaScript
   * dialog opens on the tab meanwhile (dialogs block the command that caused them).
   */
  async raceWithPrompt(promise, top) {
    let done = false;
    const wrapped = promise.then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    wrapped.finally(() => {
      done = true;
    });
    for (;;) {
      const r = await Promise.race([wrapped, sleep(100).then(() => null)]);
      if (r) {
        if (r.error) throw r.error;
        return { value: r.value };
      }
      if (!done && this.prompts.get(top)) return { prompt: this.prompts.get(top) };
    }
  }

  async performActions(ctx, actions) {
    const top = this.topOf(ctx);
    if (this.dirtyInput?.has(ctx)) {
      this.dirtyInput.delete(ctx);
      try {
        await this.client.send("input.releaseActions", { context: ctx }, { timeoutMs: 5000 });
      } catch {}
    }
    const r = await this.raceWithPrompt(this.send("input.performActions", { context: ctx, actions }, { timeoutMs: 60000 }), top);
    if (r.prompt) {
      // The action is still pending behind the dialog; release input state next time.
      (this.dirtyInput ||= new Set()).add(ctx);
      return { prompt: r.prompt };
    }
    try {
      await this.client.send("input.releaseActions", { context: ctx }, { timeoutMs: 5000 });
    } catch {}
    return {};
  }

  clampPoint(vp, x, y) {
    if (!vp) return [Math.max(0, Math.round(x)), Math.max(0, Math.round(y))];
    return [Math.min(Math.max(Math.round(x), 0), Math.max(0, vp.w - 1)), Math.min(Math.max(Math.round(y), 0), Math.max(0, vp.h - 1))];
  }

  /** target: {ctx, x, y} in ctx's viewport; vp (top viewport) is used for clamping top-level points. */
  async click(target, { button = 0, count = 1, modifiers = [], vp } = {}) {
    const top = this.topOf(target.ctx);
    const [cx, cy] = this.clampPoint(target.ctx === top ? vp : null, target.x, target.y);
    const pointer = [{ type: "pointerMove", x: cx, y: cy, duration: 60, origin: "viewport" }];
    for (let i = 0; i < count; i++) {
      pointer.push({ type: "pointerDown", button });
      pointer.push({ type: "pointerUp", button });
    }
    return this.performActions(target.ctx, this.withModifiers(pointer, modifiers));
  }

  withModifiers(pointerActions, modifiers) {
    const sources = [];
    if (modifiers.length) {
      const keys = [];
      for (const m of modifiers) keys.push({ type: "keyDown", value: m });
      for (let i = 0; i < pointerActions.length; i++) keys.push({ type: "pause" });
      for (const m of [...modifiers].reverse()) keys.push({ type: "keyUp", value: m });
      sources.push({ type: "key", id: "keyboard", actions: keys });
      pointerActions = [...modifiers.map(() => ({ type: "pause" })), ...pointerActions];
    }
    sources.unshift({ type: "pointer", id: "mouse", parameters: { pointerType: "mouse" }, actions: pointerActions });
    return sources;
  }

  async hover(target, vp) {
    const top = this.topOf(target.ctx);
    const [cx, cy] = this.clampPoint(target.ctx === top ? vp : null, target.x, target.y);
    return this.performActions(target.ctx, [
      { type: "pointer", id: "mouse", parameters: { pointerType: "mouse" }, actions: [{ type: "pointerMove", x: cx, y: cy, duration: 120, origin: "viewport" }] },
    ]);
  }

  /** Drag between two points of the same context. */
  async drag(ctx, from, to, vp) {
    const isTop = ctx === this.topOf(ctx);
    const [fx, fy] = this.clampPoint(isTop ? vp : null, from[0], from[1]);
    const [tx, ty] = this.clampPoint(isTop ? vp : null, to[0], to[1]);
    const mx = Math.round((fx + tx) / 2);
    const my = Math.round((fy + ty) / 2);
    return this.performActions(ctx, [
      {
        type: "pointer",
        id: "mouse",
        parameters: { pointerType: "mouse" },
        actions: [
          { type: "pointerMove", x: fx, y: fy, duration: 50, origin: "viewport" },
          { type: "pointerDown", button: 0 },
          { type: "pause", duration: 80 },
          { type: "pointerMove", x: Math.round(fx + (tx - fx) * 0.1), y: Math.round(fy + (ty - fy) * 0.1), duration: 80, origin: "viewport" },
          { type: "pointerMove", x: mx, y: my, duration: 150, origin: "viewport" },
          { type: "pointerMove", x: tx, y: ty, duration: 150, origin: "viewport" },
          { type: "pause", duration: 80 },
          { type: "pointerUp", button: 0 },
        ],
      },
    ]);
  }

  /** Send key actions to whichever frame has keyboard focus. */
  async keyActions(top, keyActions) {
    const ctx = await this.focusedContext(top);
    const CHUNK = 200;
    for (let i = 0; i < keyActions.length; i += CHUNK) {
      const r = await this.performActions(ctx, [{ type: "key", id: "keyboard", actions: keyActions.slice(i, i + CHUNK) }]);
      if (r.prompt) return r;
    }
    return {};
  }

  async scroll(target, dx, dy, vp) {
    const top = this.topOf(target.ctx);
    const [cx, cy] = this.clampPoint(target.ctx === top ? vp : null, target.x, target.y);
    return this.performActions(target.ctx, [
      {
        type: "wheel",
        id: "wheel",
        actions: [{ type: "scroll", x: cx, y: cy, deltaX: Math.round(dx), deltaY: Math.round(dy), duration: 150, origin: "viewport" }],
      },
    ]);
  }

  // --------------------------------------------------------- console / network

  consoleFor(top) {
    return this.consoleBuf.get(top) || [];
  }

  clearConsole(top) {
    this.consoleBuf.set(top, []);
  }

  networkFor(top) {
    return [...(this.networkBuf.get(top)?.values() || [])];
  }

  clearNetwork(top) {
    this.networkBuf.set(top, new Map());
  }

  // ------------------------------------------------------------------ dialogs

  promptFor(top) {
    return this.prompts.get(top) || null;
  }

  async handlePrompt(top, accept, userText) {
    const p = this.prompts.get(top);
    if (!p) throw new UserError("There is no open dialog on this tab.");
    const params = { context: p.context, accept: !!accept };
    if (userText != null && p.type === "prompt") params.userText = String(userText);
    await this.send("browsingContext.handleUserPrompt", params);
    this.prompts.delete(top);
    return p;
  }

  // ------------------------------------------------------------- navigation

  async navigate(top, url) {
    this.assertNoPrompt(top);
    const timeoutMs = this.config.navigationTimeoutMs;
    try {
      const r = await this.raceWithPrompt(this.send("browsingContext.navigate", { context: top, url, wait: "complete" }, { timeoutMs }), top);
      if (r.prompt) return { timedOut: false, prompt: r.prompt };
      return { timedOut: false };
    } catch (e) {
      if (e instanceof BidiTimeoutError) return { timedOut: true };
      if (e instanceof BidiError && /navigation canceled|aborted/i.test(`${e.code} ${e.bidiMessage}`)) return { timedOut: false, canceled: true };
      if (e instanceof BidiError && /NS_ERROR|NS_BINDING/i.test(e.bidiMessage)) {
        throw new UserError(`Navigation to ${url} failed: ${describeNetError(e.bidiMessage)}`);
      }
      throw e;
    }
  }

  async traverse(top, delta) {
    this.assertNoPrompt(top);
    try {
      await this.send("browsingContext.traverseHistory", { context: top, delta });
    } catch (e) {
      if (e instanceof BidiError && e.code === "no such history entry") {
        throw new UserError(`There is no ${delta < 0 ? "previous" : "next"} page in this tab's history.`);
      }
      throw e;
    }
    await this.waitForLoad(top);
  }

  async waitForLoad(top, timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;
    await sleep(100);
    while (Date.now() < deadline) {
      if (this.prompts.get(top)) return;
      try {
        const vp = await this.runtime(top, "viewport", {}, { timeoutMs: 3000 });
        if (vp.ready === "complete") return;
      } catch {}
      await sleep(150);
    }
  }

  async setFiles(top, ref, files) {
    const { context, sharedId } = await this.elementReference(ref, top);
    await this.send("input.setFiles", { context, element: { sharedId }, files });
  }

  async resizeWindow(top, width, height) {
    const tree = await this.send("browsingContext.getTree", { root: top, maxDepth: 0 });
    const clientWindow = tree.contexts?.[0]?.clientWindow;
    if (!clientWindow) throw new UserError("Could not determine the window for this tab.");
    try {
      await this.send("browser.setClientWindowState", { clientWindow, state: "normal", width: Math.round(width), height: Math.round(height) });
    } catch (e) {
      if (e instanceof BidiError && /unknown command|unsupported/i.test(e.code)) {
        throw new UserError("This browser version does not support resizing windows over WebDriver BiDi (browser.setClientWindowState).");
      }
      throw e;
    }
    await sleep(300);
    this.coordScale.delete(top);
    return this.runtime(top, "viewport");
  }
}
