# Strict typecheck baseline, per directory

Criterion 1 asks for the error count recorded per directory. Two captures exist and
they are NOT the same measurement, so both are here with their provenance.

## Initial baseline (the number criterion 4 is measured against)

Recorded immediately after the 154-file `.js`/`.mjs` -> `.ts` rename, before any
file was typed. Source: the port notepad's entry for that step.

| directory | errors |
|---|---|
| src/ (including src/bsk and src/aside) | 2,300 (bsk 437, aside 91) |
| test/ (including test/fixtures) | 2,108 (fixtures 211) |
| bridge/ | 80 |
| src/ego/ | 70 |
| bin/ | 15 |
| **total** | **5,312** |

## Later snapshot

`baseline-tsc.txt` holds a full `bun x tsc --noEmit` capture taken some way into the
port, after several directories had already been typed. It reads **3,198** errors:

| directory | errors |
|---|---|
| src/ | 2,224 |
| test/ | 880 |
| bridge/ | 80 |
| bin/ | 14 |

That file is a mid-run checkpoint, not the baseline. It is kept because it is a real
full-tree capture with per-file lines, but the baseline the port is measured against is
the 5,312 above.
