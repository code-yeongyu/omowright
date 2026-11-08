import { randomUUID } from "node:crypto";
import path from "node:path";
import type { Stats } from "node:fs";
import { mkdir, open, readFile, rename, lstat, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { TextDecoder } from "node:util";
import type * as z from "zod";
import { createChromeApi as createStandaloneChromeApi } from "./chrome.ts";
import type { ChromeApiOptions, ChromeConnection } from "./chrome.ts";
import { UnsupportedOperationError } from "./core.ts";
import { readProperty } from "./read-property.ts";
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
  isCommandName,
  isEventName,
} from "./bridge-schemas.ts";
import type { CommandName, commandParams } from "./bridge-schemas.ts";
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

type ExtensionHello = z.output<typeof ExtensionHelloSchema>;
type BridgeResponse = z.output<typeof ResponseSchema>;
type BridgeCommand = z.output<typeof CommandSchema>;
export type BridgeEvent = z.output<typeof EventSchema>;
export type BridgePayload = Record<string, unknown>;
export type BridgeListener = (payload: BridgePayload) => unknown;

export interface BridgeInput {
  on(event: "data", listener: (chunk: Uint8Array) => void): unknown;
  once?(event: "end" | "error", listener: (error?: unknown) => void): unknown;
  removeListener?(event: "data", listener: (chunk: Uint8Array) => void): unknown;
}

export interface BridgeOutput {
  write(chunk: Uint8Array, callback: (error?: Error | null) => void): boolean;
  once?(event: "error", listener: (error: unknown) => void): unknown;
}

export interface BridgeErrorOutput {
  write?(text: string): unknown;
}

export interface NativeMessagingHostOptions {
  extensionId: string;
  stdin?: BridgeInput;
  stdout?: BridgeOutput;
  stderr?: BridgeErrorOutput;
  hostName?: string;
  maxMessageBytes?: number;
  commandTimeoutMs?: number;
  maxPendingWrites?: number;
  onEvent?: (event: BridgeEvent) => unknown;
  onDisconnect?: (error: Error) => unknown;
}

export interface BridgeRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface NativeMessagingHost {
  readonly isConnected: boolean;
  readonly capabilities: { commands: ReadonlySet<string>; events: ReadonlySet<string> };
  send(value: unknown): Promise<void>;
  request(name: string, params: BridgePayload, options?: BridgeRequestOptions): Promise<unknown>;
  on(name: string, listener: BridgeListener): () => void;
  emitEvent(name: string, payload: unknown): Promise<void>;
  close(): void;
}

export interface InstallNativeMessagingHostOptions {
  hostPath: string;
  extensionId: string;
  hostName?: string;
  browser?: string;
  nativeMessagingHostDir?: string;
  force?: boolean;
  endpointPath?: unknown;
}

export interface NativeHostManifest {
  name: string;
  description: string;
  path: string;
  type: "stdio";
  allowed_origins: string[];
}

interface PendingWrite {
  frame: Buffer;
  resolve: () => void;
  reject: (reason: unknown) => void;
}

interface PendingCommand {
  requestId: string;
  name: CommandName;
  command: BridgeCommand;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
  abortHandler: (() => void) | null;
  cleanup: () => void;
  settled: boolean;
  started: boolean;
}

const decoder = new TextDecoder("utf-8", { fatal: true });
const checked = <S extends z.ZodType>(schema: S, value: unknown, message: string): z.output<S> => {
  const result = schema.safeParse(value);
  if (!result.success) throw new BridgeProtocolError(message);
  return result.data;
};
// Wire boundary: frames are arbitrary JSON. readProperty keeps plain property-read semantics,
// including the TypeError a null/undefined frame raises.
const messageOf = (error: unknown): unknown =>
  (typeof error === "object" || typeof error === "function") && error !== null && "message" in error
    ? error.message
    : undefined;
