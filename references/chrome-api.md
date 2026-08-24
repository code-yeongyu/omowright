# Chrome MV3 APIs — createChromeApi

```js
const chrome = createChromeApi(connection, {
  profilePath: "/path/to/user-data-dir",  // optional; enables profile-backed APIs
  downloadDir: "/path/to/downloads",      // optional
});
```

## Surface

| Namespace | Methods | Backend |
|---|---|---|
| `chrome.tabs` | `query`, `get` | CDP targets |
| `chrome.windows` | `get`, `getCurrent`, `getLastFocused`, `getAll` | CDP windows |
| `chrome.bookmarks` | `get`, `getChildren`, `getRecent`, `getSubTree`, `getTree`, `search` | profile `Bookmarks` JSON (read-only) |
| `chrome.history` | `search`, `getVisits` | profile `History` SQLite (read-only) |
| `chrome.downloads` | `search`, `download` | SQLite + CDP download behavior |
| `chrome.topSites` | `get` | profile `Top Sites` SQLite |

## Examples

```js
// Find the tab showing a domain and attach to it
const [tab] = await chrome.tabs.query({ url: "*://github.com/*" });
const page = await connection.attachPage(tab.id);

// Search the user's browsing history (real profile attached via connect())
const hits = await chrome.history.search({ text: "omowright", maxResults: 10 });

// Read bookmarks
const tree = await chrome.bookmarks.getTree();

// Download a file through the real browser
const saved = await chrome.downloads.download({ url: "https://files.example.com/x.zip" });
console.log(saved.filename);  // absolute path of the saved file
```

## Standalone limits

- Tab ids are CDP target-id strings, not MV3 numbers. `active`, `pinned`,
  `audible`, `groupId`, `index` are not observable and return fixed defaults.
- Profile-backed APIs need `profilePath` and throw `UnsupportedOperationError`
  without it. A `connectPipe` browser uses a fresh temp profile — these APIs
  matter when attaching to a real user browser via `connect()`.
- Write methods throw `UnsupportedOperationError` (Aside extension bridge
  required): `bookmarks.create/update/move/remove*`,
  `history.addUrl/deleteUrl/deleteRange`, `downloads.pause/resume/cancel/erase`,
  all of `chrome.tabGroups`.
- `downloads.download` uses an in-page anchor click (not `Page.navigate`,
  which hangs on download navigations) and re-asserts the download behavior
  per call because tab initialization resets it.

Full per-method reference: `/Users/yeongyu/local-workspaces/OmOWright/presets/chrome/`.
