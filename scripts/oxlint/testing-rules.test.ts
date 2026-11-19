import assert from "node:assert/strict";
import { beforeAll, describe, test } from "bun:test";

import noFlakeMasking from "./no-flake-masking.ts";
import { type Finding, LINT_HOOK_BUDGET_MS, lintFixtures } from "./rule-findings.ts";

type Case = readonly [name: string, source: string];
// A flagged no-flake-masking case names the message kind it must report, read from the rule itself.
type FlakeCase = readonly [name: string, source: string, kind: keyof typeof noFlakeMasking.meta.messages];

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

const flagged: readonly FlakeCase[] = [
  ["a test retry option", 'test("loads", { retry: 2 }, async () => {});', "retry"],
  ["an it retry option", 'it("loads", { retry: 2 }, async () => {});', "retry"],
  ["a describe retry option", 'describe("loader", { retry: 3 }, () => {});', "retry"],
  ["a test.concurrent retry option", 'test.concurrent("loads", { retry: 1 }, async () => {});', "retry"],
  ["a test.each retry option", 'test.each([1, 2])("loads %i", { retry: 1 }, async () => {});', "retry"],
  ["a retry option in the third argument", 'test("loads", async () => {}, { retry: 2 });', "retry"],
  ["a vi.setConfig retry", "vi.setConfig({ retry: 2 });", "retry"],
  ["a defineConfig test retry", "export default defineConfig({ test: { retry: 2 } });", "retry"],
  [
    "a nested projects retry",
    "export default defineConfig({ test: { projects: [{ test: { name: 'node', retry: 1 } }] } });",
    "retry",
  ],
  ["a positional timeout literal", 'test("loads", async () => {}, 60_000);', "timeout"],
  ["a positional timeout expression", 'test("loads", async () => {}, 2 * 60_000);', "timeout"],
  ["a positional timeout identifier", 'test("loads", async () => {}, LONG_TIMEOUT);', "timeout"],
  ["a timeout option in the second argument", 'test("loads", { timeout: 60_000 }, async () => {});', "timeout"],
  ["a timeout option in the third argument", 'test("loads", async () => {}, { timeout: 60_000 });', "timeout"],
  ["a describe timeout option", 'describe("loader", { timeout: 60_000 }, () => {});', "timeout"],
  ["a vi.setConfig testTimeout", "vi.setConfig({ testTimeout: 45_000 });", "timeout"],
  ["a vi.setConfig hookTimeout", "vi.setConfig({ hookTimeout: 45_000 });", "timeout"],
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

// One oxlint run for every fixture in this file, in `beforeAll`; each test reads its own case's findings.
const groups = [sleeps, signals, flagged, allowed] as const;
let results: Finding[][] = [];
beforeAll(() => {
  results = lintFixtures(groups.flat().map(([, source]) => source));
}, LINT_HOOK_BUDGET_MS);
const findingsOf = (group: (typeof groups)[number], index: number): Finding[] => {
  const offset = groups.slice(0, groups.indexOf(group)).reduce((sum, g) => sum + g.length, 0);
  return results[offset + index] ?? [];
};
const codesOf = (group: readonly Case[], index: number): string[] =>
  findingsOf(group, index).map((finding) => finding.code);

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
  flagged.forEach(([name, , kind], index) => {
    test(`reports ${name} as a ${kind}`, () => {
      assert.deepEqual(findingsOf(flagged, index), [{ code: flakeCode, message: noFlakeMasking.meta.messages[kind] }]);
    });
  });
  allowed.forEach(([name], index) => {
    test(`allows ${name}`, () => {
      assert.deepEqual(codesOf(allowed, index), []);
    });
  });
});
