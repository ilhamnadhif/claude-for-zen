// Session broker: lets several claude-for-zen servers (several Claude Code
// sessions) use the same Zen at the same time.
//
// Firefox allows one WebDriver BiDi session per browser, and a session created
// over WebDriver BiDi accepts only the connection that created it. The broker
// is a small detached process that owns that one connection and session and
// offers it to any number of local clients:
//
// - session.new from the first client creates the real session; later clients
//   get the same session back.
// - Commands are forwarded with their ids rewritten; results go back to the
//   client that sent them. Events go to every client (each one only acts on the
//   tabs it opened).
// - session.end from a client only detaches that client. When the last client
//   has gone, the broker ends the session and exits.

import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import WebSocket, { WebSocketServer } from "ws";
import { defaultHome } from "./config.js";

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "claude-for-zen.js");
const MAX_PAYLOAD = 512 * 1024 * 1024;

/**
 * Start a broker in this process.
 * @param {{upstreamUrl: string, idleMs?: number, log?: (m: string) => void, onExit?: (reason: string) => void}} opts
 * @returns {Promise<{port: number, token: string, clients: () => number, close: (reason?: string) => Promise<void>}>}
 */
export async function startBroker({ upstreamUrl, idleMs = 3000, log = () => {}, onExit = () => {} }) {
  const upstream = new WebSocket(upstreamUrl, { maxPayload: MAX_PAYLOAD, perMessageDeflate: false });
  await new Promise((resolve, reject) => {
    upstream.once("open", resolve);
    upstream.once("error", reject);
  });

  const token = crypto.randomBytes(32).toString("hex");
  const clients = new Set();
  const pending = new Map(); // upstream id → {ws, id, method, params}
  const preloads = new Map(); // preload params JSON → result
  let nextId = 1;
  let session = null; // result of the real session.new
  let creating = null; // promise while session.new is in flight
  let idleTimer = null;
  let closed = false;

  const server = new WebSocketServer({
    host: "127.0.0.1",
    port: 0,
    maxPayload: MAX_PAYLOAD,
    perMessageDeflate: false,
    verifyClient: ({ req }) => {
      const url = new URL(req.url, "http://localhost");
      const given = Buffer.from(url.searchParams.get("token") || "");
      const want = Buffer.from(token);
      return given.length === want.length && crypto.timingSafeEqual(given, want);
    },
  });
  await new Promise((resolve) => server.once("listening", resolve));

  function sendTo(ws, msg) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  function forward(params, method) {
    return new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, { resolve, method });
      upstream.send(JSON.stringify({ id, method, params }));
    });
  }

  async function close(reason = "closed") {
    if (closed) return;
    closed = true;
    clearTimeout(idleTimer);
    if (session && upstream.readyState === WebSocket.OPEN) {
      await Promise.race([forward({}, "session.end"), new Promise((r) => setTimeout(r, 2000))]);
    }
    // ws keeps waiting for open sockets when a server closes: drop them.
    for (const ws of clients) ws.terminate();
    try {
      upstream.terminate();
    } catch {}
    await Promise.race([new Promise((resolve) => server.close(() => resolve())), new Promise((r) => setTimeout(r, 500))]);
    log(`broker closed (${reason})`);
    onExit(reason);
  }

  function scheduleIdle() {
    clearTimeout(idleTimer);
    if (clients.size === 0) idleTimer = setTimeout(() => clients.size === 0 && close("no clients left"), idleMs);
  }

  upstream.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (msg.id != null && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      p.resolve(msg);
      return;
    }
    if (msg.type === "event") {
      const text = JSON.stringify(msg);
      for (const ws of clients) if (ws.readyState === WebSocket.OPEN) ws.send(text);
    }
  });
  upstream.on("close", () => close("browser connection closed"));
  upstream.on("error", (e) => log(`upstream error: ${e.message}`));

  server.on("connection", (ws) => {
    clients.add(ws);
    clearTimeout(idleTimer);
    log(`client connected (${clients.size})`);
    ws.on("close", () => {
      clients.delete(ws);
      log(`client left (${clients.size})`);
      scheduleIdle();
    });
    ws.on("message", async (data) => {
      let msg;
      try {
        msg = JSON.parse(data);
      } catch {
        return;
      }
      const { id, method, params = {} } = msg;
      if (typeof id !== "number" || typeof method !== "string") return;

      if (method === "session.new") {
        if (session) return sendTo(ws, { type: "success", id, result: session });
        creating ||= forward(params, "session.new").finally(() => (creating = null));
        const reply = await creating;
        if (reply.type === "success") session = reply.result;
        return sendTo(ws, { ...reply, id });
      }
      if (method === "session.end") {
        // Detach this client only; the session ends when the last client leaves.
        const others = [...clients].filter((c) => c !== ws && c.readyState === WebSocket.OPEN).length;
        return sendTo(ws, { type: "success", id, result: { "cfz:otherClients": others } });
      }
      if (method === "script.addPreloadScript") {
        const key = JSON.stringify(params);
        if (preloads.has(key)) return sendTo(ws, { type: "success", id, result: preloads.get(key) });
        const reply = await forward(params, method);
        if (reply.type === "success") preloads.set(key, reply.result);
        return sendTo(ws, { ...reply, id });
      }
      const reply = await forward(params, method);
      sendTo(ws, { ...reply, id });
    });
  });

  return { port: server.address().port, token, clients: () => clients.size, close };
}

