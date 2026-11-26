import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { BskSession } from "../src/bsk/session.ts";
import { BSK_CLI_VERSION } from "../src/bsk/install-cli.ts";
import { stubClient } from "./fixtures/bsk-stub-client.ts";
import { field } from "./fixtures/read-field.ts";

// Protocol contract: src/bsk speaks the wire protocol of the BrowserSkill CLI release it pins. The schemas are
// vendored from that release by scripts/bsk-protocol.ts, so this test fails when a typed call sends a method or key
// the pinned protocol does not define, and when a pin bump brings an upstream method nobody has decided about.
const SCHEMA_DIR = new URL("../src/bsk/protocol/schema/", import.meta.url);
const PARAMS_FILE = /^tool_(\w+)_params\.json$/;

// Upstream tool methods with no typed call; a caller reaches them through session.tool(name, params).
const UNTYPED = [
  "debug",
  "dialog_accept",
  "dialog_dismiss",
  // tool_dialog_handle_params.json is the params schema dialog_accept and dialog_dismiss share, not a method.
  "dialog_handle",
  "dialog_status",
  "download",
  // tool_operation_params.json is the params schema operation_await and operation_cancel share, not a method.
  "operation",
  "operation_await",
  "operation_cancel",
  "record_await",
  "record_start",
  "record_stop",
  // The daemon's own session.start / session.stop (connectBrowserSkill, BskSession.stop) translate to these.
  "session_start",
  "session_stop",
  "upload",
  "video",
  "wait_ms",
];

function schemaProperties(method: string): string[] {
  const schema: unknown = JSON.parse(readFileSync(new URL(`tool_${method}_params.json`, SCHEMA_DIR), "utf8"));
  const properties = field(schema, "properties");
  assert.ok(properties && typeof properties === "object", `tool_${method}_params.json has no properties`);
  return Object.keys(properties);
}

// Every option a typed call accepts must be filled in, so a new option cannot skip the schema check below.
type Every<T> = Required<NonNullable<T>>;
const every = <T>(options: Every<T>): Every<T> => options;
type Options<K extends keyof BskSession, I extends number> = BskSession[K] extends (...args: infer A) => unknown
  ? A[I]
  : never;

const shared = {
  context: "ctx-1",
  observation: "obs-1",
  expect: [{ target: "a", field: "text", equals: "x" }],
  dependsOn: ["e1"],
} as const;
const timing = { tabId: 7, timeoutMs: 1000 };
const CALLS: Record<string, (session: BskSession) => Promise<unknown>> = {
  cooperate: (s) =>
    s.cooperate(
      "sync",
      every<Options<"cooperate", 1>>({ tabId: 7, timeoutMs: 10, maxTokens: 10, controlPolicy: "strict" }),
    ),
  navigate: (s) =>
    s.navigate("https://example.com/", every<Options<"navigate", 1>>({ ...shared, ...timing, waitUntil: "load" })),
  back: (s) => s.back(every<Options<"back", 0>>({ ...shared, ...timing, waitUntil: "load" })),
  forward: (s) => s.forward(every<Options<"forward", 0>>({ ...shared, ...timing, waitUntil: "load" })),
  reload: (s) => s.reload(every<Options<"reload", 0>>({ ...shared, ...timing, waitUntil: "load", hard: true })),
  observe: (s) =>
    s.observe(
      every<Options<"observe", 0>>({
        ...shared,
        cursor: "c1",
        tabId: 7,
        maxDepth: 3,
        maxTokens: 10,
        debugSurfaces: true,
        probeHover: true,
      }),
    ),
  snapshot: (s) => s.snapshot(every<Options<"snapshot", 0>>({ tabId: 7, maxDepth: 3, maxTokens: 10 })),
  getHtml: (s) => s.getHtml(every<Options<"getHtml", 0>>({ ref: "e1", tabId: 7, maxBytes: 100 })),
  screenshot: async (s) => {
    const all = every<Options<"screenshot", 0>>({ ...shared, ...timing, ref: "e1", fullPage: false, scope: "follow" });
    await s.screenshot(all);
    return s.screenshot({ ...all, fullPage: true });
  },
  click: async (s) => {
    const all = every<Options<"click", 1>>({ ...shared, ...timing, button: "left", clickCount: 2, modifiers: ["alt"] });
    await s.click("e1", all);
    return s.click({ captureId: "cap-1", x: 1, y: 2 }, all);
  },
  hover: (s) => s.hover("e1", every<Options<"hover", 1>>({ ...shared, ...timing, modifiers: ["alt"], settleMs: 5 })),
  focus: (s) => s.focus("e1", every<Options<"focus", 1>>({ ...shared, ...timing })),
  blur: (s) => s.blur("e1", every<Options<"blur", 1>>({ ...shared, ...timing })),
  fill: (s) => s.fill("#q", "text", every<Options<"fill", 2>>({ ...shared, ...timing, clearBefore: true })),
  press: (s) =>
    s.press(
      "Enter",
      every<Options<"press", 1>>({ ...shared, ...timing, target: "e1", modifiers: ["ctrl"], holdMs: 5 }),
    ),
  select: (s) => s.select("#s", ["a"], every<Options<"select", 2>>({ ...shared, ...timing })),
  scrollTo: (s) => s.scrollTo("e1", every<Options<"scrollTo", 1>>({ ...shared, ...timing })),
  wheel: (s) =>
    s.wheel(
      every<Options<"wheel", 0>>({ ...shared, ...timing, deltaX: 1, deltaY: 2, target: "e1", modifiers: ["shift"] }),
    ),
  evaluate: (s) =>
    s.evaluate(
      "1",
      every<Options<"evaluate", 1>>({
        ...shared,
        ...timing,
        awaitPromise: true,
        returnByValue: true,
        unverified: true,
      }),
    ),
  read: (s) =>
    s.read(
      "a",
      every<Options<"read", 1>>({
        tabId: 7,
        timeoutMs: 100,
        context: "ctx-1",
        fields: [{ key: "t", read: "text" }],
        maxNodes: 1,
        maxBytes: 1024,
      }),
    ),
  extract: (s) =>
    s.extract(
      "list",
      every<Options<"extract", 1>>({
        ...timing,
        target: "ul",
        itemSelector: "li",
        fields: [{ key: "t", read: "text", selector: "a" }],
        maxRows: 1,
        maxColumns: 1,
        maxBytes: 1024,
        targetId: "t1",
      }),
    ),
  waitForElement: (s) =>
    s.waitForElement("a", every<Options<"waitForElement", 1>>({ ...timing, state: "visible", pollMs: 50 })),
  drag: (s) =>
    s.drag(
      { selector: "#a" },
      every<Options<"drag", 1>>({
        ...shared,
        ...timing,
        target: { selector: "#b" },
        delta: { x: 1, y: 2 },
        mode: "press-move-release",
        button: "left",
        durationMs: 10,
        holdMs: 5,
        modifiers: ["alt"],
      }),
    ),
  tabList: (s) => s.tabList(every<Options<"tabList", 0>>({ scope: "agent" })),
  tabCreate: (s) =>
    s.tabCreate(every<Options<"tabCreate", 0>>({ url: "https://example.com/", active: true, index: 0 })),
  tabClose: (s) => s.tabClose(7, every<Options<"tabClose", 1>>(shared)),
  tabSelect: (s) => s.tabSelect(7),
  tabBorrow: (s) => s.tabBorrow(7, every<Options<"tabBorrow", 1>>({ confirmationTimeoutMs: 10 })),
  tabReturn: (s) => s.tabReturn(7),
  waitForNavigation: (s) =>
    s.waitForNavigation(every<Options<"waitForNavigation", 0>>({ ...timing, waitUntil: "load" })),
  requestHelp: (s) =>
    s.requestHelp(
      every<Options<"requestHelp", 0>>({
        ...timing,
        prompt: "p",
        title: "t",
        targets: ["e1"],
        completionCriteria: { stable_for_ms: 10 },
      }),
    ),
  console: (s) =>
    s.console(every<Options<"console", 0>>({ tabId: 7, since: 1, limit: 1, maxTextChars: 10, includeStack: true })),
  network: (s) => s.network(every<Options<"network", 0>>({ tabId: 7, since: 1, limit: 1, maxTextChars: 10 })),
  resize: (s) => s.resize(800, 600, every<Options<"resize", 2>>(shared)),
  emulate: (s) => s.emulate(every<Options<"emulate", 0>>({ ...shared, tabId: 7, off: false, overrides: {} })),
};

