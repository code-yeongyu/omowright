# Aside engine: the user's Aside browser through one `aside repl` session

Aside is the first engine `connectBrowser()` tries. It drives the user's own
Aside browser, signed in as they are, through the Aside CLI's REPL. omowright
keeps ONE CLI process per session, and `globalThis` state survives between
calls. `aside repl --help` decides which process: CLIs up to 1.26.916 keep a
piped `aside repl` (each call is one stdin line, 4-17 ms); CLIs whose help says
"piped stdin runs as one script" (1.26.1107 on) keep `aside mcp` and run each
call through its `repl` tool. The help probe has its own 5 s budget, apart from
the start timeout; if `aside repl --help` does not answer in time, omowright
uses `aside mcp` when `aside mcp --help` lists a `repl` tool, else the piped
`aside repl`. Only `aside repl`, `aside mcp`'s `repl` tool, the two `--help` probes,
`aside --version` and `aside account status` are run, never a prompt or
`aside exec`, which would hand the task to Aside's own model.

## Core loop

```js
const { connectAside } = await import("omowright");
const aside = await connectAside(); // runs asideOnboard() first
await aside.open("https://example.com/"); // new tab, becomes `page`
const { tree } = await aside.snapshot({ find: "checkout" });
await aside.run('await page.locator("e3").click();');
const title = await aside.run("return await page.title();");
await aside.run("await closeTab(page);"); // close tabs you opened
await aside.close(); // ALWAYS, in finally
```

`run(code)` executes Playwright-style JavaScript in Aside's REPL scope (`page`,
`tabs`, `openTab`, `closeTab`, `snapshot`, `listBrowserTabs`,
`attachBrowserTab`) and resolves with the JSON value the code returns; return
plain data, never a handle. `runWithLogs(code)` also returns console output.
Refs from `snapshot()` are Aside refs: use them only with `page.locator(ref)`
inside `run()`. There is no raw CDP (`page.context()` is undefined), so the
omowright Page API, `compactSnapshot` and CUA do not apply; when the task needs
them, use the next engine.

## Setup and failures

`asideDoctor()` reads the Aside app (macOS), the CLI and its sign-in without
changing anything; `asideOnboard()` also installs a missing CLI with Aside's
official installer. `connectAside()` runs the setup itself and rejects with
`AsideReplError` code `aside_not_ready`, whose message is the one step only the
user can take (install the app, or run the printed `aside login` command and
approve the code in Aside). Relay that step; do not try another engine on the
user's behalf without saying why.

`repl_error` is the page code's own exception and the session stays usable.
`repl_timeout` closes the session: connect again. `repl_start_timeout` and
`repl_unsupported_cli` name the CLI version; relay them with `aside --update`.
