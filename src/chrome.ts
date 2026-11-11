import { mkdirSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import type { CdpDownloadWillBegin, CdpEventPayloads, CdpTransport } from "./cdp-protocol.ts";
import { UnsupportedOperationError } from "./core.ts";
import { createProfileApis, chromeTimeToMs } from "./chrome-profile.ts";
import { readProperty } from "./read-property.ts";

export interface ChromeTarget {
  type: string;
  targetId?: string;
  id?: string;
  url?: string;
  title?: string;
}

export interface ChromeDownloadPage {
  evaluate(expression: string): Promise<unknown>;
  close(): Promise<unknown>;
}

export interface ChromeConnection {
  cdp: Pick<CdpTransport, "send" | "on">;
  listTargets(): Promise<ChromeTarget[]>;
  newTab(url: string): Promise<ChromeDownloadPage>;
}

export interface ChromeApiOptions {
  profilePath?: string | undefined;
  downloadDir?: string | undefined;
}

export interface ChromeTab {
  id: string | undefined;
  url: string;
  title: string;
  windowId: number;
  active: boolean;
  pinned: boolean;
  audible: boolean;
  discarded: boolean;
  groupId: number;
  index: number;
}

export interface ChromeWindow {
  id: number;
  type: string;
  state: string;
  alwaysOnTop: boolean;
  incognito: boolean;
  tabs?: ChromeTab[];
}

export interface TabQueryInfo {
  url?: string | string[] | undefined;
  title?: string | undefined;
  windowId?: number | null | undefined;
}

export interface WindowQueryOptions {
  populate?: boolean | undefined;
}

export interface DownloadSearchQuery {
  limit?: number | undefined;
  url?: string | undefined;
  filename?: string | undefined;
}

export interface DownloadOptions {
  url: string;
  filename?: string | undefined;
}

// SQLite TEXT columns come back as string or NULL from both node:sqlite and bun:sqlite;
// anything else means the History schema is not the one this query was written for.
function textColumn(row: unknown, column: string): string | null {
  const value = readProperty(row, column);
  if (value === null || typeof value === "string") return value;
  throw new TypeError(`History column ${column} is not text`);
}

function timeColumn(row: unknown, column: string): string | number | bigint | null {
  const value = readProperty(row, column);
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "bigint")
    return value;
  throw new TypeError(`History column ${column} is not a time value`);
}

const EXTENSION_BRIDGE_REQUIRED = "requires the extension bridge in standalone OmOWright";
// CDP has no window-focus state, and document.hasFocus() is no substitute: OmOWright
// enables focus emulation on every page it attaches to (other automation clients do
// too), so those pages report focus, background agent windows included (#122).
const WINDOW_FOCUS_UNKNOWN =
  "is unavailable in standalone OmOWright: CDP exposes no window focus state; " +
  "track chrome.windows.onFocusChanged through the extension bridge instead";
const DOWNLOAD_TIMEOUT_MS = 30_000;

