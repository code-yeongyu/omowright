import { AsideReplError, connectAside } from "./aside/session.ts";
import type { ConnectAsideOptions } from "./aside/session-types.ts";
import { connectEgo } from "./ego/client.ts";
import type { ConnectEgoOptions } from "./ego/bindings.ts";
import { connectBrowserSkill } from "./bsk/connect.ts";
import type { ConnectBrowserSkillOptions } from "./bsk/connect.ts";
import { BskSession } from "./bsk/session.ts";
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

type EngineResult<H> = { handle: H; verified: string; skipped?: undefined } | { handle?: undefined; skipped: string };

/** One engine's outcome: when it attached, how that was verified; when it did not, why. */
export interface EngineAttempt {
  engine: EngineName;
  ok: boolean;
  /** Time spent connecting and verifying; absent for engines that were not run. */
  ms?: number;
  /** The check that proved attachment. */
  verified?: string;
  reason?: string;
}

type AnyHandle = EngineHandles[EngineName];

export interface ConnectBrowserOptions extends Partial<EngineOptions> {
  /** Tried first; any other value throws a TypeError. */
  prefer?: string | undefined;
  /** Engines allowed to run; any other name throws a TypeError. */
  allow?: readonly string[] | undefined;
  /** Also attach every other allowed engine, for comparison only (each is a second browser). */
  crossCheck?: boolean | undefined;
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

async function targetCount(handle: { listTargets(): Promise<unknown[]>; close(): Promise<unknown> }) {
  try {
    return (await handle.listTargets()).length;
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

const ENGINES: { [E in EngineName]: (options: EngineOptions[E]) => Promise<EngineResult<EngineHandles[E]>> } = {
  // connectAside runs Aside's setup (installation detection, CLI install when the app is present);
  // a step only the user can take comes back as the skip reason.
  aside: async (options) => {
    let handle;
    try {
      handle = await connectAside(options);
    } catch (error) {
      // aside_not_ready is raised only as an AsideReplError (connectAside's setup check).
      if (error instanceof AsideReplError && error.code === "aside_not_ready") return { skipped: error.message };
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
    if (!ego || typeof ego.sendCDPMessage !== "function")
      return { skipped: "Ego Lite bindings are absent (only inside `ego-browser nodejs`)" };
    const handle = await connectEgo({ ...options, ego });
    return {
      handle,
      verified: `CDP listed ${await targetCount(handle)} targets in task space ${handle.taskSpace?.id ?? "?"}`,
    };
  },
  bsk: async (options) => {
    const handle = await connectBrowserSkill(options);
    return {
      handle,
      verified: `BrowserSkill started session ${handle.sessionId} in browser ${String(handle.browserInstanceId ?? "?")}`,
    };
  },
  cloak: async (options) => {
    const handle = await connectCloakProfile(options);
    return { handle, verified: `CDP listed ${await targetCount(handle)} targets in the CloakBrowser profile` };
  },
};

function runEngine<E extends EngineName>(engine: E, options: EngineOptions[E]) {
  return ENGINES[engine](options);
}

function reasonOf(error: unknown) {
  const code = optionalProperty(error, "code");
  return `${code ? `${code}: ` : ""}${optionalProperty(error, "message") ?? String(error)}`;
}

function closeHandle(handle: AnyHandle): Promise<unknown> {
  return handle instanceof BskSession ? handle.stop() : handle.close();
}

// Tries engines in ENGINE_ORDER (or `prefer` first) and returns the first that connects as the
// primary, with one result per engine: ok, ms, how attachment was verified, and why not.
// `allow` limits which engines may run at all, so an agent that must stay in the user's browser
// leaves "cloak" out. `crossCheck` also attaches the remaining allowed engines for comparison:
// a BrowserSkill tab has no CDP endpoint, so a second engine is always a second browser.
export async function connectBrowser({
  prefer,
  allow = ENGINE_ORDER,
  crossCheck = false,
  ...perEngine
}: ConnectBrowserOptions = {}) {
  for (const name of [prefer, ...allow].filter(Boolean)) engineName(name);
  const order = prefer ? [engineName(prefer), ...ENGINE_ORDER.filter((name) => name !== prefer)] : [...ENGINE_ORDER];
  const attempts: EngineAttempt[] = [];
  let primary: { engine: EngineName; handle: AnyHandle } | null = null;
  const extra: { engine: EngineName; handle: AnyHandle }[] = [];
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
      const result = await runEngine(engine, perEngine[engine] ?? {});
      const ms = Math.round(performance.now() - started);
      if (result.skipped !== undefined) {
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
    engine: primary.engine,
    handle: primary.handle,
    attempts,
    attached: opened.map((entry) => entry.engine),
    crossCheck: extra,
    // Closes the primary and every crossCheck handle: a BrowserSkill session stops, the rest close.
    closeAll: async () => {
      const failures = (
        await Promise.all(
          opened.map(async ({ engine, handle }) => {
            try {
              await closeHandle(handle);
              return null;
            } catch (cause) {
              return new Error(`${engine} failed to close: ${reasonOf(cause)}`, { cause });
            }
          }),
        )
      ).filter((error): error is Error => error !== null);
      if (failures.length) throw new AggregateError(failures, failures.map((error) => error.message).join("; "));
    },
  };
}
