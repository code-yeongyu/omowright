import { randomUUID } from "node:crypto";
import path from "node:path";
import { mkdir, open, readFile, readlink, realpath, rename, lstat, chmod } from "node:fs/promises";
import type { Stats } from "node:fs";
import { homedir } from "node:os";
import { TextDecoder } from "node:util";
import type { ZodType } from "zod";
import type { ChromeApiOptions, ChromeConnection } from "./chrome.js";
import { createChromeApi as createStandaloneChromeApi } from "./chrome.ts";
import { UnsupportedOperationError } from "./core.ts";
import { readProperty } from "./read-property.ts";
import { WIN32_REGISTRY_KEYS, installWin32NativeHost, isWin32RegistryKey } from "./native-host-win32.ts";
import {
  HOST_NAME,
  PROTOCOL,
  MAX_MESSAGE_BYTES,
  EVENT_NAMES,
  COMMAND_NAMES,
  payloadSchemas,
  ExtensionHelloSchema,
  HostHelloSchema,
  EventSchema,
  CommandSchema,
  ResponseSchema,
} from "./bridge-schemas.ts";
import type { CommandName, EventName } from "./bridge-schemas.js";
export {
  HOST_NAME,
  PROTOCOL,
  MAX_MESSAGE_BYTES,
  EVENT_NAMES,
  COMMAND_NAMES,
  ExtensionHelloSchema,
  HostHelloSchema,
  EventSchema,
  CommandSchema,
  ResponseSchema,
} from "./bridge-schemas.ts";

/** `error.message` for a thrown value of unknown shape: same text the JS printed, including "undefined" for non-objects. */
const messageOf = (error: unknown): unknown => readProperty(error, "message");

type ExtensionHello = ReturnType<typeof ExtensionHelloSchema.parse>;
type BridgeCommand = ReturnType<typeof CommandSchema.parse>;
export type BridgeEvent = ReturnType<typeof EventSchema.parse>;
/** A protocol message as it goes on the wire: always a JSON object. */
export type BridgeMessage = Readonly<Record<string, unknown>>;
export type BridgeChunk = Uint8Array | string;
export type BridgeEventListener = (payload: Record<string, unknown>) => unknown;
/** The part of a readable stream (process.stdin by default) the host reads. */
export interface BridgeInput {
  on(event: "data", listener: (chunk: BridgeChunk) => void): unknown;
  once?(event: "end" | "error", listener: (error?: unknown) => void): unknown;
  removeListener?(event: "data", listener: (chunk: BridgeChunk) => void): unknown;
}
/** The part of a writable stream (process.stdout by default) the host writes frames to. */
export interface BridgeOutput {
  write(chunk: Buffer, callback: (error?: Error | null) => void): boolean;
  once?(event: "error", listener: (error?: unknown) => void): unknown;
}
/** The diagnostics sink (process.stderr by default). */
export interface BridgeDiagnostics {
  write?(text: string): unknown;
}
export interface NativeMessagingHostOptions {
  stdin?: BridgeInput | undefined;
  stdout?: BridgeOutput | undefined;
  stderr?: BridgeDiagnostics | undefined;
  /** Required at runtime: 32 characters a-p, the only extension whose hello is accepted. */
  extensionId?: string | undefined;
  hostName?: string | undefined;
  maxMessageBytes?: number | undefined;
  commandTimeoutMs?: number | undefined;
  maxPendingWrites?: number | undefined;
  onEvent?: ((event: BridgeEvent) => unknown) | undefined;
  onDisconnect?: ((error: Error) => unknown) | undefined;
}
export interface BridgeRequestOptions {
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
}
interface PendingCommand {
  requestId: string;
  name: CommandName;
  command: BridgeCommand;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timer: ReturnType<typeof setTimeout> | null;
  abortHandler: (() => void) | null;
  cleanup: (() => void) | null;
  settled: boolean;
  started?: boolean;
}
interface PendingWrite {
  frame: Buffer;
  resolve: (value: void) => void;
  reject: (reason: unknown) => void;
}
export interface InstallNativeMessagingHostOptions {
  hostName?: string | undefined;
  /** Required at runtime: an absolute path to a securely owned executable. */
  hostPath?: string | undefined;
  /** Required at runtime: 32 characters a-p. */
  extensionId?: string | undefined;
  browser?: string | undefined;
  nativeMessagingHostDir?: string | undefined;
  force?: boolean | undefined;
  /** Not supported: any value other than undefined is rejected. */
  endpointPath?: unknown;
  /** win32 only: an HKCU Software NativeMessagingHosts registry key. */
  registryKey?: string | undefined;
}

