import { connectAside } from "./aside/session.js";
import { connectEgo } from "./ego/client.js";
import { connectBrowserSkill } from "./bsk/connect.js";
import { connectCloakProfile } from "./cloak-profile.js";

// Most-preferred first: the user's own agent browser (Aside, Ego Lite), then the user's
// local browser through BrowserSkill, then omowright's owned CloakBrowser profile.
export const ENGINE_ORDER = Object.freeze(["aside", "ego", "bsk", "cloak"]);

export class NoBrowserEngineError extends Error {
  constructor(attempts) {
    super(`no browser engine connected: ${attempts.map((a) => `${a.engine}: ${a.reason}`).join("; ")}`);
    this.name = "NoBrowserEngineError";
    this.code = "no_engine";
    this.attempts = attempts;
  }
}

async function targetCount(handle) {
  try {
    return (await handle.listTargets()).length;
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

const ENGINES = {
  // connectAside runs Aside's setup (installation detection, CLI install when the app is present);
  // a step only the user can take comes back as the skip reason.
  aside: async (options) => {
    let handle;
    try {
      handle = await connectAside(options);
    } catch (error) {
      if (error?.code === "aside_not_ready") return { skipped: error.message };
      throw error;
    }
    try {
      if ((await handle.run("return true")) !== true) throw new Error("aside repl did not echo a probe value");
    } catch (error) {
      await handle.close().catch(() => {});
      throw error;
    }
    return { handle, verified: "aside repl evaluated a probe call" };
  },
  ego: async (options) => {
    const ego = options.ego ?? globalThis.ego;
    if (!ego || typeof ego.sendCDPMessage !== "function") return { skipped: "Ego Lite bindings are absent (only inside `ego-browser nodejs`)" };
    const handle = await connectEgo({ ...options, ego });
    return { handle, verified: `CDP listed ${await targetCount(handle)} targets in task space ${handle.taskSpace?.id ?? "?"}` };
  },
  bsk: async (options) => {
    const handle = await connectBrowserSkill(options);
    return { handle, verified: `BrowserSkill started session ${handle.sessionId} in browser ${handle.browserInstanceId ?? "?"}` };
  },
  cloak: async (options) => {
    const handle = await connectCloakProfile(options);
    return { handle, verified: `CDP listed ${await targetCount(handle)} targets in the CloakBrowser profile` };
  },
};

function reasonOf(error) {
  return `${error?.code ? `${error.code}: ` : ""}${error?.message ?? String(error)}`;
}

// Tries engines in ENGINE_ORDER (or `prefer` first) and returns the first that connects as the
// primary, with one result per engine: ok, ms, how attachment was verified, and why not.
// `allow` limits which engines may run at all, so an agent that must stay in the user's browser
// leaves "cloak" out. `crossCheck` also attaches the remaining allowed engines for comparison:
// a BrowserSkill tab has no CDP endpoint, so a second engine is always a second browser.
export async function connectBrowser({ prefer, allow = ENGINE_ORDER, crossCheck = false, ...perEngine } = {}) {
  for (const name of [prefer, ...allow].filter(Boolean)) {
    if (!ENGINE_ORDER.includes(name)) throw new TypeError(`unknown browser engine "${name}"; expected one of ${ENGINE_ORDER.join(", ")}`);
  }
  const order = prefer ? [prefer, ...ENGINE_ORDER.filter((name) => name !== prefer)] : [...ENGINE_ORDER];
  const attempts = [];
  let primary = null;
  const extra = [];
  for (const engine of order) {
    if (!allow.includes(engine)) {
      attempts.push({ engine, ok: false, reason: "not allowed by the caller" });
      continue;
    }
    if (primary && !crossCheck) {
      attempts.push({ engine, ok: false, reason: `not tried: ${primary.engine} connected first` });
      continue;
    }
    const started = performance.now();
    try {
      const result = await ENGINES[engine](perEngine[engine] ?? {});
      const ms = Math.round(performance.now() - started);
      if (result.skipped) {
        attempts.push({ engine, ok: false, ms, reason: result.skipped });
        continue;
      }
      attempts.push({ engine, ok: true, ms, verified: result.verified });
      if (primary) extra.push({ engine, handle: result.handle });
      else primary = { engine, handle: result.handle };
    } catch (error) {
      attempts.push({ engine, ok: false, ms: Math.round(performance.now() - started), reason: reasonOf(error) });
    }
  }
  if (!primary) throw new NoBrowserEngineError(attempts);
  const opened = [primary, ...extra];
  return {
    // Closes the primary and every crossCheck handle: a BrowserSkill session stops, the rest close.
    closeAll: async () => {
      await Promise.all(opened.map(({ handle }) => (typeof handle.stop === "function" ? handle.stop() : handle.close()).catch(() => {})));
    },
    engine: primary.engine,
    handle: primary.handle,
    attempts,
    attached: [primary.engine, ...extra.map((e) => e.engine)],
    ...(crossCheck ? { crossCheck: extra } : {}),
  };
}
