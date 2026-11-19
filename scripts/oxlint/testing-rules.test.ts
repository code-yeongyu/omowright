import assert from "node:assert/strict";
import { before, describe, test } from "node:test";

import { type Finding, lintFixtures } from "./rule-findings.ts";

type Case = readonly [name: string, source: string];

const sleepCode = "omowright-testing(no-fixed-sleep)";
const flakeCode = "omowright-testing(no-flake-masking)";

const sleeps: readonly Case[] = [
  [
    "setTimeout promise with a block body",
    "test('x', async () => { await new Promise((resolve) => { setTimeout(resolve, 250); }); });",
  ],
  [
    "setTimeout promise with an expression body",
    "test('x', async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });",
  ],
  [
    "globalThis.setTimeout",
    "test('x', async () => { await new Promise<void>((done) => globalThis.setTimeout(() => done(), 31_000)); });",
  ],
  [
    "timers/promises import aliased to sleep",
    'import { setTimeout as sleep } from "node:timers/promises"; test("x", async () => { await sleep(500); });',
  ],
  [
    "bare timers/promises import",
    'import { setTimeout } from "timers/promises"; afterEach(async () => { await setTimeout(20); });',
  ],
  ["scheduler.wait in a hook", "beforeEach(async () => { await scheduler.wait(10); });"],
  ["Bun.sleep", "test('x', async () => { await Bun.sleep(100); });"],
  ["test.each modifier", "test.each([1])('x %s', async () => { await scheduler.wait(1); });"],
  ["test.concurrent modifier", "test.concurrent('x', async () => { await scheduler.wait(1); });"],
  [
    "it.skipIf modifier with a function expression",
    "it.skipIf(ci)('x', async function () { await scheduler.wait(1); });",
  ],
];

const signals: readonly Case[] = [
  ["awaiting the operation itself", "test('x', async () => { await operation(); });"],
  ["a withResolvers promise", "test('x', async () => { const r = Promise.withResolvers(); await r.promise; });"],
  [
    "a sleep after fake timers",
    "test('x', async () => { vi.useFakeTimers(); await new Promise((resolve) => { setTimeout(resolve, 250); }); });",
  ],
  ["a sleep outside any test body", "serve(async () => { await scheduler.wait(10); return new Response(); });"],
  [
    "a sleep inside a helper the test awaits",
    "async function backoff(attempt) { await scheduler.wait(2 ** attempt); } test('x', async () => { await backoff(1); });",
  ],
  [
    "a timeout raced against real work",
    "test('x', async () => { await Promise.race([work, new Promise((resolve) => { setTimeout(() => resolve('pending'), 0); })]); });",
  ],
  [
    "a promise with a second scheduled statement",
    "test('x', async () => { await new Promise((resolve) => { setTimeout(resolve, 10); queueMicrotask(resolve); }); });",
  ],
  [
    "a cancelled timer without an await",
    "test('x', async () => { const timer = setTimeout(cancel, 10); await work(); clearTimeout(timer); });",
  ],
];

const flagged: readonly Case[] = [
  ["a test retry option", 'test("loads", { retry: 2 }, async () => {});'],
  ["an it retry option", 'it("loads", { retry: 2 }, async () => {});'],
  ["a describe retry option", 'describe("loader", { retry: 3 }, () => {});'],
  ["a test.concurrent retry option", 'test.concurrent("loads", { retry: 1 }, async () => {});'],
  ["a test.each retry option", 'test.each([1, 2])("loads %i", { retry: 1 }, async () => {});'],
  ["a retry option in the third argument", 'test("loads", async () => {}, { retry: 2 });'],
  ["a vi.setConfig retry", "vi.setConfig({ retry: 2 });"],
  ["a defineConfig test retry", "export default defineConfig({ test: { retry: 2 } });"],
  [
    "a nested projects retry",
    "export default defineConfig({ test: { projects: [{ test: { name: 'node', retry: 1 } }] } });",
  ],
  ["a positional timeout literal", 'test("loads", async () => {}, 60_000);'],
  ["a positional timeout expression", 'test("loads", async () => {}, 2 * 60_000);'],
  ["a positional timeout identifier", 'test("loads", async () => {}, LONG_TIMEOUT);'],
  ["a timeout option in the second argument", 'test("loads", { timeout: 60_000 }, async () => {});'],
  ["a timeout option in the third argument", 'test("loads", async () => {}, { timeout: 60_000 });'],
  ["a describe timeout option", 'describe("loader", { timeout: 60_000 }, () => {});'],
  ["a vi.setConfig testTimeout", "vi.setConfig({ testTimeout: 45_000 });"],
  ["a vi.setConfig hookTimeout", "vi.setConfig({ hookTimeout: 45_000 });"],
];

const allowed: readonly Case[] = [
  ["a plain test", 'test("loads", async () => {});'],
  ["an unrelated option", 'test("loads", { tags: ["slow"] }, async () => {});'],
  ["a concurrent option", 'test("loads", { concurrent: true }, function load() {});'],
  ["a beforeAll timeout", "beforeAll(async () => { await server.listen(); }, 60_000);"],
  ["an afterAll timeout", "afterAll(() => server.close(), 30_000);"],
  ["an expect.poll timeout", "await expect.poll(() => count(), { timeout: 5_000 }).toBe(1);"],
  ["a vi.waitFor timeout", "await vi.waitFor(() => expect(count()).toBe(1), { timeout: 5_000 });"],
  ["a non-test retry option", "const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });"],
  ["a queue retry call", "queue.retry({ delaySeconds: 30 });"],
  ["a policy retry object", "const policy = { retry: { maxAttempts: 1 } };"],
  [
    "a defineConfig default timeout",
    "export default defineConfig({ test: { testTimeout: 30_000, hookTimeout: 60_000 } });",
  ],
  ["a vi.setConfig fakeTimers", "vi.setConfig({ fakeTimers: { now: 0 } });"],
];

// One oxlint run for every fixture in this file, in `before`; each test reads its own case's findings.
const groups = [sleeps, signals, flagged, allowed] as const;
let results: Finding[][] = [];
before(() => {
  results = lintFixtures(groups.flat().map(([, source]) => source));
});
const codesOf = (group: readonly Case[], index: number): string[] => {
  const offset = groups.slice(0, groups.indexOf(group)).reduce((sum, g) => sum + g.length, 0);
  return (results[offset + index] ?? []).map((finding) => finding.code);
};

describe("no-fixed-sleep through the ratchet lint configuration", () => {
  sleeps.forEach(([name], index) => {
    test(`reports ${name}`, () => {
      assert.deepEqual(codesOf(sleeps, index), [sleepCode]);
    });
  });
  signals.forEach(([name], index) => {
    test(`allows ${name}`, () => {
      assert.deepEqual(codesOf(signals, index), []);
    });
  });
});

describe("no-flake-masking through the ratchet lint configuration", () => {
  flagged.forEach(([name], index) => {
    test(`reports ${name}`, () => {
      assert.deepEqual(codesOf(flagged, index), [flakeCode]);
    });
  });
  allowed.forEach(([name], index) => {
    test(`allows ${name}`, () => {
      assert.deepEqual(codesOf(allowed, index), []);
    });
  });
});
