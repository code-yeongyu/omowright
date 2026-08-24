# Quickstart — connections, pages, snapshots

## Two transports

```js
const { connect, connectPipe } = await import("/Users/yeongyu/local-workspaces/OmOWright/src/index.js");
```

- **`connectPipe({ browserPath, browserArgs, storageRoot })`** — launches a
  browser over `--remote-debugging-pipe`. Zero TCP listeners (verified with
  `lsof`), nothing for other processes to hijack. Default choice.
- **`connect("http://127.0.0.1:9222")`** — attaches to a running Chromium with
  `--remote-debugging-port`. Use for a real user browser (its profile,
  cookies, logins). Pair with `createChromeApi` for bookmarks/history.

**`connect()` vs `connectPipe()` API difference.** `connectPipe()` returns an
object with `newTab(url)`. `connect()` returns `BrowserConnection` which does
NOT have `newTab()` — use CDP `Target.createTarget` + `attachPage` instead:

```js
const browser = await connect("http://127.0.0.1:9222");
const { targetId } = await browser.cdp.send("Target.createTarget", { url: "https://example.com" });
const page = await browser.attachPage(targetId);
// ... work ...
await browser.cdp.send("Target.closeTarget", { targetId });
```

Always launch with a dedicated `--user-data-dir` (a `mkdtemp` dir) and delete
it after `browser.close()`.

Runs on both Node (>=20) and Bun — `node:sqlite` is loaded lazily with a
`bun:sqlite` fallback, so `import("./src/index.js")` works under `bun` too.

## Page essentials

```js
const page = await browser.newTab(url);        // waits for interactivity
await page.goto(url);                          // content-probe readiness
await page.goto(url, { waitUntil: "commit" }); // escape hatch for tiny pages
await page.title(); page.url();
await page.evaluate("document.readyState");
await page.screenshot({ path, fullPage?, clip?, type?, quality? });
await page.pdf({ path, format?, margin? });
await page.locator("e1").click();              // ref or CSS
await page.locator("input[name=q]").fill("text");
await page.keyboard.press("Enter"); await page.mouse.wheel(0, 400);
await page.close();
```

## Snapshot discipline

```js
const snap = await page.snapshot();            // { tree, refs } or JSON string
const tree = compactSnapshot(snap);            // raw tree, ~57% smaller
await page.snapshot({ interactive: true });    // interactive elements only
await page.snapshot({ maxDepth: 20, maxChars: 4000, selector: "main" });
```

- Tree lines look like `- link "Learn more" [ref=e1]` — feed `e1` to
  `page.locator("e1")`.
- Every new snapshot invalidates earlier refs. Re-snapshot after each state
  change; never act on a stale ref.
- `interactive: true` first; escalate to full snapshot only when the target
  is missing.

## Dialogs

Auto-accepted at the transport layer — pages never hang on `alert`,
`confirm`, `prompt`, `beforeunload`. `confirm() → true`, `prompt() → ""`.
There is no dismiss path. Observe via:

```js
page.on("dialog", d => console.log(d.type, d.message, d.defaultPrompt));
```

## Readiness probe

`goto` resolves when the page has a body AND (interactive elements OR
landmarks OR ≥20 visible text chars) — not `document.readyState`. A
near-empty fixture (`<h1>ok</h1>`) never satisfies it and times out after
30s; pass `waitUntil: "commit"` for such pages.

## Errors worth knowing

- `RefStaleError` — the element vanished after your snapshot; re-snapshot.
- `UnsupportedOperationError` — Aside extension-bridge feature (password
  managers, `Aside.*` commands, MV3 write methods). Not available standalone.
