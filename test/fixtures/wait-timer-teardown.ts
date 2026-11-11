import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { connectPipe, createAgentTabs } from "../../src/index.ts";
import { removeTreeSync } from "./remove-tree.ts";

// Track even unref'd timers: a settled wait must dispose its deadline, not
// merely hide it from the event loop. Isolation keeps other tests' timers out.
const schedule = globalThis.setTimeout;
const cancel = globalThis.clearTimeout;
type TimerHandle = ReturnType<typeof schedule>;
const timers = new Map<
  TimerHandle | Parameters<typeof cancel>[0],
  { ms: number | undefined; stack: string | undefined }
>();
Reflect.set(globalThis, "setTimeout", (fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
  const stack = new Error().stack;
  const timer = schedule(() => {
    timers.delete(timer);
    fn(...args);
  }, ms);
  timers.set(timer, { ms, stack });
  return timer;
});
Reflect.set(globalThis, "clearTimeout", (timer: Parameters<typeof cancel>[0]) => {
  timers.delete(timer);
  return cancel(timer);
});

const profile = mkdtempSync(path.join(tmpdir(), "omowright-wait-timers-"));
let connection: Awaited<ReturnType<typeof connectPipe>> | undefined;
try {
  connection = await connectPipe({
    browserPath: process.env["SHELL_BIN"],
    browserArgs: ["--headless", "--no-first-run", `--user-data-dir=${profile}`],
    storageRoot: profile,
  });
  const page = (await createAgentTabs(connection).create("about:blank")).page;
  await page.goto("data:text/html,<main>A local document with enough text for readiness.</main>");
  for (const state of ["interactive", "stable", "load", "domcontentloaded"] as const) {
    await page.waitForLoadState(state, { timeout: 5000 });
  }
  // A missing body cannot pass the readiness probe, regardless of scheduling.
  // Mutations or a blocked load alone can still resolve at the quiet-window cap.
  await page.evaluate(() => document.body.remove());
  await assert.rejects(page.waitForLoadState("interactive", { timeout: 100 }), /Timed out/);
  // The readiness deadline includes 1000 ms of grace. Ignore in-flight CDP
  // cleanup here; the final assertion covers those timers after teardown.
  assert.deepEqual(
    [...timers.values()].filter(({ ms }) => ms === 1100),
    [],
    "readiness deadline outlived the rejected wait",
  );
  assert.equal(await page.waitForFunction(() => true), true);
  await assert.rejects(
    page.waitForFunction(() => false, undefined, { timeout: 20 }),
    /timed out/,
  );
  await page.close();
  await connection.close();
  assert.deepEqual([...timers.values()], [], "timers outlived settled waits or teardown");
} finally {
  await connection?.close();
  for (const timer of timers.keys()) cancel(timer);
  Reflect.set(globalThis, "setTimeout", schedule);
  Reflect.set(globalThis, "clearTimeout", cancel);
  removeTreeSync(profile);
}
