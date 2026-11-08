import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { cookieToCdp } from "./cookies.ts";
import type { BrowserCookie } from "./cookies.ts";
import { createAgentTabs, getAgentTabs } from "./agent-tabs.ts";
import type { BrowserConnection } from "./connection.ts";

/** A cookie as cookies() reports it: Storage.getCookies always supplies these fields. */
export interface ContextCookie extends BrowserCookie {
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: string;
}

type CookieFilterKey = "name" | "domain" | "path";

export type CookieFilter = string | RegExp;

export type ClearCookiesOptions = { [key in CookieFilterKey]?: CookieFilter | undefined };

export interface StorageState {
  cookies: ContextCookie[];
  origins: { origin: string; localStorage: { name: string; value: string }[] }[];
}

const isCookieFilterKey = (key: string): key is CookieFilterKey => ["name", "domain", "path"].includes(key);

export class BrowserContext {
  #connection: BrowserConnection;
  #scope: { browserContextId?: string };
  #origins = new Set<string>();

  constructor(connection: BrowserConnection, browserContextId: string | undefined) {
    this.#connection = connection;
    this.#scope = browserContextId ? { browserContextId } : {};
  }

  trackOrigin(url: string) {
    if (!/^https?:\/\//.test(url ?? "")) return;
    this.#origins.add(new URL(url).origin);
  }

  async cookies(urls: string | readonly string[] = []): Promise<ContextCookie[]> {
    const { cookies } = await this.#connection.cdp.send("Storage.getCookies", this.#scope);
    const parsed = (typeof urls === "string" ? [urls] : urls).map((url) => new URL(url));
    return cookies
      .filter(
        (cookie) =>
          !parsed.length ||
          parsed.some((url) => {
            const domain = cookie.domain.startsWith(".") ? cookie.domain.slice(1) : cookie.domain;
            if (url.hostname !== domain && !(cookie.domain.startsWith(".") && url.hostname.endsWith(`.${domain}`)))
              return false;
            if (cookie.secure && url.protocol !== "https:" && url.hostname !== "localhost") return false;
            const pathname = cookie.path.endsWith("/") ? cookie.path : `${cookie.path}/`;
            return url.pathname === cookie.path || `${url.pathname}/`.startsWith(pathname);
          }),
      )
      .map((cookie) => {
        const { name, value, domain, path: cookiePath, expires, httpOnly, secure } = cookie;
        const out: ContextCookie = {
          name,
          value,
          domain,
          path: cookiePath,
          expires,
          httpOnly,
          secure,
          sameSite: cookie.sameSite ?? "Lax",
        };
        if (cookie.partitionKey) out.partitionKey = cookie.partitionKey.topLevelSite;
        return out;
      });
  }

  async addCookies(cookies: readonly BrowserCookie[]) {
    const normalized = cookies.map((cookie) => {
      if (typeof cookie.name !== "string" || typeof cookie.value !== "string") {
        throw new TypeError("Cookie name and value must be strings");
      }
      if (cookie.url !== undefined) {
        if (cookie.domain !== undefined || cookie.path !== undefined)
          throw new Error("Cookie must have either url or domain and path");
        const url = new URL(cookie.url);
        if (!/^https?:$/.test(url.protocol)) throw new Error("Cookie url must be HTTP or HTTPS");
        return cookieToCdp({
          ...cookie,
          domain: url.hostname,
          path: url.pathname.slice(0, url.pathname.lastIndexOf("/") + 1),
          secure: cookie.secure ?? url.protocol === "https:",
        });
      }
      if (!cookie.domain || !cookie.path) throw new Error("Cookie must have either url or domain and path");
      return cookieToCdp(cookie);
    });
    await this.#connection.cdp.send("Storage.setCookies", { ...this.#scope, cookies: normalized });
  }

  async clearCookies(options: ClearCookiesOptions = {}) {
    const filters = Object.entries(options).filter((entry): entry is [CookieFilterKey, (typeof entry)[1]] =>
      isCookieFilterKey(entry[0]),
    );
    if (!filters.length) {
      await this.#connection.cdp.send("Storage.clearCookies", this.#scope);
      return;
    }
    // Storage.clearCookies is context scoped. Reinstall survivors rather than
    // issuing a browser-global Network.deleteCookies for another context.
    const survivors = (await this.cookies()).filter(
      (cookie) =>
        !filters.every(([key, filter]) =>
          filter instanceof RegExp
            ? new RegExp(filter.source, filter.flags.replace(/[gy]/g, "")).test(cookie[key])
            : cookie[key] === filter,
        ),
    );
    await this.#connection.cdp.send("Storage.clearCookies", this.#scope);
    await this.addCookies(survivors);
  }

  async newPage() {
    return (
      await (getAgentTabs(this.#connection) ?? createAgentTabs(this.#connection)).create("about:blank", this.#scope)
    ).page;
  }

  async storageState(options: { path?: string | undefined } = {}) {
    const state: StorageState = { cookies: await this.cookies(), origins: [] };
    if (this.#origins.size) {
      // Read through a blank intercepted page: an origin may no longer have an
      // open frame, and visiting its real document could mutate saved storage.
      const page = await this.newPage();
      try {
        await page.route("**/*", (route) => route.fulfill({ contentType: "text/html", body: "<html></html>" }));
        for (const origin of this.#origins) {
          await page.goto(origin, { waitUntil: "domcontentloaded" });
          const { entries } = await page._sendToTarget("DOMStorage.getDOMStorageItems", {
            storageId: { securityOrigin: origin, isLocalStorage: true },
          });
          if (entries.length)
            state.origins.push({ origin, localStorage: entries.map(([name, value]) => ({ name, value })) });
        }
      } finally {
        await page.close();
      }
    }
    if (options.path !== undefined) {
      await mkdir(path.dirname(path.resolve(options.path)), { recursive: true });
      await writeFile(options.path, JSON.stringify(state, null, 2));
    }
    return state;
  }
}
