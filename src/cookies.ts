export interface RawCookie {
  name: string;
  value: string;
  domain: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  expires?: number;
  sameSite?: string;
}

export interface CdpCookieParam {
  name: string;
  value: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  url?: string;
  domain?: string;
  expires?: number;
  sameSite?: string;
}

export interface CookieTargetPage {
  _sendToTarget(method: string, params: Record<string, unknown>): Promise<unknown>;
}

export function sanitizeCookies(cookies: Iterable<RawCookie>) {
  const byKey = new Map<string, CdpCookieParam>();
  for (const cookie of cookies) {
    const out: CdpCookieParam = {
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

export async function injectCookies(page: CookieTargetPage, cookies: Iterable<RawCookie>) {
  await page._sendToTarget("Network.setCookies", { cookies: sanitizeCookies(cookies) });
}