async function sentByTypedCalls(): Promise<Map<string, Set<string>>> {
  const client = stubClient({
    "tool.screenshot": { image_base64: "", width: 1, height: 1, format: "png", tab_id: 7 },
    "tool.screenshot_full_page": { capture_id: "cap-1", width: 1, height: 1, format: "png", byte_size: 0 },
    "tool.screenshot_read": { data_base64: "", eof: true },
  });
  const session = new BskSession(client, { sessionId: "abcd" });
  for (const call of Object.values(CALLS)) await call(session);
  const sent = new Map<string, Set<string>>();
  for (const { method, params } of client.calls) {
    const keys = sent.get(method) ?? new Set<string>();
    for (const key of Object.keys(params)) keys.add(key);
    sent.set(method, keys);
  }
  return sent;
}

test("the vendored protocol is the one the pinned BrowserSkill CLI speaks", () => {
  const manifest: unknown = JSON.parse(readFileSync(new URL("../manifest.json", SCHEMA_DIR), "utf8"));
  assert.equal(field(manifest, "tag"), `cli-v${BSK_CLI_VERSION}`, "run `bun scripts/bsk-protocol.ts sync`");
});

test("every typed BskSession call is exercised with every option it accepts", () => {
  const typed = Object.getOwnPropertyNames(BskSession.prototype).filter(
    (name) => !["constructor", "client", "stopped", "tool", "stop"].includes(name),
  );
  assert.deepEqual(typed.toSorted(), Object.keys(CALLS).toSorted());
});

test("every method and key a typed call sends is defined by the pinned protocol schema", async () => {
  for (const [method, keys] of await sentByTypedCalls()) {
    const name = method.replace(/^tool\./, "");
    assert.notEqual(name, method, `${method} is not a tool method`);
    const known = schemaProperties(name);
    const unknown = [...keys].filter((key) => !known.includes(key));
    assert.deepEqual(unknown, [], `${method} sends keys its schema does not define`);
  }
});

test("upstream tool methods without a typed call are exactly the decided list", async () => {
  const sent = new Set([...(await sentByTypedCalls()).keys()].map((method) => method.replace(/^tool\./, "")));
  const catalog = readdirSync(SCHEMA_DIR).flatMap((file) => PARAMS_FILE.exec(file)?.slice(1, 2) ?? []);
  assert.deepEqual(catalog.filter((method) => !sent.has(method)).toSorted(), UNTYPED.toSorted());
});
