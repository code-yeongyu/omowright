import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { listBrowsers } from "../src/bsk/connect.ts";
import { bskDoctor } from "../src/bsk/onboard.ts";

test("listBrowsers preserves non-null status values until a consumer parses them", async () => {
  for (const browsers of [null, undefined, [], { unavailable: true }, "starting", 0]) {
    const client = { call: async () => ({ browsers }) };
    assert.deepEqual(await listBrowsers(client), browsers ?? []);
  }
});

test("bskDoctor does not misreport a malformed browser list as an offline daemon", async () => {
  const client = { call: async () => ({ browsers: { unavailable: true }, sessions: [] }) };
  await assert.rejects(
    bskDoctor({
      client,
      platform: "darwin",
      home: tmpdir(),
      bskBin: null,
      exists: () => false,
      signals: { defaultBrowser: null, running: [], lastUsed: {} },
    }),
    TypeError,
  );
});
