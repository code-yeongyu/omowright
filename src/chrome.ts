import { mkdirSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import type { CdpDownloadWillBegin, CdpEventPayloads, CdpTransport } from "./cdp-protocol.ts";
import { UnsupportedOperationError } from "./core.ts";
import { createProfileApis, chromeTimeToMs, selectRows } from "./chrome-profile.ts";
import type { SqlValue } from "./chrome-profile.ts";

const EXTENSION_BRIDGE_REQUIRED = "requires the extension bridge in standalone OmOWright";
const DOWNLOAD_TIMEOUT_MS = 30_000;

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
  profilePath?: string;
  downloadDir?: string;
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
  focused: boolean;
  type: string;
  state: string;
  alwaysOnTop: boolean;
  incognito: boolean;
  tabs?: ChromeTab[];
}

export interface TabQueryInfo {
  url?: string | string[];
  title?: string;
  windowId?: number | null;
}

export interface WindowQueryOptions {
  populate?: boolean;
}

export interface DownloadSearchQuery {
  limit?: number;
  url?: string;
  filename?: string;
}

export interface DownloadOptions {
  url: string;
  filename?: string;
}

interface DownloadRow {
  id: SqlValue;
  target_path: string;
  start_time: number | bigint | null;
  received_bytes: SqlValue;
  total_bytes: SqlValue;
  state: SqlValue;
  url: string | null;
}

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
    return [...byWindow.entries()].map(([windowId, windowTabs], index) => {
      const win: ChromeWindow = {
        id: windowId,
        focused: index === 0,
        type: "normal",
        state: "normal",
        alwaysOnTop: false,
        incognito: false,
      };
      if (queryOptions.populate) win.tabs = windowTabs;
      return win;
    });
  }

  async function firstWindow(queryOptions: WindowQueryOptions) {
    const [first] = await collectWindows(queryOptions);
    if (!first) throw new Error("No browser window found");
    return first;
  }

  const windows = {
    async get(windowId: number, queryOptions: WindowQueryOptions = {}) {
      const all = await collectWindows(queryOptions);
      const win = all.find((item) => item.id === windowId);
      if (!win) throw new Error(`No window with id: ${windowId}`);
      return win;
    },
    async getCurrent(queryOptions: WindowQueryOptions = {}) {
      return firstWindow(queryOptions);
    },
    async getLastFocused(queryOptions: WindowQueryOptions = {}) {
      return firstWindow(queryOptions);
    },
    async getAll(queryOptions: WindowQueryOptions = {}) {
      return collectWindows(queryOptions);
    },
  };

  const downloads = {
    async search(query: DownloadSearchQuery = {}) {
      return profile.withDb("History", (db) => {
        const rows = selectRows<DownloadRow>(
          db,
          `SELECT d.id, d.target_path, d.start_time, d.received_bytes, d.total_bytes, d.state,
                  (SELECT url FROM downloads_url_chains c WHERE c.id = d.id AND c.chain_index = 0) AS url
           FROM downloads d ORDER BY d.start_time DESC LIMIT ?`,
          query.limit ?? 100,
        );
        return rows
          .map((row) => ({
            id: Number(row.id),
            url: row.url ?? "",
            filename: row.target_path,
            startTime: row.start_time ? new Date(chromeTimeToMs(row.start_time)).toISOString() : null,
            bytesReceived: Number(row.received_bytes),
            totalBytes: Number(row.total_bytes),
            state:
              Number(row.state) === 1
                ? "complete"
                : Number(row.state) === 2
                  ? "canceled"
                  : Number(row.state) === 3
                    ? "interrupted"
                    : "in_progress",
          }))
          .filter((item) => !query.url || item.url.includes(query.url))
          .filter((item) => !query.filename || item.filename.includes(query.filename));
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
