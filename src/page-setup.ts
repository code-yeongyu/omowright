import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { acquireNetwork } from "./network-events.ts";
import type { NetworkRelease } from "./network-events.ts";
import { validateViewport, repinViewport } from "./viewport.ts";
import type { ViewportInput, ViewportSize } from "./viewport.ts";
import { readProperty } from "./read-property.ts";
import type { CdpEventMeta, CdpEventPayload, CdpTransport, CdpUnsubscribe } from "./cdp-protocol.ts";

/** The string-safe wire form bindingValue encodes a value into (JSON carries it both ways). */
export type EncodedBindingValue =
  | ["undefined"]
  | ["number", string]
  | ["bigint", string]
  | ["array", EncodedBindingValue[]]
  | ["object", Array<[string, EncodedBindingValue]>]
  | ["value", unknown];

type EncodedBindingArray = ["array", EncodedBindingValue[]];

interface BindingCalledEvent {
  name: string;
  payload: string;
  executionContextId: number;
}

/** The page surface init scripts, bindings, headers, viewport and media emulation need. */
export interface SetupPage {
  cdp: Pick<CdpTransport, "send"> & {
    on(
      event: "Runtime.bindingCalled",
      handler: (event: BindingCalledEvent, meta: CdpEventMeta) => unknown,
    ): CdpUnsubscribe;
    on(
      event: "Target.detachedFromTarget",
      handler: (event: CdpEventPayload<"Target.detachedFromTarget">, meta: CdpEventMeta) => unknown,
    ): CdpUnsubscribe;
  };
  frameManager: {
    readonly frames: ReadonlyMap<string, { sessionId: string }>;
    mainWorldContexts?: ReadonlyMap<string, string | undefined>;
    sessionSetup?: (sessionId: string) => unknown;
  };
  events: { on(name: "close", listener: () => unknown): unknown };
  /** The page host; a host with setViewportSize repins through its agent-tab manager. */
  browser: object;
  /** Set by BrowserConnection.attachPage; exposeBinding hands it to the callback. */
  context?: (() => unknown) | undefined;
  frames(): ReadonlyArray<{ frameId: string }>;
  resolveSessionId(): Promise<string>;
  setCachedViewportSize(size: ViewportSize): void;
}

interface InitScript {
  source: string;
  binding: boolean;
}

interface PageBinding {
  name: string;
  callback: (...args: unknown[]) => unknown;
  source: boolean;
}

interface SetupSession {
  scripts: Map<InitScript, string>;
  bindings: Set<string>;
  ready: Promise<void>;
  runtimeEnabled?: boolean;
  releaseNetwork?: NetworkRelease;
}

interface MediaState {
  media: string;
  features: Array<{ name: string; value: string }>;
}

interface SetupState {
  scripts: InitScript[];
  bindings: Map<string, PageBinding>;
  sessions: Map<string, SetupSession>;
  headers: Record<string, string> | null;
  media: MediaState | null;
}

/** A function (called with `arg` in the page), source text, or a file's contents. */
export type InitScriptInput =
  | ((arg: never) => unknown)
  | string
  | { content?: string | undefined; path?: string | undefined };

type MediaFeatureKey = "colorScheme" | "reducedMotion" | "forcedColors" | "contrast";

export type EmulateMediaOptions = { media?: string | null | undefined } & {
  [K in MediaFeatureKey]?: string | null | undefined;
};

const states = new WeakMap<SetupPage, SetupState>();

