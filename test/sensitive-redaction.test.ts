import { after, test } from "node:test";
import assert from "node:assert/strict";
import { globSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildSnapshotExpression, compactSnapshot, connectPipe } from "../src/index.ts";
import { readProperty } from "../src/read-property.ts";
import { removeTreeSync } from "./fixtures/remove-tree.ts";

// Test authoring gate: (1) contract — security (#379): an element the page marks data-sensitive
// (any value except the exact string "false") is a secret, and omowright never emits its text or
// its descendants' text, names, values or attribute values in any output; it emits a
// "[redacted: sensitive]" placeholder that keeps the element's role and ref, while elements
// outside the marked subtree keep their names and refs. (2) regression — any surface that emits
// marked text verbatim: snapshot trees, refs maps, diff/find/scoped reads, locator reads, BSK
// snapshot trees/refs/css. (3) existing coverage — password input values and fill-error echo
// (#335/#341) are redacted, but nothing covers page-MARKED text. (4) boundary — a real
// Chromium via connectPipe: page.snapshot(), page.locator() reads and the real BSK snapshot
// expression, no mocks. The secret words are synthetic NATO filler standing in for a 24-word
// recovery phrase.

const SECRET = "alpha bravo charlie";
const INPUT_SECRET = "kilo lima mike";
const MUTATED_SECRET = "foxtrot golf";
const PLACEHOLDER = "[redacted: sensitive]";
const SECRET_WORDS = [...SECRET.split(" "), ...INPUT_SECRET.split(" "), ...MUTATED_SECRET.split(" ")];

function assertNoSecret(what: string, value: unknown) {
  const text = typeof value === "string" ? value : (JSON.stringify(value) ?? "");
  for (const word of SECRET_WORDS) {
    assert.ok(!text.includes(word), `${what} leaked "${word}": ${text}`);
  }
}

function findHeadlessShell() {
  const home = process.env["HOME"] ?? "";
  const candidates = [
    ...globSync(
      path.join(
        home,
        "Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-mac-arm64/chrome-headless-shell",
      ),
    ),
    ...globSync(
      path.join(
        home,
        ".cache/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell",
      ),
    ),
  ];
  return candidates.toSorted().at(-1);
}

const SHELL = process.env["SHELL_BIN"] ?? findHeadlessShell();

type PipeBrowser = Awaited<ReturnType<typeof connectPipe>>;
type PipePage = Awaited<ReturnType<PipeBrowser["newTab"]>>;
type SnapshotResult = Awaited<ReturnType<PipePage["snapshot"]>>;
type TreeRead = Extract<SnapshotResult, { tree: string }>;

// A plain, scoped or find read: a tree plus a refs map; each contract has one primary owner, so
// the refs shape is asserted locally as { role?, name? } entries the way the API exposes them.
interface RefMeta {
  role?: unknown;
  name?: unknown;
}
type RefsRead = TreeRead & { refs: Record<string, RefMeta> };

function assertTreeRead(snapshot: SnapshotResult): asserts snapshot is RefsRead {
  assert.ok("tree" in snapshot && snapshot.refs, `expected a tree with refs, got ${JSON.stringify(snapshot)}`);
}

interface BskSnapshotValue {
  tree: string;
  refs: Record<string, RefMeta>;
  css: Record<string, unknown>;
}

function isBskSnapshotValue(value: unknown): value is BskSnapshotValue {
  return typeof value === "object" && value !== null && typeof readProperty(value, "tree") === "string";
}

async function setSecretPage(page: PipePage) {
  await page.evaluate(() => {
    document.body.innerHTML =
      "<main><h1>Wallet settings</h1>" +
      '<div data-sensitive id="phrase"><span>alpha bravo charlie</span></div>' +
      '<label for="seed">Recovery phrase</label>' +
      '<input id="seed" type="text" data-sensitive value="kilo lima mike" />' +
      '<button type="button" id="copy">Copy phrase</button>' +
      '<span data-sensitive id="secret-name">alpha bravo charlie</span>' +
      '<button type="button" id="reveal" aria-labelledby="secret-name">Reveal</button>' +
      '<div data-sensitive="false"><p>public notes stay visible</p></div>' +
      "</main>";
  });
}

