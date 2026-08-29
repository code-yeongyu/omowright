import * as z from "zod";

export const HOST_NAME = "com.omowright.cloakbridge";
export const PROTOCOL = 1;
export const MAX_MESSAGE_BYTES = 1024 * 1024;
export const EVENT_NAMES = Object.freeze(["notifications.shown", "notifications.clicked", "notifications.closed", "tabGroups.created", "tabGroups.updated", "tabGroups.moved", "tabs.activated", "windows.focusChanged"]);
export const COMMAND_NAMES = Object.freeze(["bookmarks.create", "bookmarks.move", "bookmarks.remove", "history.deleteUrl", "history.deleteRange", "tabGroups.update", "debugger.attach", "debugger.detach"]);
export const MUTATING_COMMANDS = new Set(COMMAND_NAMES);
const id = z.string().min(1).max(128);
const uuid = z.string().regex(/^[0-9a-fA-F-]{16,128}$/);
const finite = z.number().finite();
const color = z.enum(["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"]);
const group = z.object({ id: z.number().int().min(0), collapsed: z.boolean(), color, title: z.string().max(1024).nullable().optional(), windowId: z.number().int().min(-1) }).strict();
const bookmarkNode = z.lazy(() => z.object({ id: z.string().min(1), parentId: z.string().min(1).optional(), index: z.number().int().min(0).optional(), title: z.string(), url: z.string().optional(), dateAdded: finite.min(0).optional(), dateGroupModified: finite.min(0).optional(), dateLastUsed: finite.min(0).optional(), folderType: z.string().optional(), syncing: z.boolean().optional(), unmodifiable: z.string().optional(), type: z.enum(["bookmark", "folder", "url"]).optional(), children: z.array(bookmarkNode).optional() }).strict());
const empty = z.object({}).strict();
export const payloadSchemas = {
  "notifications.shown": z.object({ notificationId: z.string().min(1).max(1024) }).strict(),
  "notifications.clicked": z.object({ notificationId: z.string().min(1).max(1024) }).strict(),
  "notifications.closed": z.object({ notificationId: z.string().min(1).max(1024), byUser: z.boolean() }).strict(),
  "tabGroups.created": z.object({ group }).strict(), "tabGroups.updated": z.object({ group }).strict(), "tabGroups.moved": z.object({ group }).strict(),
  "tabs.activated": z.object({ tabId: z.number().int().min(0), windowId: z.number().int().min(-1), previousTabId: z.number().int().min(0).optional() }).strict(),
  "windows.focusChanged": z.object({ windowId: z.number().int().min(-1) }).strict(),
};
export const commandParams = {
  "bookmarks.create": z.object({ details: z.object({ parentId: z.string().min(1).optional(), index: z.number().int().min(0).optional(), title: z.string().max(8192), url: z.string().url().max(8192).optional() }).strict() }).strict(),
  "bookmarks.move": z.object({ details: z.object({ id: z.string().min(1), parentId: z.string().min(1).optional(), index: z.number().int().min(0).optional() }).strict() }).strict(),
  "bookmarks.remove": z.object({ details: z.object({ id: z.string().min(1) }).strict() }).strict(),
  "history.deleteUrl": z.object({ details: z.object({ url: z.string().url().max(8192) }).strict() }).strict(),
  "history.deleteRange": z.object({ details: z.object({ startTime: finite.min(0), endTime: finite.min(0) }).strict() }).strict().refine(v => v.details.startTime <= v.details.endTime, "startTime must not exceed endTime"),
  "tabGroups.update": z.object({ details: z.object({ groupId: z.number().int().min(0), updateProperties: z.object({ collapsed: z.boolean().optional(), color: color.optional(), title: z.string().max(1024).nullable().optional() }).strict().refine(v => Object.keys(v).length > 0, "updateProperties must not be empty") }).strict() }).strict(),
  "debugger.attach": z.object({ details: z.object({ tabId: z.number().int().min(0), requiredVersion: z.string().regex(/^\d+\.\d+$/) }).strict() }).strict(),
  "debugger.detach": z.object({ details: z.object({ tabId: z.number().int().min(0) }).strict() }).strict(),
};
export const resultSchemas = { "bookmarks.create": bookmarkNode, "bookmarks.move": bookmarkNode, "bookmarks.remove": empty, "history.deleteUrl": empty, "history.deleteRange": empty, "tabGroups.update": group, "debugger.attach": z.object({ tabId: z.number().int().min(0), attached: z.literal(true), requiredVersion: z.string() }).strict(), "debugger.detach": z.object({ tabId: z.number().int().min(0), detached: z.literal(true) }).strict() };
const base = { protocol: z.literal(PROTOCOL) };
function unique(values, ctx) { if (new Set(values).size !== values.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "array entries must be unique" }); }
const names = allowed => z.array(z.enum([...allowed])).superRefine(unique);
export const ExtensionHelloSchema = z.object({ ...base, type: z.literal("hello"), role: z.literal("extension"), connectionId: id, extensionId: z.string().regex(/^[a-p]{32}$/), extensionVersion: z.string().min(1).max(64), events: names(EVENT_NAMES), commands: names(COMMAND_NAMES), maxMessageBytes: z.number().int().min(1).max(MAX_MESSAGE_BYTES) }).strict();
export const HostHelloSchema = z.object({ ...base, type: z.literal("hello"), role: z.literal("host"), connectionId: id, hostName: z.literal(HOST_NAME), hostVersion: z.string().min(1).max(64), events: names(EVENT_NAMES), commands: names(COMMAND_NAMES), maxMessageBytes: z.number().int().min(1).max(MAX_MESSAGE_BYTES) }).strict();
export const EventSchema = z.object({ ...base, type: z.literal("event"), connectionId: id, seq: z.number().int().min(1), occurredAt: z.number().int().min(0), name: z.enum(EVENT_NAMES), payload: z.record(z.string(), z.unknown()) }).strict().superRefine((v, ctx) => { if (!payloadSchemas[v.name].safeParse(v.payload).success) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "invalid event payload" }); });
export const CommandSchema = z.object({ ...base, type: z.literal("command"), requestId: uuid, name: z.enum(COMMAND_NAMES), params: z.record(z.string(), z.unknown()), deadlineAt: z.number().int().min(0).optional() }).strict().superRefine((v, ctx) => { if (!commandParams[v.name].safeParse(v.params).success) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "invalid command parameters" }); });
const errorSchema = z.object({ code: z.enum(["INVALID_MESSAGE", "UNKNOWN_COMMAND", "UNSUPPORTED_COMMAND", "CHROME_ERROR", "DEBUGGER_ERROR", "NATIVE_HOST_DISCONNECTED", "TIMEOUT", "PAYLOAD_TOO_LARGE", "INTERNAL_ERROR"]), message: z.string().min(1).max(512), details: z.record(z.string(), z.unknown()).optional() }).strict();
const responseNames = [...COMMAND_NAMES, "protocolError"];
export const ResponseSchema = z.object({ ...base, type: z.literal("response"), requestId: uuid, name: z.enum(responseNames), ok: z.boolean(), result: z.unknown().optional(), error: errorSchema.optional() }).strict().superRefine((v, ctx) => { const valid = v.ok ? v.result !== undefined && v.error === undefined && v.name !== "protocolError" : v.error !== undefined && v.result === undefined; if (!valid) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "response must contain exactly one result or error" }); if (v.ok && resultSchemas[v.name] && !resultSchemas[v.name].safeParse(v.result).success) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "invalid command result" }); });
