// The helper add-on (extension/) that lets claude-for-zen switch Zen's remote
// control on and off while Zen keeps running: packaging, discovery and its
// control channel.

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXTENSION_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "extension");
const MANIFEST = JSON.parse(fs.readFileSync(path.join(EXTENSION_DIR, "manifest.json"), "utf8"));

export const ADDON_ID = MANIFEST.browser_specific_settings.gecko.id;
export const ADDON_VERSION = MANIFEST.version;
export const STATE_FILE = "claude-for-zen.json";
const FILES = ["manifest.json", "schema.json", "parent.js"];

// ------------------------------------------------------------------ packaging

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

export function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A zip archive of `files` ({name, data}), stored without compression. */
export function zip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of files) {
    const nameBuf = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0x21, 12); // date: 1980-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

/** The helper add-on as an .xpi archive. */
export function buildXpi() {
  return zip(FILES.map((name) => ({ name, data: fs.readFileSync(path.join(EXTENSION_DIR, name)) })));
}

// ------------------------------------------------------------------ discovery

function xpiPath(profileDir) {
  return path.join(profileDir, "extensions", `${ADDON_ID}.xpi`);
}

/** Is the add-on's file in this profile (it may not be enabled yet)? */
export function addonInstalled(profileDir) {
  return fs.existsSync(xpiPath(profileDir));
}

/**
 * What the browser recorded about the add-on (extensions.json), or null when it
 * has never seen it: {version, active, userDisabled}.
 */
export function addonInfo(profileDir) {
  try {
    const db = JSON.parse(fs.readFileSync(path.join(profileDir, "extensions.json"), "utf8"));
    const a = (db.addons || []).find((x) => x.id === ADDON_ID);
    if (a) return { version: a.version, active: !!a.active, userDisabled: !!a.userDisabled };
  } catch {}
  return null;
}

/**
 * Put the add-on into the profile's extensions folder. The browser picks it up
 * the next time it starts and asks the user to enable it (a "new add-on" notice).
 * Doesn't touch a file that is already there unless it is an older version.
 */
export function sideloadAddon(profileDir) {
  const info = addonInfo(profileDir);
  if (addonInstalled(profileDir) && (!info || compareVersions(info.version, ADDON_VERSION) >= 0)) return false;
  fs.mkdirSync(path.join(profileDir, "extensions"), { recursive: true });
  const tmp = `${xpiPath(profileDir)}.tmp`;
  fs.writeFileSync(tmp, buildXpi());
  fs.renameSync(tmp, xpiPath(profileDir));
  return true;
}

/** What the running add-on wrote to the profile, or null. */
export function addonState(profileDir) {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(profileDir, STATE_FILE), "utf8"));
    if (Number.isInteger(s.port) && s.port > 0 && typeof s.token === "string" && s.token.length >= 32) return s;
  } catch {}
  return null;
}

/** Compare dotted versions: <0, 0, >0. */
export function compareVersions(a, b) {
  const pa = String(a || "0").split(".").map(Number);
  const pb = String(b || "0").split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

// ------------------------------------------------------------------ control channel

export class ControlError extends Error {}

/**
 * Connect to the add-on's control server. The connection stays open while
 * Claude uses Zen: when it closes, the add-on switches remote control off.
 * @returns {Promise<{request(cmd: string): Promise<object>, start(): Promise<number>, close(): void, closed: boolean}>}
 */
export function connectControl(state, { timeoutMs = 3000, host = "127.0.0.1" } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port: state.port });
    let buffer = "";
    const waiting = [];
    const client = {
      closed: false,
      request(cmd, { timeout = 60000 } = {}) {
        if (client.closed) return Promise.reject(new ControlError("the connection to Zen's helper add-on is closed"));
        return new Promise((res, rej) => {
          const timer = setTimeout(() => {
            const i = waiting.findIndex((w) => w.res === res);
            if (i >= 0) waiting.splice(i, 1);
            rej(new ControlError(`Zen's helper add-on did not answer "${cmd}" in time`));
          }, timeout);
          waiting.push({ res, rej, timer });
          socket.write(JSON.stringify({ token: state.token, cmd }) + "\n");
        });
      },
      async start() {
        const r = await client.request("start");
        if (!r.ok) throw new ControlError(r.error || "the helper add-on could not switch remote control on");
        return r.port;
      },
      close() {
        client.closed = true;
        socket.destroy();
      },
    };
    const connectTimer = setTimeout(() => {
      socket.destroy();
      reject(new ControlError("Zen's helper add-on did not accept the connection"));
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(connectTimer);
      resolve(client);
    });
    socket.on("data", (d) => {
      buffer += d.toString("utf8");
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        const w = waiting.shift();
        if (!w) continue;
        clearTimeout(w.timer);
        try {
          w.res(JSON.parse(line));
        } catch {
          w.rej(new ControlError("invalid answer from Zen's helper add-on"));
        }
      }
    });
    const fail = (err) => {
      clearTimeout(connectTimer);
      client.closed = true;
      for (const w of waiting.splice(0)) {
        clearTimeout(w.timer);
        w.rej(new ControlError(`the connection to Zen's helper add-on closed${err ? ` (${err.message})` : ""}`));
      }
      reject(new ControlError(`could not reach Zen's helper add-on${err ? ` (${err.message})` : ""}`));
    };
    socket.once("error", fail);
    socket.once("close", () => fail(null));
  });
}

/** Wait until the add-on in a freshly started browser has written its state. */
export async function waitForAddonState(profileDir, pid, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = addonState(profileDir);
    if (s && (!pid || s.pid === pid)) return s;
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}
