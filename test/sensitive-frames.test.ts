import { after, test } from "node:test";
import assert from "node:assert/strict";
import { compactSnapshot } from "../src/index.ts";
import {
  PLACEHOLDER,
  type PipePage,
  assertNoWords,
  openSensitiveTab,
  releaseSensitiveBrowser,
  skipWithoutShell,
} from "./fixtures/sensitive-browser.ts";

// Test authoring gate: (1) contract — security (#379, follow-up to the #381 audit): a frame whose
// owner element is sealed with data-sensitive (the <iframe> itself, or an ancestor of it) is
// sealed content, and so is every frame below it; no snapshot read, refs map, guessed frame ref,
// frame-scoped locator read or frame-scoped matcher emits or confirms its text. (2) regression —
// takeSnapshot snapshots each descendant frame and splices it under its iframe line (or appends it
// when the owner has no ref), and frame-scoped reads run inside the child document, where the
// element walk never sees the owner. (3) existing coverage — sensitive-redaction.test.ts seals
// elements inside one document only. (4) boundary — a real Chromium via connectPipe with same-origin
// srcdoc frames, no mocks; an unmarked frame is the control that frames are still read.

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
      '<p>alpha bravo charlie</p><button>zulu outer</button><iframe id="inner" srcdoc="<p>delta echo</p><button>yankee inner</button>"></iframe>',
    );
    sealed.setAttribute("data-sensitive", "");
    const wrapper = document.createElement("div");
    wrapper.setAttribute("data-sensitive", "");
    const wrapped = frame("wrapped", "<p>hotel india</p>");
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

// The cold chrome-headless-shell start lands on this file's only test, so it carries the same
// explicit allowance sensitive-redaction.test.ts gives its first test.
after(releaseSensitiveBrowser);

test(
  "a data-sensitive frame owner seals its whole frame chain in every read (security contract #379)",
  { skip: skipWithoutShell, timeout: 30_000 },
  async () => {
    const page = await openSensitiveTab();
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

      for (let index = 1; index <= 4; index++) {
        const ref = `f${index}e1`;
        const scoped = await page.snapshot({ ref }).catch((error: unknown) => String(error));
        assertSealed(`snapshot({ ref: ${ref} })`, scoped);
        const text = await page
          .locator(ref)
          .textContent()
          .catch((error: unknown) => String(error));
        assertSealed(`locator(${ref}).textContent()`, text);
      }

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
