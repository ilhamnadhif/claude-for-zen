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
  const mode = String(env.ZEN_PROFILE_MODE || "").trim().toLowerCase();
  if (mode && mode !== "existing" && mode !== "dedicated") {
    throw new Error(`ZEN_PROFILE_MODE must be "existing" or "dedicated" (got "${env.ZEN_PROFILE_MODE}").`);
  }
  const profileMode = mode || "dedicated";
  const restart = String(env.ZEN_RESTART || "ask").trim().toLowerCase();
  if (!["ask", "auto", "never"].includes(restart)) {
    throw new Error(`ZEN_RESTART must be "ask", "auto" or "never" (got "${env.ZEN_RESTART}").`);
  }
  const explicitProfile = env.ZEN_PROFILE ? path.resolve(String(env.ZEN_PROFILE)) : null;
  return {
    host: "127.0.0.1",
    port,
    // When set, connect to this endpoint and never launch a browser.
    bidiUrl,
    connectOnly: bidiUrl != null || truthy(env.ZEN_CONNECT_ONLY),
    binary: env.ZEN_BINARY ? String(env.ZEN_BINARY) : null,
    // "dedicated": Claude's own profile. "existing": the user's everyday profile.
    profileMode,
    // existing mode: what to do when Zen is open without remote debugging.
    restart,
    // existing / connect-only mode: Claude opens its tabs in a window of its own
    // (same profile) instead of the window the user is using.
    ownWindow: env.ZEN_OWN_WINDOW == null ? true : truthy(env.ZEN_OWN_WINDOW),
    // existing mode: install the helper add-on that switches remote control
    // on and off while Zen runs, so Zen never has to be restarted for Claude.
    helperAddon: truthy(env.ZEN_HELPER_ADDON),
    // Share the browser's single WebDriver BiDi session between Claude Code
    // sessions through a local broker process (src/broker.js).
    sharedSession: env.ZEN_SHARED_SESSION == null ? true : truthy(env.ZEN_SHARED_SESSION),
    // existing mode: null means "the profile Zen normally opens" (profiles.ini).
    profileDir: explicitProfile ?? (profileMode === "existing" ? null : path.join(defaultHome(), "profile")),
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
