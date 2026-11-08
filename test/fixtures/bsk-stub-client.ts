import assert from "node:assert/strict";

export type StubParams = Record<string, unknown>;

export interface StubCall {
  method: string;
  params: StubParams;
  options: StubParams | undefined;
}

// Method syntax keeps the parameter bivariant, so a reply may annotate the params it reads.
export type StubReplyFunction = { reply(params: StubParams, count: number): unknown }["reply"];
export type StubReply = StubReplyFunction | Error | object | string | number | boolean | null | undefined;

export interface StubClient {
  calls: StubCall[];
  call(method: string, params: StubParams, options?: StubParams): Promise<unknown>;
}

// A recording BrowserSkill IPC client for BskSession tests: answers each method from `replies`.
export function stubClient(replies: Record<string, StubReply> = {}): StubClient {
  const calls: StubCall[] = [];
  return {
    calls,
    async call(method, params, options) {
      calls.push({ method, params, options });
      const reply = replies[method];
      if (typeof reply === "function") return reply(params, calls.length);
      if (reply instanceof Error) throw reply;
      return reply ?? {};
    },
  };
}

export function lastCall(client: StubClient): StubCall {
  const call = client.calls.at(-1);
  assert.ok(call, "the stub client recorded no call");
  return call;
}
