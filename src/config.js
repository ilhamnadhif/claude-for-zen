import os from "node:os";
import path from "node:path";
import fs from "node:fs";

function truthy(v) {
  return v != null && /^(1|true|yes|on)$/i.test(String(v).trim());
}

function int(v, fallback) {
  const n = parseInt(v ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function defaultHome() {
  return path.join(os.homedir(), ".claude-for-zen");
}

function defaultGifDir() {
  const downloads = path.join(os.homedir(), "Downloads");
  try {
    if (fs.statSync(downloads).isDirectory()) return downloads;
  } catch {}
  return path.join(os.tmpdir(), "claude-for-zen");
}

/**
 * All runtime configuration comes from environment variables so it can be set
 * with `claude mcp add -e KEY=value`.
 */
export function loadConfig(env = process.env) {
  const port = int(env.ZEN_BIDI_PORT, 9333);
  const bidiUrl = env.ZEN_BIDI_URL ? String(env.ZEN_BIDI_URL).trim() : null;
  return {
    host: "127.0.0.1",
    port,
    // When set, connect to this endpoint and never launch a browser.
    bidiUrl,
    connectOnly: bidiUrl != null || truthy(env.ZEN_CONNECT_ONLY),
    binary: env.ZEN_BINARY ? String(env.ZEN_BINARY) : null,
    profileDir: env.ZEN_PROFILE ? path.resolve(String(env.ZEN_PROFILE)) : path.join(defaultHome(), "profile"),
    headless: truthy(env.ZEN_HEADLESS),
    hideWebdriver: env.ZEN_HIDE_WEBDRIVER == null ? true : truthy(env.ZEN_HIDE_WEBDRIVER),
    killOnExit: truthy(env.ZEN_KILL_ON_EXIT),
    launchTimeoutMs: int(env.ZEN_LAUNCH_TIMEOUT_MS, 45_000),
    commandTimeoutMs: int(env.ZEN_COMMAND_TIMEOUT_MS, 60_000),
    navigationTimeoutMs: int(env.ZEN_NAVIGATION_TIMEOUT_MS, 30_000),
    screenshotDir: env.ZEN_SCREENSHOT_DIR ? path.resolve(String(env.ZEN_SCREENSHOT_DIR)) : path.join(os.tmpdir(), "claude-for-zen"),
    gifDir: env.ZEN_GIF_DIR ? path.resolve(String(env.ZEN_GIF_DIR)) : defaultGifDir(),
    extraArgs: env.ZEN_EXTRA_ARGS ? String(env.ZEN_EXTRA_ARGS).split(/\s+/).filter(Boolean) : [],
    debug: truthy(env.ZEN_DEBUG),
  };
}

export function endpointUrl(config) {
  return config.bidiUrl || `ws://${config.host}:${config.port}/session`;
}
