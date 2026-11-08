import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parse } from "acorn";
import {
  BROWSER_ENGINES,
  EngineOrderViolation,
  NoBrowserEngine,
  assertEngineChoice,
  engineOrder,
  enginePlan,
} from "../src/engine-order.js";
import {
  BROWSER_ENGINE_ADAPTERS,
  connectRankedBrowser,
} from "../src/connect-ranked.js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

const CONNECTORS = new Set(["connectBrowserSkill", "connectCloakProfile"]);
const WALKER = "src/connect-ranked.js";
const ASIDE_LINK = path.join(".local", "bin", "aside");

test("the ranked order is aside, then the local browser through bsk, then CloakBrowser", () => {
  assert.deepEqual(engineOrder(), ["aside", "bsk", "cloakbrowser"]);
  assert.deepEqual(BROWSER_ENGINES.map((engine) => engine.tier), [0, 1, 2]);
});

test("the first-ranked engine needs no reason and a lower one always does", () => {
  assert.equal(assertEngineChoice("aside").id, "aside");
  assert.throws(() => assertEngineChoice("bsk"), EngineOrderViolation);
  assert.throws(() => assertEngineChoice("cloakbrowser"), /aside \(tier 0\).*rank above it/);
});

test("a fallback reason reaches its own tier and no further", () => {
  assert.equal(assertEngineChoice("bsk", { fallbackReason: "aside-unavailable" }).id, "bsk");
  assert.throws(
    () => assertEngineChoice("cloakbrowser", { fallbackReason: "aside-unavailable" }),
    /reaches tier 1; cloakbrowser is tier 2/,
  );
  assert.equal(
    assertEngineChoice("cloakbrowser", { fallbackReason: "need-isolated-profile" }).tier,
    2,
  );
});

test("an unknown engine or reason names the valid set instead of guessing", () => {
  assert.throws(() => assertEngineChoice("playwright"), /the ranked list is aside > bsk > cloakbrowser/);
  assert.throws(() => enginePlan({ fallbackReason: "because" }), /unknown fallbackReason "because"/);
});

test("a plan without a reason is the whole list and a permitted reason starts at its tier", () => {
  assert.deepEqual(enginePlan().map((engine) => engine.id), ["aside", "bsk", "cloakbrowser"]);
  assert.deepEqual(enginePlan({ fallbackReason: "aside-unavailable" }).map((e) => e.id), ["bsk", "cloakbrowser"]);
  assert.deepEqual(enginePlan({ fallbackReason: "need-isolated-profile" }).map((e) => e.id), ["cloakbrowser"]);
});

function recordingAdapters({ available = {}, connectFails = new Set() } = {}) {
  const calls = [];
  const adapters = Object.fromEntries(
    engineOrder().map((id) => [
      id,
      {
        probe: async () => {
          calls.push(`${id}:probe`);
          const ok = available[id] ?? true;
          return { available: ok, reason: ok ? null : `${id} is not set up here` };
        },
        connect: async () => {
          calls.push(`${id}:connect`);
          if (connectFails.has(id)) throw new Error(`${id} refused`);
          return { engine: id };
        },
      },
    ]),
  );
  return { adapters, calls };
}

test("the walk connects to the highest-ranked available engine and records what it skipped", async () => {
  const { adapters, calls } = recordingAdapters({ available: { aside: false } });
  const result = await connectRankedBrowser({ adapters });
  assert.equal(result.engine, "bsk");
  assert.deepEqual(calls, ["aside:probe", "bsk:probe", "bsk:connect"]);
  assert.deepEqual(result.skipped, [
    { engine: "aside", code: "unavailable", detail: "aside is not set up here" },
  ]);
});

test("a declared fallback reason is not probed above its tier", async () => {
  const { adapters, calls } = recordingAdapters();
  const result = await connectRankedBrowser({ adapters, fallbackReason: "need-isolated-profile" });
  assert.equal(result.engine, "cloakbrowser");
  assert.deepEqual(calls, ["cloakbrowser:probe", "cloakbrowser:connect"]);
});

test("a probe that throws falls through instead of ending the walk", async () => {
  const { adapters, calls } = recordingAdapters();
  adapters.aside.probe = async () => {
    calls.push("aside:probe");
    throw new Error("aside --version exited -1");
  };
  const result = await connectRankedBrowser({ adapters });
  assert.equal(result.engine, "bsk");
  assert.equal(result.skipped[0].detail, "aside --version exited -1");
});

