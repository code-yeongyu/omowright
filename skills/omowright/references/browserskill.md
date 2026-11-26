# Attached engine: the user's own browser through BrowserSkill

BrowserSkill is third in `connectBrowser()`'s order, after Aside and Ego Lite.
It drives the browser the user is already signed into (Chrome, Edge, Brave)
through Tencent BrowserSkill (stock `bsk` daemon + Web Store extension, no
fork), so it serves tasks that need the user's sessions, cookies, or open tabs.

## Core loop

```js
const { connectBrowserSkill, bskSnapshot } = await import("omowright");

const session = await connectBrowserSkill({ name: "book a table", focused: false });
await session.navigate("https://example.com/");
const sync = () => session.cooperate("sync").then((r) => r.context_id);
const { tree, refs, css } = await bskSnapshot(session, { interactive: true, context: await sync() });
// tree and refs look exactly like page.snapshot(); css[ref] is a light-DOM
// selector for the same element (null inside shadow roots)
await session.click({ selector: css.e3 }, { context: await sync() }); // or "@e3" after session.observe()
await session.fill(css.e5, "hello", { clearBefore: true, context: await sync() });
await session.press("Enter", { context: await sync() });
await session.waitForNavigation({ waitUntil: "load" });
await session.stop(); // ALWAYS: returns borrowed tabs, closes the Agent Window
```

### Shared control (BrowserSkill 0.4+)

The person at the keyboard can work in the task tab while the agent does, so
the extension refuses a page action unless it carries what the latest
`session.cooperate("sync")` returned. Gated: navigation, every input method,
`drag`, `evaluate` (and so `bskSnapshot`), `tabClose`, `resize`, `emulate`,
`observe` with `probeHover`, and `screenshot({ fullPage: true })`. Reads
(`observe`, `snapshot`, `getHtml`, `read`, `extract`, `screenshot()`,
`console`, `network`, `waitForNavigation`, `waitForElement`) need no context.

Every gated action takes `{ context, observation, expect, dependsOn }`
besides its own options; any other key throws. A session runs under one
control policy, chosen by its first sync and fixed after that:

| Action                                   | `strict` (the default)               | `target` (`cooperate("sync", { controlPolicy: "target" })`) |
| ---------------------------------------- | ------------------------------------ | ----------------------------------------------------------- |
| click, hover, fill, ... on a ref/selector | a fresh `context` per action          | `context`; the same one serves the next DOM action          |
| `evaluate` (and `bskSnapshot`)            | a fresh `context` per action          | `context` plus an unused `observation`, or `expect` facts, or `unverified: true` |
| `press` with no target, `navigate`        | a fresh `context` per action          | `context` plus an unused `observation`                       |
| `dependsOn`                               | narrows the check to observed regions | refused; state facts in `expect` instead                     |

The sync result carries `context_id` and, when the daemon sends one,
`observation_id`; pass them as `{ context, observation }`. An observation is
good for one action. `expect` is a list of literal facts the extension checks
right before the input, for example
`[{ target: "#total", field: "text", equals: "3" }]` (`field` is `text`,
`value`, `checked`, `attribute` or `exists`); a false fact refuses the action
with `reason: "precondition_failed"` and nothing is sent to the page.

```js
const { connectBrowserSkill } = await import("omowright");

const session = await connectBrowserSkill({ name: "check out", focused: false });
await session.navigate("https://example.com/cart");
const sync = await session.cooperate("sync", { controlPolicy: "target" });
const context = sync.context_id;
await session.click("#apply-coupon", { context });
await session.click("#checkout", { context, expect: [{ target: "#total", field: "text", equals: "$3.00" }] });
const next = await session.cooperate("sync");
await session.press("Enter", { context: next.context_id, observation: next.observation_id });
const { items } = await session.read("h1"); // no context needed
await session.stop();
```

