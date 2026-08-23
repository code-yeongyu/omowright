# FINDINGS — LLM-facing surface audit (prompt-engineering pass)

Audited per the prompt-engineering skill: diagnose (A wrong info / B misframing /
C missing context), smallest high-signal edit, shrink when possible. All numbers
measured on mengmotaHost, 2026-08-23, via pipe transport + headless Chromium.

## Measured baseline

| Page | Total | Tree | Refs | Escapes | Est. tokens | Lines | Refs |
|---|---:|---:|---:|---:|---:|---:|---:|
| example.com | 302 B | 192 B | 82 B | 9 B | ~76 | 4 | 1 |
| github.com | 16,742 B | 7,206 B | **9,079 B (54%)** | 438 B | ~4,186 | 197 | 103 |

## Findings

### F1 — refs map duplicates the tree (A: redundant information → delete)
Every ref entry is `{role, name, tagName, nthAmongSameSignature}`. Role and name
already appear verbatim in the tree line (`- link "Learn more" [ref=e1]`).
Ref resolution is **in-page** (`globalThis.__aside.deref(refId)` via
`Runtime.callFunctionOn`) — the client never reads the refs map; it exists only
for the model. On github.com the refs map is 54% of the payload.
**Fix:** `compactSnapshot()` — returns the tree only. Measured saving: 54%.

### F2 — JSON envelope escaping (A: format overhead)
The tree rides inside a JSON string, so every newline/quote is escaped
(438 B = 2.6% on github.com). For LLM consumption the raw tree text is directly
readable. **Fix:** compact mode returns the raw tree string, no envelope.
Additional saving: ~2.6%.

### F3 — No shipped tool schema for agent harnesses (C: missing context)
The daemon ships a ~1.5 KB "## Available functions" block (recovered from the
bundle). It repeats `mutates page and tabs` per tool, inlines long option lists,
and mixes rules with schema. A harness adopting OmOWright today must write its
own. **Fix:** ship `toolSchemas` + a tightened TOOLS.md (one line per tool,
positive framing, no duplication). Target ≤ 50% of the daemon block.

### F4 — Snapshot options exist but are undocumented (A: wrong-by-omission)
The in-page engine already supports `maxDepth` (default 50), `maxChars`,
`interactive`, `showHidden`, `selector`, `ref` scoping — none appear in README.
Users pay full-page tokens because they cannot discover the knobs.
**Fix:** document the options table with the measured effect of each.

### F5 — README growth discipline (entropy gate)
New sections (F3/F4) must not grow the file net. Trim duplicated prose
(quick-start repeats API comments; NOTICE repeats LICENSE intent) to compensate.

## Non-findings (checked, no change)

- Tree line format (`- role "name" [ref=eN]`): already near-minimal; removing
  quotes or shortening `[ref=]` saves <2% and costs parse ambiguity. KEEP.
- `{tree, diff}` re-snapshot diffing: already the right token-saving design.
- page-bundle.js byte-fidelity: compaction happens client-side; the carved
  in-page engine stays byte-identical (provenance preserved).

## After-measurements (implemented)

- F1+F2 combined, github.com: 16,742 B → 7,206 B = **57% saved** (9,536 B).
- `npm test`: 7/7 green (unit + live pipe integration, single run).
