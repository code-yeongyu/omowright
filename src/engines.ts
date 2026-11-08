import { AsideReplError, connectAside } from "./aside/session.ts";
import type { ConnectAsideOptions } from "./aside/session-types.ts";
import { connectEgo } from "./ego/client.ts";
import type { ConnectEgoOptions } from "./ego/bindings.ts";
import { connectBrowserSkill } from "./bsk/connect.ts";
import type { ConnectBrowserSkillOptions } from "./bsk/connect.ts";
import { optionalProperty } from "./bsk/reply-fields.ts";
import { connectCloakProfile } from "./cloak-profile.ts";
import type { CloakConnectOptions } from "./cloak-profile.ts";

/** Each engine's own connect options, passed through by connectBrowser under the engine's name. */
export interface EngineOptions {
  aside: ConnectAsideOptions;
  ego: ConnectEgoOptions;
  bsk: ConnectBrowserSkillOptions;
  cloak: CloakConnectOptions;
}

export type EngineName = keyof EngineOptions;

interface EngineHandles {
  aside: Awaited<ReturnType<typeof connectAside>>;
  ego: Awaited<ReturnType<typeof connectEgo>>;
  bsk: Awaited<ReturnType<typeof connectBrowserSkill>>;
  cloak: Awaited<ReturnType<typeof connectCloakProfile>>;
}

type EngineResult<H> = { handle: H; skipped?: undefined } | { handle?: undefined; skipped: string };

export interface EngineAttempt {
  engine: EngineName;
  ok: boolean;
  reason?: string;
}

export interface ConnectBrowserOptions extends Partial<EngineOptions> {
  /** Tried first; any other value throws a TypeError. */
  prefer?: string | undefined;
  /** Engines allowed to run; any other name throws a TypeError. */
  allow?: readonly string[] | undefined;
}

// Most-preferred first: the user's own agent browser (Aside, Ego Lite), then the user's
// local browser through BrowserSkill, then omowright's owned CloakBrowser profile.
export const ENGINE_ORDER: readonly EngineName[] = Object.freeze(["aside", "ego", "bsk", "cloak"]);
const ENGINE_NAMES: ReadonlySet<unknown> = new Set(ENGINE_ORDER);

const isEngineName = (name: unknown): name is EngineName => ENGINE_NAMES.has(name);

function engineName(name: unknown): EngineName {
  if (!isEngineName(name))
    throw new TypeError(`unknown browser engine "${name}"; expected one of ${ENGINE_ORDER.join(", ")}`);
  return name;
}

export class NoBrowserEngineError extends Error {
  declare code: string;
  declare attempts: EngineAttempt[];

  constructor(attempts: EngineAttempt[]) {
    super(`no browser engine connected: ${attempts.map((a) => `${a.engine}: ${a.reason}`).join("; ")}`);
    this.name = "NoBrowserEngineError";
    this.code = "no_engine";
    this.attempts = attempts;
  }
}

const ENGINES: { [E in EngineName]: (options: EngineOptions[E]) => Promise<EngineResult<EngineHandles[E]>> } = {
  // connectAside runs Aside's setup (installation detection, CLI install when the app is present);
  // a step only the user can take comes back as the skip reason.
  aside: async (options) => {
    try {
      return { handle: await connectAside(options) };
    } catch (error) {
      // aside_not_ready is raised only as an AsideReplError (connectAside's setup check).
      if (error instanceof AsideReplError && error.code === "aside_not_ready") return { skipped: error.message };
      throw error;
    }
  },
  ego: async (options) => {
    const ego = options.ego ?? globalThis.ego;
    if (!ego || typeof ego.sendCDPMessage !== "function")
      return { skipped: "Ego Lite bindings are absent (only inside `ego-browser nodejs`)" };
    return { handle: await connectEgo({ ...options, ego }) };
  },
  bsk: async (options) => ({ handle: await connectBrowserSkill(options) }),
  cloak: async (options) => ({ handle: await connectCloakProfile(options) }),
};

function runEngine<E extends EngineName>(engine: E, options: EngineOptions[E]) {
  return ENGINES[engine](options);
}

function reasonOf(error: unknown) {
  const code = optionalProperty(error, "code");
  return `${code ? `${code}: ` : ""}${optionalProperty(error, "message") ?? String(error)}`;
}

// Tries engines in ENGINE_ORDER (or `prefer` first) and returns the first that connects,
// with every attempt and its reason. `allow` limits which engines may run at all, so an
// agent that must stay in the user's browser leaves "cloak" out.
export async function connectBrowser({ prefer, allow = ENGINE_ORDER, ...perEngine }: ConnectBrowserOptions = {}) {
  for (const name of [prefer, ...allow].filter(Boolean)) engineName(name);
  const order = prefer ? [engineName(prefer), ...ENGINE_ORDER.filter((name) => name !== prefer)] : [...ENGINE_ORDER];
  const attempts: EngineAttempt[] = [];
  for (const engine of order) {
    if (!allow.includes(engine)) {
      attempts.push({ engine, ok: false, reason: "not allowed by the caller" });
      continue;
    }
    try {
      const result = await runEngine(engine, perEngine[engine] ?? {});
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
