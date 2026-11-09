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

// Prefs written to the user's everyday profile (ZEN_PROFILE_MODE=existing):
// only what claude-for-zen depends on, nothing that changes normal browsing.
export const EXISTING_PROFILE_PREFS = {
  "remote.prefs.recommended": false,
  "dom.successive_dialog_time_limit": 0,
  "dom.file.createInChild": true,
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

/**
 * (Re)write our managed block in the profile's user.js, keeping everything else.
 * Creates the profile directory unless `create` is false (existing profiles).
 */
export function prepareProfile(profileDir, prefs = MANAGED_PREFS, { create = true } = {}) {
  if (create) fs.mkdirSync(profileDir, { recursive: true });
  else if (!fs.statSync(profileDir).isDirectory()) throw new Error(`${profileDir} is not a directory`);
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
    ...Object.entries(prefs).map(([k, v]) => `user_pref(${JSON.stringify(k)}, ${prefValue(v)});`),
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

// ------------------------------------------------------------ everyday profile

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

/** Is this binary Zen (as opposed to Firefox or another fork)? */
export function isZenBinary(binary) {
  return /(^|[\\/])zen[^\\/]*$|zen[^\\/]*\.app[\\/]|zen[_-]browser/i.test(binary || "");
}

/** Directories that may hold profiles.ini, most likely first. */
export function profileRoots(binary) {
  const home = os.homedir();
  let zen;
  let firefox;
  if (process.platform === "darwin") {
    zen = [path.join(home, "Library/Application Support/zen")];
    firefox = [path.join(home, "Library/Application Support/Firefox")];
  } else if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
    zen = [path.join(appData, "zen")];
    firefox = [path.join(appData, "Mozilla", "Firefox")];
  } else {
    zen = [path.join(home, ".zen"), path.join(home, ".config/zen"), path.join(home, ".var/app/app.zen_browser.zen/.zen")];
    firefox = [
      path.join(home, ".mozilla/firefox"),
      path.join(home, ".config/mozilla/firefox"),
      path.join(home, "snap/firefox/common/.mozilla/firefox"),
      path.join(home, ".var/app/org.mozilla.firefox/.mozilla/firefox"),
    ];
  }
  return binary && !isZenBinary(binary) ? [...firefox, ...zen] : [...zen, ...firefox];
}

/** Parse profiles.ini and return the default profile's absolute path (or null). */
export function defaultProfileFromIni(text, root) {
  const sections = [];
  let cur = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(";") || line.startsWith("#")) continue;
    const m = line.match(/^\[(.+)\]$/);
    if (m) {
      cur = { name: m[1], values: {} };
      sections.push(cur);
    } else if (cur) {
      const i = line.indexOf("=");
      if (i > 0) cur.values[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
  }
  const resolve = (p, relative = true) => (relative && !path.isAbsolute(p) ? path.join(root, p) : p);
  // Firefox 67+: the profile this installation uses is recorded per install.
  const install = sections.find((s) => /^Install/i.test(s.name) && s.values.Default);
  if (install) return resolve(install.values.Default);
  const profiles = sections.filter((s) => /^Profile\d+$/i.test(s.name) && s.values.Path);
  const def = profiles.find((s) => s.values.Default === "1") || profiles[0];
  if (!def) return null;
  return resolve(def.values.Path, def.values.IsRelative !== "0");
}

/** Locate the profile the user's browser normally opens. */
export function findDefaultProfile(config) {
  if (config.profileDir) {
    if (!fs.existsSync(config.profileDir)) throw new Error(`ZEN_PROFILE points to ${config.profileDir}, which does not exist.`);
    return config.profileDir;
  }
  let binary = null;
  try {
    binary = findBinary(config);
  } catch {}
  for (const root of profileRoots(binary)) {
    let text;
    try {
      text = fs.readFileSync(path.join(root, "profiles.ini"), "utf8");
    } catch {
      continue;
    }
    const dir = defaultProfileFromIni(text, root);
    if (dir && fs.existsSync(dir)) return dir;
  }
  throw new Error(
    "Could not find your Zen profile. Set ZEN_PROFILE to its folder " +
      '(open about:profiles in Zen and copy the "Root Directory" of the profile in use).',
  );
}

function run(cmd, args, timeout = 5000) {
  return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout });
}

