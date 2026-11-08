import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { UnsupportedOperationError } from "./core.ts";
import { readProperty } from "./read-property.ts";

export type SqlValue = string | number | bigint | null | Uint8Array;
export type SqlParam = string | number | bigint | null;
export type SqlRow = Record<string, SqlValue>;

export class ChromeProfileRowError extends TypeError {
  readonly code = "invalid_profile_row";
}

export interface ProfileStatement {
  all(...params: SqlParam[]): unknown[];
}

export interface ProfileDatabase {
  prepare(sql: string): ProfileStatement;
  close(): void;
}

type DatabaseFactory = (file: string) => ProfileDatabase;

let DatabaseCtor: DatabaseFactory | undefined;
async function loadSqlite(): Promise<DatabaseFactory> {
  if (DatabaseCtor) return DatabaseCtor;
  try {
    const mod = await import("node:sqlite");
    DatabaseCtor = (file) => new mod.DatabaseSync(file, { readOnly: true, readBigInts: true });
  } catch {
    const mod = await import("bun:sqlite");
    DatabaseCtor = (file) => new mod.Database(file, { readonly: true });
  }
  return DatabaseCtor;
}

function isSqlValue(value: unknown): value is SqlValue {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "bigint" ||
    value instanceof Uint8Array
  );
}

function isSqlRow(value: unknown): value is SqlRow {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.values(value).every(isSqlValue);
}

function parseSqlRow(value: unknown): SqlRow {
  if (!isSqlRow(value)) throw new ChromeProfileRowError("SQLite returned an invalid profile row");
  return value;
}

export function selectRows(db: ProfileDatabase, sql: string, ...params: SqlParam[]): SqlRow[] {
  return db
    .prepare(sql)
    .all(...params)
    .map(parseSqlRow);
}

function parseChromeTime(value: SqlValue | undefined): string | number | bigint {
  if (value === null || value === undefined) {
    throw new ChromeProfileRowError(`Cannot convert ${String(value)} to a BigInt`);
  }
  // BigInt applies the same string conversion to SQLite BLOBs; do not decode them as UTF-8.
  return value instanceof Uint8Array ? value.toString() : value;
}

const CHROME_EPOCH_OFFSET_MS = 11_644_473_600_000;
const chromeTimeToMs = (time: string | number | bigint): number =>
  Number(BigInt(time) / 1000n) - CHROME_EPOCH_OFFSET_MS;
const msToChromeTime = (ms: number): bigint => BigInt(Math.floor((ms + CHROME_EPOCH_OFFSET_MS) * 1000));

export { chromeTimeToMs };

const EXTENSION_BRIDGE_REQUIRED = "requires the extension bridge in standalone OmOWright";

interface BookmarkFileNode {
  id: string;
  name?: string;
  type?: string;
  url?: string;
  date_added?: string;
  children?: BookmarkFileNode[];
}

export interface ChromeBookmark {
  id: string;
  title: string;
  type: string | undefined;
  url?: string;
  dateAdded?: number;
  children?: ChromeBookmark[];
}

export interface BookmarkSearchQuery {
  query?: string;
  url?: string;
  title?: string;
}

export interface HistorySearchQuery {
  text?: string;
  startTime?: number | null;
  endTime?: number | null;
  maxResults?: number;
}

function isBookmarkFileNode(node: unknown): node is BookmarkFileNode {
  return Boolean(node && typeof node === "object" && "id" in node && node.id);
}

function walkBookmarks(
  nodes: BookmarkFileNode[],
  visit: (node: BookmarkFileNode, acc: BookmarkFileNode[]) => void,
  acc: BookmarkFileNode[] = [],
): BookmarkFileNode[] {
  for (const node of nodes) {
    visit(node, acc);
    if (Array.isArray(node.children)) walkBookmarks(node.children, visit, acc);
  }
  return acc;
}

function toBookmark(node: BookmarkFileNode): ChromeBookmark {
  const out: ChromeBookmark = { id: node.id, title: node.name ?? "", type: node.type };
  if (node.url) out.url = node.url;
  if (node.date_added) out.dateAdded = chromeTimeToMs(node.date_added);
  if (node.children) out.children = node.children.map(toBookmark);
  return out;
}

