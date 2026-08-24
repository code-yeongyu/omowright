# Eval-kernel integration

The `eval` tool's JS kernel keeps top-level state across cells — a browser
launched in one cell is still alive in the next. This makes eval the cheapest
way to drive OmOWright interactively and in parallel.

## Setup cell (run once per session)

```js
const m = await import("/Users/yeongyu/local-workspaces/OmOWright/src/index.js");
const fs = await import("node:fs");
const os = await import("node:os");
const path = await import("node:path");
const shell = fs.globSync(`${env("HOME")}/Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-mac-arm64/chrome-headless-shell`).sort().at(-1);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "omowright-eval-"));
globalThis.omw = await m.connectPipe({
  browserPath: shell,
  browserArgs: ["--headless", "--no-first-run", `--user-data-dir=${profile}`],
  storageRoot: profile,
});
globalThis.omwPage = await omw.newTab("about:blank");
globalThis.omwTools = m;
```

**Only `globalThis.*` survives across cells.** `const`/`let` bindings at cell
top level do NOT — re-import or read from `globalThis` in later cells.

## Later cells

```js
await omwPage.goto("https://example.com");
const tree = omwTools.compactSnapshot(await omwPage.snapshot());
console.log(tree);
await omwPage.locator("e1").click();
```

## Parallel lanes (research fan-out)

```js
const results = await parallel([1, 2, 3].map(i => async () => {
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), `omw-lane${i}-`));
  const br = await omwTools.connectPipe({ browserPath: shell, browserArgs: ["--headless", `--user-data-dir=${prof}`], storageRoot: prof });
  try {
    const p = await br.newTab(urls[i]);
    return omwTools.compactSnapshot(await p.snapshot());
  } finally {
    await br.close();
    fs.rmSync(prof, { recursive: true, force: true });
  }
}));
```

Each lane gets its own browser and profile — no shared state, no port
collisions (pipe transport has no ports at all).

## Cleanup cell

```js
await omw.close();
fs.rmSync(profile, { recursive: true, force: true });
delete globalThis.omw; delete globalThis.omwPage; delete globalThis.omwTools;
```

## Displaying screenshots

The kernel's `display()` builtin renders images inline:

```js
display(await omwPage.screenshot({ type: "png" }));
```
