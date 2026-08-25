# OmOWright

`OmOWright` is a standalone browser automation package built from the recovered
Aside daemon core. It keeps the CDP session, frame, locator, input, event, and
accessibility snapshot behavior while replacing daemon-owned infrastructure
with small standalone adapters.

## Provenance

The recovered implementation came from the Aside daemon version `1.26.822.2145`, distributed as a Node SEA application with an esbuild-style JavaScript bundle. `src/page-bundle.js` is the recovered in-page snapshot and locator-support program and is preserved byte-for-byte from the extracted artifact.

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

## Persistent CloakBrowser profiles

For long-lived authenticated workflows, use a stable CloakBrowser
`--user-data-dir` on the machine that owns the browser session. Do not copy
Google or 1Password cookies from another profile; use the same persistent
profile for the initial login and subsequent runs, and stop with
`login_required` when it is logged out.

The complete setup, profile lifecycle, cookie boundary, and scheduler
machine-boundary pattern are documented in
[`docs/cloakbrowser-persistent-profile.md`](docs/cloakbrowser-persistent-profile.md).

The Aside secure-CDP entitlement flow (`challenge -> cdp-sign -> session`) is intentionally excluded. Aside extension-only operations, daemon persistence, agent lifecycle signaling, notification persistence, and ffmpeg-backed video are represented by unsupported or no-op standalone defaults. No Bun runtime or native `.node` module is required.

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

## Status and warning

AS-IS research extraction; not yet cleared for redistribution. The Aside team authorized the tear-down, but redistribution licensing remains TBD. This package has no warranty and should not be treated as a supported Aside product.

## Pipe transport (zero TCP attack surface)

`connectPipe({ browserPath, browserArgs, storageRoot })` launches Chromium with
`--remote-debugging-pipe` and speaks CDP over inherited file descriptors
(stdio 3/4, NUL-delimited JSON). No `/json/*` HTTP endpoint and **no listening
TCP port** exists for the driven browser — OmOWright's answer to local
CDP hijacking. Target discovery uses `Target.getTargets`; tabs are created
with `connection.newTab(url)`. Verified: `lsof -a -iTCP -sTCP:LISTEN -p <pid>`
returns nothing while the browser is being driven.
