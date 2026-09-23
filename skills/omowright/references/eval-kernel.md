# Eval-kernel integration

The `eval` tool's JS kernel keeps top-level `globalThis` state across cells,
which makes it the cheapest way to drive OmOWright interactively and in
parallel. It does not keep child processes alive for you.

**ONLY `globalThis.*` SURVIVES ACROSS CELLS.** Top-level `const`/`let` bindings do
not; re-import or read from `globalThis` in later cells.

**A BROWSER SPAWNED IN A CELL CAN DIE WHEN THAT CELL SETTLES.** Measured, not
assumed: `Bun.spawn` children were killed with SIGKILL at cell completion, and
`connectPipe` (which uses `child_process.spawn` without detaching) lost a
browser between two cells. A `globalThis.omw` handle whose process is gone
rejects every call. Two patterns hold up:

1. **One cell, whole job.** Connect, act, close in the same cell. Right for any
   job that fits in one cell's runtime; the parallel lanes below are this shape.
2. **A browser that must span cells.** Launch it outside the kernel's process
   tree through the eval tool's background monitor, on a loopback debugging
   port, and attach with `connect()` (`shell`, `profile`, `omwTools` come from
   the setup cell below):

```js
await tool.monitor({ description: "omowright browser", command: `${shell} --headless --no-first-run --remote-debugging-port=9333 --user-data-dir=${profile} about:blank` });
globalThis.omw = await omwTools.connect("http://127.0.0.1:9333");   // the port is loopback-only; close the monitor with kill_bash when done
```

   If you'd rather keep `connectPipe`, treat the browser as disposable: start
   every cell with a probe and relaunch on failure.

```js
try { await globalThis.omw.listTargets(); }
catch {
  globalThis.omw = await omwTools.connectPipe({ browserPath: shell, browserArgs: ["--headless", "--no-first-run", `--user-data-dir=${profile}`], storageRoot: profile });
  globalThis.omwPage = await omw.newTab("about:blank");
}
```

## Setup cell (once per session)

The pipe-launched form. It works for short sessions, but per the rule above the
process may not outlive this cell; probe it at the top of every later cell (or
switch to the monitor + `connect()` form).

```js
const m = await import("omowright");
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
await omw.listTargets();                 // throws if the kernel reaped the browser: rerun setup
await omwPage.goto("https://example.com");
console.log(omwTools.compactSnapshot(await omwPage.snapshot()));
await omwPage.locator("e1").click();
display(await omwPage.screenshot({ type: "png" }));   // display() renders images inline
```

## Parallel lanes (research fan-out)

Each lane gets its own browser and profile: no shared state, and the pipe
transport has no ports to collide on. Every lane connects, acts, and closes
inside the cell, so the reaping rule never bites.

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
await omw.close().catch(() => {});       // no-op if the process is already gone
fs.rmSync(profile, { recursive: true, force: true });
delete globalThis.omw; delete globalThis.omwPage; delete globalThis.omwTools;
```

For the monitor-launched form, stop the monitor after `close()` so the profile
directory isn't in use when you delete it.
