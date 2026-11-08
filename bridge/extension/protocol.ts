import type { TabGroupColor, TabGroupUpdate } from "./chrome-api.ts";

export const HOST_NAME = "com.omowright.cloakbridge";
export const PROTOCOL = 1;
export const MAX_MESSAGE_BYTES = 1048576;
export const PROTOCOL_ERROR_NAME = "protocolError";
export const EVENTS = [
  "notifications.shown",
  "notifications.clicked",
  "notifications.closed",
  "tabGroups.created",
  "tabGroups.updated",
  "tabGroups.moved",
  "tabs.activated",
  "windows.focusChanged",
] as const;
export const COMMANDS = [
  "bookmarks.create",
  "bookmarks.move",
  "bookmarks.remove",
  "history.deleteUrl",
  "history.deleteRange",
  "tabGroups.update",
  "debugger.attach",
  "debugger.detach",
] as const;

export type EventName = (typeof EVENTS)[number];
export type CommandName = (typeof COMMANDS)[number];

export interface CommandDetails {
  "bookmarks.create": { parentId?: string; index?: number; title: string; url?: string };
  "bookmarks.move": { id: string; parentId?: string; index?: number };
  "bookmarks.remove": { id: string };
  "history.deleteUrl": { url: string };
  "history.deleteRange": { startTime: number; endTime: number };
  "tabGroups.update": { groupId: number; updateProperties: TabGroupUpdate };
  "debugger.attach": { tabId: number; requiredVersion: string };
  "debugger.detach": { tabId: number };
}

export type UntrustedRecord = { readonly [key: string]: unknown };

const EVENT_SET: ReadonlySet<unknown> = new Set(EVENTS);
const COMMAND_SET: ReadonlySet<unknown> = new Set(COMMANDS);
const URL_PROTOCOLS: ReadonlySet<unknown> = new Set([
  "http:",
  "https:",
  "ftp:",
  "file:",
  "data:",
  "javascript:",
  "chrome:",
  "chrome-extension:",
]);
const TAB_GROUP_COLORS: ReadonlySet<unknown> = new Set([
  "grey",
  "blue",
  "red",
  "yellow",
  "green",
  "pink",
  "purple",
  "cyan",
  "orange",
] satisfies TabGroupColor[]);

export const isEventName = (value: unknown): value is EventName => EVENT_SET.has(value);
export const isCommandName = (value: unknown): value is CommandName => COMMAND_SET.has(value);
export const validId = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-fA-F-]{16,128}$/.test(value);
export const validUrl = (value: unknown): value is string => {
  if (typeof value !== "string" || value.length > 8192) return false;
  try {
    return URL_PROTOCOLS.has(new URL(value).protocol);
  } catch {
    return false;
  }
};
export const isList = (value: unknown): value is readonly unknown[] => Array.isArray(value);
export const plain = (value: unknown): value is UntrustedRecord =>
  value !== null && typeof value === "object" && !Array.isArray(value);
export const exact = (
  value: unknown,
  allowed: readonly string[],
  required: readonly string[] = [],
): value is UntrustedRecord =>
  plain(value) &&
  Object.keys(value).every((key) => allowed.includes(key)) &&
  required.every((key) => Object.hasOwn(value, key));

const nonNegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;
const finiteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const nonEmptyString = (value: unknown): value is string => typeof value === "string" && value.length > 0;

const SHAPES: { readonly [N in CommandName]: (details: unknown) => boolean } = {
  "bookmarks.create": (details) =>
    exact(details, ["parentId", "index", "title", "url"], ["title"]) &&
    typeof details["title"] === "string" &&
    details["title"].length <= 8192 &&
    (details["parentId"] === undefined || nonEmptyString(details["parentId"])) &&
    (details["index"] === undefined || nonNegativeInteger(details["index"])) &&
    (details["url"] === undefined || validUrl(details["url"])),
  "bookmarks.move": (details) =>
    exact(details, ["id", "parentId", "index"], ["id"]) &&
    nonEmptyString(details["id"]) &&
    (details["parentId"] === undefined || nonEmptyString(details["parentId"])) &&
    (details["index"] === undefined || nonNegativeInteger(details["index"])),
  "bookmarks.remove": (details) => exact(details, ["id"], ["id"]) && nonEmptyString(details["id"]),
  "history.deleteUrl": (details) => exact(details, ["url"], ["url"]) && validUrl(details["url"]),
  "history.deleteRange": (details) =>
    exact(details, ["startTime", "endTime"], ["startTime", "endTime"]) &&
    finiteNumber(details["startTime"]) &&
    details["startTime"] >= 0 &&
    finiteNumber(details["endTime"]) &&
    details["endTime"] >= details["startTime"],
  "tabGroups.update": (details) =>
    exact(details, ["groupId", "updateProperties"], ["groupId", "updateProperties"]) &&
    nonNegativeInteger(details["groupId"]) &&
    exact(details["updateProperties"], ["collapsed", "color", "title"]) &&
    Object.keys(details["updateProperties"]).length > 0 &&
    (details["updateProperties"]["collapsed"] === undefined ||
      typeof details["updateProperties"]["collapsed"] === "boolean") &&
    (details["updateProperties"]["color"] === undefined ||
      TAB_GROUP_COLORS.has(details["updateProperties"]["color"])) &&
    (details["updateProperties"]["title"] === undefined ||
      details["updateProperties"]["title"] === null ||
      (typeof details["updateProperties"]["title"] === "string" &&
        details["updateProperties"]["title"].length <= 1024)),
  "debugger.attach": (details) =>
    exact(details, ["tabId", "requiredVersion"], ["tabId", "requiredVersion"]) &&
    nonNegativeInteger(details["tabId"]) &&
    typeof details["requiredVersion"] === "string" &&
    /^\d+\.\d+$/.test(details["requiredVersion"]),
  "debugger.detach": (details) => exact(details, ["tabId"], ["tabId"]) && nonNegativeInteger(details["tabId"]),
};

export const validDetails = <N extends CommandName>(name: N, details: unknown): details is CommandDetails[N] =>
  isCommandName(name) && SHAPES[name](details);