function schemaFor(value: unknown) {
  const type = readProperty(value, "type");
  if (type === "hello") return readProperty(value, "role") === "host" ? HostHelloSchema : ExtensionHelloSchema;
  if (type === "event") return EventSchema;
  if (type === "command") return CommandSchema;
  if (type === "response") return ResponseSchema;
  return null;
}
function responseError(response: BridgeResponse) {
  if (!response.error) throw new BridgeProtocolError("invalid response");
  return response.error;
}
export function encodeFrame(value: unknown, maxMessageBytes = MAX_MESSAGE_BYTES): Buffer {
  const schema = schemaFor(value);
  if (schema) checked(schema, value, "invalid outbound message");
  let json: string;
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
  maxMessageBytes = MAX_MESSAGE_BYTES,
): { frames: unknown[]; remainder: Buffer } {
  const frames: unknown[] = [];
  let offset = 0;
  while (buffer.length - offset >= 4) {
    const length = buffer.readUInt32LE(offset);
    if (!length || length > maxMessageBytes) throw new BridgeProtocolError("PAYLOAD_TOO_LARGE");
    if (buffer.length - offset < length + 4) break;
    const body = buffer.subarray(offset + 4, offset + 4 + length);
    let text: string;
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

export function createNativeMessagingHost(options: NativeMessagingHostOptions): NativeMessagingHost;
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
}: Partial<NativeMessagingHostOptions> = {}): NativeMessagingHost {
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
    listeners = new Map<string, Set<BridgeListener>>(),
    commandQueue: PendingCommand[] = [],
    writeQueue: PendingWrite[] = [];
  let writing = false;
  const disconnect = (reason?: unknown) => {
    if (closed) return;
    closed = true;
    const error =
      reason instanceof Error ? reason : new BridgeUnavailableError(String(reason ?? "native host disconnected"));
    for (const item of pending.values()) {
      item.cleanup();
      item.reject(error);
    }
    pending.clear();
    for (const item of commandQueue.splice(0)) {
      item.cleanup();
      item.reject(error);
    }
    for (const item of writeQueue.splice(0)) item.reject(error);
    onDisconnect?.(error);
  };
  const write = (value: unknown): Promise<void> => {
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
    const item = writeQueue.shift();
    if (!item) return;
    writing = true;
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
    write(item.command).catch((error: unknown) => {
      if (pending.delete(item.requestId)) {
        item.settled = true;
        item.cleanup();
        item.reject(error);
      }
      disconnect(error);
    });
  };
  const reportListenerError = (error: unknown) => stderr.write?.(`bridge listener: ${messageOf(error)}\n`);
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
      Promise.resolve(onEvent?.(event)).catch(reportListenerError);
    } catch (error) {
      reportListenerError(error);
    }
    for (const fn of listeners.get(event.name) ?? []) {
      try {
        Promise.resolve(fn(event.payload)).catch(reportListenerError);
      } catch (error) {
        reportListenerError(error);
      }
    }
  };
  const handle = (raw: unknown): Promise<void> | void => {
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
    const type = readProperty(raw, "type");
    if (type === "event") return dispatchEvent(checked(EventSchema, raw, "invalid event"));
    if (type === "response") {
      const parsed = checked(ResponseSchema, raw, "invalid response");
      if (parsed.name === "protocolError") {
        const error = responseError(parsed);
        throw Object.assign(new BridgeProtocolError(error.message), {
          code: error.code,
          details: error.details,
        });
      }
      const item = pending.get(parsed.requestId);
      if (!item || item.name !== parsed.name) throw new BridgeProtocolError("invalid or unknown response");
      item.settled = true;
      pending.delete(parsed.requestId);
      item.cleanup();
      mutationBusy = false;
      if (parsed.ok) item.resolve(parsed.result);
      else {
        const error = responseError(parsed);
        item.reject(Object.assign(new Error(error.message), { code: error.code, details: error.details }));
      }
      pumpCommands();
      return;
    }
    throw new BridgeProtocolError("unexpected message");
  };
  const onData = (chunk: Uint8Array) => {
    try {
      buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
      const out = decodeFrames(buffer, effectiveMax);
      buffer = out.remainder;
      for (const raw of out.frames)
        Promise.resolve(handle(raw)).catch((error: unknown) => {
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
    request(name: string, params: BridgePayload, { signal, timeoutMs = commandTimeoutMs }: BridgeRequestOptions = {}) {
      if (!hello || !isCommandName(name) || !hello.commands.includes(name))
        return Promise.reject(new BridgeUnavailableError(`unsupported bridge command: ${name}`));
      const commandName = name;
      let command: BridgeCommand;
      try {
        command = checked(
          CommandSchema,
          { protocol: PROTOCOL, type: "command", requestId: randomUUID(), name: commandName, params },
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
        const cleanup = () => {
          clearTimeout(item.timer);
          if (item.abortHandler) {
            signal?.removeEventListener("abort", item.abortHandler);
            item.abortHandler = null;
          }
        };
        const item: PendingCommand = {
          requestId: command.requestId,
          name: commandName,
          command,
          resolve,
          reject,
          timer: undefined,
          abortHandler: null,
          cleanup,
          settled: false,
          started: false,
        };
        const failIndeterminate = (code: string, reason: unknown = null) => {
          if (item.settled) return;
          item.settled = true;
          cleanup();
          if (pending.delete(item.requestId) || commandQueue.includes(item)) {
            const i = commandQueue.indexOf(item);
            if (i >= 0) commandQueue.splice(i, 1);
            item.reject(reason ?? Object.assign(new Error(`bridge command timed out: ${commandName}`), { code }));
          }
          if (item.started) disconnect(Object.assign(new Error("mutation completion is indeterminate"), { code }));
        };
        item.timer = setTimeout(() => failIndeterminate("TIMEOUT"), timeoutMs);
        if (signal?.aborted) {
          item.settled = true;
          cleanup();
          reject(
            signal.reason ?? Object.assign(new Error(`bridge command aborted: ${commandName}`), { code: "ABORT_ERR" }),
          );
          return;
        }
        item.abortHandler = () => failIndeterminate("ABORT_ERR", signal?.reason);
        signal?.addEventListener("abort", item.abortHandler, { once: true });
        commandQueue.push(item);
        pumpCommands();
      });
    },
    on(name, listener) {
      if (!isEventName(name)) throw new BridgeProtocolError("invalid event name");
      const set = listeners.get(name) ?? new Set();
      set.add(listener);
      listeners.set(name, set);
      return () => {
        set.delete(listener);
        if (!set.size) listeners.delete(name);
      };
    },
    emitEvent(name, payload) {
      if (!isEventName(name) || !hello?.events.includes(name))
        return Promise.reject(new BridgeUnavailableError("unsupported bridge event"));
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

const NATIVE_HOST_DIRS: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {
  darwin: {
    chrome: ["Library", "Application Support", "Google", "Chrome"],
    chromium: ["Library", "Application Support", "Chromium"],
  },
  linux: { chrome: [".config", "google-chrome"], chromium: [".config", "chromium"] },
};
export function defaultNativeMessagingHostDir(browser = "chrome", platform: string = process.platform) {
  const byBrowser = NATIVE_HOST_DIRS[platform];
  if (!byBrowser)
    throw new BridgeProtocolError(`no default nativeMessagingHostDir on ${platform}; pass nativeMessagingHostDir`);
  const segments = byBrowser[browser];
  if (!segments) throw new BridgeProtocolError("custom browser requires nativeMessagingHostDir");
  return path.join(homedir(), ...segments, "NativeMessagingHosts");
}
async function secureDirectory(dir: string) {
  const absolute = path.resolve(dir);
  const parts = absolute.split(path.sep).filter(Boolean);
  let current = path.parse(absolute).root;
  let final: Stats | undefined;
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    let info = await lstat(current).catch(() => null);
    if (!info) {
      await mkdir(current, { mode: 0o700 });
      info = await lstat(current);
    }
    if (current !== "/var" && (info.isSymbolicLink() || !info.isDirectory()))
      throw new BridgeProtocolError("nativeMessagingHostDir security rejected");
    if (current !== "/var" && info.uid !== process.getuid?.() && info.uid !== 0)
      throw new BridgeProtocolError("nativeMessagingHostDir ownership rejected");
    const stickyRootAncestor = index < parts.length - 1 && info.uid === 0 && (info.mode & 0o1000) !== 0;
    if (current !== "/var" && !stickyRootAncestor && (info.mode & 0o022) !== 0)
      throw new BridgeProtocolError("nativeMessagingHostDir security rejected");
    final = info;
  }
  if (!final || (final.uid !== process.getuid?.() && final.uid !== 0))
    throw new BridgeProtocolError("nativeMessagingHostDir ownership rejected");
  if ((final.mode & 0o077) !== 0) await chmod(absolute, 0o700);
}
async function secureExecutable(hostPath: string) {
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
export async function installNativeMessagingHost(
  options: InstallNativeMessagingHostOptions,
): Promise<{ path: string; manifest: NativeHostManifest }>;
export async function installNativeMessagingHost({
  hostName = HOST_NAME,
  hostPath,
  extensionId,
  browser = "chrome",
  nativeMessagingHostDir,
  force = false,
  endpointPath,
}: Partial<InstallNativeMessagingHostOptions> = {}): Promise<{ path: string; manifest: NativeHostManifest }> {
  if (endpointPath !== undefined) throw new BridgeProtocolError("endpointPath is not supported");
  if (hostName !== HOST_NAME || !/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(hostName))
    throw new BridgeProtocolError("invalid hostName");
  const executablePath = hostPath ?? "";
  if (!path.isAbsolute(executablePath)) throw new BridgeProtocolError("hostPath must be absolute");
  await secureExecutable(executablePath);
  if (!/^[a-p]{32}$/.test(extensionId ?? "")) throw new BridgeProtocolError("invalid extensionId");
  if (!nativeMessagingHostDir && browser === "cloakbrowser")
    throw new BridgeProtocolError("CloakBrowser nativeMessagingHostDir must be explicit and verified");
  const dir = nativeMessagingHostDir ?? defaultNativeMessagingHostDir(browser);
  await secureDirectory(dir);
  const manifest: NativeHostManifest = {
    name: hostName,
    description: "OmOWright internal CloakBrowser native messaging bridge.",
    path: executablePath,
    type: "stdio",
    allowed_origins: [`chrome-extension://${extensionId}/`],
  };
  const file = path.join(dir, `${hostName}.json`);
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
  // JSON boundary: the file is the manifest written above, read back to prove what landed on disk.
  const parsed = JSON.parse(await readFile(file, "utf8")) as NativeHostManifest;
  await chmod(file, 0o600);
  return { path: file, manifest: parsed };
}
export function createBridgeClient(options: NativeMessagingHostOptions) {
  return createNativeMessagingHost(options);
}

type CommandDetails<K extends CommandName> = z.input<(typeof commandParams)[K]>["details"];
type TabGroupUpdateProperties = CommandDetails<"tabGroups.update">["updateProperties"];
type BridgeEventNamespace = "notifications" | "tabGroups" | "tabs" | "windows";
type BridgeEventListener = (...args: unknown[]) => unknown;

export interface ChromeBridge {
  isConnected?: boolean;
  capabilities?: { commands?: ReadonlySet<string> };
  request(name: CommandName, params: BridgePayload): Promise<unknown>;
  on?(name: string, listener: BridgeListener): () => void;
}

export interface BridgeChromeApiOptions extends ChromeApiOptions {
  bridge?: ChromeBridge;
}

function listenerArgs(namespace: BridgeEventNamespace, event: string, payload: BridgePayload): unknown[] {
  return namespace === "notifications" && event === "onClosed"
    ? [payload.notificationId, payload.byUser]
    : namespace === "notifications"
      ? [payload.notificationId]
      : namespace === "tabGroups"
        ? [payload.group]
        : namespace === "windows"
          ? [payload.windowId]
          : [payload];
}

export function createChromeApi(connection: ChromeConnection, options: BridgeChromeApiOptions = {}) {
  const chrome = createStandaloneChromeApi(connection, options);
  const bridge = options.bridge;
  const request = (wire: CommandName, params: BridgePayload) =>
    bridge?.isConnected && bridge.capabilities?.commands?.has(wire)
      ? bridge.request(wire, params)
      : Promise.reject(
          new UnsupportedOperationError(`chrome.${wire} requires the extension bridge in standalone OmOWright`),
        );
  const bridgeEvent = (namespace: BridgeEventNamespace, event: string) => {
    const wire = `${namespace}.${event.slice(2, 3).toLowerCase() + event.slice(3)}`;
    const subscriptions = new Map<BridgeEventListener, () => void>();
    return {
      addListener(listener: BridgeEventListener) {
        if (!bridge?.on) return undefined;
        const unsubscribe = bridge.on(wire, (payload) => listener(...listenerArgs(namespace, event, payload)));
        subscriptions.set(listener, unsubscribe);
        return unsubscribe;
      },
      removeListener(listener: BridgeEventListener) {
        const unsubscribe = subscriptions.get(listener);
        if (unsubscribe) {
          unsubscribe();
          subscriptions.delete(listener);
        }
      },
    };
  };
  const bookmarkWrites = {
    create: (details: CommandDetails<"bookmarks.create">) => request("bookmarks.create", { details }),
    move: (id: string | number, details: Omit<CommandDetails<"bookmarks.move">, "id"> = {}) =>
      request("bookmarks.move", { details: { ...details, id: String(id) } }),
    remove: (id: string | number) => request("bookmarks.remove", { details: { id: String(id) } }),
  };
  const historyWrites = {
    deleteUrl: (details: CommandDetails<"history.deleteUrl">) => request("history.deleteUrl", { details }),
    deleteRange: (details: CommandDetails<"history.deleteRange">) => request("history.deleteRange", { details }),
  };
  const bookmarks: Omit<typeof chrome.bookmarks, keyof typeof bookmarkWrites> & typeof bookmarkWrites = Object.assign(
    chrome.bookmarks,
    bookmarkWrites,
  );
  const history: Omit<typeof chrome.history, keyof typeof historyWrites> & typeof historyWrites = Object.assign(
    chrome.history,
    historyWrites,
  );
  const tabGroups = {
    update: (groupId: number, updateProperties: TabGroupUpdateProperties) =>
      request("tabGroups.update", { details: { groupId, updateProperties } }),
    onCreated: bridgeEvent("tabGroups", "onCreated"),
    onUpdated: bridgeEvent("tabGroups", "onUpdated"),
    onMoved: bridgeEvent("tabGroups", "onMoved"),
  };
  const debuggerApi = {
    attach: (target: number | { tabId?: number }, requiredVersion: string) =>
      request("debugger.attach", {
        details: { tabId: typeof target === "number" ? target : (target.tabId ?? target), requiredVersion },
      }),
    detach: (target: number | { tabId?: number }) =>
      request("debugger.detach", {
        details: { tabId: typeof target === "number" ? target : (target.tabId ?? target) },
      }),
  };
  const notifications = {
    onShown: bridgeEvent("notifications", "onShown"),
    onClicked: bridgeEvent("notifications", "onClicked"),
    onClosed: bridgeEvent("notifications", "onClosed"),
  };
  const tabs = Object.assign(chrome.tabs, { onActivated: bridgeEvent("tabs", "onActivated") });
  const windows = Object.assign(chrome.windows, { onFocusChanged: bridgeEvent("windows", "onFocusChanged") });
  return Object.assign(chrome, { bookmarks, history, tabGroups, debugger: debuggerApi, notifications, tabs, windows });
}