A session's first `navigate` can meet the extension while the new task tab is
still committing its blank document. That refusal ("The initial task tab
changed", nothing sent to the page) is handled inside `navigate`: it waits on
`waitForNavigation` for the tab to settle, checks in `tabList` that the tab is
still blank, and sends the navigate once more. If the tab never settles or has
moved on, `navigate` throws the refusal with the tab's state in the message.

On `cooperation_sync_required`, call `session.cooperate("wait", { timeoutMs })`
(at most 25 s) until it reports `ready`, sync again and replan from the live
page; never replay the refused action blindly. `user_aborted` means the
person stopped the task.

`connectBrowserSkill` talks to the daemon over its Unix-socket IPC directly —
no `bsk` process per call. It starts the daemon if needed (`bsk status`),
unless `BSK_AUTO_START=0`. On Windows, a host that forbids Job Object
breakaway makes `bsk status` refuse to detach; the library then registers a
per-user `bsk-daemon-<hash>` scheduled task that runs `bsk daemon start
--foreground` under `conhost.exe --headless`, so no console window opens.
It never falls back to a headless browser: when no
extension is connected it throws `no_browser_connected` and `bskDoctor()`
tells you the one step that is missing. It also refuses extension 0.4.0 with
`extension_outdated`: that release puts each task's tabs into a "BrowserSkill"
tab group the browser saves and syncs, so the group outlives the task. With no
`browser` named, an up-to-date connected browser is picked instead; otherwise
the user updates the extension to 0.4.1 or later and deletes any saved
"BrowserSkill" groups by hand. `bskDoctor()` reports such browsers in
`outdatedExtensions` and is not `ready` while they are the only ones connected.

## What the session can do

Every method maps 1:1 onto a daemon `tool.*` method; parameters are the
daemon's own names in camelCase (`waitUntil`, `clearBefore`, `maxTokens`).
Targets are a ref (`"e3"` / `"@e3"` from `session.observe()` or
`session.snapshot()`), a CSS selector, or `{ captureId, x, y }` from a
screenshot.

On an extension older than 0.4.0 there is no shared control: `cooperate("sync")`
resolves without a `context_id` and actions run ungated, so the loop above runs
unchanged there.

A `BskSession` is not a page: it has no `goto`, `locator` or `listTargets`.
Read with `observe({ maxTokens })` first: it is the cheapest read, needs no
sync context, and its `@eN` refs work inside shadow roots and frames. To wait,
use `navigate(url, { waitUntil: "networkidle" })` for a page that renders after
load and `waitForNavigation()` after an action that navigates; for a later
state, `evaluate` a promise that resolves when the state holds
(`{ awaitPromise: true, timeoutMs, context }`; `evaluate` is a gated action).
Never a fixed delay.

| Need               | Call                                                                                                                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Navigate / history | `navigate(url, {waitUntil, timeoutMs})`, `back()`, `forward()`, `reload({hard})`, `waitForNavigation()`                                                                                    |
| Read the page      | `observe({maxTokens, cursor, probeHover})` (VOM text with `@eN` refs), `snapshot()`, `getHtml({ref, maxBytes})`, `bskSnapshot(session)` (OmOWright tree + css)                             |
| Read values        | `read(target, {fields, maxNodes})` (text, value, attributes of matching nodes), `extract("table" \| "list" \| "discover", {target, itemSelector, fields})`                                 |
| Wait               | `waitForElement(target, {state: "visible" \| "hidden" \| "attached" \| "detached", timeoutMs})`, `waitForNavigation()`                                                                      |
| Act                | `click(target, {button, clickCount, modifiers})`, `hover`, `fill(target, value)`, `press(key, {target, holdMs})`, `select(target, values)`, `focus`, `blur`, `scrollTo`, `wheel({deltaY})` |
| Drag               | `drag({selector} \| {ref}, {target, delta: {x, y}, mode})`                                                                                                                                 |
| Script             | `evaluate(expression, {awaitPromise, timeoutMs, unverified})` → `{ok, value, error}`; Agent Window tabs only                                                                                 |
| Pixels             | `screenshot({ref})` → `{buffer, width, height, captureId}`; `screenshot({fullPage: true})` streams the capture back in chunks                                                              |
| Tabs               | `tabList({scope: "user"})`, `tabCreate({url})`, `tabSelect(id)`, `tabClose(id)`, `tabBorrow(id)` (the user confirms), `tabReturn(id)`                                                      |
| Humans             | `requestHelp({prompt, targets, completionCriteria, timeoutMs})` for login, CAPTCHA, OTP, payment — the extension shows an overlay and waits                                                |
| Diagnostics        | `console({since})`, `network({since})` (metadata only), `emulate({overrides})`, `resize(w, h)`                                                                                             |

Anything the daemon refuses comes back as a `BskRpcError` with the daemon's
`code` (`not_found`, `invalid_params`, `permission_denied`, `timeout`,
`cdp_failed`, `user_aborted`, `no_browser_connected`, ...). Long calls can be
cancelled: `const h = session.client.callWithHandle(...)`, then
`session.client.cancel(h.rpcId)`. The rest of the daemon's tools (dialogs,
uploads and downloads, recording, `debug`) are reachable as
`session.tool("dialog_accept", { dialog_id })` with the daemon's own parameter
names.

