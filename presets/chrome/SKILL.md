---
name: chrome
description: Read this when you need Chrome MV3-shaped APIs — bookmarks, tabs, windows, history, downloads, or top sites — in standalone OmOWright.
---

# Chrome MV3 APIs (standalone)

`createChromeApi(connection, options?)` returns MV3-shaped namespaces backed by
CDP and the browser's own profile files — no extension required.

```js
import { createChromeApi } from "omowright";

const chrome = createChromeApi(connection, {
  profilePath: "/path/to/user-data-dir",  // enables bookmarks/history/topSites/downloads.search
  downloadDir: "/path/to/downloads",      // optional, defaults to a temp dir
});

const tabs = await chrome.tabs.query({ url: "*://example.com/*" });
const hits = await chrome.history.search({ text: "example", maxResults: 20 });
const saved = await chrome.downloads.download({ url: "https://files.example.com/x.zip" });
```

## What works standalone

| Namespace | Methods | Backend |
|---|---|---|
| `chrome.tabs` | `query`, `get` | CDP `Target.getTargets` |
| `chrome.windows` | `get`, `getCurrent`, `getLastFocused`, `getAll` | CDP `Browser.getWindowForTarget` |
| `chrome.bookmarks` | `get`, `getChildren`, `getRecent`, `getSubTree`, `getTree`, `search` | profile `Bookmarks` JSON |
| `chrome.history` | `search`, `getVisits` | profile `History` SQLite |
| `chrome.downloads` | `search`, `download` | profile `History` SQLite + CDP `Browser.setDownloadBehavior` |
| `chrome.topSites` | `get` | profile `Top Sites` SQLite |

## Standalone differences from the MV3 original

- Tab ids are CDP target id strings, not MV3 numeric ids. `active`, `pinned`,
  `audible`, `discarded`, `groupId`, `index` are not observable over CDP and
  return fixed defaults; `tabs.query` honors only `url` (MV3 match patterns),
  `title` (substring), and `windowId` filters.
- Profile-backed methods need `profilePath` (the browser's user-data-dir).
  Without it they throw `UnsupportedOperationError`. Note: a browser launched
  with `connectPipe` uses a fresh profile, so bookmarks/history are empty —
  these APIs matter when attaching to a real user browser or reading a real
  profile directory.
- Profile reads are read-only and safe against a running browser (WAL reads).
- Write methods that would mutate the user's browser state throw
  `UnsupportedOperationError` (they require the Aside extension bridge):
  `bookmarks.create/update/move/remove/removeTree`,
  `history.addUrl/deleteUrl/deleteRange`,
  `downloads.pause/resume/cancel/erase`, and all of `chrome.tabGroups`.
- `downloads.download({ url, filename? })` opens a tab, navigates, and waits
  for completion (30s timeout); the returned `filename` is the absolute saved
  path. Each call re-asserts the download behavior because tab initialization
  resets it.

## References

- Tabs: read `./tabs.md`
- Windows: read `./windows.md`
- Bookmarks: read `./bookmarks.md`
- History: read `./history.md`
- Downloads: read `./downloads.md`
- Top sites: read `./top-sites.md`
