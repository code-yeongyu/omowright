# Downloads API

## `chrome.downloads.search(query)`

Reads the profile's `History` SQLite downloads tables. Requires `profilePath`.

- `query: { url?: string; filename?: string; limit?: number }`
- Returns `[{ id, url, filename, startTime, bytesReceived, totalBytes, state }]`; state is `complete | canceled | interrupted | in_progress`.

## `chrome.downloads.download(options)`

Downloads a URL through the real browser (CDP `Browser.setDownloadBehavior`).

- `options: { url: string; filename?: string }`
- Resolves `{ id, url, filename, state: "complete" }` where `filename` is the absolute saved path.
- 30s timeout; rejects when the URL does not start a download.

## Unsupported (extension bridge required)

`pause`, `resume`, `cancel`, `erase` — throw `UnsupportedOperationError`.
