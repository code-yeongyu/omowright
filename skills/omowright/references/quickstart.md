# Quickstart — connections, pages, snapshots

## Two transports

```js
const { connect, connectPipe } = await import("/Users/yeongyu/local-workspaces/OmOWright/src/index.js");
```

- `connectPipe({ browserPath, browserArgs, storageRoot })` — launches a browser
  over `--remote-debugging-pipe`. Zero TCP listeners (verified with `lsof`),
  nothing for other processes to hijack. Default choice. Returns an object with
  `newTab(url)`.
- `connect("http://127.0.0.1:9222")` — attaches to a running Chromium started
  with `--remote-debugging-port`. Use for a real user browser (its profile,
  cookies, logins); pair with `createChromeApi` for bookmarks/history. Returns
  `BrowserConnection`, which has **NO `newTab()`** — create tabs over CDP:

```js
const browser = await connect("http://127.0.0.1:9222");
const { targetId } = await browser.cdp.send("Target.createTarget", { url: "https://example.com" });
const page = await browser.attachPage(targetId);
// ... work ...
await browser.cdp.send("Target.closeTarget", { targetId });
```

Always launch with a dedicated `--user-data-dir` (a `mkdtemp` dir) and delete it
after `browser.close()`. Runs on Node >= 20 and Bun — `node:sqlite` loads lazily
with a `bun:sqlite` fallback.

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

Tree lines look like `- link "Learn more" [ref=e1]` — feed `e1` to
`page.locator("e1")`. **EVERY NEW SNAPSHOT INVALIDATES EARLIER REFS**: re-snapshot
after each state change, never act on a stale ref. Start with
`interactive: true`; escalate to a full snapshot only when the target is missing.

## Readiness and dialogs

Both are transport-level contracts documented once, in
`/Users/yeongyu/local-workspaces/OmOWright/TOOLS.md` (sections "Readiness
probe" and "Dialogs"). Short form: `goto` waits for meaningful content, not
`readyState`, and times out after 30s on near-empty pages (`waitUntil: "commit"`
is the escape hatch); every JavaScript dialog is auto-accepted and observable via
`page.on("dialog")`.

## Errors worth knowing

- `RefStaleError` — the element vanished after your snapshot; re-snapshot.
- `UnsupportedOperationError` — extension-bridge feature (password managers,
  `OmO.*` extension commands, MV3 write methods). Not available standalone.
