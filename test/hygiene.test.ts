import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const self = fileURLToPath(import.meta.url);
const SKIP_DIRS = new Set([".git", "node_modules"]);
// The source tree is TypeScript, so .ts/.mts sit beside .js/.mjs in the scanned set.
const TEXT = /\.(?:m?[jt]s|json|md|html|ya?ml|txt)$|^(?:LICENSE|NOTICE|\.gitignore)$/;

// Shapes, not literals: listing private names here would publish them.
const RULES: ReadonlyArray<readonly [label: string, pattern: RegExp]> = [
  ["absolute home path", /\/Users\/[A-Za-z0-9._-]+\/|\/home\/(?!runner\/)[a-z][a-z0-9_-]*\//],
  ["password-manager share link", new RegExp(["share", "1password", "com/s#"].join("\\."))],
  [
    "personal e-mail address",
    /\b[A-Za-z0-9._%+-]+@(?!example\.(?:com|org|net)\b)[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[a-z]{2,}\b/,
  ],
  ["private overlay-network host", /\.ts\.net\b|\b100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/],
  ["agent session id", /\bsession\s+`?(?:0[0-9a-f]{7}|[A-Za-z0-9]{16})\b/],
  ["bundler source-region marker", /\/\/#(?:end)?region\b/],
  ["extraction provenance note", new RegExp(["research", "extraction"].join("[ -]"), "i")],
  ["carve provenance note", /\bcarv(?:e|ed|ing)\b|byte-identical/i],
];

async function walk(dir: string): Promise<string[]> {
  const entries = (await readdir(dir, { withFileTypes: true })).filter((entry) => !SKIP_DIRS.has(entry.name));
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return walk(full);
      return full !== self && TEXT.test(entry.name) ? [full] : [];
    }),
  );
  return nested.flat();
}

const files = await walk(repoRoot);

test("hygiene scan covers the shipped tree", () => {
  assert.ok(files.length >= 50, `expected the whole tree, scanned ${files.length} files`);
});

for (const [label, pattern] of RULES) {
  test(`no ${label} in tracked text`, async () => {
    const hits: string[] = [];
    const scanned = await Promise.all(
      files.map(async (file) => ({ file, lines: (await readFile(file, "utf8")).split("\n") })),
    );
    for (const { file, lines } of scanned) {
      lines.forEach((line, i) => {
        if (pattern.test(line)) hits.push(`${path.relative(repoRoot, file)}:${i + 1}`);
      });
    }
    assert.deepEqual(hits, [], `${label} found`);
  });
}

test("rules still fire on synthetic leaks", () => {
  const samples = [
    "/Users/someone/project",
    ["https://share", "1password", "com/s#abc"].join("."),
    "reach me at someone@mail.test.io",
    "host box.tail1234.ts.net",
    "session `0c0ffee0` said so",
    "//#region src/x.ts",
    ["research", "extraction"].join(" "),
    "carved from a bundle",
  ];
  RULES.forEach(([label, pattern], i) => assert.match(samples[i] as string, pattern, label));
  for (const clean of ["user@example.com", "/home/runner/work", "the aside landmark", "https://example.com/#top"]) {
    for (const [label, pattern] of RULES) assert.doesNotMatch(clean, pattern, `${label} false positive on ${clean}`);
  }
});
