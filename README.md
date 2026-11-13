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
| Where Claude works | A Zen window of its own **in your profile**: your logins work, and Zen keeps it apart from your tabs. It comes to the front when Claude starts and closes when Claude closes its last tab (`ZEN_OWN_WINDOW=0`: tabs in the window you use instead) | A separate Zen window with its own profile |
| Your logins, extensions, bookmarks | Available | Sign in once inside Claude's profile (`claude-for-zen launch`) |
| Setup cost | **With `--no-restart` (Zen):** none. The "Claude for Zen" add-on switches remote control on while Claude works and off afterwards; Zen is never restarted. **Without it:** remote control can only be switched on at startup, so if Zen is already open Claude **asks you once** and restarts it (macOS; on Linux and Windows it asks you to quit Zen and then reopens it) | None; Claude's Zen starts on first use |
| Side effects on your browsing | With `--no-restart`: Zen accepts add-ons that aren't signed by Mozilla (see below). Without it: while Zen runs with remote control on, pages can see `navigator.webdriver === true` when Claude isn't connected, and other programs on your computer could connect to it | None |

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

# Either: Claude works in your everyday Zen profile (its own window, your logins),
# and Zen never needs a restart (installs the "Claude for Zen" helper add-on)
node bin/claude-for-zen.js install --no-restart

# Or: everyday profile without the add-on (Zen is restarted once when needed)
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

**`--no-restart`, first use:** the next time Zen starts it shows that "Claude for Zen" was added; choose **Enable**. That's all: from then on Claude switches remote control on when it needs Zen and off when it is done, while Zen keeps running. (Until then Claude falls back to the restart below.)

**Everyday mode without the add-on, first use:** if Zen is open, Claude tells you it needs to restart Zen once and waits for your OK (on Linux and Windows it asks you to quit Zen, then opens it again itself). You can avoid that by quitting Zen and starting it with `node bin/claude-for-zen.js launch` (on macOS also `launch --restart`). Remote control then stays on until you quit Zen.

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
| `ZEN_HELPER_ADDON` | `0` | Everyday mode: use the "Claude for Zen" add-on so Zen never needs a restart (`install --no-restart` sets it) |
| `ZEN_SHARED_SESSION` | `1` | Let several Claude Code sessions use the same Zen at once through the local session broker. `0`: connect directly, one session at a time |
| `ZEN_OWN_WINDOW` | `1` | Everyday mode: Claude opens its tabs in a window of its own (same profile). `0`: in the window you are using |
| `ZEN_RESTART` | `ask` | Everyday mode on macOS, Zen open without remote control: `ask` (Claude asks you first), `auto` (restart without asking), `never` (tell you to restart it yourself). On Linux and Windows Claude always asks you to quit Zen |
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

### The "Claude for Zen" add-on (`--no-restart`)

Firefox can switch its WebDriver BiDi remote agent on and off while it runs (`RemoteAgent.startAtRuntime`), but only privileged browser code may do that. The add-on in [`extension/`](extension/) is that code: a WebExtension experiment of about 200 lines that

- listens on a random `127.0.0.1` port and writes it, with a random token, to `claude-for-zen.json` in your profile (readable only by you);
- on `start` from claude-for-zen switches remote control on (port **9222**, the only port Firefox uses for this; the session shares your cookies like the command-line flag does), and switches it off again as soon as claude-for-zen disconnects;
- does nothing else: it exposes no API to web pages or other add-ons.

So remote control is on only while Claude is using Zen, and `navigator.webdriver` is never visible to sites. It shows up in `about:addons` as "Claude for Zen"; disable or remove it there.

Zen's defaults only run add-ons signed by Mozilla and without experiment APIs, and Mozilla doesn't sign experiments for third parties. `--no-restart` therefore also sets `xpinstall.signatures.required = false` and `extensions.experiments.enabled = true` in your profile (Zen is built so that these prefs apply; Firefox release builds ignore them, which is why this mode is Zen-only). The trade-off: Zen will then also accept other unsigned add-ons, so only install add-ons from sources you trust. Add-ons from addons.mozilla.org are unaffected.

### What everyday mode changes in your profile

`install --existing-profile` (and every launch) writes a clearly marked block to your profile's `user.js`, leaving the rest of the file alone:

- `remote.prefs.recommended = false`: Firefox would otherwise apply "automation defaults" whenever remote control is on, which **disable Safe Browsing, the popup blocker and password saving**. This keeps your browser behaving normally.
- `dom.successive_dialog_time_limit = 0`: repeated `alert`/`confirm` dialogs stay plain, so Claude can handle them (you lose the "prevent this page from creating more dialogs" checkbox).
- `dom.file.createInChild = true`: needed for `file_upload`.

Zen is started with `-profile <your profile> --remote-debugging-port 9333`; on macOS through Launch Services, as if you opened it from the Dock. Delete the block from `user.js` to undo the prefs.

## Security and privacy

- The remote debugging port listens on `127.0.0.1` only. Web pages cannot connect to it (Firefox validates the `Host` and `Origin` headers), but **other programs running as your user can control that Zen while remote control is on**, just as with Chrome's remote debugging. In everyday mode that is your real browser with your sessions; quit and reopen Zen normally to turn remote control off.
- In everyday mode console and network events are collected only for the tabs Claude works with, and Claude lists only its own tabs unless asked for all of them. Claude's window is an unsynced Zen window, so your tabs don't show up in it and its tabs don't show up in yours.
- The page runtime runs in an isolated sandbox. Page scripts cannot read it or spoof its results.
- Password fields are never echoed back (`value="••••••"`), and tokens, keys, signatures and similar query parameters are shown as `REDACTED` in network logs.
- Claude Code's own permission prompts apply to every tool call. The server's instructions tell Claude not to enter secrets or take irreversible actions without asking you, and to ask before restarting your browser.
- Nothing is sent anywhere except between Claude Code and your local browser.

## Several Claude Code sessions at once

Two projects can use the same Zen at the same time. Firefox allows only one WebDriver BiDi session per browser, so claude-for-zen starts a small **session broker** (`claude-for-zen broker`, a background process per browser) that owns that session and shares it:

- every Claude Code session gets its own tabs (in everyday mode its own window) and only lists and closes its own tabs; input goes to each session's own tabs, so they don't get in each other's way;
- the broker listens on a random `127.0.0.1` port and only accepts clients that present a random token from a file only you can read (`~/.claude-for-zen/run/`);
- the browser session ends, and with the add-on remote control switches off, only when the last session has left; the broker then exits by itself.

Sessions share the profile, so they share cookies and logins: signing out of a site in one project signs the other out too.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Claude says Zen must be restarted (or quit) | Everyday mode, Zen was opened without remote control. Say yes (macOS), or quit Zen and let Claude reopen it / run `claude-for-zen launch`. |
| "Zen did not quit within 20 seconds" | Zen is asking something (closing tabs, a download in progress). Answer it, then let Claude retry. |
| "Another program is controlling this Zen instance" | Something other than claude-for-zen's broker (another automation tool, or an older claude-for-zen) holds Zen's only WebDriver BiDi session. Close it, or quit and reopen Zen. |
| "The Claude Zen profile … is already open" | Dedicated mode: you opened Claude's profile without remote debugging. Close that window and retry, or use `claude-for-zen launch`. |
| "Port 9333 is used by another program" | Set `ZEN_BIDI_PORT` to a free port. |
| Zen or your profile not found | Set `ZEN_BINARY` (`/Applications/Zen.app/Contents/MacOS/zen` on macOS) and/or `ZEN_PROFILE` (`about:profiles` → Root Directory). |
| Anything else | `node bin/claude-for-zen.js doctor`, then run with `ZEN_DEBUG=1` and check Claude Code's MCP logs. |

## Limitations