// The same codec runs on both sides of Runtime's string-only binding transport.
function bindingValue(value: unknown, decode?: false): EncodedBindingValue;
function bindingValue(value: EncodedBindingArray, decode: true): unknown[];
function bindingValue(value: EncodedBindingValue, decode: true): unknown;
function bindingValue(
  ...[value, decode]: [value: unknown, decode?: false | undefined] | [value: EncodedBindingValue, decode: true]
): unknown {
  if (decode) {
    const [type, data] = value;
    if (type === "undefined") return undefined;
    if (type === "number") return data === "-0" ? -0 : Number(data);
    if (type === "bigint") return BigInt(data);
    if (type === "array") return data.map((item) => bindingValue(item, true));
    if (type === "object") return Object.fromEntries(data.map(([key, item]) => [key, bindingValue(item, true)]));
    return data;
  }
  if (value === undefined) return ["undefined"];
  if (typeof value === "number" && (!Number.isFinite(value) || Object.is(value, -0)))
    return ["number", Object.is(value, -0) ? "-0" : String(value)];
  if (typeof value === "bigint") return ["bigint", String(value)];
  if (Array.isArray(value)) return ["array", value.map((item) => bindingValue(item))];
  if (value !== null && typeof value === "object")
    return ["object", Object.entries(value).map(([key, item]) => [key, bindingValue(item)])];
  return ["value", value];
}

function bindingScript(name: string, internalName: string) {
  return `(() => {
    const name = ${JSON.stringify(name)};
    if (globalThis[name]?.__omowrightBinding) return;
    const bindingValue = ${bindingValue.toString()};
    const raw = globalThis[${JSON.stringify(internalName)}];
    let sequence = 0;
    const callbacks = new Map();
    const fn = (...args) => new Promise((resolve, reject) => {
      const id = ++sequence;
      callbacks.set(id, { resolve, reject });
      try { raw(JSON.stringify({ id, args: bindingValue(args) })); }
      catch (error) { callbacks.delete(id); reject(error); }
    });
    fn.__omowrightBinding = { callbacks, bindingValue };
    globalThis[name] = fn;
  })()`;
}

export function hasPageBindings(page: SetupPage) {
  return (states.get(page)?.bindings.size ?? 0) > 0;
}

function setupState(page: SetupPage): SetupState {
  const existing = states.get(page);
  if (existing) return existing;
  const state: SetupState = { scripts: [], bindings: new Map(), sessions: new Map(), headers: null, media: null };
  states.set(page, state);
  // FrameManager calls this before resuming a paused out-of-process child.
  page.frameManager.sessionSetup = (sessionId) => initializeSession(page, state, sessionId);
  const offBinding = page.cdp.on("Runtime.bindingCalled", (event, meta) => {
    const binding = state.bindings.get(event.name);
    if (!binding || !state.sessions.has(meta.sessionId ?? "")) return;
    deliverBinding(page, state, binding, event, meta.sessionId).catch(() => {
      // A navigation or detached frame can destroy the calling context while
      // its host callback is still running. There is then no promise to settle.
    });
  });
  const offDetached = page.cdp.on("Target.detachedFromTarget", ({ sessionId }) => {
    state.sessions.get(sessionId)?.releaseNetwork?.();
    state.sessions.delete(sessionId);
  });
  page.events.on("close", async () => {
    offBinding();
    offDetached();
    states.delete(page);
    delete page.frameManager.sessionSetup;
    for (const [sessionId, session] of state.sessions) {
      session.releaseNetwork?.();
      for (const identifier of session.scripts.values()) {
        await page.cdp.send("Page.removeScriptToEvaluateOnNewDocument", { identifier }, sessionId).catch(() => {});
      }
      for (const name of session.bindings) {
        await page.cdp.send("Runtime.removeBinding", { name }, sessionId).catch(() => {});
      }
      if (state.bindings.size) await page.cdp.send("Runtime.disable", undefined, sessionId).catch(() => {});
    }
  });
  return state;
}

type BindingResult =
  | { value: EncodedBindingValue }
  | { error: { name: string; message: string; stack: string | undefined } }
  | { thrown: EncodedBindingValue };

