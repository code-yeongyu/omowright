import { readFile, readdir, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { fixedDelays, undeclaredNodeModules } from "./fixtures/doc-example-checks.ts";

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
// whatever the timer's callback is called, however its delay is spelled and however many lines the call
// takes, and a wait on a state is not (#352, #362).
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
  ];
  const waitsOnAState = [
    "await page.waitForFunction(() => window.ready === true, undefined, { timeout: 5000 });",
    "const saved = page.waitForResponse('**/api/cart');",
    "await snoop.waitFor({ url: /search/ }, { timeoutMs: 10_000 });",
    "await requestHuman(page, { prompt, timeoutMs: 300000 });",
    "setTimeout(() => controller.abort(), 0);",
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

// An example runs as written in an eval cell, where no Node module is in scope (#362).
test("the module check reports a Node module an example calls without declaring it", () => {
  const flagLine = "const flag = path.join(os.tmpdir(), `handoff-${Date.now()}.flag`);";

  assert.deepEqual(undeclaredNodeModules([flagLine, "fs.writeFileSync(flag, 'done');"]), ["os", "path", "fs"]);
  assert.deepEqual(
    undeclaredNodeModules([
      'const fs = await import("node:fs");\nconst os = await import("node:os");\nimport path from "node:path";',
      `${flagLine}\nfs.writeFileSync(flag, "done");`,
    ]),
    [],
  );
  assert.deepEqual(undeclaredNodeModules(["const where = page.url(); await session.path.join(where);"]), []);
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

  test(`${rel}: examples declare the Node modules they call`, () => {
    assert.deepEqual(undeclaredNodeModules(blocks), [], `${rel} calls a Node module no example declares`);
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