- Everyday mode: remote control can only be turned on when Zen starts, so after you quit and reopen Zen normally, Claude asks to restart it again the next time it needs it.
- Browser UI outside the page (address bar, extension popups, permission prompts, native file pickers, the downloads panel) is not visible in screenshots and can't be clicked. The same is true for Claude in Chrome.
- `find` matches roles, labels, text and attributes heuristically. Claude in Chrome uses a model for this.
- The helper add-on needs Zen (or another Firefox build without enforced signing); with Firefox release, everyday mode falls back to restarting the browser once. While the add-on has remote control on, port 9222 must be free (Chrome's remote debugging often uses it).
- Zen's remote agent can't open windows itself (it only does that for Firefox), so claude-for-zen opens Claude's window the way you would: it Shift+clicks a link in a short-lived background tab of yours, which you may see flash in the sidebar. Closing Claude's window together with its last tab uses Zen's AppleScript support and works on macOS; elsewhere the window stays open with Zen's empty tab.
- The automatic restart is macOS-only, where the standard Quit event makes Zen save its session. On Linux, Firefox-based browsers exit on SIGTERM without saving it, and Windows has no clean per-process quit, so there Claude asks you to quit Zen and then opens it with your profile.
- CAPTCHAs are not solved, by design.

## Development

```bash
npm test             # unit tests
npm run test:e2e     # end-to-end: launches headless Zen with throwaway profiles
E2E_HEADED=1 npm run test:e2e                  # watch it work
E2E_PROFILE_MODE=existing npm run test:e2e     # run the tool suite in everyday-profile mode
ZEN_BINARY=$(which firefox) npm run test:e2e   # against Firefox
```

The e2e suites drive the real MCP server over stdio, exactly as Claude Code does. `tools.test.js` exercises every tool against a fixture site: trusted clicks, modifier and multi-clicks, drag, unicode typing, React-style controlled inputs, cross-origin iframes, dialogs, popups, uploads, GIFs, stale refs and recovery after the browser is killed. `existing.test.js` plays the everyday-profile flow on a throwaway profile: a normally started browser, the permission prompt, the restart with session restore (macOS) or reopening after the user quits (Linux), Claude's tabs in a window of their own that Zen keeps unsynced from the user's, and the browser left running afterwards. `addon.test.js` (Zen only) starts Zen without the flag, checks that the add-on switches remote control on without a restart, off when Claude disconnects, that two sessions keep it on until the last one leaves, and that Zen is opened without the flag when it isn't running. `shared.test.js` runs two and then three Claude Code sessions against one browser at the same time. CI runs everything except the add-on test against headless Firefox on Linux.

Project layout:

```text
bin/claude-for-zen.js   CLI (serve, install, uninstall, launch, doctor)
src/server.js           MCP tools
src/browser.js          BiDi session, tabs, refs, input, screenshots, event buffers, profile modes
src/page/runtime.js     sandboxed page runtime (accessibility tree, find, forms, text)
src/launcher.js         Zen/profile discovery, prefs, launch, graceful restart
src/bidi.js             WebDriver BiDi client
src/broker.js           session broker shared by several Claude Code sessions
src/addon.js            helper add-on packaging and control channel (extension/ is the add-on)
```

## Bahasa Indonesia (ringkas)

`claude-for-zen` membuat Claude Code bisa mengendalikan Zen Browser seperti Claude in Chrome mengendalikan Chrome: membuka tab, membaca halaman, klik, mengetik, mengisi form, menjalankan JavaScript, membaca console/network, menangani dialog, upload file, dan merekam GIF.

- **Pakai Zen harian Anda tanpa pernah restart** (disarankan): `node bin/claude-for-zen.js install --no-restart`. Ini memasang add-on kecil "Claude for Zen" yang menyalakan remote control hanya saat Claude bekerja, lalu mematikannya lagi. Zen tidak pernah di-restart. Saat Zen dibuka berikutnya, pilih **Enable** ketika muncul pemberitahuan add-on baru. Konsekuensinya: Zen jadi menerima add-on tanpa tanda tangan Mozilla, jadi pasang add-on lain hanya dari sumber tepercaya.
- **Pakai Zen harian Anda tanpa add-on**: `node bin/claude-for-zen.js install --existing-profile`. Claude membuka **jendela Zen sendiri dengan profil Anda**, jadi login tetap ada, dan tab Anda tidak tercampur. Jendela itu muncul di depan dan tertutup otomatis saat Claude menutup tab terakhirnya (macOS). Kalau Zen sedang terbuka tanpa remote control, Claude akan **minta izin dulu** untuk me-restart Zen sekali; semua jendela dan tab kembali seperti biasa (macOS; di Linux/Windows Claude meminta Anda menutup Zen, lalu membukanya lagi). Bisa juga tutup Zen lalu buka dengan `node bin/claude-for-zen.js launch`.
- **Beberapa project sekaligus:** beberapa sesi Claude Code bisa memakai Zen yang sama dalam waktu bersamaan. Masing-masing punya tab atau jendela sendiri. Login ikut sama karena profilnya satu.
- **Profil terpisah untuk Claude**: `node bin/claude-for-zen.js install`. Claude memakai jendela Zen sendiri; login sekali lewat `node bin/claude-for-zen.js launch`.

## License

MIT
