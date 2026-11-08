import type { ChromeApi, ChromeEvent, NativePort } from "./chrome-api.ts";
import {
  COMMANDS,
  EVENTS,
  HOST_NAME,
  MAX_MESSAGE_BYTES,
  PROTOCOL,
  PROTOCOL_ERROR_NAME,
  exact,
  isCommandName,
  isEventName,
  isList,
  plain,
  validDetails,
  validId,
} from "./protocol.ts";
import type { CommandDetails, CommandName, EventName, UntrustedRecord } from "./protocol.ts";

declare const chrome: ChromeApi;

interface Capabilities {
  events: Set<EventName>;
  commands: Set<CommandName>;
}

interface EventBinding {
  attach(): void;
}

const COMMAND_BINDINGS: { readonly [N in CommandName]: (details: CommandDetails[N]) => Promise<unknown> } =
  Object.freeze({
    "bookmarks.create": (details: CommandDetails["bookmarks.create"]) => chrome.bookmarks.create(details),
    "bookmarks.move": (details: CommandDetails["bookmarks.move"]) => chrome.bookmarks.move(details.id, details),
    "bookmarks.remove": (details: CommandDetails["bookmarks.remove"]) => chrome.bookmarks.remove(details.id),
    "history.deleteUrl": (details: CommandDetails["history.deleteUrl"]) => chrome.history.deleteUrl(details),
    "history.deleteRange": (details: CommandDetails["history.deleteRange"]) => chrome.history.deleteRange(details),
    "tabGroups.update": (details: CommandDetails["tabGroups.update"]) =>
      chrome.tabGroups.update(details.groupId, details.updateProperties),
    "debugger.attach": (details: CommandDetails["debugger.attach"]) =>
      chrome.debugger
        .attach({ tabId: details.tabId }, details.requiredVersion)
        .then(() => ({ tabId: details.tabId, attached: true, requiredVersion: details.requiredVersion })),
    "debugger.detach": (details: CommandDetails["debugger.detach"]) =>
      chrome.debugger.detach({ tabId: details.tabId }).then(() => ({ tabId: details.tabId, detached: true })),
  });
const runCommand = <N extends CommandName>(name: N, details: CommandDetails[N]): Promise<unknown> =>
  COMMAND_BINDINGS[name](details);

const bindEvent = <A extends unknown[]>(
  event: ChromeEvent<A>,
  name: EventName,
  wrap: (...args: A) => unknown,
): EventBinding => ({ attach: () => event.addListener((...args: A) => emit(name, wrap, args)) });
const EVENT_BINDINGS: readonly EventBinding[] = [
  bindEvent(chrome.notifications.onShown, "notifications.shown", (id) => ({ notificationId: id })),
  bindEvent(chrome.notifications.onClicked, "notifications.clicked", (id) => ({ notificationId: id })),
  bindEvent(chrome.notifications.onClosed, "notifications.closed", (id, byUser) => ({ notificationId: id, byUser })),
  bindEvent(chrome.tabGroups.onCreated, "tabGroups.created", (group) => ({ group })),
  bindEvent(chrome.tabGroups.onUpdated, "tabGroups.updated", (group) => ({ group })),
  bindEvent(chrome.tabGroups.onMoved, "tabGroups.moved", (group) => ({ group })),
  bindEvent(chrome.tabs.onActivated, "tabs.activated", (info) => info),
  bindEvent(chrome.windows.onFocusChanged, "windows.focusChanged", (id) => ({ windowId: id })),
];

const isObject = (value: unknown): value is UntrustedRecord => typeof value === "object" && value !== null;
const asRecord = (value: unknown): UntrustedRecord | undefined => (isObject(value) ? value : undefined);
const makeId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);
const emptyCapabilities = (): Capabilities => ({ events: new Set(), commands: new Set() });

let port: NativePort | undefined;
let connectionId: string | undefined;
let sequence = 0;
let capabilities = emptyCapabilities();
let negotiatedMax = MAX_MESSAGE_BYTES;
let epoch = 0;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let retries = 0;
const seen = new Set<string>();
const pending = new Map<unknown, { reject(error: Error): void }>();

