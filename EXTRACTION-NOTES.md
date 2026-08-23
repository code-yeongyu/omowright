# Extraction notes

The recovered automation implementation is retained in `src/core.js` as an esbuild-factory slice rather than being de-minified or behaviorally rewritten.

Intentional deviations from byte-faithful carving:

1. **Factory/runtime prelude added.** The original SEA bundle's `__esmMin`, export helpers, bundled `Emittery` and Zod bindings, and many daemon-wide module initializers were outside the requested byte closure. `src/core.js` supplies the smallest ESM-compatible runtime declarations and uses the package dependencies `ws` and `zod`.
2. **Node WebSocket transport supplied.** The recovered client constructs `new WebSocket(url, { headers })`; the package binds this to the `ws` dependency for Node ESM compatibility.
3. **Secure CDP authentication removed.** `AsideSecureCdpAuthorizer` and the challenge/sign/session flow are intentionally excluded. An explicit `cdpUrl` uses no authorizer; callers may provide a generic `authorizer` through `options.client`.
4. **Injected page source substituted with the cooked artifact.** The embedded `BUNDLE$1` template in the daemon is replaced by `src/page-bundle.js` loaded as a string. This is not a content change: its SHA-256 is `e3b2dcb5ad8a9af1d0b57ddfd678716276f30cd55d1377df8e0e80b66049ae20`, identical to the supplied page bundle.
5. **Daemon service edges stubbed.** REPL async-local context, extension bridge commands, notification persistence, session/event stores, lifecycle messaging, and daemon path helpers use no-op, pass-through, or explicit `UnsupportedOperationError` defaults. This removes account/session/extension/native dependencies while retaining standard CDP page behavior.
6. **Browser facade replaced.** The daemon-bound `AsideBrowser` is not exposed. `BrowserConnection` owns a `CdpClient`, `SessionManager`, `FrameManager`, and attached pages; `TabRepository.listTargets()` delegates to standard `GET /json/list`; `attachPage()` uses flattened `Target.attachToTarget`.
7. **Video remains unsupported.** The recovered ffmpeg-backed video implementation is not made a package dependency; its standalone default reports unsupported capability.
8. **Node filesystem paths are caller-owned.** Screenshot/PDF path operations resolve under the connection's optional `storageRoot` instead of daemon session roots.

No live browser connection was attempted.
