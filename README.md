# claude-for-zen

**Let Claude Code drive [Zen Browser](https://zen-browser.app) the way Claude in Chrome drives Chrome.**

`claude-for-zen` is an MCP server that gives Claude Code a full set of browser tools for Zen (or any Firefox-based browser): it opens tabs, reads pages, clicks, types, fills forms, runs JavaScript, reads console and network logs, handles dialogs, uploads files and records GIFs. Clicks and keystrokes are real, trusted input events, so sites behave as they do for a person.

> Unofficial community project. Not affiliated with or endorsed by Anthropic or the Zen Browser team.

```text
you ▸ open my GitHub notifications in Zen and summarise anything that needs my review

Claude ▸ tabs_create → navigate github.com/notifications → read_page → find "Review requested" → …
```

## How it works

```text
Claude Code ──stdio (MCP)──▶ claude-for-zen ──WebDriver BiDi (ws://127.0.0.1:9333)──▶ Zen
```

Claude in Chrome uses a Chrome extension and the Chrome DevTools Protocol. Firefox (and therefore Zen) does not expose an equivalent API to extensions, but it ships **WebDriver BiDi**, the W3C browser automation protocol, built in. `claude-for-zen` talks BiDi straight to Zen, so no extension is needed:

| Capability | How |
| --- | --- |
| Screenshots | `browsingContext.captureScreenshot`, scaled so screenshot pixels map exactly to page coordinates |
| Clicks, typing, keys, scroll, drag | `input.performActions`: trusted events (`event.isTrusted === true`), routed into the right frame (including cross-origin iframes) |
| Page structure, `find`, form filling | A small runtime injected into an **isolated sandbox** (page scripts can't see or tamper with it), producing an accessibility-tree outline with stable `ref_N` handles |
| JavaScript | `script.evaluate` in the page, with REPL semantics (top-level `await`, last expression returned) |
| Console and network | `log.entryAdded` and `network.*` events, buffered per tab |
| Dialogs | `browsingContext.userPromptOpened` and `handleUserPrompt` |

## Two ways to run it

| | **Your everyday Zen** (`--existing-profile`) | **Claude's own profile** (default) |
| --- | --- | --- |
| Where Claude works | New tabs in the Zen window you use, like Claude in Chrome | A separate Zen window with its own profile |
| Your logins, extensions, bookmarks | Available | Sign in once inside Claude's profile (`claude-for-zen launch`) |
| Setup cost | Zen must run with remote control on. It can only be switched on at startup, so if Zen is already open, Claude **asks you once** and restarts it; your windows and tabs come back as after a normal quit | None; Claude's Zen starts on first use |
| Side effects on your browsing | While Zen runs with remote control on, pages can see `navigator.webdriver === true` when Claude isn't connected (some sign-in pages treat that as automation), and other programs on your computer could connect to it | None |

Pick the everyday mode if you want Claude to work in your normal browser with your accounts. Pick the dedicated mode if you want automation kept apart from your personal browsing.

## Requirements

- [Zen Browser](https://zen-browser.app) (or a recent Firefox; set `ZEN_BINARY`)
- Node.js 20+
- [Claude Code](https://claude.com/claude-code)

macOS, Linux and Windows are supported. Zen and your profile are auto-detected in their usual locations.

## Install

```bash
git clone https://github.com/ilhamnadhif/claude-for-zen.git
cd claude-for-zen
npm install

# Either: Claude works in your everyday Zen (new tabs in your window)
node bin/claude-for-zen.js install --existing-profile

# Or: Claude gets its own separate Zen profile
node bin/claude-for-zen.js install

node bin/claude-for-zen.js doctor      # optional: checks everything
```

Or register it without cloning:

```bash
claude mcp add --scope user zen -e ZEN_PROFILE_MODE=existing -- npx -y github:ilhamnadhif/claude-for-zen
```

Start a new Claude Code session and ask for something in Zen ("open example.com in Zen and take a screenshot"). The tools appear as `mcp__zen__*`.

**Everyday mode, first use:** if Zen is open, Claude tells you it needs to restart Zen once and waits for your OK. You can avoid that by quitting Zen and starting it with `node bin/claude-for-zen.js launch` (or let Claude do it: `launch --restart`). Remote control then stays on until you quit Zen.

**Dedicated mode:** to sign in to sites for Claude, open its profile with `node bin/claude-for-zen.js launch` and log in as usual.

To remove it: `node bin/claude-for-zen.js uninstall` (or `claude mcp remove --scope user zen`).

## Tools

Everything Claude in Chrome offers, plus dialog handling, file uploads and window resizing.

| Tool | What it does | Claude in Chrome equivalent |
| --- | --- | --- |
| `tabs_context` | List Claude's tabs (`all: true` for every tab); `createIfEmpty` opens one; `restartBrowser` restarts your Zen once you agreed | `tabs_context_mcp` |
| `tabs_create` | Open a new tab, optionally at a URL | `tabs_create_mcp` |
| `tabs_close` | Close a tab Claude opened (`force` for others) | `tabs_close_mcp` |
| `navigate` | Go to a URL, or `back` / `forward` | `navigate` |
| `computer` | `screenshot`, `left_click`, `right_click`, `double_click`, `triple_click`, `type`, `key`, `scroll`, `scroll_to`, `hover`, `left_click_drag`, `zoom`, `wait`; click by coordinate or by `ref`, with modifiers | `computer` |
| `read_page` | Accessibility-tree outline with refs, including iframe contents; `filter: "interactive"`, `depth`, `ref_id`, `max_chars` | `read_page` |
| `find` | Find elements by description ("search bar", "Sign in button") | `find` |
| `form_input` | Set inputs, textareas, selects, checkboxes, radios, contenteditable editors (React/Vue friendly) | `form_input` |
| `get_page_text` | Readable text of the page, article first | `get_page_text` |
| `javascript_tool` | Run JavaScript in the page | `javascript_tool` |
| `read_console_messages` | Console logs and uncaught exceptions, with regex filter | `read_console_messages` |
| `read_network_requests` | HTTP requests with status/type/size; secrets in URLs redacted | `read_network_requests` |
| `gif_creator` | Record actions to an animated GIF (clicks marked) | `gif_creator` |
| `browser_batch` | Run several tool calls in one go | `browser_batch` |
| `handle_dialog` | Accept or dismiss `alert` / `confirm` / `prompt` / `beforeunload` | — |
| `file_upload` | Put local files into an `<input type=file>` | `upload_image` (more general) |
| `resize_window` | Resize the window (responsive testing) | `resize_window` |

## Configuration

Set environment variables with `claude-for-zen install -e KEY=VALUE` or `claude mcp add -e KEY=VALUE`.

| Variable | Default | Meaning |
| --- | --- | --- |
| `ZEN_PROFILE_MODE` | `dedicated` | `existing`: use your everyday profile, new tabs in your window. `dedicated`: Claude's own profile |
| `ZEN_RESTART` | `ask` | Everyday mode, Zen open without remote control: `ask` (Claude asks you first), `auto` (restart without asking), `never` (tell you to restart it yourself) |
| `ZEN_PROFILE` | see meaning | Profile directory. Dedicated: `~/.claude-for-zen/profile`. Everyday: the profile Zen normally opens (from `profiles.ini`) |
| `ZEN_BINARY` | auto-detected | Path to the Zen (or Firefox) executable |
| `ZEN_BIDI_PORT` | `9333` | Remote debugging port |
| `ZEN_BIDI_URL` | — | Connect to this BiDi endpoint and never launch Zen |
| `ZEN_CONNECT_ONLY` | `0` | Never launch Zen; connect to `ws://127.0.0.1:$ZEN_BIDI_PORT/session` |
| `ZEN_HEADLESS` | `0` | Launch Zen without a window |
| `ZEN_HIDE_WEBDRIVER` | `1` | While Claude is connected, report `navigator.webdriver === false` to pages, as in a normal session |
| `ZEN_KILL_ON_EXIT` | `0` | Dedicated mode: quit Claude's Zen when the server exits (by default it keeps running, like Chrome does). Your everyday Zen is never quit |
| `ZEN_SCREENSHOT_DIR` | OS temp dir | Where `save_to_disk` screenshots go |
| `ZEN_GIF_DIR` | `~/Downloads` | Where GIF exports go |
| `ZEN_NAVIGATION_TIMEOUT_MS` | `30000` | How long `navigate` waits for a page to load |
| `ZEN_DEBUG` | `0` | Verbose logs on stderr |

### What everyday mode changes in your profile

`install --existing-profile` (and every launch) writes a clearly marked block to your profile's `user.js`, leaving the rest of the file alone:

- `remote.prefs.recommended = false`: Firefox would otherwise apply "automation defaults" whenever remote control is on, which **disable Safe Browsing, the popup blocker and password saving**. This keeps your browser behaving normally.
- `dom.successive_dialog_time_limit = 0`: repeated `alert`/`confirm` dialogs stay plain, so Claude can handle them (you lose the "prevent this page from creating more dialogs" checkbox).
- `dom.file.createInChild = true`: needed for `file_upload`.

Zen is started with `-profile <your profile> --remote-debugging-port 9333`; on macOS through Launch Services, as if you opened it from the Dock. Delete the block from `user.js` to undo the prefs.

## Security and privacy

- The remote debugging port listens on `127.0.0.1` only. Web pages cannot connect to it (Firefox validates the `Host` and `Origin` headers), but **other programs running as your user can control that Zen while remote control is on**, just as with Chrome's remote debugging. In everyday mode that is your real browser with your sessions; quit and reopen Zen normally to turn remote control off.
- In everyday mode console and network events are collected only for the tabs Claude works with, and Claude lists only its own tabs unless asked for all of them.
- The page runtime runs in an isolated sandbox. Page scripts cannot read it or spoof its results.
- Password fields are never echoed back (`value="••••••"`), and tokens, keys, signatures and similar query parameters are shown as `REDACTED` in network logs.
- Claude Code's own permission prompts apply to every tool call. The server's instructions tell Claude not to enter secrets or take irreversible actions without asking you, and to ask before restarting your browser.
- Nothing is sent anywhere except between Claude Code and your local browser.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Claude says Zen must be restarted | Everyday mode, Zen was opened without remote control. Say yes, or quit Zen and run `claude-for-zen launch`. |
| "Zen did not quit within 20 seconds" | Zen is asking something (closing tabs, a download in progress). Answer it, then let Claude retry. |
| "Another client is already controlling this Zen instance" | WebDriver BiDi allows one session per browser. Close the other Claude Code session using Zen, or give each session its own `ZEN_BIDI_PORT` + `ZEN_PROFILE` (dedicated mode). |
| "The Claude Zen profile … is already open" | Dedicated mode: you opened Claude's profile without remote debugging. Close that window and retry, or use `claude-for-zen launch`. |
| "Port 9333 is used by another program" | Set `ZEN_BIDI_PORT` to a free port. |
| Zen or your profile not found | Set `ZEN_BINARY` (`/Applications/Zen.app/Contents/MacOS/zen` on macOS) and/or `ZEN_PROFILE` (`about:profiles` → Root Directory). |
| Anything else | `node bin/claude-for-zen.js doctor`, then run with `ZEN_DEBUG=1` and check Claude Code's MCP logs. |

## Limitations

- Everyday mode: remote control can only be turned on when Zen starts, so after you quit and reopen Zen normally, Claude asks to restart it again the next time it needs it.
- Browser UI outside the page (address bar, extension popups, permission prompts, native file pickers, the downloads panel) is not visible in screenshots and can't be clicked. The same is true for Claude in Chrome.
- `find` matches roles, labels, text and attributes heuristically. Claude in Chrome uses a model for this.
- One Claude Code session per Zen instance at a time (see Troubleshooting).
- The automatic restart is tested on macOS (Zen) and Linux (Firefox). On Windows Claude can't identify the running Zen process, so it asks you to quit Zen yourself; then it opens Zen with your profile (or use `claude-for-zen launch`).
- CAPTCHAs are not solved, by design.

## Development

```bash
npm test             # unit tests
npm run test:e2e     # end-to-end: launches headless Zen with throwaway profiles
E2E_HEADED=1 npm run test:e2e                  # watch it work
E2E_PROFILE_MODE=existing npm run test:e2e     # run the tool suite in everyday-profile mode
ZEN_BINARY=$(which firefox) npm run test:e2e   # against Firefox
```

The e2e suites drive the real MCP server over stdio, exactly as Claude Code does. `tools.test.js` exercises every tool against a fixture site: trusted clicks, modifier and multi-clicks, drag, unicode typing, React-style controlled inputs, cross-origin iframes, dialogs, popups, uploads, GIFs, stale refs and recovery after the browser is killed. `existing.test.js` plays the everyday-profile flow on a throwaway profile: a normally started browser, the permission prompt, the restart with session restore, Claude's tab in the user's window, and the browser left running afterwards. CI runs both against headless Firefox on Linux.

Project layout:

```text
bin/claude-for-zen.js   CLI (serve, install, uninstall, launch, doctor)
src/server.js           MCP tools
src/browser.js          BiDi session, tabs, refs, input, screenshots, event buffers, profile modes
src/page/runtime.js     sandboxed page runtime (accessibility tree, find, forms, text)
src/launcher.js         Zen/profile discovery, prefs, launch, graceful restart
src/bidi.js             WebDriver BiDi client
```

## Bahasa Indonesia (ringkas)

`claude-for-zen` membuat Claude Code bisa mengendalikan Zen Browser seperti Claude in Chrome mengendalikan Chrome: membuka tab, membaca halaman, klik, mengetik, mengisi form, menjalankan JavaScript, membaca console/network, menangani dialog, upload file, dan merekam GIF.

- **Pakai Zen harian Anda** (disarankan kalau ingin seperti Claude in Chrome): `node bin/claude-for-zen.js install --existing-profile`. Claude membuka **tab baru di jendela Zen Anda**, dengan login Anda. Kalau Zen sedang terbuka tanpa remote control, Claude akan **minta izin dulu** untuk me-restart Zen sekali; semua jendela dan tab kembali seperti biasa. Bisa juga tutup Zen lalu buka dengan `node bin/claude-for-zen.js launch`.
- **Profil terpisah untuk Claude**: `node bin/claude-for-zen.js install`. Claude memakai jendela Zen sendiri; login sekali lewat `node bin/claude-for-zen.js launch`.

## License

MIT
