// Command line entry point.

import { execFileSync, spawnSync } from "node:child_process";

import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, endpointUrl } from "./config.js";
import {
  findBinary,
  isPortOpen,
  launchBrowser,
  findProcessesUsingProfile,
  findDefaultProfile,
  findProfileOwner,
  prepareProfile,
  restoresTabs,
  existingProfilePrefs,
  CAN_RESTART_BROWSER,
} from "./launcher.js";
import { addonInfo, addonState, connectControl, sideloadAddon } from "./addon.js";
import { VERSION } from "./version.js";

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "claude-for-zen.js");

const HELP = `claude-for-zen ${VERSION} — let Claude Code drive Zen Browser

Usage:
  claude-for-zen [serve]        Run the MCP server on stdio (what Claude Code launches)
  claude-for-zen install        Register the MCP server with Claude Code (user scope)
         [--existing-profile]   Use your everyday Zen profile (Claude gets its own window, your logins) instead of a separate profile
         [--no-restart]         Everyday profile + the "Claude for Zen" add-on, so Zen never needs a restart
         [--name zen] [--scope user|local|project] [-e KEY=VALUE ...]
  claude-for-zen uninstall      Remove it from Claude Code  [--name zen] [--scope user]
  claude-for-zen launch         Start Zen with remote control on (dedicated mode: Claude's profile,
         [--restart]            e.g. to sign in to sites once; existing mode: your Zen, --restart if open)
  claude-for-zen doctor         Check the setup end to end
  claude-for-zen --version

Environment (set with "claude mcp add -e KEY=VALUE" or install -e):
  ZEN_PROFILE_MODE     "dedicated" (default, Claude's own profile) or "existing" (your everyday profile)
  ZEN_RESTART          existing mode, Zen open without remote control: ask (default) | auto | never
  ZEN_OWN_WINDOW=0     existing mode: open Claude's tabs in your current window instead of a window of its own
  ZEN_HELPER_ADDON=1   existing mode: use the "Claude for Zen" add-on so Zen never needs a restart (install --no-restart)
  ZEN_SHARED_SESSION=0 Don't share Zen between Claude Code sessions (connect directly, one session at a time)
  ZEN_BINARY           Path to the Zen executable (auto-detected)
  ZEN_PROFILE          Profile directory (dedicated default ~/.claude-for-zen/profile;
                       existing default: the profile Zen normally opens)
  ZEN_BIDI_PORT        Remote debugging port (default 9333)
  ZEN_BIDI_URL         Connect to an existing WebDriver BiDi endpoint and never launch
  ZEN_CONNECT_ONLY=1   Never launch Zen; connect to ws://127.0.0.1:$ZEN_BIDI_PORT/session
  ZEN_HEADLESS=1       Launch Zen headless
  ZEN_HIDE_WEBDRIVER=0 Keep navigator.webdriver = true in pages
  ZEN_KILL_ON_EXIT=1   Quit the Zen that was launched when the server exits (dedicated mode only)
  ZEN_DEBUG=1          Verbose logs on stderr
`;

function parseFlags(argv) {
  const flags = { env: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--existing-profile") flags.mode = "existing";
    else if (a === "--dedicated-profile") flags.mode = "dedicated";
    else if (a === "--restart") flags.restart = true;
    else if (a === "--no-restart" || a === "--helper-addon") flags.helperAddon = true;
    else if (a === "--name") flags.name = argv[++i];
    else if (a === "--scope" || a === "-s") flags.scope = argv[++i];
    else if (a === "-e" || a === "--env") flags.env.push(argv[++i]);
    else if (a.startsWith("--name=")) flags.name = a.slice(7);
    else if (a.startsWith("--scope=")) flags.scope = a.slice(8);
    else throw new Error(`Unknown option ${a}`);
  }
  return flags;
}

function findClaude() {
  const r = spawnSync(process.platform === "win32" ? "where" : "which", ["claude"], { encoding: "utf8" });
  const p = r.stdout?.split(/\r?\n/)[0]?.trim();
  return p || null;
}

