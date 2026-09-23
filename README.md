# OmOWright

[![CI](https://github.com/code-yeongyu/omowright/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/code-yeongyu/omowright/actions/workflows/ci.yml)

Browser automation as a code library for AI agents. OmOWright drives any
Chromium over the DevTools Protocol, with no external CLI, no daemon, and, on
the pipe transport, no listening CDP port. Its snapshots are sized for LLMs, and
the package ships an agent skill that teaches a model how to use it.

- **Token-efficient accessibility snapshots.** `page.snapshot()` returns an
  indented role tree with virtual refs (`[ref=e1]` -> `page.locator("e1")`);
  `compactSnapshot()` drops the duplicated refs map (about 57% smaller on real
  pages), and re-snapshots come back as a unified diff.
- **Zero-port pipe transport.** `connectPipe()` launches Chromium with
  `--remote-debugging-pipe` and speaks CDP over inherited file descriptors, so
  no `/json/*` endpoint or TCP port exists for the driven browser.
- **Agent toolkit.** Coordinate control (`createCua`), CAPTCHA helpers
  (`createCaptcha`), network snooping and request routes, flight-recorder traces
  with HAR export, OOPIF-aware snapshots, overlay detection, dialog policy,
  device emulation, human handoff for login and OTP, background agent tabs, and
  push events for tabs, popups, and downloads.
- **Real-profile reads.** `createChromeApi()` exposes MV3-shaped
  tabs/windows/bookmarks/history/downloads/topSites over CDP and profile files.
  A native-messaging bridge extension covers what CDP cannot see.

## Install

The package is private. Install it from GitHub with an account that can read
this repository:

```bash
bun add github:code-yeongyu/omowright
```

Bun >= 1.4 is recommended; Node >= 22 is supported. Runtime dependencies are
`ws` and `zod`. OmOWright never downloads a browser; point it at any Chromium,
Chrome, a Chromium headless shell, or CloakBrowser.

## Quick start

```js
import { compactSnapshot, connectPipe } from "omowright";

const browser = await connectPipe({
  browserPath: "/path/to/chromium",
  browserArgs: ["--headless", "--no-first-run"],
});
const page = await browser.newTab("https://example.com");
console.log(compactSnapshot(await page.snapshot()));
await page.locator("e1").click();
await browser.close();
```

To attach to a browser that already exposes a DevTools HTTP endpoint instead:

```js
import { connect } from "omowright";

const browser = await connect("http://127.0.0.1:9222");
const targets = await browser.listTargets();
const page = await browser.attachPage(targets.find((t) => t.type === "page").id);
```

Snapshot options: `maxDepth` (50), `maxChars`, `interactive`, `showHidden`,
`selector`, `ref`. `goto` waits for meaningful content rather than
`readyState`. Every JavaScript dialog is handled by the dialog policy and
surfaced via `page.on("dialog")`. The agent-facing tool reference is
[`TOOLS.md`](TOOLS.md); machine-readable schemas ship as the `toolSchemas` export.

## Agent skill

`skills/omowright/` is a self-contained agent skill (`SKILL.md` plus
references) that routes a model through the library: the snapshot/ref loop, the
obstacle ladder (refs -> overlays -> coordinates -> viewport pin -> CAPTCHA ->
browser log), stealth profiles, eval-kernel usage, frames and human handoff, and
reading a 1Password web vault item safely. Task presets live in `presets/`:

| Preset | Covers |
| --- | --- |
| `presets/visual-browse` | Coordinate UI, viewport pinning, extension popups |
| `presets/captcha` | Checkbox, slider, OCR, and image-grid challenges |
| `presets/network` | Snoop JSON APIs, wait for requests, scroll collection, traces, routes |
| `presets/chrome` | Tabs, windows, bookmarks, history, downloads, topSites |
| `presets/agent-events` | Tab, popup, and download push events |
| `presets/cloak-bridge` | The MV3 bridge extension and native-messaging host |

Install the skill by copying or symlinking `skills/omowright` into your
harness's skills directory (for example `~/.agents/skills/omowright`).

## Persistent CloakBrowser profiles

For long-lived authenticated work, use `connectCloakProfile()` or the bundled
`omowright-cloak` launcher. The first run stores a random fingerprint seed in
`.omowright-cloak.json` (mode `0600`) inside the private profile (mode `0700`).
Later runs reuse the seed and reject a conflicting one instead of silently
changing identity. Never copy Google or 1Password cookies between profiles. Full
lifecycle: [`docs/cloakbrowser-persistent-profile.md`](docs/cloakbrowser-persistent-profile.md).

## Bridge extension

For what CDP cannot see (notifications, tabGroups, bookmark and history writes,
`chrome.debugger` on a user-driven browser), `bridge/extension/` is a minimal
MV3 service-worker extension paired with a native-messaging stdio host
(`src/bridge-transport.js`). It uses strict zod envelopes in both directions,
bounded queues, and one mutation in flight, and like the pipe transport it
opens no listening ports. `createChromeApi` uses the bridge when it is
connected and falls back to read-only profile access otherwise.

## Development

```bash
bun install
bun run test        # Bun runner
bun run test:node   # Node test runner, same files
```

Live tests need a Chromium headless shell. Set `SHELL_BIN` (and
`CLOAKBROWSER_BIN` for the event-bridge test) to its path, or install one into
Playwright's cache. CI installs `chrome-headless-shell` with
`@puppeteer/browsers` and runs both runners on Ubuntu. `test/hygiene.test.mjs`
fails the build if a tracked file contains an absolute home path, a personal
address, or a private host.

## License

Proprietary. Copyright (c) 2026 Yeongyu Kim. All rights reserved. See
[`LICENSE`](LICENSE).
