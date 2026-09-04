# Top Sites API

`chrome.topSites.get()` reads the profile's `Top Sites` SQLite. Requires `profilePath`.

Returns `[{ url, title }]` ordered by rank (max 50).
