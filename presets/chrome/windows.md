# Windows API

`chrome.windows.*` inspects browser windows over CDP (`Browser.getWindowForTarget`).

## Methods

### `chrome.windows.get(windowId, queryOptions?)`
### `chrome.windows.getCurrent(queryOptions?)`
### `chrome.windows.getLastFocused(queryOptions?)`
### `chrome.windows.getAll(queryOptions?)`

- `queryOptions?: { populate?: boolean }` — `populate: true` adds a `tabs` array.
- Returns `{ id, focused, type, state, alwaysOnTop, incognito, tabs? }`.
- Standalone note: headless sessions have exactly one window; `getCurrent`/`getLastFocused` return the first.
