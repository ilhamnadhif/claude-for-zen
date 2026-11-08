// Locate and launch Zen (or any Firefox-based browser) with WebDriver BiDi enabled.

import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const USER_JS_BEGIN = "// >>> claude-for-zen managed prefs (do not edit inside this block) >>>";
const USER_JS_END = "// <<< claude-for-zen managed prefs <<<";

// Prefs written to the dedicated Claude profile.
export const MANAGED_PREFS = {
  // Do NOT let the remote agent flip "automation" defaults (it would disable
  // Safe Browsing, the popup blocker, password saving, ...).
  "remote.prefs.recommended": false,
  // Quiet first run.
  "browser.shell.checkDefaultBrowser": false,
  "browser.aboutwelcome.enabled": false,
  "browser.startup.homepage_override.mstone": "ignore",
  "startup.homepage_welcome_url": "",
  "startup.homepage_welcome_url.additional": "",
  "zen.welcome-screen.seen": true,
  "datareporting.policy.dataSubmissionPolicyBypassNotification": true,
  "datareporting.policy.firstRunURL": "",
  "trailhead.firstrun.didSeeAboutWelcome": true,
  // Firefox turns the 2nd+ dialog within 3s into a "prevent more dialogs" variant
  // that WebDriver BiDi cannot see or handle; keep dialogs plain.
  "dom.successive_dialog_time_limit": 0,
  // input.setFiles (file_upload) needs File objects created in the content process.
  "dom.file.createInChild": true,
  // Keep pages "focused" even when Claude's window is behind other windows
  // (like Claude in Chrome's focus emulation).
  "focusmanager.testmode": true,
  // Don't unload Claude's tabs under memory pressure mid-task.
  "browser.tabs.unloadOnLowMemory": false,
  "browser.tabs.warnOnClose": false,
  "browser.warnOnQuit": false,
  "browser.warnOnQuitShortcut": false,
};

function isExecutable(p) {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function which(cmd) {
  const exts = process.platform === "win32" ? (process.env.PATHEXT || ".EXE").split(";") : [""];
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = path.join(dir, cmd + ext);
      if (isExecutable(p)) return p;
    }
  }
  return null;
}

export function binaryCandidates() {
  const home = os.homedir();
  if (process.platform === "darwin") {
    const apps = ["Zen.app", "Zen Browser.app", "Zen Twilight.app"];
    const out = [];
    for (const root of ["/Applications", path.join(home, "Applications")]) {
      for (const app of apps) out.push(path.join(root, app, "Contents/MacOS/zen"));
    }
    return out;
  }
  if (process.platform === "win32") {
    const roots = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs")].filter(Boolean);
    const out = [];
    for (const r of roots) {
      out.push(path.join(r, "Zen Browser", "zen.exe"));
      out.push(path.join(r, "Zen", "zen.exe"));
    }
    return out;
  }
  return [
    which("zen"),
    which("zen-browser"),
    which("zen-bin"),
    "/opt/zen/zen",
    "/opt/zen-browser/zen",
    "/opt/zen-browser-bin/zen-bin",
    "/usr/lib/zen/zen",
    "/usr/lib/zen-browser/zen",
    "/var/lib/flatpak/exports/bin/app.zen_browser.zen",
    path.join(home, ".local/share/flatpak/exports/bin/app.zen_browser.zen"),
    path.join(home, ".tarball-installations/zen/zen"),
  ].filter(Boolean);
}

export function findBinary(config) {
  if (config.binary) {
    if (isExecutable(config.binary)) return config.binary;
    const resolved = which(config.binary);
    if (resolved) return resolved;
    throw new Error(`ZEN_BINARY is set to "${config.binary}" but it is not an executable file.`);
  }
  for (const c of binaryCandidates()) {
    if (isExecutable(c)) return c;
  }
  throw new Error(
    "Could not find the Zen Browser executable. Install Zen (https://zen-browser.app) " +
      "or set ZEN_BINARY to its path (any Firefox-based browser works, e.g. /usr/bin/firefox).",
  );
}