function install(argv) {
  const flags = parseFlags(argv);
  const name = flags.name || "zen";
  const scope = flags.scope || "user";
  const claude = findClaude();
  if (!claude) {
    console.error("Could not find the `claude` CLI on PATH. Install Claude Code first, or add the server manually:");
    console.error(`  claude mcp add --scope ${scope} ${name} -- ${process.execPath} ${BIN} serve`);
    process.exit(1);
  }
  const env = flags.env.filter((e) => !/^ZEN_PROFILE_MODE=/.test(e) && !(flags.helperAddon && /^ZEN_HELPER_ADDON=/.test(e)));
  const modeFromEnv = flags.env.map((e) => e.match(/^ZEN_PROFILE_MODE=(.*)$/)?.[1]).filter(Boolean).pop();
  const mode = flags.helperAddon ? "existing" : flags.mode || modeFromEnv;
  if (flags.helperAddon) env.unshift("ZEN_HELPER_ADDON=1");
  if (mode) env.unshift(`ZEN_PROFILE_MODE=${mode}`);
  let addonNote = null;

  if (mode === "existing") {
    // Write the few prefs claude-for-zen needs now, so they are in place whenever Zen next starts.
    const envVars = Object.fromEntries(env.map((e) => [e.slice(0, e.indexOf("=")), e.slice(e.indexOf("=") + 1)]));
    const config = loadConfig({ ...process.env, ...envVars });
    try {
      const dir = findDefaultProfile(config);
      prepareProfile(dir, existingProfilePrefs(config), { create: false });
      console.log(`Using your Zen profile: ${dir}`);
      if (config.helperAddon) {
        const info = addonInfo(dir);
        if (info?.active) addonNote = 'The "Claude for Zen" add-on is already active: Claude switches remote control on and off without restarting Zen.';
        else {
          sideloadAddon(dir);
          addonNote = info?.userDisabled
            ? 'The "Claude for Zen" add-on is disabled in Zen. Enable it in about:addons so Claude never needs to restart Zen.'
            : 'The next time Zen starts it will say "Claude for Zen" was added: choose Enable. From then on Claude never needs to restart Zen.';
        }
      }
    } catch (e) {
      console.error(e.message);
      process.exit(1);
    }
  }

  spawnSync(claude, ["mcp", "remove", "--scope", scope, name], { stdio: "ignore" });
  // `-e` is variadic, so it must come after the server name (claude mcp add <name> -e K=V -- cmd).
  const args = ["mcp", "add", "--scope", scope, name];
  for (const e of env) args.push("-e", e);
  args.push("--", process.execPath, BIN, "serve");
  const r = spawnSync(claude, args, { stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status || 1);
  console.log(`\nInstalled. Start a new Claude Code session and ask it to use Zen, e.g. "open example.com in Zen and take a screenshot".`);
  if (addonNote) {
    console.log("Claude will open its tabs in a Zen window of its own, with your profile and logins.");
    console.log(addonNote);
  } else if (mode === "existing") {
    console.log(
      CAN_RESTART_BROWSER
        ? "Claude will open its tabs in a Zen window of its own, with your profile and logins. If Zen is already open without remote control, Claude asks before restarting it once."
        : "Claude will open its tabs in a Zen window of its own, with your profile and logins. If Zen is already open without remote control, Claude asks you to quit it once and then reopens it.",
    );
  }
  console.log(`Tools appear as mcp__${name}__*. Run "claude-for-zen doctor" to verify the browser side.`);
}

function uninstall(argv) {
  const flags = parseFlags(argv);
  const claude = findClaude();
  if (!claude) {
    console.error("Could not find the `claude` CLI on PATH.");
    process.exit(1);
  }
  const r = spawnSync(claude, ["mcp", "remove", "--scope", flags.scope || "user", flags.name || "zen"], { stdio: "inherit" });
  process.exit(r.status || 0);
}

async function launch(argv) {
  const flags = parseFlags(argv);
  const config = loadConfig(flags.mode ? { ...process.env, ZEN_PROFILE_MODE: flags.mode } : process.env);
  if (config.connectOnly) {
    console.log(`ZEN_BIDI_URL / ZEN_CONNECT_ONLY is set; claude-for-zen will connect to ${endpointUrl(config)} and never launch Zen.`);
    return;
  }
  if (config.profileMode === "existing") {
    const dir = findDefaultProfile(config);
    if (config.helperAddon && addonInfo(dir)?.active) {
      // Remote control is switched on by the add-on when Claude needs it; Zen just has to run.
      if (findProfileOwner(dir)) {
        console.log('Zen is running. Its "Claude for Zen" add-on switches remote control on whenever Claude needs it.');
        return;
      }
      const r = await launchBrowser(config, (m) => console.log(m), { profileDir: dir, existing: true, remoteDebugging: false });
      console.log(`Opened Zen with your profile (pid ${r.pid ?? "?"}). The "Claude for Zen" add-on switches remote control on when Claude needs it.`);
      return;
    }
    if (await isPortOpen(config.host, config.port)) {
      console.log(`Zen is already running with remote control on (port ${config.port}).`);
      return;
    }
    if (findProfileOwner(dir) && !CAN_RESTART_BROWSER) {
      console.log("Zen is open without remote control. Quit Zen (Ctrl+Q), then run this command again.");
      return;
    }
    if (findProfileOwner(dir) && !flags.restart) {
      const back = restoresTabs(dir, findBinary(config)) ? "your windows and tabs come back" : "only pinned tabs and Essentials come back (Zen opens a home page at startup)";
      console.log(`Zen is open without remote control. Run "claude-for-zen launch --restart" to restart it now (${back}).`);
      return;
    }
    const { ZenBrowser } = await import("./browser.js");
    const b = new ZenBrowser(config, (m) => console.log(m));
    try {
      await b.startExistingProfile({ allowRestart: true });
    } catch (e) {
      console.error(e.message);
      process.exit(1);
    }
    console.log(`Zen is running with your profile (${dir}) and remote control on port ${config.port}.`);
    return;
  }
  if (await isPortOpen(config.host, config.port)) {
    console.log(`Claude's Zen is already running (port ${config.port}).`);
    return;
  }
  const r = await launchBrowser(config, (m) => console.log(m));
  console.log(`Launched Zen (pid ${r.pid}) with profile ${config.profileDir}.`);
  console.log("Sign in to the sites you want Claude to use; the profile keeps your sessions.");
}

async function doctor() {
  const config = loadConfig();
  let ok = true;
  const line = (status, msg) => console.log(`${status === true ? "✔" : status === false ? "✘" : "•"} ${msg}`);
  const major = Number(process.versions.node.split(".")[0]);
  const nodeOk = major >= 20;
  line(nodeOk, `Node.js ${process.versions.node}${nodeOk ? "" : " (need >= 20)"}`);
  ok &&= nodeOk;

  const existing = config.profileMode === "existing" && !config.connectOnly;
  let profileDir = config.profileDir;
  if (!config.connectOnly) {
    try {
      line(true, `Zen executable: ${findBinary(config)}`);
    } catch (e) {
      line(false, e.message);
      ok = false;
    }
    if (existing) {
      try {
        profileDir = findDefaultProfile(config);
        line(true, `Mode: your everyday Zen profile (${profileDir}); Claude opens its tabs in ${config.ownWindow ? "a window of its own" : "your current window"}`);
      } catch (e) {
        line(false, e.message);
        ok = false;
      }
    } else {
      line(null, `Mode: Claude's own profile (${profileDir}), a separate Zen window`);
    }
  } else {
    line(null, `Connect-only mode: ${endpointUrl(config)}`);
  }

  const open = await isPortOpen(config.host, config.port);
  let skipE2e = false;
  let addonReady = false;
  if (existing && profileDir && config.helperAddon) {
    const info = addonInfo(profileDir);
    const state = addonState(profileDir);
    const running = findProfileOwner(profileDir);
    if (info?.active && running && state) {
      try {
        const c = await connectControl(state);
        const st = await c.request("status");
        c.close();
        addonReady = !!st.ok;
        line(addonReady, `"Claude for Zen" add-on ${info.version} is active: Claude switches remote control on and off without restarting Zen`);
      } catch (e) {
        line(false, `"Claude for Zen" add-on is installed but did not answer (${e.message})`);
      }
    } else if (info?.active) {
      line(true, `"Claude for Zen" add-on ${info.version} is installed and enabled; it starts with Zen`);
      addonReady = true;
    } else if (info?.userDisabled) {
      line(false, '"Claude for Zen" add-on is disabled. Enable it in Zen\'s about:addons so Zen never needs a restart.');
    } else {
      line(null, '"Claude for Zen" add-on is not active yet: the next time Zen starts, choose Enable when it says the add-on was added.');
    }
  }
  if (open) {
    line(null, `Port ${config.port}: Zen is listening`);
  } else if (existing && profileDir && addonReady) {
    skipE2e = !findProfileOwner(profileDir);
    if (skipE2e) line(null, "Zen is not running; Claude opens it with your profile on first use.");
  } else if (existing && profileDir) {
    if (findProfileOwner(profileDir)) {
      line(
        null,
        CAN_RESTART_BROWSER
          ? `Zen is open without remote control. Claude will ask before restarting it once (or run "claude-for-zen launch --restart").`
          : `Zen is open without remote control. Quit Zen and run "claude-for-zen launch" (or let Claude open it after you quit).`,
      );
    } else {
      line(null, "Zen is not running; it will be opened with your profile on first use.");
    }
    skipE2e = true;
  } else {
    line(null, `Port ${config.port}: not running yet (will be launched on first use)`);
    if (!config.connectOnly) {
      const procs = findProcessesUsingProfile(config.profileDir);
      if (procs.length) {
        line(false, `The Claude profile is open in Zen pid ${procs.map((p) => p.pid).join(", ")} without remote debugging. Close that window.`);
        ok = false;
      }
    }
  }

  const claude = findClaude();
  if (claude) {
    try {
      const list = execFileSync(claude, ["mcp", "list"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 30000 });
      const registered = /claude-for-zen/.test(list);
      line(registered ? true : null, registered ? "Registered in Claude Code (claude mcp list)" : 'Not registered in Claude Code yet — run "claude-for-zen install"');
    } catch {
      line(null, "Could not run `claude mcp list`");
    }
  } else {
    line(null, "`claude` CLI not found on PATH");
  }

  if (ok && skipE2e) {
    console.log("\nSkipping the end-to-end check so your Zen is not opened or restarted. Run doctor again once Zen has remote control on.");
  } else if (ok) {
    console.log("\nEnd-to-end check (opens a tab, takes a screenshot, closes it)…");
    const { createServer } = await import("./server.js");
    const { handlers, browser } = createServer(config, { log: () => {} });
    try {
      const created = await handlers.tabs_create({ url: "data:text/html,<title>claude-for-zen doctor</title><h1>It works</h1>" });
      if (created.isError) throw new Error(created.content[0].text);
      const tabId = Number(created.content[0].text.match(/tab (\d+)/i)[1]);
      const shot = await handlers.computer({ action: "screenshot", tabId });
      if (shot.isError) throw new Error(shot.content[0].text);
      const tree = await handlers.read_page({ tabId, filter: "all" });
      if (!/heading "It works"/.test(tree.content[0].text)) throw new Error("read_page did not see the test heading");
      await handlers.tabs_close({ tabId });
      line(true, `Connected to ${browser.capabilities?.browserName} ${browser.capabilities?.browserVersion}; screenshot + read_page OK`);
    } catch (e) {
      line(false, `End-to-end check failed: ${e.message}`);
      ok = false;
    } finally {
      await browser.shutdown();
    }
  }
  console.log(ok ? "\nAll good." : "\nSome checks failed.");
  process.exit(ok ? 0 : 1);
}

export async function main(argv) {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case undefined:
    case "serve": {
      const { runStdioServer } = await import("./server.js");
      await runStdioServer();
      return;
    }
    case "install":
      return install(rest);
    case "uninstall":
      return uninstall(rest);
    case "launch":
      return launch(rest);
    case "broker": {
      // Internal: the detached session broker started by `serve` (src/broker.js).
      const { runBroker } = await import("./broker.js");
      const [host = "127.0.0.1", port] = rest;
      await runBroker(host, Number(port), { log: process.env.ZEN_DEBUG ? (m) => process.stderr.write(`[claude-for-zen broker] ${m}\n`) : () => {} });
      return;
    }
    case "doctor":
      return doctor();
    case "-v":
    case "--version":
    case "version":
      console.log(VERSION);
      return;
    case "-h":
    case "--help":
    case "help":
      console.log(HELP);
      return;
    default:
      console.error(`Unknown command "${cmd}".\n`);
      console.log(HELP);
      process.exit(1);
  }
}