## bskSnapshot leaves no trace

`bskSnapshot` evaluates the same page bundle `page.snapshot()` uses, wrapped so
`globalThis` is a local object: the page never sees `__omowright`, no
attribute is written, and a MutationObserver on the page counts zero records.
Refs are mapped to CSS paths (`#id` when unique, otherwise
`tag:nth-of-type(n)` chains) so a click goes through the daemon's `selector`
target. Elements inside shadow roots get `css: null` — use `session.observe()`
and its `@eN` ref for those.

The daemon itself enables `Runtime.enable` on every tab it drives (console
capture). That is BrowserSkill's stock behaviour and is a known CDP signal to
bot detection; for WAF-heavy targets use the owned engine with CloakBrowser
(`skills/omowright/references/stealth.md`).

## Onboarding: everything except one click

```js
const { bskDoctor, bskOnboard } = await import("omowright");
const report = await bskDoctor(); // {cli, daemon, browsers, primary, identification, browsersConnected, ready, nextStep}
if (!report.ready) {
  const result = await bskOnboard({ browser: knownBrowserOrUndefined, onHumanStep: (s) => console.log(s.step) });
  // result.needsChoice === true: nothing was registered; ask the user which
  //   browser they use (result.identification.candidates), then call again with
  //   { browser: "<id>" }.
  // result.outdatedExtensions non-empty and ready === false: the only connected
  //   extension is 0.4.0; humanStep (also sent to onHumanStep) tells the user to
  //   update it to 0.4.1 or later and delete saved "BrowserSkill" tab groups.
  // result.daemon.running === false: humanStep is null and nothing was
  //   registered; result.nextStep says how to start the daemon. Start it and
  //   call again before telling the user anything.
  // otherwise result.humanStep is the single thing to tell the user, e.g.
  // 'Quit Aside completely and open it again; a dialog offers to enable "BrowserSkill" — click Enable.'
}
```

`daemon.startBlocked: true` means the host refused a detached daemon start
(Windows Job Object breakaway). Only a client that starts the daemon can see
that, so `bskOnboard()` reports it; `bskDoctor()`'s default client has
auto-start off and does not.

### Which browser gets the extension

Exactly one: the browser the user actually uses. A profile directory on disk
proves nothing — Chrome leaves one behind after a single launch — so
`identifyBrowser` ranks the installed Chromium-family browsers (Chrome, Edge,
Brave, Chromium, Arc, Dia, Vivaldi, Opera, Comet, Aside, Naver Whale) by
usage signals from `probeBrowserSignals`:

