# Agent notes: omowright

## Tests

- Full suite: `bun run test`. `bun run test:node` runs the same files under real Node (Node >= 24: three child scripts use `await using`), which is the runtime consumers import the packed package from, and CI runs both. It goes through `scripts/node-test.ts`, which resolves `SHELL_BIN` (environment first, then Playwright's cache) and refuses to start without one: nine live tests skip when it is unset, and a gate whose test set depends on an ambient variable cannot compare two heads. A child script spawned by a test must name the `.ts` source it imports: Node resolves the specifier literally, so `../src/index.js` fails with ERR_MODULE_NOT_FOUND.
- Focused: `bun test test/<file>.test.ts`.
- `test` runs the whole suite in one bun process; `test:cloak-profile` runs the two CloakBrowser profile files, which need `CLOAKBROWSER_BIN`.
- Live tests need a Chromium headless shell: set `SHELL_BIN` (and `CLOAKBROWSER_BIN` for the event-bridge test), or install one into Playwright's cache.
- `test/hygiene.test.ts` fails on any tracked file that contains an absolute home path, a personal address or a private host. Write paths as `~/...` or relative, and never paste real hosts or addresses into docs, fixtures or tests.

## Build and publish

- `bun run build` writes `dist/` and swaps it in only when every step passed: the bundle plus its lazy chunks, `page-bundle.js` (read at runtime beside the module), `bin/omowright-cloak.js` and the declarations. `package.json` `exports` and `bin` point at `dist/`, and `prepack` runs the build, so a tarball packed without it ships nothing importable.
- Never import a `bun:*` module statically: a single-file bundle hoists it to the entry and Node cannot resolve it, and consumers (oh-my-openagent's browser skill) build exactly that bundle. The Windows lock backend imports `bun:ffi` on its first lock attempt and opens ntdll once; `test/bundle-runtime-imports.test.ts` counts static `bun:` imports on a built single-file bundle. The published bundle is still split so the Windows backend stays in a lazy chunk.
- Declarations come from `typescript-5` (`node_modules/typescript-5/lib/tsc.js`) via `tsconfig.build.json`. TypeScript 7 stays the type gate; it cannot emit them here (TS4094 on the anonymous class `createOmOPageClass` returns).

## Test authoring gate

Before adding or changing a test, answer all four; a missing answer means do not add it yet:

1. What observable behavior, invariant, or independent contract does it protect?
2. What credible regression makes it fail?
3. Why does existing coverage not already catch that failure? Each contract has one primary test owner at the strongest boundary; extend a table case or shared fixture instead of adding a near-duplicate.
4. Does it need a production seam (export, flag, wrapper, injection hook) no production caller needs? If yes, test at the real boundary instead.
   Junk patterns (reject unless the retention bar below applies): assertion-free probes; self-comparisons and identity copiers; copied fixtures, inventories, manifests or export lists; exact source, import or string greps; private call-shape tests duplicated at a real boundary; duplicate invocations of one contract; replays of a shared helper through a wrapper; tests that exist to keep a test-only export or wrapper alive; production code whose only callers are tests; expected values produced by the code under test; mocks that implement the asserted behavior; fixture-supplied receipts or postconditions the code under test should produce; assertions against a store nothing writes; capability or flag restatements without a delivery proof; negative controls that pass for an unrelated reason; names that promise more than the input exercises.
   Retention bar: keep a pattern match only when it independently guards a public API, protocol, config, migration, storage, security, platform, default, prompt-byte, generated or cross-language, package, release, or architecture contract, and say which one in the test. Static or slow is never a deletion reason. A retained test that fails on the base is a product bug to fix at its owner, never a test to delete.
   A bug regression test must fail on the pre-fix code for the intended reason; an existing owner test that already fails may serve as that proof.
   Method source: openclaw test-audit skill.
