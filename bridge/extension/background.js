const HOST_NAME = "com.omowright.cloakbridge";
const PROTOCOL = 1;
const EVENTS = ["notifications.shown", "notifications.clicked", "notifications.closed", "tabGroups.created", "tabGroups.updated", "tabGroups.moved", "tabs.activated", "windows.focusChanged"];
const COMMANDS = ["bookmarks.create", "bookmarks.move", "bookmarks.remove", "history.deleteUrl", "history.deleteRange", "tabGroups.update", "debugger.attach", "debugger.detach"];
const COMMAND_BINDINGS = Object.freeze({
  "bookmarks.create": details => chrome.bookmarks.create(details),
  "bookmarks.move": details => chrome.bookmarks.move(details.id, details),
  "bookmarks.remove": details => chrome.bookmarks.remove(details.id),
  "history.deleteUrl": details => chrome.history.deleteUrl(details),
  "history.deleteRange": details => chrome.history.deleteRange(details),
  "tabGroups.update": details => chrome.tabGroups.update(details.groupId, details.updateProperties),
  "debugger.attach": details => chrome.debugger.attach({ tabId: details.tabId }, details.requiredVersion),
  "debugger.detach": details => chrome.debugger.detach({ tabId: details.tabId })
});
const EVENT_BINDINGS = [
  [chrome.notifications.onShown, "notifications.shown", notificationId => ({ notificationId })],
  [chrome.notifications.onClicked, "notifications.clicked", notificationId => ({ notificationId })],
  [chrome.notifications.onClosed, "notifications.closed", (notificationId, byUser) => ({ notificationId, byUser })],
  [chrome.tabGroups.onCreated, "tabGroups.created", group => ({ group })],
  [chrome.tabGroups.onUpdated, "tabGroups.updated", group => ({ group })],
  [chrome.tabGroups.onMoved, "tabGroups.moved", group => ({ group })],
  [chrome.tabs.onActivated, "tabs.activated", info => info],
  [chrome.windows.onFocusChanged, "windows.focusChanged", windowId => ({ windowId })]
];

const makeId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);
let port;
let connectionId;
let sequence;

function response(request, ok, value) {
  return { protocol: PROTOCOL, type: "response", requestId: request.requestId, name: request.name, ok, ...(ok ? { result: value } : { error: value }) };
}
function errorFor(error) {
  const message = String(error?.message ?? error).slice(0, 512);
  return { code: error?.code === "DEBUGGER_ERROR" ? "DEBUGGER_ERROR" : "CHROME_ERROR", message };
}
function connect() {
  port = chrome.runtime.connectNative(HOST_NAME);
  connectionId = makeId();
  sequence = 0;
  port.postMessage({ protocol: PROTOCOL, type: "hello", role: "extension", connectionId, extensionId: chrome.runtime.id, extensionVersion: chrome.runtime.getManifest().version, events: EVENTS, commands: COMMANDS, maxMessageBytes: 1048576 });
  for (const [event, name, wrap] of EVENT_BINDINGS) event.addListener((...args) => { sequence += 1; port.postMessage({ protocol: PROTOCOL, type: "event", connectionId, seq: sequence, occurredAt: Date.now(), name, payload: wrap(...args) }); });
  port.onMessage.addListener(async message => {
    if (message?.type === "hello") return;
    if (message?.type !== "command" || !COMMANDS.includes(message.name) || !message.requestId || !message.params?.details) { if (message?.requestId) port.postMessage(response(message, false, { code: "INVALID_MESSAGE", message: "invalid command" })); return; }
    const fn = COMMAND_BINDINGS[message.name];
    try { const result = await fn(message.params.details); port.postMessage(response(message, true, result === undefined ? {} : result)); }
    catch (error) { void chrome.runtime.lastError; port.postMessage(response(message, false, errorFor(error))); }
  });
  port.onDisconnect.addListener(() => { void chrome.runtime.lastError; });
}
connect();
