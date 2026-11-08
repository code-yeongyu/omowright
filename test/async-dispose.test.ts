// Contract owner (#244): the handle connect() returns is async-disposable, so
// `await using browser = await connect(url)` releases it when the scope ends
// and an agent script exits on its own: no trailing close() or process.exit().
// Each scenario runs as its own child process because "the process exits" is
// the behavior under test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, globSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { removeTreeSync } from "./fixtures/remove-tree.ts";
import { field } from "./fixtures/read-field.ts";

function findHeadlessShell() {
  const candidates = globSync(
    path.join(
      process.env.HOME ?? "",
      "Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-mac-arm64/chrome-headless-shell",
    ),
  );
  if (candidates.length > 0) return candidates.toSorted().at(-1);
  const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (existsSync(chrome)) return chrome;
  return null;
}

const SHELL = process.env.SHELL_BIN ?? findHeadlessShell();
// Live tests are skipped without a binary; inside them the path is required.
function requireBinary(binary: string | null | undefined): string {
  assert.ok(binary, "live test ran without a Chromium binary");
  return binary;
}
const INDEX = new URL("../src/index.js", import.meta.url).href;
// A script that never releases its socket keeps running until this bound.
const EXIT_BOUND_MS = 20_000;

async function withBrowser(fn: (context: { url: string; ud: string }) => Promise<void>) {
  const ud = mkdtempSync(path.join(tmpdir(), "omowright-dispose-"));
  const browser = spawn(
    requireBinary(SHELL),
    ["--headless", "--no-first-run", "--remote-debugging-port=0", `--user-data-dir=${ud}`, "about:blank"],
    {
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  try {
    const wsUrl = await new Promise<string>((resolve, reject) => {
      let buffered = "";
      browser.stderr.on("data", (chunk: Buffer) => {
        buffered += chunk;
        const match = /DevTools listening on (ws:\/\/\S+)/.exec(buffered);
        if (match) resolve(match[1] ?? "");
      });
      browser.once("exit", (code) => reject(new Error(`chromium exited early (${code})`)));
    });
    await fn({ url: wsUrl.replace(/^ws:/, "http:").replace(/\/devtools\/.*$/, ""), ud });
  } finally {
    const exited = browser.exitCode === null ? once(browser, "exit") : Promise.resolve();
    browser.kill();
    await exited;
    removeTreeSync(ud);
  }
}

// Runs `body` as an ES module in a child of the current runtime and reports how
// it ended. `null` code means it was still running at the bound and was killed.
async function runScript(ud: string, name: string, body: string) {
  const file = path.join(ud, `${name}.mjs`);
  writeFileSync(file, `import { connect, createAgentTabs } from ${JSON.stringify(INDEX)};\n${body}\n`);
  const child = spawn(process.execPath, [file], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    stderr += chunk;
  });
  const exited = once(child, "exit");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<"bound">((resolve) => {
    timer = setTimeout(resolve, EXIT_BOUND_MS, "bound");
  });
  const outcome = await Promise.race([exited, bound]);
  clearTimeout(timer);
  if (outcome === "bound") {
    child.kill("SIGKILL");
    await exited;
    return { code: null, stdout, stderr };
  }
  return { code: field(outcome, "0"), stdout, stderr };
}

async function targetIds(url: string) {
  const response = await fetch(`${url}/json/list`);
  return (await response.json()).map((target: { id: string }) => target.id);
}

test(
  "a script that holds connect() with await using exits on its own and leaves its agent tab and the browser up",
  {
    skip: !SHELL && "no chromium binary found",
    timeout: 90_000,
  },
  async () => {
    await withBrowser(async ({ url, ud }) => {
      const first = await runScript(
        ud,
        "first",
        `
      await using browser = await connect(${JSON.stringify(url)}, { storageRoot: ${JSON.stringify(ud)} });
      const tab = await createAgentTabs(browser).create("about:blank");
      console.log(JSON.stringify({ targetId: tab.targetId }));
    `,
      );
      assert.equal(first.code, 0, `the script must exit by itself: ${first.stderr}`);
      const { targetId } = JSON.parse(first.stdout.trim().split("\n").at(-1) ?? "");
      assert.ok((await targetIds(url)).includes(targetId), "disposal keeps the agent tab open");

      const second = await runScript(
        ud,
        "second",
        `
      await using browser = await connect(${JSON.stringify(url)}, { storageRoot: ${JSON.stringify(ud)} });
      const page = await browser.attachPage(${JSON.stringify(targetId)});
      console.log(JSON.stringify({ url: page.url() }));
    `,
      );
      assert.equal(second.code, 0, `a later script attaches the tab and exits: ${second.stderr}`);
      assert.equal(JSON.parse(second.stdout.trim().split("\n").at(-1) ?? "").url, "about:blank");
    });
  },
);

test(
  "a script that throws inside the await using scope still exits",
  {
    skip: !SHELL && "no chromium binary found",
    timeout: 60_000,
  },
  async () => {
    await withBrowser(async ({ url, ud }) => {
      const result = await runScript(
        ud,
        "throws",
        `
      await using browser = await connect(${JSON.stringify(url)}, { storageRoot: ${JSON.stringify(ud)} });
      await createAgentTabs(browser).create("about:blank");
      throw new Error("agent step failed");
    `,
      );
      assert.notEqual(result.code, null, "the script must not hang after a throw");
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /agent step failed/);
    });
  },
);

// connect(url) hands out leases on one shared connection (#76): disposing one
// lease must release only that holder, never close the connection under another.
test(
  "disposing one shared connect() handle leaves the other holder connected",
  {
    skip: !SHELL && "no chromium binary found",
    timeout: 60_000,
  },
  async () => {
    await withBrowser(async ({ url, ud }) => {
      const result = await runScript(
        ud,
        "shared",
        `
      const options = { storageRoot: ${JSON.stringify(ud)} };
      const kept = await connect(${JSON.stringify(url)}, options);
      {
        await using scoped = await connect(${JSON.stringify(url)}, options);
        await scoped.cdp.send("Browser.getVersion");
      }
      const version = await kept.cdp.send("Browser.getVersion");
      console.log(JSON.stringify({ product: version.product }));
      await kept.close();
    `,
      );
      assert.equal(result.code, 0, result.stderr);
      assert.match(JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "").product, /Chrome/);
    });
  },
);
