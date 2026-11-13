import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { findProfileOwner } from "../../src/launcher.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, "..", "..");
export const BIN = path.join(ROOT, "bin", "claude-for-zen.js");
const FIXTURES = path.join(here, "fixtures");

export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

export async function startFixtureServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname.startsWith("/api/data")) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, page: url.searchParams.get("page") }));
      return;
    }
    const file = path.join(FIXTURES, path.normalize(url.pathname).replace(/^(\.\.[/\\])+/, ""));
    if (!file.startsWith(FIXTURES) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    res.setHeader("content-type", file.endsWith(".html") ? "text/html; charset=utf-8" : "application/octet-stream");
    res.end(fs.readFileSync(file));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

export async function startMcp(extraEnv = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cfz-e2e-"));
  const port = await freePort();
  const env = {
    ...process.env,
    ZEN_PROFILE: path.join(tmp, "profile"),
    ZEN_BIDI_PORT: String(port),
    ZEN_HEADLESS: process.env.E2E_HEADED ? "0" : "1",
    ZEN_KILL_ON_EXIT: "1",
    ZEN_GIF_DIR: path.join(tmp, "gifs"),
    ZEN_SCREENSHOT_DIR: path.join(tmp, "shots"),
    ...extraEnv,
  };
  // E2E_PROFILE_MODE=existing runs a suite as if the throwaway profile were the
  // user's everyday one (it must exist; Claude may not quit it on exit).
  if (process.env.E2E_PROFILE_MODE === "existing" && !extraEnv.ZEN_PROFILE_MODE) {
    env.ZEN_PROFILE_MODE = "existing";
    fs.mkdirSync(env.ZEN_PROFILE, { recursive: true });
    fs.writeFileSync(
      path.join(env.ZEN_PROFILE, "user.js"),
      ['"browser.aboutwelcome.enabled", false', '"zen.welcome-screen.seen", true', '"browser.startup.homepage_override.mstone", "ignore"', '"trailhead.firstrun.didSeeAboutWelcome", true', '"datareporting.policy.dataSubmissionPolicyBypassNotification", true']
        .map((p) => `user_pref(${p});`)
        .join("\n") + "\n",
    );
  }
  const transport = new StdioClientTransport({ command: process.execPath, args: [BIN, "serve"], env, stderr: "pipe" });
  let stderr = "";
  transport.stderr?.on("data", (d) => {
    stderr += d.toString();
  });
  const client = new Client({ name: "cfz-e2e", version: "1.0.0" });
  await client.connect(transport);

  async function call(name, args = {}, { expectError = false } = {}) {
    const res = await client.callTool({ name, arguments: args }, undefined, { timeout: 180000 });
    const textOut = res.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
    if (!!res.isError !== expectError) {
      throw new Error(`${name}(${JSON.stringify(args)}) ${expectError ? "unexpectedly succeeded" : "failed"}: ${textOut}\n--- server stderr ---\n${stderr.slice(-2000)}`);
    }
    return { ...res, text: textOut, images: res.content.filter((c) => c.type === "image") };
  }

  async function js(tabId, code) {
    const r = await call("javascript_tool", { tabId, text: code, action: "javascript_exec" });
    try {
      return JSON.parse(r.text);
    } catch {
      return r.text;
    }
  }

  async function close({ keepBrowser = false } = {}) {
    try {
      await client.close();
    } catch {}
    // Another session still uses the browser: leave it and its profile alone.
    if (keepBrowser) return;
    // Give the server a moment to quit the browser it launched, then make sure
    // nothing is left holding a throwaway profile this helper created.
    await new Promise((r) => setTimeout(r, 1500));
    const ownProfile = path.resolve(env.ZEN_PROFILE).startsWith(tmp + path.sep);
    const owner = ownProfile && fs.existsSync(env.ZEN_PROFILE) ? findProfileOwner(env.ZEN_PROFILE) : null;
    if (owner?.pid) {
      try {
        process.kill(owner.pid, "SIGKILL");
      } catch {}
      await new Promise((r) => setTimeout(r, 500));
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  return { client, call, js, close, tmp, env, port, get stderr() { return stderr; } };
}

export function refFor(treeText, pattern) {
  const line = treeText.split("\n").find((l) => pattern.test(l));
  if (!line) throw new Error(`No line matching ${pattern} in:\n${treeText.slice(0, 3000)}`);
  const m = line.match(/\[(ref_\d+)\]/);
  if (!m) throw new Error(`No ref in line: ${line}`);
  return m[1];
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Read a Firefox/Zen .jsonlz4 session file ("mozLz40\0" + size + LZ4 block). */
export function readMozLz4(file) {
  const buf = fs.readFileSync(file);
  if (buf.subarray(0, 8).toString("latin1") !== "mozLz40\0") return buf.toString("utf8");
  const src = buf.subarray(12);
  const out = Buffer.alloc(buf.readUInt32LE(8));
  let i = 0;
  let o = 0;
  while (i < src.length) {
    const token = src[i++];
    let lit = token >> 4;
    if (lit === 15) for (let b = 255; b === 255; ) lit += b = src[i++];
    src.copy(out, o, i, i + lit);
    i += lit;
    o += lit;
    if (i >= src.length) break;
    const offset = src[i] | (src[i + 1] << 8);
    i += 2;
    let len = token & 15;
    if (len === 15) for (let b = 255; b === 255; ) len += b = src[i++];
    len += 4;
    for (let k = 0; k < len; k++, o++) out[o] = out[o - offset];
  }
  return out.subarray(0, o).toString("utf8");
}
