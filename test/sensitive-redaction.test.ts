import { after, test } from "node:test";
import assert from "node:assert/strict";
import { buildSnapshotExpression, compactSnapshot, describeLayers } from "../src/index.ts";
import { readProperty } from "../src/read-property.ts";
import {
  PLACEHOLDER,
  type PipePage,
  assertNoWords,
  openSensitiveTab as openTab,
  releaseSensitiveBrowser,
  skipWithoutShell as skip,
} from "./fixtures/sensitive-browser.ts";

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
// recovery phrase. The text, label and role matchers (#382) are outputs too: a match count would
// confirm a guessed secret, so they read a sealed subtree as the placeholder.

const SECRET = "alpha bravo charlie";
const INPUT_SECRET = "kilo lima mike";
const MUTATED_SECRET = "foxtrot golf";
const OPTION_SECRET = "november oscar";
const LAYER_SECRET = "papa quebec";
const ATTRIBUTE_SECRET = "sierra tango";
const SECRET_WORDS = [SECRET, INPUT_SECRET, MUTATED_SECRET, OPTION_SECRET, LAYER_SECRET, ATTRIBUTE_SECRET].flatMap(
  (s) => s.split(" "),
);

function assertNoSecret(what: string, value: unknown) {
  assertNoWords(what, value, SECRET_WORDS);
}

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
      '<select data-sensitive id="pin"><option>november oscar</option></select>' +
      '<div data-sensitive><input id="hint" data-testid="hint-box" title="sierra tango" placeholder="sierra tango" />' +
      '<img alt="sierra tango" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" /></div>' +
      "</main>";
  });
}

// One browser serves the whole file. The first test that runs starts it — the lighter BSK read
// below runs first, so the cold chrome-headless-shell start, which alone takes the whole default
// per-test limit on windows-latest, lands on the lightest body and carries that one explicit
// timeout, and the locator-read contract runs against the already-warm browser.
after(releaseSensitiveBrowser);

// This test runs first, so it pays the cold chrome-headless-shell start, measured at ~5 s on
// windows-latest: run 46127683648 took 4920 ms and run 46130078845 reached its first CDP command
// only at elapsedSinceLaunchMs=4975, past the default 5 s per-test limit. The launch is the one
// boundary here with an explicit timeout, the same allowance async-dispose.test.ts grants its
// launchers; the contract read below keeps the default limit against the warm browser.
test(
  "bsk snapshot redacts data-sensitive text and emits no css path for marked refs (security contract #379)",
  { skip, timeout: 30_000 },
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

    // Matchers (#382): a guessed sealed string matches nothing, by text, label or role name,
    // while unmarked text still matches.
    assert.equal(await page.getByText("bravo").count(), 0, "getByText confirmed a sealed string");
    const sealedSpans = page.locator("#phrase span");
    assert.equal(await sealedSpans.filter({ hasText: "bravo" }).count(), 0, "filter hasText confirmed a secret");
    assert.equal(await sealedSpans.filter({ hasText: /^alpha/ }).count(), 0, "filter hasText RegExp confirmed");
    assert.equal(await sealedSpans.filter({ hasNotText: "bravo" }).count(), 1, "filter hasNotText confirmed");

    // Attribute matchers (#386) read sealed attribute values as the placeholder; the test id stays
    // matchable so a sealed block can be located.
    assert.equal(await page.getByPlaceholder("sierra").count(), 0, "getByPlaceholder confirmed a secret");
    assert.equal(await page.getByTitle("sierra").count(), 0, "getByTitle confirmed a secret");
    assert.equal(await page.getByAltText("sierra").count(), 0, "getByAltText confirmed a secret");
    assert.equal(await page.getByTestId("hint-box").count(), 1, "a sealed block lost its test id");
    // A CSS selector comparing attribute values is refused in a document with sealed content,
    // whatever its match would be; presence, id and class selectors still run.
    for (const selector of ['input[data-sensitive][value^="k"]', 'main:has(input[value^="k"])', '[title*="z"]']) {
      await assert.rejects(page.locator(selector).count(), /data-sensitive/, `CSS ${selector} answered`);
      await assert.rejects(page.waitForSelector(selector, { timeout: 200 }), /data-sensitive/, `wait ${selector}`);
    }
    assert.equal(await page.locator("#seed[data-sensitive]").count(), 1, "presence selector refused");
    assert.equal(await page.getByText("oscar").count(), 0, "getByText confirmed a sealed option");
    assert.equal(await page.getByLabel("bravo").count(), 0, "getByLabel confirmed a sealed label");
    assert.equal(await page.getByRole("button", { name: "bravo" }).count(), 0, "role name confirmed a secret");
    assert.equal(await page.getByText("Copy phrase").count(), 1, "unmarked text stopped matching");

    // Layers (#382): a sealed overlay is named by the placeholder, with no selector hint.
    await page.evaluate(() => {
      const overlay = document.createElement("div");
      overlay.setAttribute("data-sensitive", "");
      overlay.style.cssText = "position:fixed;inset:0;background:#fff";
      overlay.textContent = "papa quebec";
      document.body.append(overlay);
    });
    const layers = await describeLayers(page);
    assertNoSecret("layers", layers);
    assert.equal(layers.blocking?.name, PLACEHOLDER, `sealed overlay layer: ${JSON.stringify(layers.blocking)}`);
  } finally {
    await page.close();
  }
});