export class BridgeUnavailableError extends Error {
  constructor(message = "Cloak bridge is unavailable") {
    super(message);
    this.name = "BridgeUnavailableError";
  }
}
export class BridgeProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BridgeProtocolError";
  }
}
const decoder = new TextDecoder("utf-8", { fatal: true });
const checked = <T>(schema: ZodType<T>, value: unknown, message: string): T => {
  const result = schema.safeParse(value);
  if (!result.success) throw new BridgeProtocolError(message);
  return result.data;
};
function schemaFor(value: BridgeMessage): ZodType | null {
  if (value["type"] === "hello") return value["role"] === "host" ? HostHelloSchema : ExtensionHelloSchema;
  if (value["type"] === "event") return EventSchema;
  if (value["type"] === "command") return CommandSchema;
  if (value["type"] === "response") return ResponseSchema;
  return null;
}
export function encodeFrame(value: BridgeMessage, maxMessageBytes: number = MAX_MESSAGE_BYTES): Buffer {
  const schema = schemaFor(value);
  if (schema) checked(schema, value, "invalid outbound message");
  let json;
  try {
    json = JSON.stringify(value);
  } catch {
    throw new BridgeProtocolError("invalid JSON");
  }
  const body = Buffer.from(json, "utf8");
  if (body.length === 0 || body.length > maxMessageBytes) throw new BridgeProtocolError("PAYLOAD_TOO_LARGE");
  const frame = Buffer.allocUnsafe(4 + body.length);
  frame.writeUInt32LE(body.length, 0);
  body.copy(frame, 4);
  return frame;
}
export function decodeFrames(
  buffer: Buffer,
  maxMessageBytes: number = MAX_MESSAGE_BYTES,
): { frames: unknown[]; remainder: Buffer } {
  const frames: unknown[] = [];
  let offset = 0;
  while (buffer.length - offset >= 4) {
    const length = buffer.readUInt32LE(offset);
    if (!length || length > maxMessageBytes) throw new BridgeProtocolError("PAYLOAD_TOO_LARGE");
    if (buffer.length - offset < length + 4) break;
    const body = buffer.subarray(offset + 4, offset + 4 + length);
    let text;
    try {
      text = decoder.decode(body);
    } catch {
      throw new BridgeProtocolError("invalid UTF-8");
    }
    try {
      frames.push(JSON.parse(text));
    } catch {
      throw new BridgeProtocolError("invalid JSON");
    }
    offset += length + 4;
  }
  return { frames, remainder: buffer.subarray(offset) };
}

