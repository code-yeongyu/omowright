import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { connectPipe, compactSnapshot } from "../src/index.ts";
import { removeTreeSync } from "./fixtures/remove-tree.ts";

const shell = process.env["SHELL_BIN"];

// Public snapshot contracts: implicit status feedback and live text beyond a control's
// capped name survive both modes. Existing feedback coverage has neither output nor
// a live region inside an already text-named control; no production seam is needed.
for (const tag of ["output", "a", "button"]) {
  test(`snapshot preserves live feedback inside ${tag}`, { skip: !shell, timeout: 60000 }, async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "omowright-live-feedback-"));
    const browser = await connectPipe({
      browserPath: shell,
      browserArgs: ["--headless", `--user-data-dir=${dir}`],
      storageRoot: dir,
    });
    try {
      const feedback = `Copied ${"x".repeat(93)}`;
      const html =
        tag === "output"
          ? `<output>${feedback}<span>FEEDBACK_TAIL</span></output>`
          : `<${tag} ${tag === "a" ? 'href="#next"' : ""}>Label ${"word ".repeat(100)}LABEL_TAIL<span aria-live="polite">${feedback}<span>FEEDBACK_TAIL</span></span></${tag}>`;
      const page = await browser.newTab(`data:text/html,${encodeURIComponent(`<main>${html}</main>`)}`);
      for (const interactive of [false, true]) {
        const tree = compactSnapshot(await page.snapshot({ interactive }));
        assert.ok(tree.includes(feedback), `${tag}, interactive=${interactive} keeps live feedback:\n${tree}`);
        if (interactive) assert.ok(!tree.includes("FEEDBACK_TAIL"), `live feedback is capped:\n${tree}`);
        if (tag !== "output") {
          assert.ok(!tree.includes("LABEL_TAIL"), `the control's own name stays capped:\n${tree}`);
          assert.equal(tree.split("Label").length - 1, 1, `the control name prints once:\n${tree}`);
        }
      }
    } finally {
      await browser.close();
      removeTreeSync(dir);
    }
  });
}