// Frames (#384, follow-up to the #381 audit): a frame whose owner element is sealed (the <iframe>
// itself, or an ancestor of it) is sealed content, and so is every frame below it. takeSnapshot
// snapshots each descendant frame and splices it under its iframe line (or appends it when the
// owner has no ref), and frame-scoped reads run inside the child document, where the element walk
// never sees the owner. Same-origin srcdoc frames; an unmarked frame is the control that frames
// are still read.

const SEALED_WORDS = ["alpha", "bravo", "charlie", "zulu", "delta", "echo", "yankee", "hotel", "india"];

function assertSealed(what: string, value: unknown) {
  assertNoWords(what, value, SEALED_WORDS);
}

async function setFramedPage(page: PipePage) {
  await page.evaluate(async () => {
    const frame = (id: string, srcdoc: string) => {
      const element = document.createElement("iframe");
      element.id = id;
      element.srcdoc = srcdoc;
      return element;
    };
    const sealed = frame(
      "sealed",
      '<p>alpha bravo charlie</p><button title="zulu tip">zulu outer</button><iframe id="inner" srcdoc="<p>delta echo</p><button title=\'yankee tip\'>yankee inner</button>"></iframe>',
    );
    sealed.setAttribute("data-sensitive", "");
    const wrapper = document.createElement("div");
    wrapper.setAttribute("data-sensitive", "");
    const wrapped = frame("wrapped", '<p>hotel india</p><img alt="india tip" title="india tip" />');
    wrapper.append(wrapped);
    const open = frame("open", "<p>public frame text</p><button>Open action</button>");
    const loaded = [sealed, wrapped, open].map(
      (element) => new Promise((resolve) => element.addEventListener("load", resolve, { once: true })),
    );
    const main = document.createElement("main");
    main.append(sealed, wrapper, open);
    document.body.replaceChildren(main);
    await Promise.all(loaded);
  });
}

test(
  "a data-sensitive frame owner seals its whole frame chain in every read (security contract #379)",
  { skip },
  async () => {
    const page = await openTab();
    try {
      await setFramedPage(page);

      for (const options of [{}, { interactive: true }, { selector: "main" }]) {
        const read = await page.snapshot(options);
        assert.ok("tree" in read && read.refs, `expected a tree with refs, got ${JSON.stringify(read)}`);
        const tree = compactSnapshot(read);
        assertSealed(`${JSON.stringify(options)} tree`, tree);
        assertSealed(`${JSON.stringify(options)} refs`, read.refs);
        assert.ok(tree.includes(PLACEHOLDER), `no placeholder in ${JSON.stringify(options)} tree:\n${tree}`);
        assert.ok(tree.includes("Open action"), `unmarked frame dropped from ${JSON.stringify(options)}:\n${tree}`);
      }
      assertSealed("diff", compactSnapshot(await page.snapshot({ diff: true })));

      // Frame prefixes follow attach order: f1 #sealed, f2 #wrapped, f3 #open, f4 #inner. A guessed
      // ref into a sealed frame is refused; the unmarked frame's ref still resolves.
      for (const ref of ["f1e1", "f2e1", "f4e1"]) {
        await assert.rejects(page.snapshot({ ref }), `snapshot({ ref: ${ref} }) read a sealed frame`);
        await assert.rejects(page.locator(ref).textContent(), `locator(${ref}) read a sealed frame`);
      }
      assert.equal(await page.locator("f3e1").textContent(), "Open action");

      const sealed = page.frameLocator("#sealed");
      const inner = sealed.frameLocator("#inner");
      const wrapped = page.frameLocator("#wrapped");
      for (const [what, frame] of [
        ["sealed", sealed],
        ["inner", inner],
        ["wrapped", wrapped],
      ] as const) {
        assert.equal(await frame.locator("p").textContent(), PLACEHOLDER, `${what} textContent`);
        assert.equal(await frame.locator("p").innerText(), PLACEHOLDER, `${what} innerText`);
        assert.equal(await frame.locator("body").innerHTML(), PLACEHOLDER, `${what} innerHTML`);
        assertSealed(`${what} allTextContents`, await frame.locator("p").allTextContents());
        // Guesses the placeholder cannot match: "o" is in every sealed frame's text, not in it.
        assert.equal(await frame.getByText("o").count(), 0, `${what} getByText matched sealed text`);
        assert.equal(await frame.locator("p").filter({ hasText: "o" }).count(), 0, `${what} filter matched`);
        await assert.rejects(frame.locator('button[type^="s"]').count(), /data-sensitive/, `${what} CSS compare`);
        assert.equal(await frame.getByTitle(/zulu|yankee|india/).count(), 0, `${what} getByTitle confirmed a secret`);
        assert.equal(await frame.getByAltText("india").count(), 0, `${what} getByAltText confirmed a secret`);
        const roleGuess = frame.getByRole("button", { name: /zulu|yankee/ });
        assert.equal(await roleGuess.count(), 0, `${what} role name matched`);
      }
      assert.equal(await sealed.locator("button").getAttribute("type"), PLACEHOLDER, "sealed getAttribute");

      const open = page.frameLocator("#open");
      assert.equal(await open.locator("p").textContent(), "public frame text");
      assert.equal(await open.getByText("public frame").count(), 1);
      assert.equal(await open.getByRole("button", { name: "Open action" }).count(), 1);
    } finally {
      await page.close();
    }
  },
);
