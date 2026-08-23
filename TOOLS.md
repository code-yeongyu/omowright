# TOOLS — agent-facing reference

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

## Rules

- Ref ids are virtual: pass them straight to `page.locator('e1')`, never into
  CSS selectors. Every new snapshot invalidates earlier ref ids.
- `page.context()` and raw CDP `_sendToTarget` exist but are escape hatches;
  prefer the tools above.
