// Command line entry point.

import { execFileSync, spawnSync } from "node:child_process";

import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, endpointUrl } from "./config.js";
import { findBinary, isPortOpen, launchBrowser, findProcessesUsingProfile } from "./launcher.js";
import { VERSION } from "./version.js";

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "claude-for-zen.js");

const HELP = `claude-for-zen ${VERSION} — let Claude Code drive Zen Browser

Usage:
  claude-for-zen [serve]        Run the MCP server on stdio (what Claude Code launches)
  claude-for-zen install        Register the MCP server with Claude Code (user scope)
         [--name zen] [--scope user|local|project] [-e KEY=VALUE ...]
  claude-for-zen uninstall      Remove it from Claude Code  [--name zen] [--scope user]
  claude-for-zen launch         Open Claude's Zen profile (e.g. to sign in to sites once)
  claude-for-zen doctor         Check the setup end to end
  claude-for-zen --version

Environment (set with "claude mcp add -e KEY=VALUE" or install -e):
  ZEN_BINARY           Path to the Zen executable (auto-detected)
  ZEN_PROFILE          Profile directory for Claude's Zen (default ~/.claude-for-zen/profile)
  ZEN_BIDI_PORT        Remote debugging port (default 9333)
  ZEN_BIDI_URL         Connect to an existing WebDriver BiDi endpoint and never launch
  ZEN_CONNECT_ONLY=1   Never launch Zen; connect to ws://127.0.0.1:$ZEN_BIDI_PORT/session
  ZEN_HEADLESS=1       Launch Zen headless
  ZEN_HIDE_WEBDRIVER=0 Keep navigator.webdriver = true in pages
  ZEN_KILL_ON_EXIT=1   Quit the Zen that was launched when the server exits
  ZEN_DEBUG=1          Verbose logs on stderr
`;

function parseFlags(argv) {
  const flags = { env: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--name") flags.name = argv[++i];
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
  spawnSync(claude, ["mcp", "remove", "--scope", scope, name], { stdio: "ignore" });
  const args = ["mcp", "add", "--scope", scope];
  for (const e of flags.env) args.push("-e", e);
  args.push(name, "--", process.execPath, BIN, "serve");
  const r = spawnSync(claude, args, { stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status || 1);
  console.log(`\nInstalled. Start a new Claude Code session and ask it to use Zen, e.g. "open example.com in Zen and take a screenshot".`);
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

async function launch() {
  const config = loadConfig();
  if (config.connectOnly) {
    console.log(`ZEN_BIDI_URL / ZEN_CONNECT_ONLY is set; claude-for-zen will connect to ${endpointUrl(config)} and never launch Zen.`);
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

  if (!config.connectOnly) {
    try {
      line(true, `Zen executable: ${findBinary(config)}`);
    } catch (e) {
      line(false, e.message);
      ok = false;
    }
    line(null, `Profile: ${config.profileDir}`);
  } else {
    line(null, `Connect-only mode: ${endpointUrl(config)}`);
  }

  const open = await isPortOpen(config.host, config.port);
  line(null, `Port ${config.port}: ${open ? "Zen is listening" : "not running yet (will be launched on first use)"}`);
  if (!open && !config.connectOnly) {
    const procs = findProcessesUsingProfile(config.profileDir);
    if (procs.length) {
      line(false, `The Claude profile is open in Zen pid ${procs.map((p) => p.pid).join(", ")} without remote debugging. Close that window.`);
      ok = false;
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

  if (ok) {
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
      return launch();
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


