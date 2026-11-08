import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { UnsupportedOperationError } from "./core.js";

let DatabaseCtor;
async function loadSqlite() {
  if (DatabaseCtor) return DatabaseCtor;
  try {
    const mod = await import("node:sqlite");
    DatabaseCtor = file => new mod.DatabaseSync(file, { readOnly: true, readBigInts: true });
  } catch {
    const mod = await import("bun:sqlite");
    DatabaseCtor = file => new mod.Database(file, { readonly: true });
  }
  return DatabaseCtor;
}

const CHROME_EPOCH_OFFSET_MS = 11_644_473_600_000;
const chromeTimeToMs = time => Number(BigInt(time) / 1000n) - CHROME_EPOCH_OFFSET_MS;
const msToChromeTime = ms => BigInt(Math.floor((ms + CHROME_EPOCH_OFFSET_MS) * 1000));

export { chromeTimeToMs };

const EXTENSION_BRIDGE_REQUIRED = "requires the extension bridge in standalone OmOWright";

export function createProfileApis(profilePath) {
  function profileDir() {
    if (!profilePath) {
      throw new UnsupportedOperationError(
        "chrome.bookmarks/history/topSites need a profilePath (the browser's user-data-dir); pass it to createChromeApi(connection, { profilePath })",
      );
    }
    return path.join(profilePath, "Default");
  }

  async function openDb(fileName) {
    const file = path.join(profileDir(), fileName);
    if (!existsSync(file)) return null;
    const ctor = await loadSqlite();
    return ctor(file);
  }

  async function withDb(fileName, fn) {
    const db = await openDb(fileName);
    if (!db) return [];
    try {
      return fn(db);
    } finally {
      db.close();
    }
  }

  function bookmarkRoots() {
    const file = path.join(profileDir(), "Bookmarks");
    if (!existsSync(file)) return [];
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return Object.values(parsed.roots ?? {}).filter(node => node && typeof node === "object" && node.id);
  }

  function walkBookmarks(nodes, visit, acc = []) {
    for (const node of nodes) {
      visit(node, acc);
      if (Array.isArray(node.children)) walkBookmarks(node.children, visit, acc);
    }
    return acc;
  }

  function findBookmark(id) {
    for (const root of bookmarkRoots()) {
      const found = walkBookmarks([root], (node, acc) => {
        if (node.id === String(id)) acc.push(node);
      });
      if (found.length > 0) return found[0];
    }
    return null;
  }

  function toBookmark(node) {
    const out = { id: node.id, title: node.name ?? "", type: node.type };
    if (node.url) out.url = node.url;
    if (node.date_added) out.dateAdded = chromeTimeToMs(node.date_added);
    if (node.children) out.children = node.children.map(toBookmark);
    return out;
  }

  const bookmarks = {
    async get(idOrIdList) {
      const ids = Array.isArray(idOrIdList) ? idOrIdList : [idOrIdList];
      return ids.map(findBookmark).filter(Boolean).map(toBookmark);
    },
    async getChildren(id) {
      const node = findBookmark(id);
      return (node?.children ?? []).map(toBookmark);
    },
    async getRecent(numberOfItems) {
      const urls = walkBookmarks(bookmarkRoots(), (node, acc) => {
        if (node.type === "url") acc.push(node);
      });
      return urls
        .sort((a, b) => Number(b.date_added ?? 0) - Number(a.date_added ?? 0))
        .slice(0, numberOfItems)
        .map(toBookmark);
    },
    async getSubTree(id) {
      const node = findBookmark(id);
      return node ? [toBookmark(node)] : [];
    },
    async getTree() {
      return bookmarkRoots().map(toBookmark);
    },
    async search(query) {
      const needle = typeof query === "string" ? query.toLowerCase() : (query.query ?? "").toLowerCase();
      const url = typeof query === "object" ? query.url?.toLowerCase() : undefined;
      const title = typeof query === "object" ? query.title?.toLowerCase() : undefined;
      return walkBookmarks(bookmarkRoots(), (node, acc) => {
        if (node.type !== "url") return;
        const name = (node.name ?? "").toLowerCase();
        const href = (node.url ?? "").toLowerCase();
        const ok = (needle && (name.includes(needle) || href.includes(needle)))
          || (url && href.includes(url))
          || (title && name.includes(title));
        if (ok) acc.push(node);
      }).map(toBookmark);
    },
    async create() { throw new UnsupportedOperationError(`chrome.bookmarks.create ${EXTENSION_BRIDGE_REQUIRED}`); },
    async update() { throw new UnsupportedOperationError(`chrome.bookmarks.update ${EXTENSION_BRIDGE_REQUIRED}`); },
    async move() { throw new UnsupportedOperationError(`chrome.bookmarks.move ${EXTENSION_BRIDGE_REQUIRED}`); },
    async remove() { throw new UnsupportedOperationError(`chrome.bookmarks.remove ${EXTENSION_BRIDGE_REQUIRED}`); },
    async removeTree() { throw new UnsupportedOperationError(`chrome.bookmarks.removeTree ${EXTENSION_BRIDGE_REQUIRED}`); },
  };

  const history = {
    async search(query) {
      const text = `%${query.text ?? ""}%`;
      const start = query.startTime != null ? msToChromeTime(query.startTime) : 0n;
      const end = query.endTime != null ? msToChromeTime(query.endTime) : 99999999999999999n;
      const max = query.maxResults ?? 100;
      return (await withDb("History", db => db.prepare(
        `SELECT id, url, title, visit_count, last_visit_time FROM urls
         WHERE (url LIKE ? OR title LIKE ?) AND last_visit_time BETWEEN ? AND ?
         ORDER BY last_visit_time DESC LIMIT ?`,
      ).all(text, text, start, end, max).map(row => ({
        id: String(row.id),
        url: row.url,
        title: row.title ?? "",
        visitCount: Number(row.visit_count),
        lastVisitTime: chromeTimeToMs(row.last_visit_time),
      }))));
    },
    async getVisits(details) {
      return (await withDb("History", db => db.prepare(
        `SELECT v.id, v.visit_time, v.transition FROM visits v
         JOIN urls u ON u.id = v.url WHERE u.url = ?
         ORDER BY v.visit_time DESC`,
      ).all(details.url).map(row => ({
        id: String(row.id),
        url: details.url,
        visitTime: chromeTimeToMs(row.visit_time),
        transition: Number(row.transition),
      }))));
    },
    async addUrl() { throw new UnsupportedOperationError(`chrome.history.addUrl ${EXTENSION_BRIDGE_REQUIRED}`); },
    async deleteUrl() { throw new UnsupportedOperationError(`chrome.history.deleteUrl ${EXTENSION_BRIDGE_REQUIRED}`); },
    async deleteRange() { throw new UnsupportedOperationError(`chrome.history.deleteRange ${EXTENSION_BRIDGE_REQUIRED}`); },
  };

  const topSites = {
    async get() {
      return (await withDb("Top Sites", db => db.prepare(
        `SELECT url, title, url_rank FROM top_sites ORDER BY url_rank ASC LIMIT 50`,
      ).all())).map(row => ({ url: row.url, title: row.title ?? "" }));
    },
  };

  return { bookmarks, history, topSites, withDb };
}
