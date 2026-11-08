import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { listBrowsers } from "../src/bsk/connect.ts";
import { bskDoctor } from "../src/bsk/onboard.ts";

test("listBrowsers returns lists and defaults nullish status fields to an empty list", async () => {
  for (const browsers of [null, undefined, [], [{ browser_name: "test" }]]) {
    const client = { call: async () => ({ browsers }) };
    const result: unknown[] = await listBrowsers(client);
    assert.deepEqual(result, browsers ?? []);
  }
});

test("listBrowsers rejects malformed lists at its public array boundary", async () => {
  for (const browsers of [{ unavailable: true }, "starting", 0]) {
    const client = { call: async () => ({ browsers }) };
    await assert.rejects(listBrowsers(client), TypeError);
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
