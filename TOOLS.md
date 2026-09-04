# OmOWright tools — agent-facing reference

Drive a browser with Playwright-shaped JS. Two transports: `connectPipe`
(launch a browser, zero TCP port) and `connect(cdpHttpUrl)` (attach to a
running Chromium DevTools endpoint).

## Core loop

1. Open or attach a tab: `connection.newTab(url)` / `connection.attachPage(targetId)`.
2. Read the page with `page.snapshot()` — never `page.content()` for reading.
3. Act through `page.locator(refOrCss)` using `[ref=eN]` ids from the snapshot.

## Tools

- `newTab(url)` — open a tab, waits for interactivity, returns page.
- `listTargets()` — list open tabs (id, type, url, title).
- `attachPage(targetId)` — attach an existing tab.
- `page.goto(url)` — navigate; resolves when interactive.
- `page.snapshot(options?)` — PRIMARY read. Returns `{tree, refs}`; tree lines
  look like `- link "Learn more" [ref=e1]`. Options: `maxDepth` (50),
  `maxChars`, `interactive`, `showHidden`, `selector`, `ref`.
- `compactSnapshot(snapshot)` — returns the raw tree without the refs map
  (refs resolve in-page; the map is ~54% of bytes on real pages). Use before
  sending snapshots to a model.
- `page.locator(refOrCss)` — `click`, `fill`, `press`, `pressSequentially`,
  `hover`, `check`, `selectOption`, `dragTo`, `setInputFiles`, `textContent`,
  `innerText`, `isVisible`, `waitFor`, `first/nth/last`, `filter`.
- `page.evaluate(expression)` — run JS in the page.
- `page.screenshot(options?)` — image bytes (path, fullPage, clip, type, quality).
- `page.pdf(options?)` — PDF bytes (path, format, margin, printBackground).
- `page.keyboard` / `page.mouse` — press, type, insertText / move, click, wheel.
- `createCua(page)` — coordinate fallback (visual-browse equivalent): `click`,
  `doubleClick`, `drag({path})`, `move`, `scroll`, `type`, `keypress`,
  `getVisibleScreenshot()` (base64 PNG). Use only when refs/locators cannot
  target the UI (canvas, custom controls, stale refs).
- `createCaptcha(page, { ocr? })` — captcha helpers: `click(bounds)`,
  `drag(from, to, {steps})`, `readText(bounds?)`. `click`/`drag` return a
  compact snapshot tree after a settle wait (default 3s, `settleMs` to tune).
  `readText` OCRs a screenshot region — defaults to macOS Vision
  (`macOSVisionOcr`); pass `ocr: async (pngBuffer) => string` on other
  platforms or to use a vision model.
- `createChromeApi(connection, { profilePath?, downloadDir? })` — Chrome
  MV3-shaped APIs: `tabs.query/get`, `windows.get/getCurrent/getLastFocused/
  getAll`, `bookmarks.*` (read-only), `history.search/getVisits`,
  `downloads.search/download`, `topSites.get`. Profile-backed methods need
  `profilePath`. Write methods throw `UnsupportedOperationError` (extension
  bridge required). Full reference: presets/chrome/.
- `injectCookies(page, cookies)` — inject raw cookie exports (e.g. from a
  real browser profile) with CDP sanitization handled: negative `expires`
  dropped, `__Host-` cookies forced secure + root path + url-scoped,
  `SameSite=None` dropped when not secure, name+domain deduped.
  `sanitizeCookies(cookies)` is the pure transform if you need it.

## Rules

- Ref ids are virtual: pass them straight to `page.locator('e1')`, never into
  CSS selectors. Every new snapshot invalidates earlier ref ids.
- `page.context()` and raw CDP `_sendToTarget` exist but are escape hatches;
  prefer the tools above.

## Dialogs (alert / confirm / prompt / beforeunload)

Every JavaScript dialog is **auto-accepted at the transport layer** — the page
never hangs waiting for a human. Consequences:

- `alert()` returns immediately; `confirm()` returns `true`; `prompt()` returns
  `""` (empty string). There is no dismiss/cancel path and no way to supply
  prompt text.
- `beforeunload` handlers never block navigation.
- Dialogs during page load are accepted the same way; `page.goto()` completes
  normally because readiness is content-probe based, not `readyState` based.
- Subscribe to `page.on('dialog', d => ...)` for observability: the event
  carries `{type, message, defaultPrompt, url}` and fires after the accept.

## Readiness probe

`page.goto()` waits for meaningful content, not just `document.readyState`:
the page is ready when `body` exists AND (interactive elements > 0 OR
landmarks > 0 OR visible text >= 20 chars). A near-empty page (e.g.
`<h1>ok</h1>`) never satisfies the probe and `goto` times out after 30s — use
`page.goto(url, { waitUntil: "commit" })` for content-free fixtures.