export function createNativeMessagingHost({
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
  extensionId,
  hostName = HOST_NAME,
  maxMessageBytes = MAX_MESSAGE_BYTES,
  commandTimeoutMs = 30_000,
  maxPendingWrites = 256,
  onEvent,
  onDisconnect,
}: NativeMessagingHostOptions = {}) {
  if (!/^[a-p]{32}$/.test(extensionId ?? "")) throw new BridgeProtocolError("a valid extensionId is required");
  if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(hostName) || hostName !== HOST_NAME)
    throw new BridgeProtocolError("invalid hostName");
  let buffer: Buffer = Buffer.alloc(0),
    closed = false,
    hello: ExtensionHello | null = null,
    hostConnectionId: string | null = null,
    effectiveMax = maxMessageBytes,
    lastEventSeq = 0,
    sequence = 0,
    mutationBusy = false;
  const pending = new Map<string, PendingCommand>(),
    listeners = new Map<EventName, Set<BridgeEventListener>>(),
    commandQueue: PendingCommand[] = [],
    writeQueue: PendingWrite[] = [];
  let writing = false;
  const disconnect = (reason?: unknown) => {
    if (closed) return;
    closed = true;
    const error =
      reason instanceof Error
        ? reason
        : new BridgeUnavailableError(reason === undefined ? "native host disconnected" : String(reason));
    for (const item of pending.values()) {
      item.cleanup?.();
      item.reject(error);
    }
    pending.clear();
    for (const item of commandQueue.splice(0)) {
      item.cleanup?.();
      item.reject(error);
    }
    for (const item of writeQueue.splice(0)) item.reject(error);
    onDisconnect?.(error);
  };
  const write = (value: BridgeMessage): Promise<void> => {
    if (closed) return Promise.reject(new BridgeUnavailableError());
    let frame: Buffer;
    try {
      const schema = schemaFor(value);
      if (!schema) throw new BridgeProtocolError("invalid outbound message type");
      checked(schema, value, "invalid outbound message");
      frame = encodeFrame(value, effectiveMax);
    } catch (error) {
      return Promise.reject(error);
    }
    if (writeQueue.length + (writing ? 1 : 0) >= maxPendingWrites)
      return Promise.reject(new BridgeProtocolError("BOUNDED_TRANSPORT"));
    return new Promise<void>((resolve, reject) => {
      writeQueue.push({ frame, resolve, reject });
      pumpWrites();
    });
  };
  const pumpWrites = () => {
    if (writing || closed || !writeQueue.length) return;
    writing = true;
    const item = writeQueue.shift();
    if (!item) {
      writing = false;
      return;
    }
    let finished = false;
    const done = (error?: unknown) => {
      if (finished) return;
      finished = true;
      writing = false;
      if (error) {
        item.reject(error);
        disconnect(error);
      } else item.resolve();
      pumpWrites();
    };
    try {
      const result = stdout.write(item.frame, (error) => done(error));
      if (result === false && stdout.once) stdout.once("error", done);
    } catch (error) {
      done(error);
    }
  };
  const pumpCommands = () => {
    if (closed || mutationBusy || !commandQueue.length) return;
    const item = commandQueue.shift();
    if (!item) return;
    item.started = true;
    mutationBusy = true;
    pending.set(item.requestId, item);
    write(item.command).catch((error) => {
      if (pending.delete(item.requestId)) {
        item.settled = true;
        item.cleanup?.();
        item.reject(error);
      }
      disconnect(error);
    });
  };
  const dispatchEvent = (event: BridgeEvent) => {
    if (
      !hello ||
      event.connectionId !== hello.connectionId ||
      event.seq <= lastEventSeq ||
      !hello.events.includes(event.name)
    )
      throw new BridgeProtocolError("invalid event ordering or capability");
    lastEventSeq = event.seq;
    try {
      Promise.resolve(onEvent?.(event)).catch((error) => stderr.write?.(`bridge listener: ${messageOf(error)}\n`));
    } catch (error) {
      stderr.write?.(`bridge listener: ${messageOf(error)}\n`);
    }
    for (const fn of listeners.get(event.name) ?? []) {
      try {
        Promise.resolve(fn(event.payload)).catch((error) => stderr.write?.(`bridge listener: ${messageOf(error)}\n`));
      } catch (error) {
        stderr.write?.(`bridge listener: ${messageOf(error)}\n`);
      }
    }
  };
  const handle = (raw: unknown) => {
    if (!hello) {
      const parsed = checked(ExtensionHelloSchema, raw, "extension hello rejected");
      if (parsed.extensionId !== extensionId) throw new BridgeProtocolError("extension hello rejected");
      hello = parsed;
      hostConnectionId = randomUUID();
      effectiveMax = Math.min(maxMessageBytes, parsed.maxMessageBytes);
      lastEventSeq = 0;
      return write({
        protocol: PROTOCOL,
        type: "hello",
        role: "host",
        connectionId: hostConnectionId,
        hostName,
        hostVersion: "0.1.0",
        events: EVENT_NAMES.filter((x) => parsed.events.includes(x)),
        commands: COMMAND_NAMES.filter((x) => parsed.commands.includes(x)),
        maxMessageBytes: effectiveMax,
      });
    }
    const frameType = readProperty(raw, "type");
    if (frameType === "event") return dispatchEvent(checked(EventSchema, raw, "invalid event"));
    if (frameType === "response") {
      const parsed = checked(ResponseSchema, raw, "invalid response");
      if (parsed.name === "protocolError")
        throw Object.assign(new BridgeProtocolError(parsed.error?.message ?? "protocol error"), {
          code: parsed.error?.code,
          details: parsed.error?.details,
        });
      const item = pending.get(parsed.requestId);
      if (!item || item.name !== parsed.name) throw new BridgeProtocolError("invalid or unknown response");
      item.settled = true;
      pending.delete(parsed.requestId);
      item.cleanup?.();
      mutationBusy = false;
      if (parsed.ok) item.resolve(parsed.result);
      else
        item.reject(
          Object.assign(new Error(parsed.error?.message), { code: parsed.error?.code, details: parsed.error?.details }),
        );
      pumpCommands();
      return;
    }
    throw new BridgeProtocolError("unexpected message");
  };
  const onData = (chunk: BridgeChunk) => {
    try {
      buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
      const out = decodeFrames(buffer, effectiveMax);
      buffer = out.remainder;
      for (const raw of out.frames)
        Promise.resolve(handle(raw)).catch((error) => {
          stderr.write?.(`bridge: ${messageOf(error)}\n`);
          disconnect(error);
        });
    } catch (error) {
      stderr.write?.(`bridge: ${messageOf(error)}\n`);
      disconnect(error);
    }
  };
  stdin.on("data", onData);
  stdin.once?.("end", () => disconnect());
  stdin.once?.("error", disconnect);
  return {
    get isConnected() {
      return !closed && !!hello;
    },
    get capabilities() {
      return { commands: new Set(hello?.commands ?? []), events: new Set(hello?.events ?? []) };
    },
    send: write,
    request(
      name: CommandName,
      params: unknown,
      { signal, timeoutMs = commandTimeoutMs }: BridgeRequestOptions = {},
    ): Promise<unknown> {
      if (!hello || !hello.commands.includes(name))
        return Promise.reject(new BridgeUnavailableError(`unsupported bridge command: ${name}`));
      let command: BridgeCommand;
      try {
        command = checked(
          CommandSchema,
          { protocol: PROTOCOL, type: "command", requestId: randomUUID(), name, params },
          "invalid command parameters",
        );
      } catch (error) {
        return Promise.reject(error);
      }
      return new Promise<unknown>((resolve, reject) => {
        if (commandQueue.length + pending.size >= maxPendingWrites) {
          reject(new BridgeProtocolError("BOUNDED_TRANSPORT"));
          return;
        }
        const item: PendingCommand = {
          requestId: command.requestId,
          name,
          command,
          resolve,
          reject,
          timer: null,
          abortHandler: null,
          cleanup: () => {},
          settled: false,
        };
        const cleanup = () => {
          if (item.timer !== null) clearTimeout(item.timer);
          if (item.abortHandler) {
            signal?.removeEventListener("abort", item.abortHandler);
            item.abortHandler = null;
          }
        };
        item.cleanup = cleanup;
        const failIndeterminate = (code: string, reason: unknown = null) => {
          if (item.settled) return;
          item.settled = true;
          cleanup();
          if (pending.delete(item.requestId) || commandQueue.includes(item)) {
            const i = commandQueue.indexOf(item);
            if (i >= 0) commandQueue.splice(i, 1);
            item.reject(reason ?? Object.assign(new Error(`bridge command timed out: ${name}`), { code }));
          }
          if (item.started) disconnect(Object.assign(new Error("mutation completion is indeterminate"), { code }));
        };
        item.timer = setTimeout(() => failIndeterminate("TIMEOUT"), timeoutMs);
        if (signal?.aborted) {
          item.settled = true;
          cleanup();
          reject(signal?.reason ?? Object.assign(new Error(`bridge command aborted: ${name}`), { code: "ABORT_ERR" }));
          return;
        }
        item.abortHandler = () => failIndeterminate("ABORT_ERR", signal?.reason);
        signal?.addEventListener("abort", item.abortHandler, { once: true });
        commandQueue.push(item);
        pumpCommands();
      });
    },
    on(name: EventName, listener: BridgeEventListener) {
      if (!EVENT_NAMES.includes(name)) throw new BridgeProtocolError("invalid event name");
      const set = listeners.get(name) ?? new Set();
      set.add(listener);
      listeners.set(name, set);
      return () => {
        set.delete(listener);
        if (!set.size) listeners.delete(name);
      };
    },
    emitEvent(name: EventName, payload: unknown) {
      if (!hello?.events.includes(name)) return Promise.reject(new BridgeUnavailableError("unsupported bridge event"));
      const checkedPayload = payloadSchemas[name].safeParse(payload);
      if (!checkedPayload.success) return Promise.reject(new BridgeProtocolError("invalid event payload"));
      sequence += 1;
      return write({
        protocol: PROTOCOL,
        type: "event",
        connectionId: hostConnectionId,
        seq: sequence,
        occurredAt: Date.now(),
        name,
        payload: checkedPayload.data,
      });
    },
    close() {
      disconnect("closed");
      stdin.removeListener?.("data", onData);
    },
  };
}

