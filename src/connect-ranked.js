import { existsSync } from "node:fs";
import { asideAvailable, connectAside } from "./aside-repl.js";
import { asidePaths, detectAsideInstall, verifyAside } from "./aside-install.js";
import { BskIpcClient } from "./bsk/ipc-client.js";
import { connectBrowserSkill, listBrowsers } from "./bsk/connect.js";
import { connectCloakProfile, findCloakBrowserPath } from "./cloak-profile.js";
import { NoBrowserEngine, enginePlan } from "./engine-order.js";

function asideBin(options = {}) {
  const paths = asidePaths({ platform: options.platform ?? process.platform });
  const detected = detectAsideInstall({ paths, exists: options.exists ?? existsSync, ...(options.envPath === undefined ? {} : { envPath: options.envPath }) });
  return { detected, bin: detected.executable ?? "aside" };
}

export const BROWSER_ENGINE_ADAPTERS = Object.freeze({
  aside: Object.freeze({
    probe: async ({ verify = true, timeoutMs, runProcess, ...options } = {}) => {
      const { detected, bin } = asideBin(options);
      if (!detected.executable) {
        return { available: false, reason: `aside install: ${detected.state}`, state: detected.state };
      }
      if (!verify) return { available: true, reason: null, bin };
      const checked = await verifyAside({ bin, ...(timeoutMs === undefined ? {} : { timeoutMs }), ...(runProcess ? { runProcess } : {}) });
      return checked.usable
        ? { available: true, reason: null, bin, ms: checked.ms }
        : {
            available: false,
            reason: `aside installed but unusable (${checked.detail})`,
            needsSignIn: checked.needsSignIn,
          };
    },
    connect: (options = {}) => connectAside({ ...options, bin: asideBin(options).bin }),
  }),
  bsk: Object.freeze({
    probe: async ({ home, env, sockPath, bskBin, waitForBrowserMs } = {}) => {
      try {
        const browsers = await listBrowsers(
          new BskIpcClient({ home, env, sockPath, bskBin, autoStart: false }),
          { waitForBrowserMs },
        );
        return browsers.length === 0
          ? { available: false, reason: "the bsk daemon is up but no browser extension is connected" }
          : { available: true, reason: null, browsers };
      } catch (error) {
        return { available: false, reason: error.message };
      }
    },
    connect: (options = {}) => connectBrowserSkill(options),
  }),
  cloakbrowser: Object.freeze({
    probe: ({ browserPath, browserRoot } = {}) => {
      try {
        const resolved = browserPath ?? process.env.CLOAKBROWSER_BIN ?? findCloakBrowserPath({ browserRoot });
        return { available: true, reason: null, browserPath: resolved };
      } catch (error) {
        return { available: false, reason: error.message };
      }
    },
    connect: (options = {}) => connectCloakProfile(options),
  }),
});

/**
 * The one "give me a browser" entry point: walks the ranked list, records why
 * each engine above the winner was skipped, and never starts below the tier the
 * caller's fallbackReason permits.
 */
export async function connectRankedBrowser({
  fallbackReason,
  adapters = BROWSER_ENGINE_ADAPTERS,
  ...options
} = {}) {
  const plan = enginePlan({ fallbackReason });
  const skipped = [];

  for (const engine of plan) {
    const adapter = adapters[engine.id];
    if (!adapter) {
      skipped.push({ engine: engine.id, code: "no-adapter", detail: "no adapter is registered for this engine" });
      continue;
    }
    const engineOptions = options[engine.id] ?? {};
    let probe;
    try {
      probe = await adapter.probe(engineOptions);
    } catch (error) {
      probe = { available: false, reason: error.message };
    }
    if (!probe?.available) {
      skipped.push({ engine: engine.id, code: "unavailable", detail: probe?.reason ?? "unavailable" });
      continue;
    }
    try {
      const session = await adapter.connect(engineOptions);
      return { engine: engine.id, tier: engine.tier, session, probe, skipped };
    } catch (error) {
      skipped.push({ engine: engine.id, code: "connect-failed", detail: error.message });
    }
  }

  throw new NoBrowserEngine(
    `no browser engine could serve this task; tried ${plan.map((engine) => engine.id).join(" > ")}: ${skipped
      .map((entry) => `${entry.engine} ${entry.code} (${entry.detail})`)
      .join("; ")}`,
    { skipped },
  );
}
