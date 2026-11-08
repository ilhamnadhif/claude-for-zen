// Minimal WebDriver BiDi client over WebSocket.
// Spec: https://w3c.github.io/webdriver-bidi/

import { EventEmitter } from "node:events";
import WebSocket from "ws";

export class BidiError extends Error {
  constructor(method, code, message, stacktrace) {
    super(`${method}: ${code}${message ? ` — ${message}` : ""}`);
    this.name = "BidiError";
    this.method = method;
    this.code = code;
    this.bidiMessage = message || "";
    this.stacktrace = stacktrace;
  }
}

export class BidiTimeoutError extends Error {
  constructor(method, timeoutMs) {
    super(`${method} timed out after ${Math.round(timeoutMs / 1000)}s`);
    this.name = "BidiTimeoutError";
    this.method = method;
  }
}

export class BidiClient extends EventEmitter {
  /**
   * @param {string} url WebSocket endpoint, e.g. ws://127.0.0.1:9333/session
   * @param {{commandTimeoutMs?: number, log?: (msg: string) => void}} [opts]
   */
  constructor(url, opts = {}) {
    super();
    this.setMaxListeners(100);
    this.url = url;
    this.commandTimeoutMs = opts.commandTimeoutMs ?? 60_000;
    this.log = opts.log ?? (() => {});
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.closed = true;
  }

  get connected() {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  connect(timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(this.url, {
        perMessageDeflate: false,
        maxPayload: 512 * 1024 * 1024,
        handshakeTimeout: timeoutMs,
      });
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          ws.terminate();
        } catch {}
        reject(new Error(`Timed out connecting to ${this.url}`));
      }, timeoutMs + 500);

      ws.on("open", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.ws = ws;
        this.closed = false;
        resolve();
      });
      ws.on("error", (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(err);
          return;
        }
        this.log(`websocket error: ${err.message}`);
      });
      ws.on("close", (code, reason) => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          reject(new Error(`Connection to ${this.url} closed (${code})`));
        }
        if (this.ws === ws) this._handleClose(code, reason?.toString());
      });
      ws.on("message", (data) => this._handleMessage(data));
    });
  }

  _handleClose(code, reason) {
    this.closed = true;
    this.ws = null;
    const err = new Error(`Browser connection closed${reason ? `: ${reason}` : ""} (code ${code})`);
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(err);
    }
    this.pending.clear();
    this.emit("close", { code, reason });
  }

  _handleMessage(data) {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      this.log("received non-JSON message from browser");
      return;
    }
    if (msg.type === "event") {
      try {
        this.emit("event", msg);
        this.emit(msg.method, msg.params);
      } catch (e) {
        this.log(`event handler error for ${msg.method}: ${e?.stack || e}`);
      }
      return;
    }
    if (msg.id == null) {
      if (msg.type === "error") this.log(`protocol error: ${msg.error} ${msg.message}`);
      return;
    }
    const entry = this.pending.get(msg.id);
    if (!entry) return; // late reply to a timed-out command
    this.pending.delete(msg.id);
    clearTimeout(entry.timer);
    if (msg.type === "error") {
      entry.reject(new BidiError(entry.method, msg.error, msg.message, msg.stacktrace));
    } else {
      entry.resolve(msg.result);
    }
  }

  /**
   * Send a command and resolve with its result.
   * @param {string} method
   * @param {object} [params]
   * @param {{timeoutMs?: number}} [opts]
   */
  send(method, params = {}, opts = {}) {
    if (!this.connected) {
      return Promise.reject(new Error("Not connected to the browser"));
    }
    const id = this.nextId++;
    const timeoutMs = opts.timeoutMs ?? this.commandTimeoutMs;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BidiTimeoutError(method, timeoutMs));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  close() {
    if (this.ws) {
      try {
        this.ws.close();
      } catch {}
    }
  }
}
