# Bookmarks API

`chrome.bookmarks.*` reads the profile's `Bookmarks` JSON. Requires `profilePath`.

## Methods (read-only)

### `chrome.bookmarks.get(idOrIdList)`
### `chrome.bookmarks.getChildren(id)`
### `chrome.bookmarks.getRecent(numberOfItems)`
### `chrome.bookmarks.getSubTree(id)`
### `chrome.bookmarks.getTree()`
### `chrome.bookmarks.search(query)` — `query: string | { query?, url?, title? }`

Nodes: `{ id, title, type: "url" | "folder", url?, dateAdded?, children? }`.

## Unsupported (extension bridge required)

`create`, `update`, `move`, `remove`, `removeTree` — throw `UnsupportedOperationError`.
