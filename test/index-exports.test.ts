import { test } from "node:test";
import assert from "node:assert/strict";
import * as api from "../src/index.ts";

const FUNCTION_EXPORTS = [
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
] as const satisfies ReadonlyArray<keyof typeof api>;

const CLASS_EXPORTS = [
  "BskIpcClient",
  "BskRpcError",
  "BskSession",
  "SharedConnectionError",
] as const satisfies ReadonlyArray<keyof typeof api>;

// Indexed by name through a typed view: same values and types as the namespace itself.
const surface: Pick<typeof api, (typeof FUNCTION_EXPORTS)[number] | (typeof CLASS_EXPORTS)[number]> = api;

test("package entrypoint exports the new public surfaces", () => {
  for (const name of FUNCTION_EXPORTS) {
    assert.equal(typeof surface[name], "function", name);
  }
  assert.equal(typeof api.DEVICE_PRESETS, "object");
  assert.ok(api.DEVICE_PRESETS && !Array.isArray(api.DEVICE_PRESETS));
  for (const name of CLASS_EXPORTS) {
    assert.equal(typeof surface[name], "function", name);
    assert.ok(surface[name].prototype, `${name} is a class`);
  }
  assert.equal(api.BROWSERSKILL_EXTENSION_IDS.chrome, "hhcmgoofomhgciiibhipgmgkgnoenaoi");
  assert.equal(typeof api.STORE_PAGE_URLS.edge, "string");
});
