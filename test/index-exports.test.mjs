import { test } from "node:test";
import assert from "node:assert/strict";
import * as api from "../src/index.js";

const FUNCTION_EXPORTS = [
  "connectRankedBrowser",
  "assertEngineChoice",
  "engineById",
  "engineOrder",
  "enginePlan",
  "asideAvailable",
  "connectAside",
  "parseAsideRepl",
  "runAside",
  "asideAccount",
  "asidePaths",
  "detectAsideInstall",
  "ensureAside",
  "installAsideCli",
  "resolveOnPath",
  "verifyAside",
  "createNetworkSnoop",
  "collectWhileScrolling",
  "createTrace",
  "toHar",
  "reconcileFrames",
  "snapshotWithFrames",
  "normalizeDialogPolicy",
  "resolveDialogAction",
  "requestHuman",
  "describeLayers",
  "layersHeader",
  "snapshotWithLayers",
  "emulate",
  "createRoutes",
  "connectBrowserSkill",
  "listBrowsers",
  "bskSnapshot",
  "buildSnapshotExpression",
  "detectBrowsers",
  "externalExtensionEntry",
  "registerExternalExtension",
  "unregisterExternalExtension",
  "catalogBrowsers",
  "probeBrowserSignals",
  "identifyBrowser",
  "installBskCli",
  "bskDoctor",
  "bskOnboard",
  "readDaemonInfo",
  "resolveBskHome",
];

const CLASS_EXPORTS = [
  "BskIpcClient",
  "BskRpcError",
  "BskSession",
  "SharedConnectionError",
  "AsideRepl",
  "AsideReplError",
  "AsideUnavailable",
  "EngineOrderViolation",
  "NoBrowserEngine",
];

test("package entrypoint exports the new public surfaces", () => {
  for (const name of FUNCTION_EXPORTS) {
    assert.equal(typeof api[name], "function", name);
  }
  assert.equal(typeof api.DEVICE_PRESETS, "object");
  assert.ok(api.DEVICE_PRESETS && !Array.isArray(api.DEVICE_PRESETS));
  for (const name of CLASS_EXPORTS) {
    assert.equal(typeof api[name], "function", name);
    assert.ok(api[name].prototype, `${name} is a class`);
  }
  assert.equal(api.BROWSERSKILL_EXTENSION_IDS.chrome, "hhcmgoofomhgciiibhipgmgkgnoenaoi");
  assert.equal(typeof api.STORE_PAGE_URLS.edge, "string");
  assert.deepEqual(api.engineOrder(), ["aside", "bsk", "cloakbrowser"]);
  assert.equal(typeof api.BROWSER_ENGINE_ADAPTERS.aside.connect, "function");
  assert.equal(typeof api.FALLBACK_REASONS["need-isolated-profile"].means, "string");
});