const responseName = (name: unknown) => (isCommandName(name) ? name : PROTOCOL_ERROR_NAME);
const response = (request: UntrustedRecord, ok: boolean, value: unknown, name: unknown) => ({
  protocol: PROTOCOL,
  type: "response",
  requestId: request.requestId,
  name: responseName(name),
  ok,
  ...(ok ? { result: value } : { error: value }),
});
const errorFor = (error: unknown) => {
  const debuggerFailure = asRecord(error)?.code === "DEBUGGER_ERROR";
  return {
    code: debuggerFailure ? "DEBUGGER_ERROR" : "CHROME_ERROR",
    message: debuggerFailure ? "debugger operation failed" : "Chrome operation failed",
  };
};
const withinLimit = (message: unknown) => {
  try {
    return new TextEncoder().encode(JSON.stringify(message)).length <= negotiatedMax;
  } catch {
    return false;
  }
};
const safePost = (message: unknown, expected = port) => {
  if (!expected || expected !== port || !withinLimit(message)) return false;
  try {
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- chrome.runtime.Port.postMessage takes no targetOrigin.
    expected.postMessage(message);
    return true;
  } catch {
    return false;
  }
};
function rejectPending() {
  for (const item of pending.values())
    item.reject(Object.assign(new Error("native host disconnected"), { code: "NATIVE_HOST_DISCONNECTED" }));
  pending.clear();
}
function emit<A extends unknown[]>(name: EventName, wrap: (...args: A) => unknown, args: A) {
  if (!port || !capabilities.events.has(name)) return;
  const current = port;
  sequence += 1;
  const event = {
    protocol: PROTOCOL,
    type: "event",
    connectionId,
    seq: sequence,
    occurredAt: Date.now(),
    name,
    payload: wrap(...args),
  };
  if (!safePost(event, current)) rejectPending();
}
function scheduleReconnect() {
  if (retryTimer) return;
  if (retries >= 6) console.warn("Cloak bridge remains disconnected; retrying at maximum backoff");
  const delay = Math.min(1000 * 2 ** retries, 30000);
  retries += 1;
  retryTimer = setTimeout(() => {
    retryTimer = undefined;
    connect();
  }, delay);
}
function acceptHello(message: UntrustedRecord) {
  const { commands, events, hostVersion, maxMessageBytes } = message;
  if (
    message.protocol !== PROTOCOL ||
    message.role !== "host" ||
    message.hostName !== HOST_NAME ||
    !validId(message.connectionId) ||
    typeof hostVersion !== "string" ||
    !hostVersion.length ||
    hostVersion.length > 64 ||
    !isList(commands) ||
    !isList(events) ||
    typeof maxMessageBytes !== "number" ||
    !Number.isInteger(maxMessageBytes) ||
    maxMessageBytes < 1 ||
    maxMessageBytes > MAX_MESSAGE_BYTES ||
    new Set(commands).size !== commands.length ||
    new Set(events).size !== events.length ||
    !commands.every(isCommandName) ||
    !events.every(isEventName)
  )
    throw new Error("invalid hello");
  capabilities = { commands: new Set(commands), events: new Set(events) };
  retries = 0;
  negotiatedMax = Math.min(MAX_MESSAGE_BYTES, maxMessageBytes);
}
function connect() {
  const current = chrome.runtime.connectNative(HOST_NAME);
  port = current;
  const currentEpoch = ++epoch;
  connectionId = makeId();
  sequence = 0;
  capabilities = emptyCapabilities();
  negotiatedMax = MAX_MESSAGE_BYTES;
  const hello = {
    protocol: PROTOCOL,
    type: "hello",
    role: "extension",
    connectionId,
    extensionId: chrome.runtime.id,
    extensionVersion: chrome.runtime.getManifest().version,
    events: EVENTS,
    commands: COMMANDS,
    maxMessageBytes: MAX_MESSAGE_BYTES,
  };
  safePost(hello, current);
  current.onMessage.addListener(async (received) => {
    const message = asRecord(received);
    try {
      if (current !== port || currentEpoch !== epoch) return;
      if (message?.type === "hello") return acceptHello(message);
      if (message?.type !== "command") {
        if (validId(message?.requestId))
          safePost(
            response(message, false, { code: "INVALID_MESSAGE", message: "invalid command" }, message.name),
            current,
          );
        return;
      }
      const { name, params, requestId } = message;
      const details = plain(params) && exact(params, ["details"], ["details"]) ? params.details : undefined;
      if (
        !(
          message.protocol === PROTOCOL &&
          validId(requestId) &&
          isCommandName(name) &&
          capabilities.commands.has(name) &&
          validDetails(name, details) &&
          !seen.has(requestId)
        )
      ) {
        if (validId(requestId)) {
          const unsupported = isCommandName(name) && !capabilities.commands.has(name);
          const error = { code: unsupported ? "UNSUPPORTED_COMMAND" : "INVALID_MESSAGE", message: "invalid command" };
          safePost(response(message, false, error, name), current);
        }
        return;
      }
      seen.add(requestId);
      pending.set(requestId, { reject: () => {} });
      const result = await runCommand(name, details);
      pending.delete(requestId);
      if (current === port && currentEpoch === epoch)
        safePost(response(message, true, result === undefined ? {} : result, name), current);
    } catch (error) {
      pending.delete(message?.requestId);
      if (current === port && currentEpoch === epoch && message?.type === "command" && validId(message.requestId))
        safePost(response(message, false, errorFor(error), message.name), current);
    }
  });
  current.onDisconnect.addListener(() => {
    void chrome.runtime.lastError;
    if (current !== port || currentEpoch !== epoch) return;
    port = undefined;
    capabilities = emptyCapabilities();
    rejectPending();
    scheduleReconnect();
  });
}
for (const binding of EVENT_BINDINGS) binding.attach();
connect();