const NATIVE_HOST_DIRS: Partial<Record<NodeJS.Platform, Partial<Record<string, string[]>>>> = {
  darwin: {
    chrome: ["Library", "Application Support", "Google", "Chrome"],
    chromium: ["Library", "Application Support", "Chromium"],
  },
  linux: { chrome: [".config", "google-chrome"], chromium: [".config", "chromium"] },
};
export function defaultNativeMessagingHostDir(
  browser: string = "chrome",
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "win32") {
    if (WIN32_REGISTRY_KEYS[browser] === undefined)
      throw new BridgeProtocolError("custom browser requires nativeMessagingHostDir");
    return path.win32.join(
      process.env["LOCALAPPDATA"] || path.win32.join(homedir(), "AppData", "Local"),
      "omowright",
      "NativeMessagingHosts",
      browser,
    );
  }
  const byBrowser = NATIVE_HOST_DIRS[platform];
  if (!byBrowser)
    throw new BridgeProtocolError(`no default nativeMessagingHostDir on ${platform}; pass nativeMessagingHostDir`);
  const segments = byBrowser[browser];
  if (!segments) throw new BridgeProtocolError("custom browser requires nativeMessagingHostDir");
  return path.join(homedir(), ...segments, "NativeMessagingHosts");
}
async function secureDirectory(dir: string): Promise<void> {
  const absolute = path.resolve(dir);
  const parts = absolute.split(path.sep).filter(Boolean);
  let current = path.parse(absolute).root;
  let final: Stats | undefined;
  while (parts.length) {
    const part = parts.shift();
    if (part === undefined) break;
    current = path.join(current, part);
    let info = await lstat(current).catch(() => null);
    if (!info) {
      await mkdir(current, { mode: 0o700 });
      info = await lstat(current);
    }
    if (info.isSymbolicLink()) {
      if (process.platform !== "darwin" || !["/tmp", "/var", "/etc"].includes(current) || info.uid !== 0)
        throw new BridgeProtocolError(
          `nativeMessagingHostDir security rejected at ${current}: symlink is not a root-owned macOS system alias`,
        );
      let target: string, resolved: string;
      try {
        target = await readlink(current);
        resolved = await realpath(current);
      } catch (error) {
        throw new BridgeProtocolError(
          `nativeMessagingHostDir security rejected at ${current}: system alias could not be resolved (${String(readProperty(error, "code") ?? readProperty(error, "message"))})`,
        );
      }
      if (!resolved.startsWith("/private/"))
        throw new BridgeProtocolError(
          `nativeMessagingHostDir security rejected at ${current}: system alias target is outside /private`,
        );
      // Walk the target from its root too: resolving the entire path would hide unsafe components.
      parts.unshift(...target.split(path.sep).filter(Boolean));
      current = path.isAbsolute(target) ? path.parse(target).root : path.dirname(current);
      continue;
    }
    if (!info.isDirectory())
      throw new BridgeProtocolError(`nativeMessagingHostDir security rejected at ${current}: not a directory`);
    if (info.uid !== process.getuid?.() && info.uid !== 0)
      throw new BridgeProtocolError(
        `nativeMessagingHostDir ownership rejected at ${current}: not owned by the current user or root`,
      );
    const stickyRootAncestor = parts.length > 0 && info.uid === 0 && (info.mode & 0o1000) !== 0;
    if (!stickyRootAncestor && (info.mode & 0o022) !== 0)
      throw new BridgeProtocolError(`nativeMessagingHostDir security rejected at ${current}: writable by others`);
    final = info;
  }
  if (!final || (final.uid !== process.getuid?.() && final.uid !== 0))
    throw new BridgeProtocolError(
      `nativeMessagingHostDir ownership rejected at ${current}: not owned by the current user or root`,
    );
  if ((final.mode & 0o077) !== 0) await chmod(absolute, 0o700);
}
async function secureExecutable(hostPath: string): Promise<void> {
  const info = await lstat(hostPath).catch(() => null);
  if (
    !info?.isFile() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o111) === 0 ||
    (info.mode & 0o022) !== 0
  )
    throw new BridgeProtocolError("hostPath must be a securely owned executable file");
}
export async function installNativeMessagingHost({
  hostName = HOST_NAME,
  hostPath,
  extensionId,
  browser = "chrome",
  nativeMessagingHostDir,
  force = false,
  endpointPath,
  registryKey,
}: InstallNativeMessagingHostOptions = {}) {
  const win32 = process.platform === "win32";
  if (endpointPath !== undefined) throw new BridgeProtocolError("endpointPath is not supported");
  if (hostName !== HOST_NAME || !/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(hostName))
    throw new BridgeProtocolError("invalid hostName");
  if (hostPath === undefined || !path.isAbsolute(hostPath)) throw new BridgeProtocolError("hostPath must be absolute");
  if (!win32) await secureExecutable(hostPath);
  if (extensionId === undefined || !/^[a-p]{32}$/.test(extensionId))
    throw new BridgeProtocolError("invalid extensionId");
  if (!nativeMessagingHostDir && browser === "cloakbrowser")
    throw new BridgeProtocolError("CloakBrowser nativeMessagingHostDir must be explicit and verified");
  if (registryKey !== undefined && !win32) throw new BridgeProtocolError("registryKey is only used on win32");
  const dir = nativeMessagingHostDir ?? defaultNativeMessagingHostDir(browser);
  const manifest = {
    name: hostName,
    description: "OmOWright internal CloakBrowser native messaging bridge.",
    path: hostPath,
    type: "stdio",
    allowed_origins: [`chrome-extension://${extensionId}/`],
  };
  const writeManifest = async (file: string): Promise<unknown> => {
    if (!force && (await lstat(file).catch(() => null)))
      throw new BridgeProtocolError("registration manifest already exists; use force");
    const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    const handle = await open(temp, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(manifest, null, 2) + "\n");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, file);
    return JSON.parse(await readFile(file, "utf8"));
  };
  if (win32) {
    const key = registryKey ?? WIN32_REGISTRY_KEYS[browser];
    if (!isWin32RegistryKey(key))
      throw new BridgeProtocolError(
        registryKey === undefined
          ? "custom browser requires registryKey on win32"
          : "registryKey must be HKCU\\Software\\...\\NativeMessagingHosts",
      );
    try {
      return await installWin32NativeHost({ hostName, hostPath, dir, registryKey: key, force, writeManifest });
    } catch (error) {
      throw error instanceof BridgeProtocolError
        ? error
        : new BridgeProtocolError(String(readProperty(error, "message")));
    }
  }
  await secureDirectory(dir);
  const file = path.join(dir, `${hostName}.json`);
  const parsed = await writeManifest(file);
  await chmod(file, 0o600);
  return { path: file, manifest: parsed };
}
/** The bridge surface createChromeApi drives: a native messaging host, or anything shaped like one. */
export interface ChromeBridge {
  readonly isConnected?: boolean | undefined;
  readonly capabilities?: { readonly commands?: ReadonlySet<string> | undefined } | undefined;
  request(name: CommandName, params: unknown): Promise<unknown>;
  on?(name: string, listener: BridgeEventListener): () => void;
}
export interface BridgeChromeApiOptions extends ChromeApiOptions {
  bridge?: ChromeBridge | undefined;
}
export type ChromeEventListener = (...args: unknown[]) => unknown;
export interface ChromeBridgeEvent {
  addListener(listener: ChromeEventListener): (() => void) | undefined;
  removeListener(listener: ChromeEventListener): void;
}
/** chrome.debugger's Debuggee; only tabId is forwarded. */
export interface ChromeDebuggee {
  readonly tabId?: number | undefined;
}
type StandaloneChromeApi = ReturnType<typeof createStandaloneChromeApi>;
/** The standalone API with the bridge-backed mutations, tabGroups, debugger, and the per-namespace bridge events. */
export type BridgedChromeApi = Omit<StandaloneChromeApi, "bookmarks" | "history"> & {
  bookmarks: Omit<StandaloneChromeApi["bookmarks"], "create" | "move" | "remove"> & {
    create(details: unknown): Promise<unknown>;
    move(id: unknown, details?: Readonly<Record<string, unknown>>): Promise<unknown>;
    remove(id: unknown): Promise<unknown>;
  };
  history: Omit<StandaloneChromeApi["history"], "deleteUrl" | "deleteRange"> & {
    deleteUrl(details: unknown): Promise<unknown>;
    deleteRange(details: unknown): Promise<unknown>;
  };
  tabGroups?: { update(groupId: number, updateProperties: Readonly<Record<string, unknown>>): Promise<unknown> };
  debugger?: {
    attach(target: ChromeDebuggee, requiredVersion: string): Promise<unknown>;
    detach(target: ChromeDebuggee): Promise<unknown>;
  };
} & { [namespace: string]: Record<string, unknown> | undefined };
export function createBridgeClient(options: NativeMessagingHostOptions = {}) {
  return createNativeMessagingHost(options);
}
export function createChromeApi(connection: ChromeConnection, options: BridgeChromeApiOptions = {}): BridgedChromeApi {
  const chrome: BridgedChromeApi = createStandaloneChromeApi(connection, options);
  const bridge = options.bridge;
  const request = (wire: CommandName, params: unknown): Promise<unknown> =>
    bridge?.isConnected && bridge.capabilities?.commands?.has(wire)
      ? bridge.request(wire, params)
      : Promise.reject(
          new UnsupportedOperationError(`chrome.${wire} requires the extension bridge in standalone OmOWright`),
        );
  chrome.bookmarks.create = (details) => request("bookmarks.create", { details });
  chrome.bookmarks.move = (id, details = {}) => request("bookmarks.move", { details: { ...details, id: String(id) } });
  chrome.bookmarks.remove = (id) => request("bookmarks.remove", { details: { id: String(id) } });
  chrome.history.deleteUrl = (details) => request("history.deleteUrl", { details });
  chrome.history.deleteRange = (details) => request("history.deleteRange", { details });
  chrome.tabGroups = {
    update: (groupId, updateProperties) => request("tabGroups.update", { details: { groupId, updateProperties } }),
  };
  chrome.debugger = {
    attach: (target, requiredVersion) =>
      request("debugger.attach", { details: { tabId: target.tabId ?? target, requiredVersion } }),
    detach: (target) => request("debugger.detach", { details: { tabId: target.tabId ?? target } }),
  };
  const eventMap = {
    notifications: ["onShown", "onClicked", "onClosed"],
    tabGroups: ["onCreated", "onUpdated", "onMoved"],
    tabs: ["onActivated"],
    windows: ["onFocusChanged"],
  };
  for (const [namespace, events] of Object.entries(eventMap)) {
    chrome[namespace] ??= {};
    for (const event of events) {
      const wire = `${namespace}.${event.slice(2, 3).toLowerCase() + event.slice(3)}`;
      const subscriptions = new Map<ChromeEventListener, () => void>();
      chrome[namespace][event] = {
        addListener(listener: ChromeEventListener) {
          if (!bridge?.on) return undefined;
          const unsubscribe = bridge.on(wire, (payload) =>
            listener(
              ...(namespace === "notifications" && event === "onClosed"
                ? [payload["notificationId"], payload["byUser"]]
                : namespace === "notifications"
                  ? [payload["notificationId"]]
                  : namespace === "tabGroups"
                    ? [payload["group"]]
                    : namespace === "windows"
                      ? [payload["windowId"]]
                      : [payload]),
            ),
          );
          subscriptions.set(listener, unsubscribe);
          return unsubscribe;
        },
        removeListener(listener: ChromeEventListener) {
          const unsubscribe = subscriptions.get(listener);
          if (unsubscribe) {
            unsubscribe();
            subscriptions.delete(listener);
          }
        },
      };
    }
  }
  return chrome;
}