test("a failed connect is recorded and the next engine is tried", async () => {
  const { adapters } = recordingAdapters({ connectFails: new Set(["aside"]) });
  const result = await connectRankedBrowser({ adapters });
  assert.equal(result.engine, "bsk");
  assert.deepEqual(
    result.skipped.map((entry) => [entry.engine, entry.code]),
    [["aside", "connect-failed"]],
  );
});

test("nothing reachable reports every engine it tried, in rank order", async () => {
  const { adapters } = recordingAdapters({ available: { aside: false, bsk: false, cloakbrowser: false } });
  await assert.rejects(
    connectRankedBrowser({ adapters }),
    (error) => {
      assert.equal(error instanceof NoBrowserEngine, true);
      assert.deepEqual(error.skipped.map((entry) => entry.engine), ["aside", "bsk", "cloakbrowser"]);
      assert.match(error.message, /tried aside > bsk > cloakbrowser/);
      return true;
    },
  );
});

test("the rank-0 probe reports the installation state before it reports the rank", async () => {
  const missing = await BROWSER_ENGINE_ADAPTERS.aside.probe({ exists: () => false, envPath: "" });
  assert.equal(missing.available, false);
  assert.equal(missing.state, "absent");
  assert.match(missing.reason, /aside install: absent/);

  const signedOut = await BROWSER_ENGINE_ADAPTERS.aside.probe({
    envPath: "",
    exists: (candidate) => candidate.endsWith(ASIDE_LINK),
    runProcess: async () => ({ code: 0, signal: null, timedOut: false, stdout: "not signed in\n[error | 9ms]", stderr: "" }),
  });
  assert.equal(signedOut.available, false);
  assert.equal(signedOut.needsSignIn, true);

  const usable = await BROWSER_ENGINE_ADAPTERS.aside.probe({
    envPath: "",
    exists: (candidate) => candidate.endsWith(ASIDE_LINK),
    runProcess: async () => ({ code: 0, signal: null, timedOut: false, stdout: "Example Domain\n[ok | 2317ms]", stderr: "" }),
  });
  assert.equal(usable.available, true);
  assert.ok(usable.bin.endsWith(ASIDE_LINK));
  assert.equal(usable.ms, 2317);
});

async function listSources(dir = path.join(repoRoot, "src"), out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await listSources(full, out);
    else if (entry.name.endsWith(".js")) out.push(full);
  }
  return out;
}

function scanEngineCalls(source) {
  const found = { connectors: [], guarded: false };
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (node.type === "CallExpression" && node.callee?.type === "Identifier") {
      const name = node.callee.name;
      if (CONNECTORS.has(name)) found.connectors.push(name);
      if (name === "assertEngineChoice" || name === "connectRankedBrowser") found.guarded = true;
    }
    for (const value of Object.values(node)) visit(value);
  };
  visit(parse(source, { ecmaVersion: "latest", sourceType: "module" }));
  return found;
}

// Architecture contract: the ranking is only load-bearing if a call site cannot
// reach a lower-tier connector without asking the order first.
test("no source file reaches a lower-ranked engine without the order check", async () => {
  const offenders = [];
  for (const file of await listSources()) {
    const relative = path.relative(repoRoot, file).split(path.sep).join("/");
    if (relative === WALKER) continue;
    const { connectors, guarded } = scanEngineCalls(await readFile(file, "utf8"));
    if (connectors.length > 0 && !guarded) offenders.push(`${relative}: ${connectors.join(", ")}`);
  }
  assert.deepEqual(offenders, []);
});

test("the order check fires on an unguarded call and passes a guarded one", () => {
  const unguarded = `import { connectCloakProfile } from "./cloak-profile.js";\nawait connectCloakProfile();`;
  assert.deepEqual(scanEngineCalls(unguarded), { connectors: ["connectCloakProfile"], guarded: false });
  const guarded = `assertEngineChoice("cloakbrowser", { fallbackReason: "need-isolated-profile" });\nawait connectCloakProfile();`;
  assert.equal(scanEngineCalls(guarded).guarded, true);
});
