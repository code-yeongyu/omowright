import { readFile, readdir, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { fixedDelays, parseFailure, unaccountedNames } from "./fixtures/doc-example-checks.ts";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

async function listDocs() {
  const skillDir = path.join(repoRoot, "skills", "omowright");
  const docs = [path.join(skillDir, "SKILL.md")];
  for (const f of await readdir(path.join(skillDir, "references"))) {
    if (f.endsWith(".md")) docs.push(path.join(skillDir, "references", f));
  }
  for (const d of await readdir(path.join(repoRoot, "presets"))) {
    const p = path.join(repoRoot, "presets", d, "SKILL.md");
    try {
      await stat(p);
      docs.push(p);
    } catch {}
  }
  return docs;
}

function captured(match: RegExpMatchArray): string {
  const value = match[1];
  if (value === undefined) throw new TypeError(`pattern matched ${match[0]} without its capture group`);
  return value;
}

function frontmatter(text: string) {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  assert.ok(m, "missing YAML frontmatter");
  const block = captured(m);
  const name = block.match(/^name:\s*(.+)$/m)?.[1]?.trim();
  const description = block.match(/^description:\s*(.+)$/m)?.[1]?.trim();
  return { name, description };
}

// Paths a reader is expected to open: package-root files, home-relative install
// paths, and doc-relative `references/x.md` / `presets/x/SKILL.md` links.
function referencedPaths(text: string, docPath: string) {
  const out = new Set<string>();
  const docDir = path.dirname(docPath);
  for (const m of text.matchAll(/`((?:TOOLS|README)\.md|docs\/[A-Za-z0-9_-]+\.md)`/g))
    out.add(path.join(repoRoot, captured(m)));
  for (const m of text.matchAll(/~\/\.agents\/skills\/omowright\/([A-Za-z0-9_./-]+\.md)/g))
    out.add(path.join(repoRoot, "skills", "omowright", captured(m)));
  for (const m of text.matchAll(/`(references\/[A-Za-z0-9_-]+\.md)`/g)) out.add(path.join(docDir, captured(m)));
  for (const m of text.matchAll(/`(presets\/[A-Za-z0-9_-]+\/SKILL\.md)`/g)) out.add(path.join(repoRoot, captured(m)));
  for (const m of text.matchAll(/`(skills\/omowright\/references\/[A-Za-z0-9_-]+\.md)`/g))
    out.add(path.join(repoRoot, captured(m)));
  return [...out].map((p) => p.replace(/[.,;:)]+$/, ""));
}

function jsBlocks(text: string) {
  return [...text.matchAll(/```(?:js|javascript|ts|typescript)\n([\s\S]*?)```/g)].map(captured);
}

