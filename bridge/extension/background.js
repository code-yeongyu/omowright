const HOST_NAME = "com.omowright.cloakbridge";
const PROTOCOL = 1;
const MAX_MESSAGE_BYTES = 1048576;
const EVENTS = ["notifications.shown", "notifications.clicked", "notifications.closed", "tabGroups.created", "tabGroups.updated", "tabGroups.moved", "tabs.activated", "windows.focusChanged"];
const COMMANDS = ["bookmarks.create", "bookmarks.move", "bookmarks.remove", "history.deleteUrl", "history.deleteRange", "tabGroups.update", "debugger.attach", "debugger.detach"];
const COMMAND_BINDINGS = Object.freeze({
  "bookmarks.create": details => chrome.bookmarks.create(details), "bookmarks.move": details => chrome.bookmarks.move(details.id, details), "bookmarks.remove": details => chrome.bookmarks.remove(details.id),
  "history.deleteUrl": details => chrome.history.deleteUrl(details), "history.deleteRange": details => chrome.history.deleteRange(details), "tabGroups.update": details => chrome.tabGroups.update(details.groupId, details.updateProperties),
  "debugger.attach": details => chrome.debugger.attach({ tabId: details.tabId }, details.requiredVersion).then(() => ({ tabId: details.tabId, attached: true, requiredVersion: details.requiredVersion })),
  "debugger.detach": details => chrome.debugger.detach({ tabId: details.tabId }).then(() => ({ tabId: details.tabId, detached: true }))
});
const EVENT_BINDINGS = [
  [chrome.notifications.onShown, "notifications.shown", id => ({ notificationId: id })], [chrome.notifications.onClicked, "notifications.clicked", id => ({ notificationId: id })], [chrome.notifications.onClosed, "notifications.closed", (id, byUser) => ({ notificationId: id, byUser })],
  [chrome.tabGroups.onCreated, "tabGroups.created", group => ({ group })], [chrome.tabGroups.onUpdated, "tabGroups.updated", group => ({ group })], [chrome.tabGroups.onMoved, "tabGroups.moved", group => ({ group })], [chrome.tabs.onActivated, "tabs.activated", info => info], [chrome.windows.onFocusChanged, "windows.focusChanged", id => ({ windowId: id })]
];
const makeId = () => crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
const validId = value => typeof value === "string" && /^[0-9a-fA-F-]{16,128}$/.test(value);
const validUrl = value => { if (typeof value !== "string" || value.length > 8192) return false; try { return ["http:", "https:", "ftp:", "file:", "data:", "javascript:", "chrome:", "chrome-extension:"].includes(new URL(value).protocol); } catch { return false; } };
const plain = value => value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value, allowed, required = []) => plain(value) && Object.keys(value).every(key => allowed.includes(key)) && required.every(key => Object.hasOwn(value, key));
const validDetails = (name, details) => {
  const shapes = {
    "bookmarks.create": () => exact(details, ["parentId", "index", "title", "url"], ["title"]) && typeof details.title === "string" && details.title.length <= 8192 && (details.parentId === undefined || (typeof details.parentId === "string" && details.parentId.length > 0)) && (details.index === undefined || Number.isInteger(details.index) && details.index >= 0) && (details.url === undefined || validUrl(details.url)),
    "bookmarks.move": () => exact(details, ["id", "parentId", "index"], ["id"]) && typeof details.id === "string" && details.id.length > 0 && (details.parentId === undefined || typeof details.parentId === "string" && details.parentId.length > 0) && (details.index === undefined || Number.isInteger(details.index) && details.index >= 0),
    "bookmarks.remove": () => exact(details, ["id"], ["id"]) && typeof details.id === "string" && details.id.length > 0,
    "history.deleteUrl": () => exact(details, ["url"], ["url"]) && validUrl(details.url),
    "history.deleteRange": () => exact(details, ["startTime", "endTime"], ["startTime", "endTime"]) && Number.isFinite(details.startTime) && details.startTime >= 0 && Number.isFinite(details.endTime) && details.endTime >= details.startTime,
    "tabGroups.update": () => exact(details, ["groupId", "updateProperties"], ["groupId", "updateProperties"]) && Number.isInteger(details.groupId) && details.groupId >= 0 && exact(details.updateProperties, ["collapsed", "color", "title"]) && Object.keys(details.updateProperties).length > 0 && (details.updateProperties.collapsed === undefined || typeof details.updateProperties.collapsed === "boolean") && (details.updateProperties.color === undefined || ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"].includes(details.updateProperties.color)) && (details.updateProperties.title === undefined || details.updateProperties.title === null || typeof details.updateProperties.title === "string" && details.updateProperties.title.length <= 1024),
    "debugger.attach": () => exact(details, ["tabId", "requiredVersion"], ["tabId", "requiredVersion"]) && Number.isInteger(details.tabId) && details.tabId >= 0 && typeof details.requiredVersion === "string" && /^\d+\.\d+$/.test(details.requiredVersion),
    "debugger.detach": () => exact(details, ["tabId"], ["tabId"]) && Number.isInteger(details.tabId) && details.tabId >= 0
  };
  return COMMANDS.includes(name) && shapes[name]?.();
};
let port; let connectionId; let sequence = 0; let capabilities = new Set(); let negotiatedMax = MAX_MESSAGE_BYTES; let epoch = 0; let retryTimer; let retries = 0;
const seen = new Set(); const pending = new Map();
const response = (request, ok, value, name) => ({ protocol: PROTOCOL, type: "response", requestId: request.requestId, name: COMMANDS.includes(name) ? name : "", ok, ...(ok ? { result: value } : { error: value }) });
const errorFor = error => ({ code: error?.code === "DEBUGGER_ERROR" ? "DEBUGGER_ERROR" : "CHROME_ERROR", message: error?.code === "DEBUGGER_ERROR" ? "debugger operation failed" : "Chrome operation failed" });
const withinLimit = message => { try { return new TextEncoder().encode(JSON.stringify(message)).length <= negotiatedMax; } catch { return false; } };
const safePost = (message, expected = port) => { if (!expected || expected !== port || !withinLimit(message)) return false; try { expected.postMessage(message); return true; } catch { return false; } };
function rejectPending() { for (const item of pending.values()) item.reject(Object.assign(new Error("native host disconnected"), { code: "NATIVE_HOST_DISCONNECTED" })); pending.clear(); }
function emit(name, wrap, args) { if (!port || !capabilities.events.has(name)) return; const current = port; sequence += 1; if (!safePost({ protocol: PROTOCOL, type: "event", connectionId, seq: sequence, occurredAt: Date.now(), name, payload: wrap(...args) }, current)) rejectPending(); }
function scheduleReconnect() { if (retryTimer || retries >= 6) return; const delay = Math.min(1000 * 2 ** retries++, 30000); retryTimer = setTimeout(() => { retryTimer = undefined; connect(); }, delay); }
function connect() {
  const current = chrome.runtime.connectNative(HOST_NAME); port = current; const currentEpoch = ++epoch; connectionId = makeId(); sequence = 0; capabilities = { events: new Set(), commands: new Set() }; negotiatedMax = MAX_MESSAGE_BYTES;
  safePost({ protocol: PROTOCOL, type: "hello", role: "extension", connectionId, extensionId: chrome.runtime.id, extensionVersion: chrome.runtime.getManifest().version, events: EVENTS, commands: COMMANDS, maxMessageBytes: MAX_MESSAGE_BYTES }, current);
  current.onMessage.addListener(async message => {
    try {
      if (current !== port || currentEpoch !== epoch) return;
      if (message?.type === "hello") { if (message.protocol !== PROTOCOL || message.role !== "host" || message.hostName !== HOST_NAME || !validId(message.connectionId) || typeof message.hostVersion !== "string" || !message.hostVersion.length || message.hostVersion.length > 64 || !Array.isArray(message.commands) || !Array.isArray(message.events) || !Number.isInteger(message.maxMessageBytes) || message.maxMessageBytes < 1 || message.maxMessageBytes > MAX_MESSAGE_BYTES || new Set(message.commands).size !== message.commands.length || new Set(message.events).size !== message.events.length || !message.commands.every(x => COMMANDS.includes(x)) || !message.events.every(x => EVENTS.includes(x))) throw new Error("invalid hello"); capabilities = { commands: new Set(message.commands), events: new Set(message.events) }; negotiatedMax = Math.min(MAX_MESSAGE_BYTES, message.maxMessageBytes); return; }
      if (message?.type !== "command") { if (validId(message?.requestId)) safePost(response(message, false, { code: "INVALID_MESSAGE", message: "invalid command" }, message?.name), current); return; }
      const name = message.name; const valid = message.protocol === PROTOCOL && validId(message.requestId) && COMMANDS.includes(name) && capabilities.commands.has(name) && plain(message.params) && exact(message.params, ["details"], ["details"]) && validDetails(name, message.params.details) && !seen.has(message.requestId);
      if (!valid) { if (validId(message.requestId)) safePost(response(message, false, { code: COMMANDS.includes(name) && !capabilities.commands.has(name) ? "UNSUPPORTED_COMMAND" : "INVALID_MESSAGE", message: "invalid command" }, name), current); return; }
      seen.add(message.requestId); pending.set(message.requestId, { reject: () => {} }); const result = await COMMAND_BINDINGS[name](message.params.details); pending.delete(message.requestId); if (current === port && currentEpoch === epoch) safePost(response(message, true, result === undefined ? {} : result, name), current);
    } catch (error) { pending.delete(message?.requestId); if (current === port && currentEpoch === epoch && message?.type === "command" && validId(message.requestId)) safePost(response(message, false, errorFor(error), message.name), current); }
  });
  current.onDisconnect.addListener(() => { void chrome.runtime.lastError; if (current !== port || currentEpoch !== epoch) return; port = undefined; capabilities = { events: new Set(), commands: new Set() }; rejectPending(); scheduleReconnect(); });
}
for (const [event, name, wrap] of EVENT_BINDINGS) event.addListener((...args) => emit(name, wrap, args));
connect();
