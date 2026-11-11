# Ego Lite engine: an agent task space in the user's Ego browser

Ego Lite is second in `connectBrowser()`'s order. Its CDP bindings
(`globalThis.ego`) exist only inside a script run by `ego-browser nodejs`, so
load omowright there by absolute path:

```bash
ego-browser nodejs -e "const { connectBrowser } = await import('file:///<abs>/omowright/src/index.ts'); const { handle: browser } = await connectBrowser({ allow: ['ego'] }); const page = await browser.newTab('https://example.com'); console.log(await page.title()); await browser.close();"
```

The script runs as ESM with top-level await, outside your shell's working
directory and environment: use absolute paths and write inputs into the script.

`connectEgo({ taskName, profileId, taskSpace })` (or `connectBrowser({ ego: {...} })`)
creates an agent task space and selects it, because Ego sends raw CDP only for
the selected, agent-owned space. `taskSpace: <numeric id>` reuses one the agent
already claimed. The handle is a `BrowserConnection`: the full Page API,
`compactSnapshot` and CUA apply. `handle.taskSpace` names the space.

One client at a time owns Ego's callbacks in a runtime: a second connect
rejects with `ego_busy` and changes nothing, so close the first.
`close()` releases the callbacks and leaves the user's browser running.
Sends Ego refuses (the user took the space over, no space selected) reject at
once with Ego's `error_code`, such as `EGO_TASK_SPACE_USER_IN_CONTROL`.