// Names an example takes from the package: `const { a, b: c } = await import("omowright")`
// and `import { a, b as c } from "omowright"`.
function importedNames(block: string) {
  const lists = [
    ...block.matchAll(/\{([^{}]*)\}\s*=\s*await import\(\s*["']omowright["']\s*\)/g),
    ...block.matchAll(/import\s*\{([^{}]*)\}\s*from\s*["']omowright["']/g),
  ];
  const names: string[] = [];
  for (const list of lists) {
    for (const part of captured(list).split(",")) {
      const name = part.trim().split(/\s*(?::|\bas\b)\s*/)[0];
      if (name) names.push(name);
    }
  }
  return names;
}

// The guard below is only as good as this matcher: every way an example can wait on a clock is flagged,
// whatever the timer's callback is called, however its delay is spelled and however the call is laid out,
// and a wait on a state is not, even when a comment or a string beside it names a timer (#352, #362, #366).
test("the fixed-delay matcher flags a wait on a clock and passes a wait on a state", () => {
  const waitsOnAClock = [
    "await Bun.sleep(1000);",
    "await page.waitForTimeout(1500);",
    "await new Promise((r) => setTimeout(r, 800));",
    "await new Promise(finish => setTimeout(finish, 1000));",
    "await new Promise((ok) => setTimeout(() => ok(), 2_000));",
    "await sleep(500);",
    "await setTimeout(1000);",
    "await new Promise((resolve) => setTimeout(resolve, delayMs));",
    "await new Promise(done => setTimeout(\n  () => done(),\n  1000\n));",
    "await new Promise((done) => setTimeout((v) => done(v), 1000, true));",
    "await new Promise((done) => setTimeout(() => done(), 1e3));",
    "await new Promise((done) => setTimeout(() => done(), 0x3e8));",
    "await new Promise((done) => setTimeout(() => done(), 1.5));",
    'await new Promise((done) => setTimeout(() => done("a, b"), /* ms */ 250));',
    "await new Promise((ok) => setTimeout /* defer */ (() => ok(), 1000));",
    "await new Promise((ok) => setTimeout?.(() => ok(), 1000));",
    "await new Promise((ok) => setTimeout(() => ok(), (1000)));",
    "await new Promise((ok) => setTimeout(() => /[)]/.test(label) && ok(), 1000));",
    "await new Promise((ok) => globalThis.setTimeout(() => ok(), 0b1010));",
    "const poll = setInterval(() => check(), 500);",
    "await scheduler.wait(1000);",
  ];
  const waitsOnAState = [
    "await page.waitForFunction(() => window.ready === true, undefined, { timeout: 5000 });",
    "const saved = page.waitForResponse('**/api/cart');",
    "await snoop.waitFor({ url: /search/ }, { timeoutMs: 10_000 });",
    "await requestHuman(page, { prompt, timeoutMs: 300000 });",
    "setTimeout(() => controller.abort(), 0);",
    "setTimeout(next, 0);",
    "await page.waitForFunction(() => window.ready); // never use sleep(500)",
    'await page.waitForFunction(() => document.body.innerText.includes("setTimeout(done, 1000)"));',
    "const timers = { sleep: 500, setTimeout: 1000 };",
  ];

  assert.deepEqual(
    waitsOnAClock.filter((example) => fixedDelays(example).length === 0),
    [],
  );
  assert.deepEqual(
    waitsOnAState.filter((example) => fixedDelays(example).length > 0),
    [],
  );
});

// An example runs as written in an eval cell: every name it uses is declared in its document's examples, is
// a platform global, or is listed in a `// given:` line that tells the reader what to supply (#362, #366).
test("the name check reports what an example uses without accounting for it", () => {
  const snapshot = "const page = await browser.newTab(url);\nprint(compactSnapshot(await page.snapshot()));";

  assert.deepEqual(unaccountedNames([snapshot]), ["browser", "url", "compactSnapshot"]);
  assert.deepEqual(unaccountedNames(["const text = await fs.promises.readFile(cookieFile, 'utf8');"]), [
    "fs",
    "cookieFile",
  ]);
  assert.deepEqual(
    unaccountedNames([
      'const { connect, compactSnapshot } = await import("omowright");\nglobalThis.browser = await connect();',
      `// given: url\n${snapshot}`,
      "await page.evaluate(() => document.title); display(await page.screenshot()); // later example, same names",
    ]),
    [],
  );
  assert.deepEqual(unaccountedNames(["for (const item of items) console.log(item.id);"]), ["items"]);
});

const docs = await listDocs();
assert.ok(docs.length >= 6, `expected skill + presets docs, found ${docs.length}`);

// Package contract: skills/, presets/, README.md and TOOLS.md ship in the npm tarball and agents run their
// js examples as written, so an example must import names the package exports and must not wait on a clock.
const exported = new Set(Object.keys(await import("../src/index.ts")));
for (const doc of [...docs, path.join(repoRoot, "README.md"), path.join(repoRoot, "TOOLS.md")]) {
  const rel = path.relative(repoRoot, doc);
  const blocks = jsBlocks(await readFile(doc, "utf8"));

  test(`${rel}: examples import only names the package exports`, () => {
    const unknown = blocks.flatMap(importedNames).filter((name) => !exported.has(name));
    assert.deepEqual(unknown, [], `${rel} imports names that omowright does not export`);
  });

  test(`${rel}: no example waits on a fixed delay`, () => {
    assert.deepEqual(blocks.flatMap(fixedDelays), [], `${rel} waits on a clock; wait for the state instead`);
  });

  test(`${rel}: every example parses and accounts for the names it uses`, () => {
    assert.deepEqual(
      blocks.flatMap((block) => parseFailure(block) ?? []),
      [],
      `${rel} has an example that is not valid JavaScript`,
    );
    assert.deepEqual(unaccountedNames(blocks), [], `${rel} uses names no example declares or lists as given`);
  });
}

for (const doc of docs) {
  const rel = path.relative(repoRoot, doc);
  const text = await readFile(doc, "utf8");

  if (path.basename(doc) === "SKILL.md") {
    test(`${rel}: frontmatter name matches its directory`, () => {
      // Package contract: shipped skill docs are LF on every OS (.gitattributes), so a loader sees the same bytes.
      assert.ok(!text.includes("\r"), "skill docs must be checked out with LF line endings (see .gitattributes)");
      const { name, description } = frontmatter(text);
      assert.equal(name, path.basename(path.dirname(doc)));
      assert.ok(description && description.length > 20, "description must route the skill");
      assert.ok(!/\n/.test(description), "description must be a single line");
    });
  }

  test(`${rel}: every referenced doc path exists`, async () => {
    const missing = [];
    for (const p of referencedPaths(text, doc)) {
      const candidates = [p, p.replace(/\/\.\.\.\//, "/")];
      if (p.includes("/.../")) continue; // elided glob examples, not links
      let ok = false;
      for (const c of candidates) {
        try {
          await stat(c);
          ok = true;
          break;
        } catch {}
      }
      if (!ok) missing.push(p);
    }
    assert.deepEqual(missing, [], `dangling references in ${rel}`);
  });
}