function prefValue(v) {
  if (typeof v === "string") return JSON.stringify(v);
  return String(v);
}

/** Create the profile directory and (re)write our managed block in user.js. */
export function prepareProfile(profileDir) {
  fs.mkdirSync(profileDir, { recursive: true });
  const userJs = path.join(profileDir, "user.js");
  let existing = "";
  try {
    existing = fs.readFileSync(userJs, "utf8");
  } catch {}
  const start = existing.indexOf(USER_JS_BEGIN);
  const end = existing.indexOf(USER_JS_END);
  if (start !== -1 && end !== -1 && end > start) {
    existing = existing.slice(0, start) + existing.slice(end + USER_JS_END.length);
  }
  const block = [
    USER_JS_BEGIN,
    ...Object.entries(MANAGED_PREFS).map(([k, v]) => `user_pref(${JSON.stringify(k)}, ${prefValue(v)});`),
    USER_JS_END,
  ].join("\n");
  const rest = existing.trim();
  fs.writeFileSync(userJs, `${block}\n${rest ? `\n${rest}\n` : ""}`);
}

export function isPortOpen(host, port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (v) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(v);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/** Best effort: is some process already using this profile directory? */
export function findProcessesUsingProfile(profileDir) {
  if (process.platform === "win32") return [];
  try {
    const out = execFileSync("ps", ["-eww", "-o", "pid=,command="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const needle = path.resolve(profileDir);
    return out
      .split("\n")
      // Child processes (content, GPU, media, …) carry -parentBuildID; only the main process matters.
      .filter((l) => l.includes(needle) && /-profile/.test(l) && !/-parentBuildID|plugin-container|helper/i.test(l))
      .map((l) => {
        const m = l.trim().match(/^(\d+)\s+(.*)$/);
        return m ? { pid: Number(m[1]), command: m[2] } : null;
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Launch the browser with the dedicated profile and wait for the BiDi port.
 * The browser is detached so it outlives this process (like Chrome does for
 * Claude in Chrome); set ZEN_KILL_ON_EXIT=1 to tie its lifetime to the server.
 * @returns {Promise<{pid: number, binary: string}>}
 */
export async function launchBrowser(config, log = () => {}) {
  const binary = findBinary(config);
  const running = findProcessesUsingProfile(config.profileDir);
  if (running.length) {
    throw new Error(
      `The Claude Zen profile (${config.profileDir}) is already open in another Zen process ` +
        `(pid ${running.map((r) => r.pid).join(", ")}) without remote debugging on port ${config.port}. ` +
        `Close that Zen window and try again.`,
    );
  }
  prepareProfile(config.profileDir);

  const args = ["-profile", config.profileDir, "-no-remote", "--remote-debugging-port", String(config.port)];
  if (config.headless) args.push("-headless");
  args.push(...config.extraArgs);

  log(`launching ${binary} ${args.join(" ")}`);
  const child = spawn(binary, args, {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, MOZ_CRASHREPORTER_DISABLE: "1" },
  });
  let exited = null;
  child.once("exit", (code, signal) => {
    exited = { code, signal };
  });
  child.once("error", (err) => {
    exited = { error: err };
  });
  child.unref();

  const deadline = Date.now() + config.launchTimeoutMs;
  while (Date.now() < deadline) {
    if (await isPortOpen(config.host, config.port)) {
      return { pid: child.pid, binary };
    }
    // Firefox on Linux may fork and exit its launcher process with code 0;
    // only treat a non-zero exit as fatal.
    if (exited && (exited.error || (exited.code && exited.code !== 0))) {
      throw new Error(`Zen exited during startup (${exited.error?.message || `code ${exited.code}`}).`);
    }
    await sleep(250);
  }
  throw new Error(
    `Zen did not open its remote debugging port ${config.port} within ${Math.round(config.launchTimeoutMs / 1000)}s. ` +
      `Is another program using that port? Set ZEN_BIDI_PORT to change it.`,
  );
}
