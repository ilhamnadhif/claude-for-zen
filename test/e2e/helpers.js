import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

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

  async function close() {
    try {
      await client.close();
    } catch {}
    // Give the server a moment to quit the browser it launched.
    await new Promise((r) => setTimeout(r, 1500));
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