async function deliverBinding(
  page: SetupPage,
  state: SetupState,
  binding: PageBinding,
  event: BindingCalledEvent,
  sessionId: string | undefined,
) {
  // JSON boundary: the page-side stub sends `{ id, args: bindingValue(args) }`.
  const call: { id: number; args: EncodedBindingArray } = JSON.parse(event.payload);
  let result: BindingResult;
  try {
    const args = bindingValue(call.args, true);
    if (binding.source) {
      const frameId = page.frameManager.mainWorldContexts?.get(`${sessionId}:${event.executionContextId}`);
      const frame = page.frames().find((candidate) => candidate.frameId === frameId);
      if (!frame) throw Error("Binding caller frame is detached");
      // A page attached without a BrowserConnection has no context(); the JS original threw this TypeError calling it.
      if (page.context === undefined) throw new TypeError("page.context is not a function");
      args.unshift({ context: page.context(), page, frame });
    }
    result = { value: bindingValue(await binding.callback(...args)) };
  } catch (error) {
    result =
      error instanceof Error
        ? { error: { name: error.name, message: error.message, stack: error.stack } }
        : { thrown: bindingValue(error) };
  }
  if (states.get(page) !== state || !state.sessions.has(sessionId ?? "")) return;
  await page.cdp.send(
    "Runtime.evaluate",
    {
      contextId: event.executionContextId,
      expression: `(() => {
      const state = globalThis[${JSON.stringify(binding.name)}].__omowrightBinding;
      const callback = state.callbacks.get(${call.id});
      state.callbacks.delete(${call.id});
      const result = ${JSON.stringify(result)};
      if (result.error) {
        const error = new Error(result.error.message);
        error.name = result.error.name; error.stack = result.error.stack;
        callback.reject(error);
      } else if (result.thrown) callback.reject(state.bindingValue(result.thrown, true));
      else callback.resolve(state.bindingValue(result.value, true));
    })()`,
    },
    sessionId,
  );
}

async function installScripts(page: SetupPage, state: SetupState, sessionId: string, session: SetupSession) {
  for (const script of state.scripts) {
    if (session.scripts.has(script)) continue;
    const { identifier } = await page.cdp.send(
      "Page.addScriptToEvaluateOnNewDocument",
      { source: script.source, runImmediately: script.binding },
      sessionId,
    );
    session.scripts.set(script, identifier);
  }
}

function initializeSession(page: SetupPage, state: SetupState, sessionId: string): Promise<void> {
  let existing = state.sessions.get(sessionId);
  if (!existing) {
    existing = { scripts: new Map(), bindings: new Set(), ready: Promise.resolve() };
    state.sessions.set(sessionId, existing);
  }
  const session = existing;
  // Explicit setup calls can overlap the automatic OOPIF attach path.
  const operation = session.ready.then(async () => {
    for (const [name] of state.bindings) {
      if (session.bindings.has(name)) continue;
      await page.cdp.send("Runtime.addBinding", { name }, sessionId);
      session.bindings.add(name);
    }
    if (state.bindings.size && !session.runtimeEnabled) {
      await page.cdp.send("Runtime.enable", undefined, sessionId);
      session.runtimeEnabled = true;
    }
    await installScripts(page, state, sessionId, session);
    if (state.headers !== null) {
      session.releaseNetwork ??= acquireNetwork(page.cdp, sessionId);
      await session.releaseNetwork.ready;
      await page.cdp.send("Network.setExtraHTTPHeaders", { headers: state.headers }, sessionId);
    }
    if (state.media) await page.cdp.send("Emulation.setEmulatedMedia", state.media, sessionId);
  });
  session.ready = operation.catch(() => {});
  return operation;
}

async function updateSessions(page: SetupPage, state: SetupState) {
  const main = await page.resolveSessionId();
  const sessions = new Set([main, ...[...page.frameManager.frames.values()].map((frame) => frame.sessionId)]);
  for (const sessionId of sessions) {
    await initializeSession(page, state, sessionId);
    await page.cdp.send(
      "Target.setAutoAttach",
      { autoAttach: true, waitForDebuggerOnStart: true, flatten: true },
      sessionId,
    );
  }
}

export async function addInitScript(this: SetupPage, script: InitScriptInput, arg?: unknown) {
  let source;
  if (typeof script === "function") {
    source = `(() => { const __name = value => value; (${script.toString()})(${JSON.stringify(arg) ?? "undefined"}); })()`;
  } else if (typeof script === "string") source = script;
  else if (typeof script?.content === "string") source = script.content;
  else if (typeof script?.path === "string") source = await readFile(script.path, "utf8");
  else throw new TypeError("addInitScript requires a function, string, or { path | content }");
  const state = setupState(this);
  state.scripts.push({ source, binding: false });
  await updateSessions(this, state);
}

