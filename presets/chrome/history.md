# History API

`chrome.history.*` reads the profile's `History` SQLite. Requires `profilePath`.

## Methods (read-only)

### `chrome.history.search(query)`

- `query: { text: string; startTime?: number; endTime?: number; maxResults?: number }` (times are Unix ms)
- Returns `[{ id, url, title, visitCount, lastVisitTime }]`, newest first.

### `chrome.history.getVisits(details)`

- `details: { url: string }` — returns `[{ id, url, visitTime, transition }]`.

## Unsupported (extension bridge required)

`addUrl`, `deleteUrl`, `deleteRange` — throw `UnsupportedOperationError`.