// ------------------------------------------------------------ files and process

function runDir() {
  return path.join(defaultHome(), "run");
}

function keyOf(host, port) {
  return `${String(host).replace(/[^\w.-]/g, "_")}-${Number(port)}`;
}

function brokerFile(host, port) {
  return path.join(runDir(), `broker-${keyOf(host, port)}.json`);
}

function lockFile(host, port) {
  return path.join(runDir(), `broker-${keyOf(host, port)}.lock`);
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

function readBroker(host, port) {
  try {
    const b = JSON.parse(fs.readFileSync(brokerFile(host, port), "utf8"));
    if (Number.isInteger(b.port) && typeof b.token === "string" && isAlive(b.pid)) return b;
  } catch {}
  return null;
}

function canConnect(port, timeoutMs = 500) {
  return new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port });
    const done = (v) => {
      s.destroy();
      resolve(v);
    };
    s.setTimeout(timeoutMs, () => done(false));
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
}

/** Take the per-browser lock; false if another live broker holds it. */
function acquireLock(host, port) {
  fs.mkdirSync(runDir(), { recursive: true, mode: 0o700 });
  const file = lockFile(host, port);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, String(process.pid), { flag: "wx", mode: 0o600 });
      return true;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      const holder = Number(fs.readFileSync(file, "utf8"));
      if (holder && holder !== process.pid && isAlive(holder)) return false;
      try {
        fs.unlinkSync(file); // stale
      } catch {}
    }
  }
  return false;
}

/** Entry point of `claude-for-zen broker <host> <port>` (a detached process). */
export async function runBroker(host, port, { log = () => {} } = {}) {
  if (!acquireLock(host, port)) return; // another broker serves this browser
  const cleanup = () => {
    for (const f of [brokerFile(host, port), lockFile(host, port)]) {
      try {
        if (f.endsWith(".lock") ? Number(fs.readFileSync(f, "utf8")) === process.pid : JSON.parse(fs.readFileSync(f, "utf8")).pid === process.pid) {
          fs.unlinkSync(f);
        }
      } catch {}
    }
  };
  let broker;
  try {
    broker = await startBroker({
      upstreamUrl: `ws://${host}:${port}/session`,
      log,
      onExit: () => {
        cleanup();
        setTimeout(() => process.exit(0), 50);
      },
    });
  } catch (e) {
    cleanup();
    log(`could not reach the browser: ${e.message}`);
    process.exitCode = 1;
    return;
  }
  const file = brokerFile(host, port);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ pid: process.pid, port: broker.port, token: broker.token }), { mode: 0o600 });
  fs.renameSync(tmp, file);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => broker.close(sig));
}

/**
 * URL of the broker for the browser at host:port, starting one if needed.
 * @returns {Promise<string>}
 */
export async function ensureBroker(host, port, { timeoutMs = 10000, log = () => {} } = {}) {
  const deadline = Date.now() + timeoutMs;
  let spawned = false;
  while (Date.now() < deadline) {
    const b = readBroker(host, port);
    if (b && (await canConnect(b.port))) return `ws://127.0.0.1:${b.port}/?token=${b.token}`;
    if (!spawned) {
      spawned = true;
      log(`starting the session broker for ${host}:${port}`);
      const child = spawn(process.execPath, [BIN, "broker", host, String(port)], { detached: true, stdio: "ignore" });
      child.unref();
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`the session broker for ${host}:${port} did not start`);
}