export function createProfileApis(profilePath?: string) {
  function profileDir() {
    if (!profilePath) {
      throw new UnsupportedOperationError(
        "chrome.bookmarks/history/topSites need a profilePath (the browser's user-data-dir); pass it to createChromeApi(connection, { profilePath })",
      );
    }
    return path.join(profilePath, "Default");
  }

  async function openDb(fileName: string): Promise<ProfileDatabase | null> {
    const file = path.join(profileDir(), fileName);
    if (!existsSync(file)) return null;
    const ctor = await loadSqlite();
    return ctor(file);
  }

  async function withDb<T>(fileName: string, fn: (db: ProfileDatabase) => T): Promise<T | never[]> {
    const db = await openDb(fileName);
    if (!db) return [];
    try {
      return fn(db);
    } finally {
      db.close();
    }
  }

  function bookmarkRoots(): BookmarkFileNode[] {
    const file = path.join(profileDir(), "Bookmarks");
    if (!existsSync(file)) return [];
    // JSON boundary: only `roots` is read, and each root is narrowed by isBookmarkFileNode.
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    return Object.values(readProperty(parsed, "roots") ?? {}).filter(isBookmarkFileNode);
  }

  function findBookmark(id: string | number): BookmarkFileNode | null {
    for (const root of bookmarkRoots()) {
      const found = walkBookmarks([root], (node, acc) => {
        if (node.id === String(id)) acc.push(node);
      });
      const [first] = found;
      if (first) return first;
    }
    return null;
  }

  const bookmarks = {
    async get(idOrIdList: string | number | Array<string | number>) {
      const ids = Array.isArray(idOrIdList) ? idOrIdList : [idOrIdList];
      return ids
        .map((id) => findBookmark(id))
        .filter((node): node is BookmarkFileNode => node !== null)
        .map(toBookmark);
    },
    async getChildren(id: string | number) {
      const node = findBookmark(id);
      return (node?.children ?? []).map(toBookmark);
    },
    async getRecent(numberOfItems: number) {
      const urls = walkBookmarks(bookmarkRoots(), (node, acc) => {
        if (node.type === "url") acc.push(node);
      });
      return urls
        .toSorted((a, b) => Number(b.date_added ?? 0) - Number(a.date_added ?? 0))
        .slice(0, numberOfItems)
        .map(toBookmark);
    },
    async getSubTree(id: string | number) {
      const node = findBookmark(id);
      return node ? [toBookmark(node)] : [];
    },
    async getTree() {
      return bookmarkRoots().map(toBookmark);
    },
    async search(query: string | BookmarkSearchQuery) {
      const needle = typeof query === "string" ? query.toLowerCase() : (query.query ?? "").toLowerCase();
      const url = typeof query === "object" ? query.url?.toLowerCase() : undefined;
      const title = typeof query === "object" ? query.title?.toLowerCase() : undefined;
      return walkBookmarks(bookmarkRoots(), (node, acc) => {
        if (node.type !== "url") return;
        const name = (node.name ?? "").toLowerCase();
        const href = (node.url ?? "").toLowerCase();
        const ok =
          (needle && (name.includes(needle) || href.includes(needle))) ||
          (url && href.includes(url)) ||
          (title && name.includes(title));
        if (ok) acc.push(node);
      }).map(toBookmark);
    },
    async create(..._args: unknown[]) {
      throw new UnsupportedOperationError(`chrome.bookmarks.create ${EXTENSION_BRIDGE_REQUIRED}`);
    },
    async update(..._args: unknown[]) {
      throw new UnsupportedOperationError(`chrome.bookmarks.update ${EXTENSION_BRIDGE_REQUIRED}`);
    },
    async move(..._args: unknown[]) {
      throw new UnsupportedOperationError(`chrome.bookmarks.move ${EXTENSION_BRIDGE_REQUIRED}`);
    },
    async remove(..._args: unknown[]) {
      throw new UnsupportedOperationError(`chrome.bookmarks.remove ${EXTENSION_BRIDGE_REQUIRED}`);
    },
    async removeTree(..._args: unknown[]) {
      throw new UnsupportedOperationError(`chrome.bookmarks.removeTree ${EXTENSION_BRIDGE_REQUIRED}`);
    },
  };

  const history = {
    async search(query: HistorySearchQuery) {
      const text = `%${query.text ?? ""}%`;
      const start = query.startTime != null ? msToChromeTime(query.startTime) : 0n;
      const end = query.endTime != null ? msToChromeTime(query.endTime) : 99999999999999999n;
      const max = query.maxResults ?? 100;
      return await withDb("History", (db) =>
        selectRows(
          db,
          `SELECT id, url, title, visit_count, last_visit_time FROM urls
         WHERE (url LIKE ? OR title LIKE ?) AND last_visit_time BETWEEN ? AND ?
         ORDER BY last_visit_time DESC LIMIT ?`,
          text,
          text,
          start,
          end,
          max,
        ).map((row) => ({
          id: String(row["id"]),
          url: row["url"],
          title: row["title"] ?? "",
          visitCount: Number(row["visit_count"]),
          lastVisitTime: chromeTimeToMs(parseChromeTime(row["last_visit_time"])),
        })),
      );
    },
    async getVisits(details: { url: string }) {
      return await withDb("History", (db) =>
        selectRows(
          db,
          `SELECT v.id, v.visit_time, v.transition FROM visits v
         JOIN urls u ON u.id = v.url WHERE u.url = ?
         ORDER BY v.visit_time DESC`,
          details.url,
        ).map((row) => ({
          id: String(row["id"]),
          url: details.url,
          visitTime: chromeTimeToMs(parseChromeTime(row["visit_time"])),
          transition: Number(row["transition"]),
        })),
      );
    },
    async addUrl(..._args: unknown[]) {
      throw new UnsupportedOperationError(`chrome.history.addUrl ${EXTENSION_BRIDGE_REQUIRED}`);
    },
    async deleteUrl(..._args: unknown[]) {
      throw new UnsupportedOperationError(`chrome.history.deleteUrl ${EXTENSION_BRIDGE_REQUIRED}`);
    },
    async deleteRange(..._args: unknown[]) {
      throw new UnsupportedOperationError(`chrome.history.deleteRange ${EXTENSION_BRIDGE_REQUIRED}`);
    },
  };

  const topSites = {
    async get() {
      return (
        await withDb("Top Sites", (db) =>
          selectRows(db, `SELECT url, title, url_rank FROM top_sites ORDER BY url_rank ASC LIMIT 50`),
        )
      ).map((row) => ({ url: row["url"], title: row["title"] ?? "" }));
    },
  };

  return { bookmarks, history, topSites, withDb };
}