| Signal          | macOS                                                                                            | Linux                                  | Windows             |
| --------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------- | ------------------- |
| Default browser | LaunchServices `https` handler                                                                   | `xdg-settings get default-web-browser` | `UserChoice` ProgId |
| Running now     | the app bundle in `/Applications` or `~/Applications` (automation builds elsewhere do not count) | process name                           | `tasklist` image    |
| Recent use      | `Local State` / `Default/History` mtime within 7 days                                            | same                                   | same                |

The decision, in order, with the `confidence` each step reports: an explicit
`browser` option or `OMOWRIGHT_BROWSER` (`explicit`); the one browser whose
extension is already connected to the daemon (`connected`); the default
browser when it is also in use (`default-and-in-use`), or when nothing else is
(`default`); the only browser in use (`only-in-use`), the only one running
(`only-running`) or the only one installed (`only-installed`) when no default
can be read. The extension names its browser from the user agent, and forks
such as Brave and Arc report `chrome`, so a `chrome` or `chromium` name counts
as connected only when exactly one browser able to send it is running.
Everything else — the default is Safari or Firefox, the default is idle while
another browser runs, several browsers are in use, or nothing shows use —
returns `needsChoice: true` with
every candidate and its signals, and registers nothing. Ask the user; if the
agent keeps a memory, look there first and record the answer.

`bskDoctor()` reports the same `identification` plus `registeredElsewhere`:
browsers that still carry an entry from an older onboarding. It never removes
them — deleting an external-extension entry uninstalls an extension the user
may have enabled; `unregisterExternalExtension({ browser })` does it on request.

`bskOnboard` runs, in order: the official `install.sh` / `install.ps1` into
`~/.local/bin` (any PATH lines the installer appends to shell rc files are
reverted — the library calls the binary by absolute path); `bsk status` to
start the daemon; then, for the identified browser only, Chrome's
external-extension registration for the Web Store listing:

| Platform                           | Where the entry goes                                                     | What the user does                                |
| ---------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------- |
| macOS                              | `<user data dir>/External Extensions/<id>.json`                          | relaunch the browser, click **Enable** once       |
| Windows                            | `HKCU\Software\<vendor>\<browser>\Extensions\<id>` (`reg add`, no admin) | click **Enable** on the toolbar badge; no restart |
| Linux (Chromium)                   | `<user data dir>/External Extensions/<id>.json`                          | relaunch; installs silently                       |
| Linux (Chrome/Edge/Brave)          | `/opt/google/chrome/extensions/<id>.json` etc. — needs root              | otherwise: open the store link and click Add      |
| Opera, and Vivaldi/Whale off macOS | no external-extension path                                               | open the store link in that browser and click Add |

Then it waits on `system.status{wait_for_browser_ms}` until the extension
connects. Tell the user exactly `result.humanStep`, nothing more. If the user
uninstalled the extension from the browser UI earlier, Chrome blocklists the
id for external installs; `registerExternalExtension` detects that
(`reason: "blocklisted"`) and returns the store link instead.

Do not use enterprise policies (`ExtensionInstallForcelist`) from this
library: they brand the browser "managed by your organization" and the user
cannot remove the extension.

## Remote browsers

The daemon that owns the user's browser must be reachable over its Unix
socket. On another machine, run the library where the daemon is (for example
through a machine mesh), or pair the extension to a daemon in server mode
(`bsk daemon start --mode server`, WSS required off loopback). Windows named
pipes are not discovered automatically; pass `sockPath` explicitly.

When the process cannot reach the daemon by socket path at all, pass your own
transport as `connectBrowserSkill({ client })`. It is any object with
`call(method, params, options)` that sends one daemon request (`system.status`,
`session.start`, `tool.*`, `session.stop`) and resolves with its `result` or
rejects with a `BskRpcError`. The exported type `BskClient` describes it, and
the session uses nothing else.
