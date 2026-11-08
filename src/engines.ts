import { connectAside } from "./aside/session.ts";
import { connectEgo } from "./ego/client.ts";
import { connectBrowserSkill } from "./bsk/connect.ts";
import { connectCloakProfile } from "./cloak-profile.ts";

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

const ENGINES = {
  // connectAside runs Aside's setup (installation detection, CLI install when the app is present);
  // a step only the user can take comes back as the skip reason.
  aside: async (options) => {
    try {
      return { handle: await connectAside(options) };
    } catch (error) {
      if (error?.code === "aside_not_ready") return { skipped: error.message };
      throw error;
    }
  },
  ego: async (options) => {
    const ego = options.ego ?? globalThis.ego;
    if (!ego || typeof ego.sendCDPMessage !== "function") return { skipped: "Ego Lite bindings are absent (only inside `ego-browser nodejs`)" };
    return { handle: await connectEgo({ ...options, ego }) };
  },
  bsk: async (options) => ({ handle: await connectBrowserSkill(options) }),
  cloak: async (options) => ({ handle: await connectCloakProfile(options) }),
};

function reasonOf(error) {
  return `${error?.code ? `${error.code}: ` : ""}${error?.message ?? String(error)}`;
}

// Tries engines in ENGINE_ORDER (or `prefer` first) and returns the first that connects,
// with every attempt and its reason. `allow` limits which engines may run at all, so an
// agent that must stay in the user's browser leaves "cloak" out.
export async function connectBrowser({ prefer, allow = ENGINE_ORDER, ...perEngine } = {}) {
  for (const name of [prefer, ...allow].filter(Boolean)) {
    if (!ENGINE_ORDER.includes(name)) throw new TypeError(`unknown browser engine "${name}"; expected one of ${ENGINE_ORDER.join(", ")}`);
  }
  const order = prefer ? [prefer, ...ENGINE_ORDER.filter((name) => name !== prefer)] : [...ENGINE_ORDER];
  const attempts = [];
  for (const engine of order) {
    if (!allow.includes(engine)) {
      attempts.push({ engine, ok: false, reason: "not allowed by the caller" });
      continue;
    }
    try {
      const result = await ENGINES[engine](perEngine[engine] ?? {});
      if (result.skipped) {
        attempts.push({ engine, ok: false, reason: result.skipped });
        continue;
      }
      attempts.push({ engine, ok: true });
      return { engine, handle: result.handle, attempts };
    } catch (error) {
      attempts.push({ engine, ok: false, reason: reasonOf(error) });
    }
  }
  throw new NoBrowserEngineError(attempts);
}
