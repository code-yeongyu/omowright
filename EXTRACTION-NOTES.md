# Extraction notes

The recovered automation implementation is retained in `src/core.js` as an esbuild-factory slice rather than being de-minified or behaviorally rewritten.

Intentional deviations from byte-faithful carving:

1. **Public identity renamed.** Recovered page and input classes are exposed as
   `OmOPage`, `OmOMouse`, and `OmOKeyboard`; runtime artifacts use the
   `omowright-artifacts` namespace.
2. **Factory/runtime prelude added.** The original SEA bundle's `__esmMin`, export helpers, bundled `Emittery` and Zod bindings, and many daemon-wide module initializers were outside the requested byte closure. `src/core.js` supplies the smallest ESM-compatible runtime declarations and uses the package dependencies `ws` and `zod`.
3. **Node WebSocket transport supplied.** The recovered client constructs `new WebSocket(url, { headers })`; the package binds this to the `ws` dependency for Node ESM compatibility.
4. **Secure CDP authentication removed.** `AsideSecureCdpAuthorizer` and the challenge/sign/session flow are intentionally excluded. An explicit `cdpUrl` uses no authorizer; callers may provide a generic `authorizer` through `options.client`.
5. **Injected page source substituted with the cooked artifact.** The embedded `BUNDLE$1` template in the daemon is replaced by `src/page-bundle.js` loaded as a string. This is not a content change: its SHA-256 is `e3b2dcb5ad8a9af1d0b57ddfd678716276f30cd55d1377df8e0e80b66049ae20`, identical to the supplied page bundle.
6. **Daemon service edges stubbed.** REPL async-local context, extension bridge commands, notification persistence, session/event stores, lifecycle messaging, and daemon path helpers use no-op, pass-through, or explicit `UnsupportedOperationError` defaults. This removes account/session/extension/native dependencies while retaining standard CDP page behavior.
7. **Browser facade replaced.** The daemon-bound `AsideBrowser` is not exposed. `BrowserConnection` owns a `CdpClient`, `SessionManager`, `FrameManager`, and attached pages; `TabRepository.listTargets()` delegates to standard `GET /json/list`; `attachPage()` uses flattened `Target.attachToTarget`.
8. **Video remains unsupported.** The recovered ffmpeg-backed video implementation is not made a package dependency; its standalone default reports unsupported capability.
9. **Node filesystem paths are caller-owned.** Screenshot/PDF path operations resolve under the connection's optional `storageRoot` instead of daemon session roots.

The standalone package is covered by a live Chromium pipe-transport test.