function matchUrlPattern(url: string, pattern: string | string[]) {
  const patterns = Array.isArray(pattern) ? pattern : [pattern];
  return patterns.some((item) => {
    if (!item.includes("*")) return url.startsWith(item);
    const regex = new RegExp(`^${item.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
    return regex.test(url);
  });
}

export function createChromeApi(connection: ChromeConnection, options: ChromeApiOptions = {}) {
  const profile = createProfileApis(options.profilePath);
  const cdp = connection.cdp;

  async function pageTargets() {
    return (await connection.listTargets()).filter((target) => target.type === "page");
  }

  async function toTab(target: ChromeTarget): Promise<ChromeTab> {
    let windowId = 0;
    try {
      const win = await cdp.send("Browser.getWindowForTarget", { targetId: target.targetId ?? target.id });
      windowId = win.windowId;
    } catch {}
    return {
      id: target.targetId ?? target.id,
      url: target.url ?? "",
      title: target.title ?? "",
      windowId,
      active: false,
      pinned: false,
      audible: false,
      discarded: false,
      groupId: -1,
      index: -1,
    };
  }

  const tabs = {
    async query(queryInfo: TabQueryInfo = {}) {
      let targets = await pageTargets();
      const { url, title } = queryInfo;
      if (url) targets = targets.filter((t) => matchUrlPattern(t.url ?? "", url));
      if (title) targets = targets.filter((t) => (t.title ?? "").includes(title));
      const out: ChromeTab[] = [];
      for (const target of targets) {
        const tab = await toTab(target);
        if (queryInfo.windowId != null && tab.windowId !== queryInfo.windowId) continue;
        out.push(tab);
      }
      return out;
    },
    async get(tabId: string) {
      const targets = await pageTargets();
      const target = targets.find((t) => (t.targetId ?? t.id) === tabId);
      if (!target) throw new Error(`No tab with id: ${tabId}`);
      return toTab(target);
    },
  };

  async function collectWindows(queryOptions: WindowQueryOptions = {}): Promise<ChromeWindow[]> {
    const byWindow = new Map<number, ChromeTab[]>();
    for (const target of await pageTargets()) {
      const tab = await toTab(target);
      const list = byWindow.get(tab.windowId) ?? [];
      list.push(tab);
      byWindow.set(tab.windowId, list);
    }
    return [...byWindow.entries()].map(([windowId, windowTabs]) => {
      const win: ChromeWindow = {
        id: windowId,
        type: "normal",
        state: "normal",
        alwaysOnTop: false,
        incognito: false,
      };
      if (queryOptions.populate) win.tabs = windowTabs;
      return win;
    });
  }

  const windows = {
    async get(windowId: number, queryOptions: WindowQueryOptions = {}) {
      const all = await collectWindows(queryOptions);
      const win = all.find((item) => item.id === windowId);
      if (!win) throw new Error(`No window with id: ${windowId}`);
      return win;
    },
    async getCurrent(queryOptions: WindowQueryOptions = {}) {
      const [first] = await collectWindows(queryOptions);
      // Undefined exactly when the list is empty.
      if (first === undefined) throw new Error("No browser window found");
      return first;
    },
    async getLastFocused() {
      throw new UnsupportedOperationError(`chrome.windows.getLastFocused ${WINDOW_FOCUS_UNKNOWN}`);
    },
    async getAll(queryOptions: WindowQueryOptions = {}) {
      return collectWindows(queryOptions);
    },
  };

  const downloads = {
    async search(query: DownloadSearchQuery = {}) {
      return profile.withDb("History", (db) => {
        const rows = db
          .prepare(
            `SELECT d.id, d.target_path, d.start_time, d.received_bytes, d.total_bytes, d.state,
                  (SELECT url FROM downloads_url_chains c WHERE c.id = d.id AND c.chain_index = 0) AS url
           FROM downloads d ORDER BY d.start_time DESC LIMIT ?`,
          )
          .all(query.limit ?? 100);
        return (
          rows
            .map((row) => {
              const startTime = timeColumn(row, "start_time");
              const state = Number(readProperty(row, "state"));
              return {
                id: Number(readProperty(row, "id")),
                url: textColumn(row, "url") ?? "",
                filename: textColumn(row, "target_path"),
                startTime: startTime ? new Date(chromeTimeToMs(startTime)).toISOString() : null,
                bytesReceived: Number(readProperty(row, "received_bytes")),
                totalBytes: Number(readProperty(row, "total_bytes")),
                state:
                  state === 1 ? "complete" : state === 2 ? "canceled" : state === 3 ? "interrupted" : "in_progress",
              };
            })
            .filter((item) => !query.url || item.url.includes(query.url))
            // A NULL target_path threw this TypeError when a filename filter was given.
            .filter((item) => {
              if (!query.filename) return true;
              if (item.filename === null) throw new TypeError("Cannot read properties of null (reading 'includes')");
              return item.filename.includes(query.filename);
            })
        );
      });
    },

    async download(downloadOptions: DownloadOptions) {
      const downloadDir = options.downloadDir ?? path.join(tmpdir(), "omowright-downloads");
      mkdirSync(downloadDir, { recursive: true });

      const { promise: began, resolve: resolveBegin } = Promise.withResolvers<CdpDownloadWillBegin>();
      const {
        promise: done,
        resolve: resolveDone,
        reject: rejectDone,
      } = Promise.withResolvers<CdpEventPayloads["Browser.downloadProgress"]>();
      const offBegin = cdp.on("Browser.downloadWillBegin", (params) => resolveBegin(params));
      const offProgress = cdp.on("Browser.downloadProgress", (params) => {
        if (params.state === "completed") resolveDone(params);
        else if (params.state === "canceled") rejectDone(new Error("Download was canceled"));
      });
      const timer = setTimeout(
        () => rejectDone(new Error(`chrome.downloads.download timed out after ${DOWNLOAD_TIMEOUT_MS}ms`)),
        DOWNLOAD_TIMEOUT_MS,
      );

      const page = await connection.newTab("about:blank");
      try {
        await cdp.send("Browser.setDownloadBehavior", {
          behavior: "allow",
          downloadPath: downloadDir,
          eventsEnabled: true,
        });
        await page.evaluate(`(() => {
          const a = document.createElement("a");
          a.href = ${JSON.stringify(downloadOptions.url)};
          document.body.appendChild(a);
          a.click();
        })()`);
        const begin = await Promise.race([began, done.then(() => null)]);
        if (!begin) throw new Error("No download started for the given URL");
        await done;
        const filename = downloadOptions.filename ?? begin.suggestedFilename;
        return {
          id: begin.guid,
          url: begin.url ?? downloadOptions.url,
          filename: path.join(downloadDir, filename ?? "download"),
          state: "complete",
        };
      } finally {
        clearTimeout(timer);
        offBegin();
        offProgress();
        await page.close().catch(() => {});
      }
    },

    async pause(..._args: unknown[]) {
      throw new UnsupportedOperationError(`chrome.downloads.pause ${EXTENSION_BRIDGE_REQUIRED}`);
    },
    async resume(..._args: unknown[]) {
      throw new UnsupportedOperationError(`chrome.downloads.resume ${EXTENSION_BRIDGE_REQUIRED}`);
    },
    async cancel(..._args: unknown[]) {
      throw new UnsupportedOperationError(`chrome.downloads.cancel ${EXTENSION_BRIDGE_REQUIRED}`);
    },
    async erase(..._args: unknown[]) {
      throw new UnsupportedOperationError(`chrome.downloads.erase ${EXTENSION_BRIDGE_REQUIRED}`);
    },
  };

  return {
    tabs,
    windows,
    downloads,
    bookmarks: profile.bookmarks,
    history: profile.history,
    topSites: profile.topSites,
  };
}