/**
 * Which process has this profile open? Returns {pid} (pid may be null when the
 * profile is locked but the owner can't be identified) or null.
 */
export function findProfileOwner(profileDir) {
  if (process.platform === "win32") {
    const lock = path.join(profileDir, "parent.lock");
    if (!fs.existsSync(lock)) return null;
    try {
      fs.closeSync(fs.openSync(lock, "r+"));
      return null; // stale lock file
    } catch (e) {
      return e.code === "EBUSY" || e.code === "EPERM" || e.code === "EACCES" ? { pid: null } : null;
    }
  }
  const parentLock = path.join(profileDir, ".parentlock");
  if (fs.existsSync(parentLock)) {
    try {
      const pids = run("lsof", ["-t", "--", parentLock]).split(/\s+/).map(Number).filter((p) => p > 0 && isAlive(p));
      if (pids.length) return { pid: pids[0] };
    } catch {}
  }
  // Linux also keeps a "lock" symlink pointing at "<ip>:+<pid>".
  try {
    const m = fs.readlinkSync(path.join(profileDir, "lock")).match(/\+(\d+)$/);
    if (m && isAlive(Number(m[1]))) return { pid: Number(m[1]) };
  } catch {}
  const procs = findProcessesUsingProfile(profileDir);
  return procs.length ? { pid: procs[0].pid } : null;
}

/** pid of the process listening on a local TCP port, or null if unknown. */
export function findPortListener(port) {
  if (process.platform === "win32") return null;
  try {
    const pid = Number(run("lsof", ["-nP", "-t", `-iTCP:${port}`, "-sTCP:LISTEN"]).split(/\s+/)[0]);
    return pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export function processCommand(pid) {
  if (!pid || process.platform === "win32") return "";
  try {
    return run("ps", ["-ww", "-o", "command=", "-p", String(pid)]).trim();
  } catch {
    return "";
  }
}

/**
 * Can a running browser be asked to quit the way the user would (saving its
 * session)? On macOS the standard Quit Apple Event does exactly that. On Linux,
 * Firefox exits on SIGTERM without writing its session (measured with Firefox
 * 159, headed and headless), and Windows offers no per-process equivalent, so
 * there the user quits the browser themselves.
 */
export const CAN_RESTART_BROWSER = process.platform === "darwin";

/**
 * Ask a browser process to quit the way the user would (Cmd+Q), so it saves
 * its session. Resolves true once it has exited.
 */
export async function quitGracefully(pid, { timeoutMs = 20000 } = {}) {
  if (!pid) return false;
  if (process.platform === "darwin") {
    let sent = false;
    try {
      // NSRunningApplication.terminate sends the standard Quit Apple Event to exactly this process.
      const out = run("osascript", [
        "-l",
        "JavaScript",
        "-e",
        `ObjC.import("AppKit"); const a = $.NSRunningApplication.runningApplicationWithProcessIdentifier(${Number(pid)}); a.isNil() ? "nil" : String(a.terminate)`,
      ], 10000).trim();
      sent = out === "true";
    } catch {}
    if (!sent) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {}
    }
  } else if (process.platform === "win32") {
    try {
      run("taskkill", ["/PID", String(pid)], 10000); // WM_CLOSE, no /F
    } catch {}
  } else {
    try {
      process.kill(pid, "SIGTERM"); // Firefox quits normally on SIGTERM
    } catch {}
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await sleep(200);
  }
  return !isAlive(pid);
}

/** Wait until no process holds the profile lock. */
export async function waitForProfileRelease(profileDir, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!findProfileOwner(profileDir)) return true;
    await sleep(200);
  }
  return false;
}

