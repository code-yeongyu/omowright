import { test } from "node:test";
import assert from "node:assert/strict";
import { BskSession } from "../src/bsk/session.ts";
import { BskRpcError } from "../src/bsk/ipc-client.ts";
import { stubClient } from "./fixtures/bsk-stub-client.ts";
import type { StubReply } from "./fixtures/bsk-stub-client.ts";

// Measured on a connected BrowserSkill 0.5.0 extension (6 of 6 session starts that navigated at once): the
// extension lets a context-free first navigate through only while the agent-created tab is still an initial blank
// with no pending URL (ext-v0.5.0 apps/extension/src/cooperation/controller.ts, bootstrap()). Caught mid-load it
// refuses with this error and sends nothing. tool.wait_for_navigation waits on the tab's own pendingUrl, and once it
// reached "load" the same navigate passed in every run.
const bootstrapRefusal = (effectState = "none") =>
  new BskRpcError("permission_denied", "The initial task tab changed; synchronize before acting", {
    effect_state: effectState,
    reason: "cooperation_sync_required",
  });
const arrived = { tab_id: 7, url: "https://example.com/", final_url: "https://example.com/", reached: "load" };
const taskTab = (url: string) => ({ tabs: [{ tab_id: 7, active: true, scope: "agent", url }] });

function refusedOnce(replies: Record<string, StubReply> = {}) {
  return stubClient({
    "tool.navigate": (_params, count) => {
      if (count === 1) throw bootstrapRefusal();
      return arrived;
    },
    "tool.wait_for_navigation": { tab_id: 7, reached: "load" },
    "tool.tab_list": taskTab("about:blank"),
    ...replies,
  });
}

test("a session's first navigate refused by the initial-tab bootstrap waits for the tab to settle and is sent once more", async () => {
  const client = refusedOnce();
  const session = new BskSession(client, { sessionId: "abcd" });

  assert.deepEqual(await session.navigate("https://example.com/", { waitUntil: "load" }), arrived);
  assert.deepEqual(
    client.calls.map(({ method, params }) => [method, params]),
    [
      ["tool.navigate", { session_id: "abcd", url: "https://example.com/", wait_until: "load" }],
      ["tool.wait_for_navigation", { session_id: "abcd", wait_until: "load", timeout_ms: 10_000 }],
      ["tool.tab_list", { session_id: "abcd", scope: "agent" }],
      ["tool.navigate", { session_id: "abcd", url: "https://example.com/", wait_until: "load" }],
    ],
  );
});

test("first-navigate recovery gives up without re-sending when the task tab is not an initial blank, naming its state", async () => {
  const cases: Array<[string, Record<string, StubReply>, RegExp]> = [
    [
      "the tab moved on",
      { "tool.tab_list": taskTab("https://other.example/") },
      /tab 7 is at https:\/\/other\.example\//,
    ],
    [
      "the tab never settled",
      { "tool.wait_for_navigation": { tab_id: 7, reached: "timeout", error_text: "timed out" } },
      /wait_for_navigation reached "timeout"/,
    ],
  ];
  for (const [name, replies, names] of cases) {
    const client = refusedOnce(replies);
    const session = new BskSession(client, { sessionId: "abcd" });
    await assert.rejects(
      session.navigate("https://example.com/"),
      (error) =>
        error instanceof BskRpcError &&
        error.code === "permission_denied" &&
        /The initial task tab changed/.test(error.message) &&
        names.test(error.message),
      name,
    );
    assert.equal(client.calls.filter((c) => c.method === "tool.navigate").length, 1, `${name}: sent only once`);
  }
});

test("a bootstrap-shaped refusal is returned untouched unless it is the session's first page action with no effect", async () => {
  const cases: Array<[string, (session: BskSession) => Promise<unknown>, BskRpcError]> = [
    [
      "after an earlier page action",
      async (session) => {
        await session.hover("a");
        return session.navigate("https://example.com/");
      },
      bootstrapRefusal(),
    ],
    ["effect unknown", (session) => session.navigate("https://example.com/"), bootstrapRefusal("unknown")],
    [
      "caller sent a context",
      (session) => session.navigate("https://example.com/", { context: "ctx-1" }),
      bootstrapRefusal(),
    ],
    [
      "an ordinary sync refusal",
      (session) => session.navigate("https://example.com/"),
      new BskRpcError("permission_denied", "This action requires the context returned by the latest cooperate sync", {
        effect_state: "none",
        reason: "cooperation_sync_required",
      }),
    ],
  ];
  for (const [name, act, refusal] of cases) {
    const client = stubClient({ "tool.navigate": refusal, "tool.hover": {} });
    const session = new BskSession(client, { sessionId: "abcd" });
    await assert.rejects(act(session), (error) => error === refusal, name);
    assert.deepEqual(
      client.calls.map((c) => c.method).filter((m) => m !== "tool.hover"),
      ["tool.navigate"],
      name,
    );
  }
});
