/** A cookie as callers and Storage.getCookies describe it. */
export interface BrowserCookie {
  name: string;
  value: string;
  url?: string | undefined;
  domain?: string | undefined;
  path?: string | undefined;
  httpOnly?: boolean | undefined;
  secure?: boolean | undefined;
  sameSite?: string | undefined;
  expires?: number | undefined;
  /** The partition's top-level site. */
  partitionKey?: string | undefined;
}

/** A cookie to sanitize before injection; `domain` is read for every cookie. */
export interface InjectedCookie extends BrowserCookie {
  domain: string;
}

/** Network.CookieParam. */
export interface CdpCookieParam {
  name: string;
  value: string;
  url?: string | undefined;
  domain?: string | undefined;
  path?: string | undefined;
  httpOnly?: boolean | undefined;
  secure?: boolean | undefined;
  sameSite?: string | undefined;
  expires?: number;
  partitionKey?: { topLevelSite: string; hasCrossSiteAncestor: boolean };
}

export interface CookieInjectionPage {
  _sendToTarget(method: "Network.setCookies", params: { cookies: CdpCookieParam[] }): Promise<unknown>;
}

export function cookieToCdp(cookie: BrowserCookie): CdpCookieParam {
  const { name, value, url, domain, path, httpOnly, secure, sameSite } = cookie;
  const out: CdpCookieParam = { name, value, url, domain, path, httpOnly, secure, sameSite };
  if (cookie.expires !== undefined && cookie.expires !== -1) out.expires = cookie.expires;
  if (cookie.partitionKey !== undefined) {
    out.partitionKey = { topLevelSite: cookie.partitionKey, hasCrossSiteAncestor: true };
  }
  return out;
}

export function sanitizeCookies(cookies: Iterable<InjectedCookie>): BrowserCookie[] {
  const byKey = new Map<string, BrowserCookie & { path: string; secure: boolean; httpOnly: boolean }>();
  for (const cookie of cookies) {
    const out: BrowserCookie & { path: string; secure: boolean; httpOnly: boolean } = {
      name: cookie.name,
      value: cookie.value,
      path: cookie.path || "/",
      secure: Boolean(cookie.secure),
      httpOnly: Boolean(cookie.httpOnly),
    };
    if (cookie.name.startsWith("__Host-")) {
      out.secure = true;
      out.path = "/";
      out.url = `https://${cookie.domain.replace(/^\./, "")}`;
    } else {
      out.domain = cookie.domain;
    }
    if (cookie.expires && cookie.expires > 0) out.expires = cookie.expires;
    if (cookie.sameSite && (cookie.sameSite !== "None" || out.secure)) out.sameSite = cookie.sameSite;
    const key = `${out.name}|${out.domain ?? out.url}`;
    const prev = byKey.get(key);
    if (!prev || (out.expires ?? 0) > (prev.expires ?? 0)) byKey.set(key, out);
  }
  return [...byKey.values()];
}

export async function injectCookies(page: CookieInjectionPage, cookies: Iterable<InjectedCookie>) {
  await page._sendToTarget("Network.setCookies", { cookies: sanitizeCookies(cookies).map(cookieToCdp) });
}
