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
  attempt = "best",
  ...options
} = {}) {
  const plan = enginePlan({ fallbackReason });
  if (attempt === "both") return connectBoth(plan, adapters, options);
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

/**
 * `attempt: "both"`: try the two ends of the plan - the attached engine a person's own browser gives, and the engine
 * that launches its own - and report each result on its own, with the one to use and whether both answered. A single
 * success is the common case and is not a failure; a failure of one is reported, never hidden behind the other (#12805
 * decided this shape; a caller must be able to say why the second did not answer).
 */
async function connectBoth(plan, adapters, options) {
  const attached = plan[0];
  const launched = plan[plan.length - 1];
  const targets = attached.id === launched.id ? [attached] : [attached, launched];
  const results = [];
  let primary = null;
  for (const engine of targets) {
    const adapter = adapters[engine.id];
    const engineOptions = options[engine.id] ?? {};
    if (!adapter) {
      results.push({ engine: engine.id, tier: engine.tier, ok: false, code: "no-adapter", detail: "no adapter is registered for this engine" });
      continue;
    }
    const startedAt = Date.now();
    let probe;
    try {
      probe = await adapter.probe(engineOptions);
    } catch (error) {
      results.push({ engine: engine.id, tier: engine.tier, ok: false, code: "unavailable", detail: error.message, ms: Date.now() - startedAt });
      continue;
    }
    if (!probe?.available) {
      results.push({ engine: engine.id, tier: engine.tier, ok: false, code: "unavailable", detail: probe?.reason ?? "unavailable", ms: Date.now() - startedAt });
      continue;
    }
    try {
      const session = await adapter.connect(engineOptions);
      results.push({ engine: engine.id, tier: engine.tier, ok: true, probe, session, ms: Date.now() - startedAt });
      if (primary === null) primary = engine.id;
    } catch (error) {
      results.push({ engine: engine.id, tier: engine.tier, ok: false, code: "connect-failed", detail: error.message, ms: Date.now() - startedAt });
    }
  }
  if (primary === null) {
    throw new NoBrowserEngine(
      `no browser engine could serve this task; tried ${targets.map((engine) => engine.id).join(" and ")}: ${results
        .map((entry) => `${entry.engine} ${entry.code} (${entry.detail})`)
        .join("; ")}`,
      { results },
    );
  }
  return { engine: primary, results, bothSucceeded: results.filter((entry) => entry.ok).length === targets.length };
}
