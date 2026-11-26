import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, globSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { connectPipe, createAgentTabs } from "../src/index.ts";
import { createNetworkSnoop } from "../src/network-snoop.ts";
import { collectWhileScrolling } from "../src/scroll-collect.ts";
import type { CollectWhileScrollingResult } from "../src/scroll-collect.ts";
import { startSnoopServer } from "./fixtures/snoop-server.ts";
import type { SnoopServer } from "./fixtures/snoop-server.ts";
import { removeTreeSync } from "./fixtures/remove-tree.ts";

function findHeadlessShell() {
  const candidates = globSync(
    path.join(
      process.env["HOME"] ?? "",
      "Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-mac-arm64/chrome-headless-shell",
    ),
  );
  if (candidates.length > 0) return candidates.toSorted().at(-1);
  const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (existsSync(chrome)) return chrome;
  return null;
}

const SHELL = process.env["SHELL_BIN"] ?? findHeadlessShell();

function hasIntegerId(item: unknown): boolean {
  return typeof item === "object" && item !== null && "id" in item && Number.isInteger(item.id);
}

type LivePage = Awaited<ReturnType<ReturnType<typeof createAgentTabs>["create"]>>["page"];
type Snoop = ReturnType<typeof createNetworkSnoop>;

async function withSnoopedPage(
  server: SnoopServer,
  run: (page: LivePage, snoop: Snoop) => Promise<void>,
): Promise<void> {
  assert.ok(SHELL);
  const userDataDir = mkdtempSync(path.join(tmpdir(), "omowright-snoop-test-"));
  let connection: Awaited<ReturnType<typeof connectPipe>> | null = null;
  let snoop: Snoop | null = null;
  try {
    connection = await connectPipe({
      browserPath: SHELL,
      browserArgs: ["--headless", "--no-first-run", `--user-data-dir=${userDataDir}`],
      storageRoot: userDataDir,
    });
    const page = (await createAgentTabs(connection).create("about:blank")).page;
    snoop = createNetworkSnoop(page);
    await run(page, snoop);
  } finally {
    snoop?.dispose();
    await connection?.close();
    removeTreeSync(userDataDir);
    await server.close();
  }
}

test(
  "snoop captures live traffic and collectWhileScrolling harvests paged items",
  { skip: !SHELL && "no chromium binary found", timeout: 120_000 },
  async () => {
    const server = await startSnoopServer();
    await withSnoopedPage(server, async (page, snoop) => {
      await page.goto(server.url);

      const clicked = snoop.waitFor({ url: "/api/click" }, { timeoutMs: 20_000 });
      await page.locator("#ping").click();
      const entry = await clicked;
      assert.equal(entry.status, 200);
      assert.equal(entry.method, "GET");
      assert.equal(entry.mimeType, "application/json");
      assert.deepEqual(JSON.parse(String(entry.body)), { ok: true });

      const items: unknown[] = [];
      const generator = collectWhileScrolling(page, snoop, { minItems: 15, maxScrolls: 10, settleMs: 500 });
      let result: CollectWhileScrollingResult;
      for (;;) {
        const next = await generator.next();
        if (next.done) {
          result = next.value;
          break;
        }
        items.push(next.value);
      }
      assert.ok(items.length >= 15, `collected ${items.length} items while scrolling`);
      assert.equal(result.stoppedBecause, "minItems");
      assert.equal(result.total, items.length);
      assert.ok(result.rounds >= 1);
      assert.ok(items.every(hasIntegerId));
    });
  },
);

/** A frozen clock: armed timers fire only when the test calls advance(). */
function manualClock() {
  const timers = new Map<number, () => void>();
  let lastId = 0;
  let onArm: (() => void) | null = null;
  return {
    setTimeout(callback: () => void) {
      lastId += 1;
      timers.set(lastId, callback);
      onArm?.();
      onArm = null;
      return lastId;
    },
    clearTimeout(handle: unknown) {
      if (typeof handle === "number") timers.delete(handle);
    },
    get pending() {
      return timers.size;
    },
    armed(): Promise<void> {
      if (timers.size > 0) return Promise.resolve();
      return new Promise((resolve) => {
        onArm = resolve;
      });
    },
    advance() {
      const due = [...timers.values()];
      timers.clear();
      for (const callback of due) callback();
    },
  };
}

/** Loads the fixture, waits for page 1 to render, and drains its items from a fresh collector. */
async function collectorPastFirstPage(
  page: LivePage,
  snoop: Snoop,
  server: SnoopServer,
  clock: ReturnType<typeof manualClock>,
) {
  await page.goto(server.url);
  await page.waitForFunction(
    (count: number) => document.querySelectorAll(".item").length === count,
    server.itemsPerPage,
  );
  const generator = collectWhileScrolling(page, snoop, { scroll: "end", settleMs: 60_000, clock });
  for (let index = 0; index < server.itemsPerPage; index += 1) {
    assert.equal((await generator.next()).done, false);
  }
  return generator;
}

// Regression for #339: a round ends when its response lands, not when the settleMs timer fires.
test(
  "collectWhileScrolling yields a held page when its response arrives, with the settle timer frozen",
  { skip: !SHELL && "no chromium binary found" },
  async () => {
    const server = await startSnoopServer({ holdPage: 2 });
    await withSnoopedPage(server, async (page, snoop) => {
      const clock = manualClock();
      const generator = await collectorPastFirstPage(page, snoop, server, clock);

      let advanced = false;
      const pending = generator.next().then((next) => {
        advanced = true;
        return next;
      });
      await server.held;
      await clock.armed();
      assert.equal(advanced, false, "the generator advanced before the held page was released");

      server.release();
      const bound = AbortSignal.timeout(20_000);
      const yielded = await Promise.race([
        pending,
        new Promise<never>((_resolve, reject) =>
          bound.addEventListener("abort", () =>
            reject(Error("held page not yielded while the settle timer was frozen")),
          ),
        ),
      ]);
      assert.deepEqual(yielded, { done: false, value: { id: server.itemsPerPage + 1 } });
      await generator.return({ rounds: 0, total: 0, stoppedBecause: "maxScrolls" });
    });
  },
);

// The settleMs default bound: a response that never arrives ends each round on the timer, and two flat rounds stop.
test(
  "collectWhileScrolling ends a round without a response at settleMs and stops after two flat rounds",
  { skip: !SHELL && "no chromium binary found" },
  async () => {
    const server = await startSnoopServer({ holdPage: 2 });
    await withSnoopedPage(server, async (page, snoop) => {
      const clock = manualClock();
      const generator = await collectorPastFirstPage(page, snoop, server, clock);

      const finished = generator.next();
      await server.held;
      await clock.armed();
      clock.advance();
      await clock.armed();
      clock.advance();
      assert.deepEqual(await finished, {
        done: true,
        value: { rounds: 2, total: server.itemsPerPage, stoppedBecause: "noGrowth" },
      });
      assert.equal(clock.pending, 0);
    });
  },
);