/** The value of a pref as stored in the profile (user.js wins over prefs.js), or undefined. */
export function readProfilePref(profileDir, name) {
  let value;
  for (const file of ["prefs.js", "user.js"]) {
    let text;
    try {
      text = fs.readFileSync(path.join(profileDir, file), "utf8");
    } catch {
      continue;
    }
    const re = new RegExp(`user_pref\\(\\s*${JSON.stringify(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*,\\s*([^)]*?)\\s*\\)\\s*;`, "g");
    for (const m of text.matchAll(re)) {
      try {
        value = JSON.parse(m[1]);
      } catch {
        value = m[1];
      }
    }
  }
  return value;
}

/** Will the browser bring all tabs back after a restart of this profile? */
export function restoresTabs(profileDir, binary) {
  const page = readProfilePref(profileDir, "browser.startup.page");
  // Zen ships with "restore previous session" (3) as its default; Firefox with 1.
  return (page ?? (isZenBinary(binary) ? 3 : 1)) === 3;
}

function macBundle(binary) {
  const m = process.platform === "darwin" && binary.match(/^(.*?\.app)\/Contents\/MacOS\/[^/]+$/);
  return m ? m[1] : null;
}

/**
 * Launch the browser with WebDriver BiDi enabled and wait for the port.
 *
 * Dedicated profile (default): the profile is created if needed and gets the
 * MANAGED_PREFS; the browser is detached so it outlives this process (like
 * Chrome does for Claude in Chrome); ZEN_KILL_ON_EXIT=1 ties its lifetime to
 * the server.
 *
 * Existing profile: opens the user's own browser the way the OS would (on
 * macOS through LaunchServices), with only EXISTING_PROFILE_PREFS added.
 * `oneShotPrefs` are applied for this start only.
 * @returns {Promise<{pid: number|null, binary: string}>}
 */
export async function launchBrowser(config, log = () => {}, { profileDir = config.profileDir, existing = false, oneShotPrefs = null } = {}) {
  const binary = findBinary(config);
  const prefs = existing ? EXISTING_PROFILE_PREFS : MANAGED_PREFS;
  if (existing) {
    if (findProfileOwner(profileDir)) throw new Error(`The profile ${profileDir} is already open in Zen.`);
    prepareProfile(profileDir, { ...prefs, ...(oneShotPrefs || {}) }, { create: false });
  } else {
    const running = findProcessesUsingProfile(profileDir);
    if (running.length) {
      throw new Error(
        `The Claude Zen profile (${profileDir}) is already open in another Zen process ` +
          `(pid ${running.map((r) => r.pid).join(", ")}) without remote debugging on port ${config.port}. ` +
          `Close that Zen window and try again.`,
      );
    }
    prepareProfile(profileDir, prefs);
  }

  const args = ["-profile", profileDir];
  if (!existing) args.push("-no-remote");
  args.push("--remote-debugging-port", String(config.port));
  if (config.headless) args.push("-headless");
  args.push(...config.extraArgs);

  let pid = null;
  let exited = null;
  const bundle = existing ? macBundle(binary) : null;
  if (bundle) {
    // A normal app launch (Dock icon, Apple Events, no inherited environment).
    log(`launching ${bundle} ${args.join(" ")}`);
    execFileSync("open", ["-n", "-a", bundle, "--args", ...args], { stdio: "ignore", timeout: 30000 });
  } else {
    log(`launching ${binary} ${args.join(" ")}`);
    const child = spawn(binary, args, {
      detached: true,
      stdio: "ignore",
      env: existing ? process.env : { ...process.env, MOZ_CRASHREPORTER_DISABLE: "1" },
    });
    pid = child.pid;
    child.once("exit", (code, signal) => {
      exited = { code, signal };
    });
    child.once("error", (err) => {
      exited = { error: err };
    });
    child.unref();
  }

  try {
    const deadline = Date.now() + config.launchTimeoutMs;
    while (Date.now() < deadline) {
      if (await isPortOpen(config.host, config.port)) {
        if (existing) pid = findProfileOwner(profileDir)?.pid ?? pid;
        return { pid, binary };
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
  } finally {
    // Zen has read user.js by the time the port opens (or gave up); drop one-shot prefs.
    if (existing && oneShotPrefs) {
      try {
        prepareProfile(profileDir, prefs, { create: false });
      } catch {}
    }
  }
}
