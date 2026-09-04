# Eval-kernel integration

The `eval` tool's JS kernel keeps top-level state across cells — a browser
launched in one cell is still alive in the next. This makes eval the cheapest way
to drive OmOWright interactively and in parallel.

**ONLY `globalThis.*` SURVIVES ACROSS CELLS.** Top-level `const`/`let` bindings do
not — re-import or read from `globalThis` in later cells.

## Setup cell (once per session)

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

## Later cells

```js
await omwPage.goto("https://example.com");
console.log(omwTools.compactSnapshot(await omwPage.snapshot()));
await omwPage.locator("e1").click();
display(await omwPage.screenshot({ type: "png" }));   // display() renders images inline
```

## Parallel lanes (research fan-out)

Each lane gets its own browser and profile — no shared state, and the pipe
transport has no ports to collide on.

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

## Cleanup cell

```js
await omw.close();
fs.rmSync(profile, { recursive: true, force: true });
delete globalThis.omw; delete globalThis.omwPage; delete globalThis.omwTools;
```
