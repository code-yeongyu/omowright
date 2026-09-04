# Tabs API

`chrome.tabs.*` inspects the tab strip over CDP. Ids are CDP target id strings.

## Methods

### `chrome.tabs.query(queryInfo)`

- `queryInfo: { url?: string | string[]; title?: string; windowId?: number }`
- `url` supports MV3 match patterns (`*://*.example.com/*`); `title` is a substring match.
- Returns tabs: `{ id, url, title, windowId, active, pinned, audible, discarded, groupId, index }` — the last six are fixed defaults (not observable over CDP).

### `chrome.tabs.get(tabId)`

- `tabId: string` — throws when no tab has the id.

Tab lifecycle: use `connection.newTab(url)` and `page.close()`. Page interaction: `page.goto()`, `page.locator()`.