// One browser serves the whole file. The first test that runs starts it — the lighter BSK read
// below runs first, so the cold chrome-headless-shell start, which alone can take most of a slow
// runner's per-test limit, lands on the lightest body, and the locator-read contract runs against
// the already-warm browser — and after() releases everything. Not in a before() hook: bun gives
// hooks the test limit and ignores a hook's timeout option, and that hook timed out on a Windows
// runner. Not while the module loads either: a run whose filter selects no test here would launch a
// browser and leave its profile behind. Release runs newest first, the browser before its
// user-data dir, collecting failures instead of stranding the rest.
const skip = !SHELL && "no chromium binary found";
type Release = () => unknown;
const releases: Release[] = [];
let shared: Promise<PipeBrowser> | undefined;

async function start(): Promise<PipeBrowser> {
  assert.ok(SHELL, "no chromium binary found");
  const ud = mkdtempSync(path.join(tmpdir(), "omowright-sensitive-"));
  releases.push(() => removeTreeSync(ud));
  const browser = await connectPipe({
    browserPath: SHELL,
    browserArgs: ["--headless", "--no-first-run", `--user-data-dir=${ud}`],
    storageRoot: ud,
  });
  releases.push(() => browser.close());
  return browser;
}

after(async () => {
  await shared?.catch(() => undefined);
  const failures: unknown[] = [];
  for (const step of releases.toReversed()) {
    try {
      await step();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0)
    throw new AggregateError(failures, "the sensitive-redaction fixture did not release cleanly");
});

async function openTab(): Promise<PipePage> {
  shared ??= start();
  const browser = await shared;
  return await browser.newTab("about:blank");
}

test(
  "bsk snapshot redacts data-sensitive text and emits no css path for marked refs (security contract #379)",
  { skip },
  async () => {
    const page = await openTab();
    try {
      await setSecretPage(page);
      const sessionId = await page.resolveSessionId();
      const reply = await page.cdp.send(
        "Runtime.evaluate",
        { expression: buildSnapshotExpression({}), returnByValue: true, awaitPromise: true },
        sessionId,
      );
      assert.equal(reply.exceptionDetails, undefined, "bsk snapshot expression threw");
      const value = reply.result.value;
      assert.ok(isBskSnapshotValue(value), "bsk snapshot returned no tree");

      assertNoSecret("bsk tree", value.tree);
      assert.ok(value.tree.includes(PLACEHOLDER), `bsk tree has no placeholder:\n${value.tree}`);
      assertNoSecret("bsk refs", value.refs);
      const sensitive = Object.entries(value.refs).filter(([, meta]) => meta.name === PLACEHOLDER);
      assert.ok(sensitive.length >= 1, `no redacted ref entry in bsk refs: ${JSON.stringify(value.refs)}`);
      for (const [ref] of sensitive) assert.equal(value.css[ref], null, `css path for marked ref ${ref}`);

      const copy = Object.entries(value.refs).find(([, meta]) => meta.name === "Copy phrase");
      assert.ok(copy, "outside button missing from bsk refs");
      const copyPath = value.css[copy[0]];
      assert.ok(
        typeof copyPath === "string" && copyPath.length > 0,
        `outside button lost its css path: ${String(copyPath)}`,
      );
    } finally {
      await page.close();
    }
  },
);

test("snapshot and locator reads redact data-sensitive page text (security contract #379)", { skip }, async () => {
  const page = await openTab();
  try {
    await setSecretPage(page);

    for (const options of [{}, { interactive: true }]) {
      const read = await page.snapshot(options);
      assertTreeRead(read);
      const tree = compactSnapshot(read);
      assertNoSecret(`${JSON.stringify(options)} tree`, tree);
      assert.ok(tree.includes(PLACEHOLDER), `no placeholder in ${JSON.stringify(options)} tree:\n${tree}`);
      assert.ok(tree.includes("Copy phrase"), `outside button dropped from ${JSON.stringify(options)} tree:\n${tree}`);
      assertNoSecret(`${JSON.stringify(options)} refs`, read.refs);
      const redactedEntries = Object.entries(read.refs).filter(([, meta]) => meta.name === PLACEHOLDER);
      assert.ok(redactedEntries.length >= 1, `no redacted ref entry in ${JSON.stringify(options)} refs`);
    }
    // Interactive mode drops free-standing prose by design, so the inert-value control runs
    // on a full read: data-sensitive="false" stays visible and unredacted.
    const full = await page.snapshot();
    assertTreeRead(full);
    const fullTree = compactSnapshot(full);
    assert.ok(fullTree.includes("public notes stay visible"), `data-sensitive="false" must stay visible:\n${fullTree}`);

    // find: the match set of the redacted tree cannot contain the secret.
    const found = await page.snapshot({ find: "alpha" });
    assertTreeRead(found);
    assertNoSecret("find tree", found.tree);

    // A read scoped to the marked element itself is redacted too, with the placeholder.
    const scoped = await page.snapshot({ selector: "#phrase" });
    assertTreeRead(scoped);
    assertNoSecret("scoped tree", scoped.tree);
    assert.ok(scoped.tree.includes(PLACEHOLDER), `scoped read has no placeholder:\n${scoped.tree}`);

    // diff: a change inside the marked subtree plus one outside must not leak the secret.
    await page.evaluate(() => {
      const span = document.querySelector("#phrase span");
      if (span) span.textContent = `${span.textContent ?? ""} foxtrot golf`;
      const later = document.createElement("button");
      later.textContent = "Later";
      document.body.append(later);
    });
    const delta = compactSnapshot(await page.snapshot({ diff: true }));
    assertNoSecret("diff", delta);
    assert.ok(delta.includes("Later"), `diff lost the outside change:\n${delta}`);

    // Locator reads: the marked element and its descendants return the placeholder; an
    // ancestor read substitutes the placeholder for the marked subtree; unmarked reads are
    // untouched.
    assert.equal(await page.locator("#phrase").textContent(), PLACEHOLDER);
    assert.equal(await page.locator("#phrase span").textContent(), PLACEHOLDER);
    assert.equal(await page.locator("#phrase span").innerText(), PLACEHOLDER);
    assert.equal(await page.locator("#seed").inputValue(), PLACEHOLDER);
    assert.equal(await page.locator("#seed").getAttribute("value"), PLACEHOLDER);
    assert.equal(await page.locator("#copy").getAttribute("id"), "copy");

    const mainText = await page.locator("main").textContent();
    assertNoSecret("main textContent", mainText);
    assert.ok(
      mainText?.includes("Copy phrase") && mainText.includes("public notes stay visible"),
      `ancestor read lost unmarked text:\n${mainText}`,
    );
    assert.ok(mainText?.includes(PLACEHOLDER), `ancestor read has no placeholder:\n${mainText}`);

    const mainHtml = await page.locator("main").innerHTML();
    assertNoSecret("main innerHTML", mainHtml);
    assert.ok(mainHtml.includes(PLACEHOLDER), `ancestor innerHTML has no placeholder:\n${mainHtml}`);

    const texts = await page.locator("main span, main p").allTextContents();
    assertNoSecret("allTextContents", texts);
    assert.ok(
      texts.includes("public notes stay visible") && texts.includes(PLACEHOLDER),
      `allTextContents lost unmarked text or placeholder: ${JSON.stringify(texts)}`,
    );
  } finally {
    await page.close();
  }
});
