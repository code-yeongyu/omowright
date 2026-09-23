# Attached engine: the user's own browser through BrowserSkill

OmOWright has two engines. The **owned** engine (`connectPipe`,
`connectCloakProfile`) launches a browser you control. The **attached** engine
drives the browser the user is already signed into, through Tencent
BrowserSkill (stock `bsk` daemon + Web Store extension, no fork). Pick the
attached engine when the task needs the user's sessions, cookies, or their
open tabs; pick the owned engine for scraping, WAF targets, headless runs, and
anything that should not touch the user's profile.

## Core loop

```js
const { connectBrowserSkill, bskSnapshot } = await import("omowright");

const session = await connectBrowserSkill({ name: "book a table", focused: false });
await session.navigate("https://example.com/");
const { tree, refs, css } = await bskSnapshot(session, { interactive: true });
// tree and refs look exactly like page.snapshot(); css[ref] is a light-DOM
// selector for the same element (null inside shadow roots)
await session.click({ selector: css.e3 });          // or session.click("@e3") after session.observe()
await session.fill(css.e5, "hello", { clearBefore: true });
await session.press("Enter");
await session.waitForNavigation({ waitUntil: "load" });
await session.stop();                                // ALWAYS: returns borrowed tabs, closes the Agent Window
```

`connectBrowserSkill` talks to the daemon over its Unix-socket IPC directly —
no `bsk` process per call. It starts the daemon if needed (`bsk status`),
unless `BSK_AUTO_START=0`. It never falls back to a headless browser: when no
extension is connected it throws `no_browser_connected` and `bskDoctor()`
tells you the one step that is missing.

## What the session can do

Every method maps 1:1 onto a daemon `tool.*` method; parameters are the
daemon's own names in camelCase (`waitUntil`, `clearBefore`, `maxTokens`).
Targets are a ref (`"e3"` / `"@e3"` from `session.observe()` or
`session.snapshot()`), a CSS selector, or `{ captureId, x, y }` from a
screenshot.

| Need | Call |
| --- | --- |
| Navigate / history | `navigate(url, {waitUntil, timeoutMs})`, `back()`, `forward()`, `reload({hard})`, `waitForNavigation()` |
| Read the page | `observe({maxTokens, cursor, probeHover})` (VOM text with `@eN` refs), `snapshot()`, `getHtml({ref, maxBytes})`, `bskSnapshot(session)` (OmOWright tree + css) |
| Act | `click(target, {button, clickCount, modifiers})`, `hover`, `fill(target, value)`, `press(key, {target, holdMs})`, `select(target, values)`, `focus`, `blur`, `scrollTo`, `wheel({deltaY})` |
| Script | `evaluate(expression, {awaitPromise, timeoutMs})` → `{ok, value, error}`; Agent Window tabs only |
| Pixels | `screenshot({ref})` → `{buffer, width, height, captureId}`; `screenshot({fullPage: true})` streams the capture back in chunks |
| Tabs | `tabList({scope: "user"})`, `tabCreate({url})`, `tabSelect(id)`, `tabClose(id)`, `tabBorrow(id)` (the user confirms), `tabReturn(id)` |
| Humans | `requestHelp({prompt, targets, completionCriteria, timeoutMs})` for login, CAPTCHA, OTP, payment — the extension shows an overlay and waits |
| Diagnostics | `console({since})`, `network({since})` (metadata only), `emulate({overrides})`, `resize(w, h)` |

Anything the daemon refuses comes back as a `BskRpcError` with the daemon's
`code` (`not_found`, `invalid_params`, `permission_denied`, `timeout`,
`cdp_failed`, `user_aborted`, `no_browser_connected`, ...). Long calls can be
cancelled: `const h = session.client.callWithHandle(...)`, then
`session.client.cancel(h.rpcId)`.

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
const report = await bskDoctor();            // {cli, daemon, browsers, browsersConnected, ready, nextStep}
if (!report.ready) {
  const result = await bskOnboard({ onHumanStep: (s) => console.log(s.step) });
  // result.humanStep is the single thing to tell the user, e.g.
  // 'Quit Chrome completely and open it again; a dialog offers to enable "BrowserSkill" — click Enable.'
}
```

`bskOnboard` runs, in order: the official `install.sh` / `install.ps1` into
`~/.local/bin` (any PATH lines the installer appends to shell rc files are
reverted — the library calls the binary by absolute path); `bsk status` to
start the daemon; then, for every Chromium-family browser profile it finds
(Chrome, Edge, Brave, Chromium), Chrome's external-extension registration for
the Web Store listing:

| Platform | Where the entry goes | What the user does |
| --- | --- | --- |
| macOS | `<user data dir>/External Extensions/<id>.json` | relaunch the browser, click **Enable** once |
| Windows | `HKCU\Software\<vendor>\<browser>\Extensions\<id>` (`reg add`, no admin) | click **Enable** on the toolbar badge; no restart |
| Linux (Chromium) | `<user data dir>/External Extensions/<id>.json` | relaunch; installs silently |
| Linux (Chrome/Edge/Brave) | `/opt/google/chrome/extensions/<id>.json` etc. — needs root | otherwise: open the store link and click Add |

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
