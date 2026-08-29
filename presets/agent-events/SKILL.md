---
name: agent-events
description: Push browser tab and download lifecycle events plus manager-owned background tabs. Read this when an agent needs lifecycle notifications or a temporary tab without polling.
---

# Agent Events

Use one events capability per browser connection and await `ready` before
trusting baseline discovery or download configuration:

```js
import { createEvents, createAgentTabs } from "omowright";

const events = createEvents(connection, {
  downloadBehavior: "allow",
  downloadPath: "/absolute/path/to/downloads",
});
const tabs = createAgentTabs(connection);
await Promise.all([events.ready, tabs.ready]);
```

## Subscribe before acting

Install the listener or `waitForEvent()` before the action that can produce the
event. Event waits are bounded and support async predicates:

```js
const opened = events.waitForEvent("popupOpened", {
  timeout: 30_000,
  predicate: tab => tab.openerTargetId === mainTargetId,
});
await mainPage.evaluate("window.open('https://example.com')");
const popup = await opened;
```

The six push events are `tabOpened`, `tabClosed`, `popupOpened`,
`downloadStarted`, `downloadProgress`, and `downloadFinished`. Only page
targets produce tab events. A popup produces both `tabOpened` and
`popupOpened`; `about:blank` is a valid URL and a valid popup placeholder.
Download progress is not coalesced, and terminal downloads finish exactly once.

## Own temporary tabs through the manager

Create tabs only through `createAgentTabs(connection)`. The manager always requests background creation and owns cleanup. CloakBrowser headless defers renderer startup for background targets, so the manager activates immediately before attaching only for connections launched with a `--headless` browser argument. Headed connections attach without activation so background targets do not steal focus. Do not call Target.activateTarget yourself.


```js
const tab = await tabs.create("about:blank", {
  viewport: { width: 1440, height: 900 },
});
try {
  await tab.page.goto("https://example.com");
  await tabs.repin(tab);
} finally {
  await tabs.close(tab);
}
```

Do not send `Target.createTarget` directly or bring a page to the front. `tabs.list()` and `tabs.get(targetId)` expose only
tabs created by this manager. Close all owned tabs in cleanup with
`await tabs.closeAll()` or `await tabs.dispose()`.

## Viewports and lifecycle

The manager pins the viewport after attach and again after main-frame
navigation. Child-frame navigation does not require a re-pin. Use `tabs.repin`
when a coordinate-based action needs an explicit fresh pin.

Treat events as push notifications. Do not poll `Target.getTargets` to detect
opens, closes, popups, or downloads. Use `waitForEvent()` with a predicate when
target identity matters, and dispose the capabilities when the connection is
being shut down. `events.dispose()` does not close the browser or agent tabs;
`tabs.dispose()` owns its tabs by default.
