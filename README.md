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
                                                                                     (Claude's own profile)
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

By default Claude gets its **own Zen profile**, launched on first use as a separate Zen window next to your normal one. Your everyday Zen profile is never touched. Sign in to the sites you want Claude to use once (`claude-for-zen launch`), and the profile remembers them.

## Requirements

- [Zen Browser](https://zen-browser.app) (or a recent Firefox; set `ZEN_BINARY`)
- Node.js 20+
- [Claude Code](https://claude.com/claude-code)

macOS, Linux and Windows are supported. Zen is auto-detected in its usual install locations.

## Install

```bash
git clone https://github.com/ilhamnadhif/claude-for-zen.git
cd claude-for-zen
npm install
node bin/claude-for-zen.js install     # registers the "zen" MCP server with Claude Code (user scope)
node bin/claude-for-zen.js doctor      # optional: checks everything end to end
```

Or register it yourself without cloning:

```bash
claude mcp add --scope user zen -- npx -y github:ilhamnadhif/claude-for-zen
```

Start a new Claude Code session and ask for something in Zen ("open example.com in Zen and take a screenshot"). The tools appear as `mcp__zen__*`.

To sign in to sites for Claude, open its profile and log in as usual:

```bash
node bin/claude-for-zen.js launch
```

To remove it: `node bin/claude-for-zen.js uninstall` (or `claude mcp remove --scope user zen`).

## Tools

Everything Claude in Chrome offers, plus dialog handling, file uploads and window resizing.

| Tool | What it does | Claude in Chrome equivalent |
| --- | --- | --- |
| `tabs_context` | List Claude's tabs (`all: true` for every tab); `createIfEmpty` opens one | `tabs_context_mcp` |
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
| `ZEN_BINARY` | auto-detected | Path to the Zen (or Firefox) executable |
| `ZEN_PROFILE` | `~/.claude-for-zen/profile` | Claude's profile directory |
| `ZEN_BIDI_PORT` | `9333` | Remote debugging port |
| `ZEN_BIDI_URL` | — | Connect to this BiDi endpoint and never launch Zen |
| `ZEN_CONNECT_ONLY` | `0` | Never launch Zen; connect to `ws://127.0.0.1:$ZEN_BIDI_PORT/session` |
| `ZEN_HEADLESS` | `0` | Launch Zen without a window |
| `ZEN_HIDE_WEBDRIVER` | `1` | Report `navigator.webdriver === false` to pages, as in a normal session |
| `ZEN_KILL_ON_EXIT` | `0` | Quit the launched Zen when the server exits (by default it keeps running, like Chrome does) |
| `ZEN_SCREENSHOT_DIR` | OS temp dir | Where `save_to_disk` screenshots go |
| `ZEN_GIF_DIR` | `~/Downloads` | Where GIF exports go |
| `ZEN_NAVIGATION_TIMEOUT_MS` | `30000` | How long `navigate` waits for a page to load |
| `ZEN_DEBUG` | `0` | Verbose logs on stderr |

### Using your everyday Zen profile (advanced)

Claude in Chrome works inside your normal browser. You can do the same with Zen, but understand the trade-offs first:

- Zen must be started with `--remote-debugging-port`, and **while it runs that way every page sees `navigator.webdriver === true`** (claude-for-zen hides it only while it is connected). Some sites, such as Google sign-in, treat that as automation.
- Firefox applies "automation defaults" when remote debugging is on, which **disable Safe Browsing, the popup blocker and password saving** unless you opt out.

If you still want it:

1. In `about:config` of your profile, set:
   - `remote.prefs.recommended` = `false` (keeps Safe Browsing, the popup blocker and password saving on)
   - `dom.successive_dialog_time_limit` = `0` (otherwise repeated dialogs can't be handled)
   - `dom.file.createInChild` = `true` (needed for `file_upload`)
2. Quit Zen, then start it with the flag:
   `/Applications/Zen.app/Contents/MacOS/zen --remote-debugging-port 9333`
3. Register the server in connect-only mode:
   `node bin/claude-for-zen.js install -e ZEN_CONNECT_ONLY=1`

Claude then opens its tabs in a separate window of your profile.

## Security and privacy

- The remote debugging port listens on `127.0.0.1` only. Web pages cannot connect to it (Firefox validates the `Host` and `Origin` headers), but **other programs running as your user can control that Zen instance while it is running**, just as with Chrome's remote debugging. Quit Claude's Zen when you don't need it if that matters to you.
- The page runtime runs in an isolated sandbox. Page scripts cannot read it or spoof its results.
- Password fields are never echoed back (`value="••••••"`), and tokens, keys, signatures and similar query parameters are shown as `REDACTED` in network logs.
- Claude Code's own permission prompts apply to every tool call. The server's instructions tell Claude not to enter secrets or take irreversible actions without asking you.
- Nothing is sent anywhere except between Claude Code and your local browser.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| "Another client is already controlling this Zen instance" | WebDriver BiDi allows one session per browser. Close the other Claude Code session using Zen, or give each session its own `ZEN_BIDI_PORT` + `ZEN_PROFILE`. |
| "The Claude Zen profile … is already open" | You opened Claude's profile without remote debugging. Close that window and retry, or use `claude-for-zen launch`. |
| Port already in use | Another program uses 9333. Set `ZEN_BIDI_PORT`. |
| Zen not found | Set `ZEN_BINARY` to the executable (`/Applications/Zen.app/Contents/MacOS/zen` on macOS). |
| Anything else | `node bin/claude-for-zen.js doctor`, then run with `ZEN_DEBUG=1` and check Claude Code's MCP logs. |

## Limitations

- Browser UI outside the page (address bar, extension popups, permission prompts, native file pickers, the downloads panel) is not visible in screenshots and can't be clicked. The same is true for Claude in Chrome.
- `find` matches roles, labels, text and attributes heuristically. Claude in Chrome uses a model for this.
- One Claude Code session per Zen instance at a time (see Troubleshooting).
- CAPTCHAs are not solved, by design.

## Development

```bash
npm test             # unit tests
npm run test:e2e     # end-to-end: launches a headless Zen with a throwaway profile
E2E_HEADED=1 npm run test:e2e                  # watch it work
ZEN_BINARY=$(which firefox) npm run test:e2e   # against Firefox
```

The e2e suite drives the real MCP server over stdio, exactly as Claude Code does, and exercises every tool against a fixture site: trusted clicks, modifier and multi-clicks, drag, unicode typing, React-style controlled inputs, cross-origin iframes, dialogs, popups, uploads, GIFs, stale refs and recovery after the browser is killed. CI runs it against headless Firefox on Linux.

Project layout:

```text
bin/claude-for-zen.js   CLI (serve, install, uninstall, launch, doctor)
src/server.js           MCP tools
src/browser.js          BiDi session, tabs, refs, input, screenshots, event buffers
src/page/runtime.js     sandboxed page runtime (accessibility tree, find, forms, text)
src/launcher.js         Zen discovery, profile prefs, launch
src/bidi.js             WebDriver BiDi client
```

## Bahasa Indonesia (ringkas)

`claude-for-zen` membuat Claude Code bisa mengendalikan Zen Browser seperti Claude in Chrome mengendalikan Chrome: membuka tab, membaca halaman, klik, mengetik, mengisi form, menjalankan JavaScript, membaca console/network, menangani dialog, upload file, dan merekam GIF. Pasang dengan `npm install`, lalu `node bin/claude-for-zen.js install`. Claude memakai profil Zen tersendiri (jendela terpisah), jadi profil harian Anda tidak tersentuh. Login ke situs yang ingin dipakai Claude sekali lewat `node bin/claude-for-zen.js launch`.

## License

MIT
