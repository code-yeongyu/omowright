---
name: cloak-bridge
description: Use when a user-driven CloakBrowser profile needs MV3 Chrome writes/events through the native messaging bridge.
---

# CloakBrowser bridge

The bridge is an opt-in, zero-TCP extension channel. Load `bridge/extension` as an
MV3 unpacked extension and install the native host with the exact 32-character
extension ID. The host manifest must use an absolute executable path and one
exact `chrome-extension://<id>/` allowed origin. Keep stdout protocol-only;
write diagnostics to stderr.

```js
import { createBridgeClient, createChromeApi } from "omowright";
const bridge = createBridgeClient({ extensionId, stdin, stdout });
const chrome = createChromeApi(connection, { profilePath, bridge });
```

Use the pinned CloakBrowser binary at
`~/.cloakbrowser/chromium-145.0.7632.109.2/Chromium.app/Contents/MacOS/Chromium`.
When launching the bridge, add `--load-extension=/absolute/path/to/bridge/extension`
and, optionally, exactly one `--silent-debugger-extension-api`. This flag only
suppresses the debugger warning; it is not authorization.

## Support matrix

| API | Bridge behavior |
|---|---|
| bookmarks.create/move/remove | Supported only when negotiated |
| history.deleteUrl/deleteRange | Supported only when negotiated |
| tabGroups.update | Supported only when negotiated |
| debugger.attach/detach | Supported only when negotiated, numeric tab IDs only |
| notifications, tabGroups, tabs, windows events | Forwarded without replay |
| bookmarks.update/removeTree | Unsupported |
| history.addUrl | Unsupported |
| downloads.pause/resume/cancel/erase | Unsupported |
| standalone reads and downloads.download | Existing CDP/profile behavior |

Do not retry mutations after disconnect: completion is indeterminate. Subscribe
to events before triggering actions. Native host registration for CloakBrowser
must pass a verified `nativeMessagingHostDir`; the product directory cannot be
safely guessed from `--user-data-dir` or the application filename.
