import { test } from "node:test";
import assert from "node:assert/strict";
import * as api from "../src/index.js";

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
];

test("package entrypoint exports the new public surfaces", () => {
  for (const name of FUNCTION_EXPORTS) {
    assert.equal(typeof api[name], "function", name);
  }
  assert.equal(typeof api.DEVICE_PRESETS, "object");
  assert.ok(api.DEVICE_PRESETS && !Array.isArray(api.DEVICE_PRESETS));
});
