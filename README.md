# OmOWright

`OmOWright` is a standalone browser automation package. It provides CDP
session, frame, locator, input, event, and accessibility snapshot behavior
through small standalone adapters.

## Scope

This package connects to a standard, unauthenticated Chromium DevTools Protocol HTTP endpoint such as one exposed with `--remote-debugging-port`:

```js
import { connect } from "omowright";
const browser = await connect("http://127.0.0.1:9222");
const targets = await browser.listTargets();
const page = await browser.attachPage(targets.find(target => target.type === "page").id);
```

For a private, zero-port browser launched by OmOWright:

```js
import { compactSnapshot, connectPipe } from "omowright";

const browser = await connectPipe({
  browserPath: "/path/to/chromium",
  browserArgs: ["--headless", "--no-first-run"],
});
const page = await browser.newTab("https://example.com");
console.log(compactSnapshot(await page.snapshot()));
await browser.close();
```

## Runtime

Bun >= 1.4 is recommended; Node >= 20 is supported. Run the default suite with
`bun test` (or `bun run test`) and the Node runner with `bun run test:node`.
Integration tests need a Chromium headless shell from Playwright's cache.

## Persistent CloakBrowser profiles

For long-lived authenticated workflows, use a stable CloakBrowser
`--user-data-dir` on the machine that owns the browser session. Do not copy
Google or 1Password cookies from another profile; use the same persistent
profile for the initial login and subsequent runs, and stop with
`login_required` when it is logged out.

The complete setup, profile lifecycle, cookie boundary, and scheduler
machine-boundary pattern are documented in
[`docs/cloakbrowser-persistent-profile.md`](docs/cloakbrowser-persistent-profile.md).

For a reused authenticated profile, use the bundled `omowright-cloak` launcher
or `connectCloakProfile()`. The first run stores a random fingerprint seed in
`.omowright-cloak.json` (mode `0600`) inside the private profile; later runs
reuse it and reject a conflicting seed. The profile itself is mode `0700`, and
the metadata file contains no credentials.

The launcher uses `connectPipe()` with the CloakBrowser binary, not a plain
Chromium process. It adds the fixed `--fingerprint=<seed>` and
`--fingerprint-platform=<platform>` flags while preserving the zero-port CDP
transport. Keep one process per profile; closing a run preserves the profile
directory and its site sessions.

Secure-CDP entitlement flows (`challenge -> cdp-sign -> session`), extension-only daemon operations, daemon persistence, agent lifecycle signaling, notification persistence, and ffmpeg-backed video are intentionally excluded or represented by unsupported or no-op standalone defaults. No Bun runtime or native `.node` module is required.

## LLM-facing surfaces

`page.snapshot()` returns `{tree, refs}`; the refs map duplicates tree content
and is ~54% of bytes on real pages (measured: 9,079 B of 16,742 B on
github.com). Refs resolve in-page, so pass output through `compactSnapshot()`
before sending it to a model — it returns the raw tree. Snapshot options:
`maxDepth` (50), `maxChars`, `interactive`, `showHidden`, `selector`, `ref`.
Agent-facing tool reference: TOOLS.md; machine schemas: `toolSchemas` export.
Audit with before/after numbers: FINDINGS.md.

## Higher-level APIs

- `createCua(page)` — coordinate fallback (visual-browse): click/drag/scroll/
  type/keypress at viewport points, base64 screenshots. Preset: presets/visual-browse/.
- `createCaptcha(page, { ocr? })` — captcha click/drag/readText with pluggable
  OCR (macOS Vision built in).
- `createChromeApi(connection, { profilePath?, downloadDir? })` — Chrome
  MV3-shaped tabs/windows/bookmarks/history/downloads/topSites over CDP and
  profile files. Preset: presets/chrome/.
- JavaScript dialogs (`alert`/`confirm`/`prompt`/`beforeunload`) are
  auto-accepted at the transport layer and surfaced via `page.on('dialog')`.

## Browser event bridge and agent tabs

- `createEvents(connection, { downloadBehavior?, downloadPath? })` — push events
  over CDP so agents stop polling: `tabOpened`/`tabClosed` (with reason +
  lastKnown), `popupOpened` (openerId-classified), `downloadStarted`/
  `downloadProgress`/`downloadFinished`. Works over both `connect` (WS) and
  `connectPipe`; pending waiters reject on disconnect; download terminals are
  exactly-once; reconnects reconcile target state. Preset: presets/agent-events/.
- `createAgentTabs(connection)` — owns agent-tab lifecycle: every tab created
  with `Target.createTarget({ background: true })` so automation never steals
  focus (headless activates before attach to defeat deferred renderer startup),
  serialized viewport repins, unforgeable creation capability (raw
  `Target.createTarget` is rejected in both CDP clients).

## cloak-bridge extension and nativeMessaging transport

For what CDP cannot see — notifications, tabGroups, bookmark/history writes,
chrome.debugger attach on a user-driven browser (Chrome 136+ blocks the
default-profile debugging port) — the cloak-bridge pairs a dumb MV3
service-worker extension (`bridge/extension/`: 8 events, 8 commands, validated
handshake, epoch-tagged reconnect, `protocolError` channel) with a Node
nativeMessaging stdio host (`src/bridge-transport.js`): strict zod envelopes
both directions, min-negotiated frame cap, bounded write/command queues,
one-mutation-in-flight with fail-closed indeterminates, filesystem-pinned
native-host registration. Zero listening ports, same as the pipe transport.
`createChromeApi` is bridge-aware and falls back to the standalone read-only
implementation (with `UnsupportedOperationError` for writes) when no bridge is
connected. Preset: presets/cloak-bridge/.

## Status and warning

Private package provided AS-IS, with no warranty and no support. Not published; redistribution terms are not yet established.

## Pipe transport (zero TCP attack surface)

`connectPipe({ browserPath, browserArgs, storageRoot })` launches Chromium with
`--remote-debugging-pipe` and speaks CDP over inherited file descriptors
(stdio 3/4, NUL-delimited JSON). No `/json/*` HTTP endpoint and **no listening
TCP port** exists for the driven browser — OmOWright's answer to local
CDP hijacking. Target discovery uses `Target.getTargets`; tabs are created
with `connection.newTab(url)`. Verified: `lsof -a -iTCP -sTCP:LISTEN -p <pid>`
returns nothing while the browser is being driven.
