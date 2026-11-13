/* This Source Code is part of claude-for-zen (MIT). */
/* global ExtensionAPI, ChromeUtils, Services, Cc, Ci */
"use strict";

// Runs in Zen's parent process with chrome privileges (WebExtension experiment).
//
// It lets claude-for-zen switch Zen's WebDriver BiDi remote agent on while
// Claude works and off when it is done, without restarting Zen:
//
// - On startup it listens on a random loopback port and writes
//   <profile>/claude-for-zen.json = {port, token, pid, version} (mode 0600).
// - A client sends one JSON line per request, carrying that token:
//     {"token": "...", "cmd": "start"}  -> {"ok": true, "port": 9222}
//     {"token": "...", "cmd": "status"} -> {"ok": true, "running": ..., "port": ...}
//     {"token": "...", "cmd": "stop"}
// - When the last client that asked for "start" disconnects, remote control is
//   switched off again (only if this add-on switched it on).

const STATE_FILE = "claude-for-zen.json";
const PREF_DYNAMIC_START = "remote.experimental.dynamicstart.enabled";

const { setTimeout } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");

function log(message) {
  Services.console.logStringMessage(`claude-for-zen: ${message}`);
}

function remoteAgent() {
  return ChromeUtils.importESModule("chrome://remote/content/components/RemoteAgent.sys.mjs").RemoteAgent;
}

function randomToken() {
  const bytes = Cc["@mozilla.org/security/random-generator;1"].getService(Ci.nsIRandomGenerator).generateRandomBytes(32);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class ControlServer {
  constructor(version) {
    this.version = version;
    this.server = null;
    this.token = randomToken();
    this.statePath = PathUtils.join(Services.dirsvc.get("ProfD", Ci.nsIFile).path, STATE_FILE);
    this.clients = new Set(); // connections that asked for remote control
    this.startedByUs = false;
    this.pending = Promise.resolve();
  }

  async open() {
    this.server = Cc["@mozilla.org/network/server-socket;1"].createInstance(Ci.nsIServerSocket);
    this.server.init(-1, true /* loopback only */, -1);
    this.server.asyncListen({
      onSocketAccepted: (_server, transport) => this.accept(transport),
      onStopListening: () => {},
    });
    const state = JSON.stringify({ port: this.server.port, token: this.token, pid: Services.appinfo.processID, version: this.version });
    const tmp = `${this.statePath}.tmp`;
    await IOUtils.writeUTF8(tmp, state);
    try {
      await IOUtils.setPermissions(tmp, 0o600);
    } catch {}
    await IOUtils.move(tmp, this.statePath);
    log(`control server on 127.0.0.1:${this.server.port}`);
  }

  close(isAppShutdown) {
    try {
      this.server?.close();
    } catch {}
    this.server = null;
    IOUtils.remove(this.statePath, { ignoreAbsent: true }).catch(() => {});
    for (const conn of this.clients) this.drop(conn);
    if (!isAppShutdown) this.stopIfOurs();
  }

  accept(transport) {
    const conn = {
      transport,
      input: transport.openInputStream(0, 0, 0),
      output: transport.openOutputStream(Ci.nsITransport.OPEN_UNBUFFERED, 0, 0),
      buffer: "",
      closed: false,
    };
    const pump = Cc["@mozilla.org/network/input-stream-pump;1"].createInstance(Ci.nsIInputStreamPump);
    pump.init(conn.input, 0, 0, false);
    pump.asyncRead({
      onStartRequest: () => {},
      onDataAvailable: (_request, stream, _offset, count) => {
        const sis = Cc["@mozilla.org/scriptableinputstream;1"].createInstance(Ci.nsIScriptableInputStream);
        sis.init(stream);
        conn.buffer += sis.readBytes(count);
        if (conn.buffer.length > 65536) {
          this.drop(conn);
          return;
        }
        let nl;
        while ((nl = conn.buffer.indexOf("\n")) >= 0) {
          const line = conn.buffer.slice(0, nl);
          conn.buffer = conn.buffer.slice(nl + 1);
          this.pending = this.pending.then(() => this.handle(conn, line)).catch((e) => log(`request failed: ${e}`));
        }
      },
      onStopRequest: () => this.drop(conn),
    });
  }

  send(conn, message) {
    if (conn.closed) return;
    const text = JSON.stringify(message) + "\n";
    try {
      conn.output.write(text, text.length);
    } catch {
      this.drop(conn);
    }
  }

  drop(conn) {
    if (conn.closed) return;
    conn.closed = true;
    try {
      conn.input.close();
      conn.output.close();
      conn.transport.close(0);
    } catch {}
    if (this.clients.delete(conn) && this.clients.size === 0) this.stopIfOurs();
  }

  async handle(conn, line) {
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      this.send(conn, { ok: false, error: "invalid JSON" });
      return;
    }
    if (!request || request.token !== this.token) {
      this.send(conn, { ok: false, error: "invalid token" });
      this.drop(conn);
      return;
    }
    const agent = remoteAgent();
    try {
      switch (request.cmd) {
        case "start": {
          const port = await this.start(agent);
          this.clients.add(conn);
          this.send(conn, { ok: true, port });
          return;
        }
        case "stop":
          if (this.clients.delete(conn) && this.clients.size === 0) await this.stopIfOurs();
          this.send(conn, { ok: true });
          return;
        case "status":
          this.send(conn, { ok: true, running: agent.running, port: agent.running ? agent.port : null, startedByUs: this.startedByUs, version: this.version });
          return;
        default:
          this.send(conn, { ok: false, error: `unknown command ${request.cmd}` });
      }
    } catch (e) {
      this.send(conn, { ok: false, error: String(e?.message || e) });
    }
  }

  async start(agent) {
    if (agent.running) return agent.port; // started with --remote-debugging-port, or already by us
    Services.prefs.getDefaultBranch("").setBoolPref(PREF_DYNAMIC_START, true);
    if (!Services.prefs.getBoolPref(PREF_DYNAMIC_START, false)) {
      throw new Error(`${PREF_DYNAMIC_START} is set to false in about:config`);
    }
    // startAtRuntime needs a browser window that finished starting up.
    for (let i = 0; ; i++) {
      const win = Services.wm.getMostRecentBrowserWindow();
      if (win?.gBrowserInit && !Services.startup.startingUp) break;
      if (i >= 300) throw new Error("no Zen window is open");
      await sleep(100);
    }
    // isBrowserAutomation: true gives the same session as --remote-debugging-port
    // (the user's cookies, no prompt); false would confine it to a separate container.
    const port = await agent.startAtRuntime({ isBrowserAutomation: true });
    if (port < 0) throw new Error("Zen did not start its remote agent (disabled by policy?)");
    this.startedByUs = true;
    log(`remote control on (port ${port})`);
    return port;
  }

  async stopIfOurs() {
    if (!this.startedByUs) return;
    this.startedByUs = false;
    try {
      await remoteAgent().stopAtRuntime();
      log("remote control off");
    } catch (e) {
      log(`could not stop remote control: ${e}`);
    }
  }
}

let control = null;

this.claudeForZen = class extends ExtensionAPI {
  onStartup() {
    control = new ControlServer(this.extension.version);
    control.open().catch((e) => log(`could not start: ${e}`));
  }

  onShutdown(isAppShutdown) {
    control?.close(isAppShutdown);
    control = null;
  }

  getAPI() {
    return { claudeForZen: {} };
  }
};
