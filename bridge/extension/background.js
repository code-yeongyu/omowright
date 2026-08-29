const HOST_NAME = "com.omowright.cloakbridge";
const PROTOCOL = 1;
const EVENTS = ["notifications.shown", "notifications.clicked", "notifications.closed", "tabGroups.created", "tabGroups.updated", "tabGroups.moved", "tabs.activated", "windows.focusChanged"];
const COMMANDS = ["bookmarks.create", "bookmarks.move", "bookmarks.remove", "history.deleteUrl", "history.deleteRange", "tabGroups.update", "debugger.attach", "debugger.detach"];
const COMMAND_BINDINGS = Object.freeze({
  "bookmarks.create": details => chrome.bookmarks.create(details), "bookmarks.move": details => chrome.bookmarks.move(details.id, details), "bookmarks.remove": details => chrome.bookmarks.remove(details.id),
  "history.deleteUrl": details => chrome.history.deleteUrl(details), "history.deleteRange": details => chrome.history.deleteRange(details), "tabGroups.update": details => chrome.tabGroups.update(details.groupId, details.updateProperties),
  "debugger.attach": details => chrome.debugger.attach({ tabId: details.tabId }, details.requiredVersion).then(() => ({ tabId: details.tabId, attached: true, requiredVersion: details.requiredVersion })),
  "debugger.detach": details => chrome.debugger.detach({ tabId: details.tabId }).then(() => ({ tabId: details.tabId, detached: true }))
});
const EVENT_BINDINGS = [
  [chrome.notifications.onShown, "notifications.shown", notificationId => ({ notificationId })], [chrome.notifications.onClicked, "notifications.clicked", notificationId => ({ notificationId })], [chrome.notifications.onClosed, "notifications.closed", (notificationId, byUser) => ({ notificationId, byUser })],
  [chrome.tabGroups.onCreated, "tabGroups.created", group => ({ group })], [chrome.tabGroups.onUpdated, "tabGroups.updated", group => ({ group })], [chrome.tabGroups.onMoved, "tabGroups.moved", group => ({ group })], [chrome.tabs.onActivated, "tabs.activated", info => info], [chrome.windows.onFocusChanged, "windows.focusChanged", windowId => ({ windowId })]
];
const makeId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);
const validId = value => typeof value === "string" && /^[0-9a-fA-F-]{16,128}$/.test(value);
const validDetails = (name, details) => {
  if (!details || typeof details !== "object" || Array.isArray(details)) return false;
  const required = { "bookmarks.create": ["title"], "bookmarks.move": ["id"], "bookmarks.remove": ["id"], "history.deleteUrl": ["url"], "history.deleteRange": ["startTime", "endTime"], "tabGroups.update": ["groupId", "updateProperties"], "debugger.attach": ["tabId", "requiredVersion"], "debugger.detach": ["tabId"] }[name];
  return COMMANDS.includes(name) && required?.every(key => Object.hasOwn(details, key));
};
let port; let connectionId; let sequence; let capabilities = new Set(); let reconnecting = false;
const seen = new Set(); const pending = new Map();
function response(request, ok, value, name = COMMANDS[0]) { return { protocol: PROTOCOL, type: "response", requestId: request.requestId, name: COMMANDS.includes(name) ? name : COMMANDS[0], ok, ...(ok ? { result: value } : { error: value }) }; }
function errorFor(error) { const code = error?.code === "DEBUGGER_ERROR" ? "DEBUGGER_ERROR" : "CHROME_ERROR"; return { code, message: code === "DEBUGGER_ERROR" ? "debugger operation failed" : "Chrome operation failed" }; }
function safePost(message) { if (!port) return false; try { port.postMessage(message); return true; } catch { return false; } }
function rejectPending() { for (const item of pending.values()) item.reject(Object.assign(new Error("native host disconnected"), { code: "NATIVE_HOST_DISCONNECTED" })); pending.clear(); }
function emit(name, wrap, args) { if (!port) return; sequence += 1; if (!safePost({ protocol: PROTOCOL, type: "event", connectionId, seq: sequence, occurredAt: Date.now(), name, payload: wrap(...args) })) rejectPending(); }
function connect() {
  reconnecting = false; port = chrome.runtime.connectNative(HOST_NAME); connectionId = makeId(); sequence = 0; capabilities = new Set();
  safePost({ protocol: PROTOCOL, type: "hello", role: "extension", connectionId, extensionId: chrome.runtime.id, extensionVersion: chrome.runtime.getManifest().version, events: EVENTS, commands: COMMANDS, maxMessageBytes: 1048576 });
  for (const [event, name, wrap] of EVENT_BINDINGS) event.addListener((...args) => emit(name, wrap, args));
  port.onMessage.addListener(async message => {
    try {
      if (message?.type === "hello") { if (message.protocol !== PROTOCOL || message.role !== "host" || message.hostName !== HOST_NAME || !validId(message.connectionId) || !Array.isArray(message.commands) || !Array.isArray(message.events) || !message.commands.every(x => COMMANDS.includes(x)) || !message.events.every(x => EVENTS.includes(x))) throw new Error("invalid hello"); capabilities = new Set(message.commands); return; }
      if (message?.type !== "command") { if (message?.requestId) safePost(response(message, false, { code: "INVALID_MESSAGE", message: "invalid command" })); return; }
      const valid = message.protocol === PROTOCOL && validId(message.requestId) && COMMANDS.includes(message.name) && capabilities.has(message.name) && validDetails(message.name, message.params?.details) && !seen.has(message.requestId);
      if (!valid) { if (validId(message.requestId)) safePost(response(message, false, { code: COMMANDS.includes(message.name) && !capabilities.has(message.name) ? "UNSUPPORTED_COMMAND" : "INVALID_MESSAGE", message: "invalid command" }, message.name)); return; }
      seen.add(message.requestId); const operation = COMMAND_BINDINGS[message.name]; const result = await operation(message.params.details); if (port) safePost(response(message, true, result === undefined ? {} : result));
    } catch (error) { if (message?.type === "command" && validId(message.requestId)) safePost(response(message, false, errorFor(error), message.name)); }
  });
  port.onDisconnect.addListener(() => { void chrome.runtime.lastError; rejectPending(); if (!reconnecting) { reconnecting = true; connect(); } });
}
connect();
