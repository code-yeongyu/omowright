# Strict TypeScript port: evidence

Every number below came from a command run against this branch. Each row names the
file in this directory (or the command) that produced it.

| # | criterion | evidence | result |
|---|---|---|---|
| 1 | baseline on the untouched tree | `baseline-suite.txt`, `baseline-tsc-by-directory.md` | 510 pass / 24 skip / 0 fail / 534 tests / 58 files; 5,312 tsc errors recorded per directory right after the rename (src 2,300 / test 2,108 / bridge 80 / ego 70 / bin 15) |
| 2 | every directory ported | batch runs under `.omo/plans/omowright-strict-ts-port.md` | every tracked `.js`/`.mjs` source is `.ts` |
| 3 | behaviour comparison | `behaviour-comparison.md` | modules=83 ported=83 lost=0 |
| 4 | strict typecheck | `bun x tsc --noEmit -p tsconfig.json` | 0 errors |
| 5 | `.js` removal and packaging | `deletion-gate.txt`, `bun run build` | 95 of 95 sources have a `.ts` counterpart, missing=0, stray=0; build emits dist/index.js, dist/page-bundle.js and bridge/extension/background.js |
| 6 | no test lost | `post-suite.txt` against `baseline-suite.txt` | **518 pass / 25 skip / 0 fail / 543 tests / 58 files** against the baseline's 510 / 24 / 0 / 534 / 58. The count GREW because origin/main's PR #257 added nine tests while this branch was open; every one of them passes. |

## The two artifacts that stay JavaScript

- `src/page-bundle.js` - read as text and injected into pages; it must be JavaScript at rest.
- `bridge/extension/background.js` - compiled from `bridge/extension/background.ts` by
  `bridge/build-extension.ts`, which is run by `bun run build`.

## Lint gate

`bun x oxlint --deny-warnings src bin bridge test scripts` -> 0. Casts are machine-banned
through `typescript/consistent-type-assertions` with `assertionStyle: "never"`.
