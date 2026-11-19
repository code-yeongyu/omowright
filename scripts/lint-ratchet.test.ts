import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { compare, countByFile, countSuppressions, lint, ratchetedFiles, SUPPRESSION } from "./lint-ratchet.ts";

const root = "/repo";
const sleep = "omowright-testing/no-fixed-sleep";
const flake = "omowright-testing/no-flake-masking";
const moduleMock = "omowright-testing/no-module-mock";

test("counts findings per file and rule, relative to the repo root", () => {
  const counts = countByFile(
    [
      { code: "omowright-testing(no-module-mock)", filename: "src/a.test.ts" },
      { code: "omowright-testing(no-module-mock)", filename: "/repo/src/a.test.ts" },
      { code: "omowright-testing(no-fixed-sleep)", filename: "src/a.test.ts" },
      { code: "omowright-testing(no-flake-masking)", filename: "scripts/b.test.ts" },
    ],
    root,
  );
  assert.deepEqual(counts, {
    "src/a.test.ts": { [moduleMock]: 2, [sleep]: 1 },
    "scripts/b.test.ts": { [flake]: 1 },
  });
});

test("refuses a count that goes up, including any finding in a file the baseline does not list", () => {
  const { increases } = compare(
    { "src/a.test.ts": { [moduleMock]: 2 } },
    { "src/a.test.ts": { [moduleMock]: 3 }, "src/new.test.ts": { [sleep]: 1 } },
  );
  assert.deepEqual(increases, [
    { file: "src/a.test.ts", rule: moduleMock, before: 2, after: 3 },
    { file: "src/new.test.ts", rule: sleep, before: 0, after: 1 },
  ]);
});

test("reports a count that goes down, so the baseline must be lowered in the same change", () => {
  const { increases, decreases } = compare(
    { "src/a.test.ts": { [flake]: 2 }, "src/gone.test.ts": { [moduleMock]: 1 } },
    { "src/a.test.ts": { [flake]: 2 } },
  );
  assert.deepEqual(increases, []);
  assert.deepEqual(decreases, [{ file: "src/gone.test.ts", rule: moduleMock, before: 1, after: 0 }]);
});

test("accepts counts that match the baseline exactly", () => {
  const counts = { "src/a.test.ts": { [flake]: 2 } };
  assert.deepEqual(compare(counts, counts), { increases: [], decreases: [] });
});

test("counts every disable comment that names a ratcheted rule or disables every rule", () => {
  // Built at runtime so this file holds no directive of its own for the gate to count.
  const line = "/".repeat(2);
  const block = ["/", "*"].join("");
  const source = [
    `${line} oxlint-disable-next-line omowright-testing/no-fixed-sleep`,
    `${line} eslint-disable-next-line omowright-testing/no-flake-masking -- legacy`,
    `${block} eslint-disable */`,
    `const a = 1; ${line} oxlint-disable-line`,
    `${line} oxlint-disable-next-line omowright-testing/no-module-mock, eslint/no-console`,
    `${line} oxlint-disable-next-line eslint/no-console -- unrelated rule, not counted`,
    `const text = "oxlint-disable-next-line omowright-testing/no-module-mock";`,
    `${block}\n  eslint-disable-next-line omowright-testing/no-module-mock\n*/`,
  ].join("\n");
  assert.equal(countSuppressions("probe.ts", source), 6);
  assert.equal(countSuppressions("probe.ts", "const x = 1;\n"), 0);
});

test("refuses a new disable comment like any other rise", () => {
  const { increases } = compare({}, { "scripts/probe.ts": { [SUPPRESSION]: 1 } });
  assert.deepEqual(increases, [{ file: "scripts/probe.ts", rule: SUPPRESSION, before: 0, after: 1 }]);
});

test("ratchets only hand-written JS/TS sources, never the tracked build outputs", () => {
  const files = ["src/a.ts", "src/b.mjs", "src/page-bundle.js", "bridge/extension/background.js"];
  assert.deepEqual(ratchetedFiles([...files, "README.md"]), ["src/a.ts", "src/b.mjs"]);
});

// The ratchet's real oxlint run, in a scratch repo that reuses this repo's oxlint and plugin. A config's
// ignorePatterns resolve inside its own directory, so the hidden file sits in scripts/ next to it.
// It runs at module load: bun ignores node:test hook options.
const scratch = mkdtempSync(join(tmpdir(), "lint-ratchet-ignore-"));
const config = join(scratch, "scripts/lint-ratchet.oxlintrc.json");
const repo = join(import.meta.dirname, "..");
const shipped = JSON.parse(readFileSync(join(repo, "scripts/lint-ratchet.oxlintrc.json"), "utf8"));
symlinkSync(join(repo, "node_modules"), join(scratch, "node_modules"));
mkdirSync(join(scratch, "scripts"));
symlinkSync(join(repo, "scripts/oxlint"), join(scratch, "scripts/oxlint"));
writeFileSync(config, JSON.stringify(shipped));
writeFileSync(
  join(scratch, "scripts/hidden.test.ts"),
  'import { mock } from "bun:test";\nmock.module("./dep", () => ({}));\n',
);
writeFileSync(join(scratch, "clean.ts"), "export const clean = 1;\n");
writeFileSync(join(scratch, ".eslintignore"), "scripts/hidden.test.ts\n");
execFileSync("git", ["init", "-q"], { cwd: scratch });
execFileSync("git", ["add", "."], { cwd: scratch });
const listedInEslintignore = lint(scratch);
writeFileSync(config, JSON.stringify({ ...shipped, ignorePatterns: ["hidden.test.ts"] }));
const hiddenByIgnorePatterns = lint(scratch);
rmSync(scratch, { recursive: true, force: true });

test("still counts a violating file that .eslintignore lists", () => {
  assert.deepEqual(listedInEslintignore, {
    counts: { "scripts/hidden.test.ts": { [moduleMock]: 1 } },
    unparsed: [],
    skipped: 0,
  });
});

test("reports a file hidden by the ratchet config ignorePatterns as skipped, not as zero findings", () => {
  assert.deepEqual(hiddenByIgnorePatterns, { counts: {}, unparsed: [], skipped: 1 });
});