export async function exposeFunction(this: SetupPage, name: string, callback: (...args: never[]) => unknown) {
  await registerBinding(this, name, callback, false);
}

export async function exposeBinding(this: SetupPage, name: string, callback: (...args: never[]) => unknown) {
  await registerBinding(this, name, callback, true);
}

async function registerBinding(page: SetupPage, name: unknown, callback: unknown, source: boolean) {
  if (typeof name !== "string" || typeof callback !== "function")
    throw new TypeError(`${source ? "exposeBinding" : "exposeFunction"} requires a name and function`);
  const state = setupState(page);
  if ([...state.bindings.values()].some((binding) => binding.name === name))
    throw Error(`Function "${name}" has already been registered`);
  const internalName = `__omowright_binding_${randomUUID().replaceAll("-", "")}`;
  // A checked function value: the page decides what it is called with.
  const invoke = (...args: unknown[]): unknown => Reflect.apply(callback, undefined, args);
  state.bindings.set(internalName, { name, callback: invoke, source });
  state.scripts.push({ source: bindingScript(name, internalName), binding: true });
  await updateSessions(page, state);
}

/** Validated at runtime: anything but a plain object of string values throws a TypeError. */
export async function setExtraHTTPHeaders(this: SetupPage, headers: Readonly<Record<string, unknown>>) {
  if (!headers || typeof headers !== "object" || Array.isArray(headers))
    throw new TypeError("headers must be an object of strings");
  const checked: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value !== "string") throw new TypeError(`Header "${name}" value must be a string`);
    checked[name] = value;
  }
  const state = setupState(this);
  state.headers = checked;
  await updateSessions(this, state);
}

export async function setViewportSize(this: SetupPage, viewport: ViewportInput) {
  const size = validateViewport(viewport);
  const hostSetViewportSize = readProperty(this.browser, "setViewportSize");
  if (hostSetViewportSize) {
    // `this.browser.setViewportSize(size)` threw this TypeError for a truthy non-function.
    if (typeof hostSetViewportSize !== "function")
      throw new TypeError("this.browser.setViewportSize is not a function");
    await Reflect.apply(hostSetViewportSize, this.browser, [size]);
  } else await repinViewport(this, size);
}

const mediaFeatures: Readonly<Record<MediaFeatureKey, readonly [string, readonly string[]]>> = {
  colorScheme: ["prefers-color-scheme", ["light", "dark", "no-preference"]],
  reducedMotion: ["prefers-reduced-motion", ["reduce", "no-preference"]],
  forcedColors: ["forced-colors", ["active", "none"]],
  contrast: ["prefers-contrast", ["more", "no-preference"]],
};
const mediaFeatureKeys: readonly MediaFeatureKey[] = ["colorScheme", "reducedMotion", "forcedColors", "contrast"];

export async function emulateMedia(this: SetupPage, options: EmulateMediaOptions = {}) {
  if (options.media !== undefined && options.media !== null && !["screen", "print"].includes(options.media))
    throw new TypeError("media must be screen, print or null");
  for (const key of mediaFeatureKeys) {
    const [, allowed] = mediaFeatures[key];
    const value = options[key];
    if (value !== undefined && value !== null && !allowed.includes(value))
      throw new TypeError(`${key} must be ${allowed.join(", ")} or null`);
  }
  const state = setupState(this);
  const previous = new Map(state.media?.features.map((feature) => [feature.name, feature.value]));
  for (const key of mediaFeatureKeys) {
    const [name] = mediaFeatures[key];
    if (options[key] !== undefined) previous.set(name, options[key] ?? "");
  }
  state.media = {
    media: options.media === undefined ? (state.media?.media ?? "") : (options.media ?? ""),
    features: [...previous].map(([name, value]) => ({ name, value })),
  };
  await updateSessions(this, state);
}
