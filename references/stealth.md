# Stealth — CloakBrowser through OmOWright

CloakBrowser is a stealth Chromium with source-level fingerprint patches
(passes Cloudflare Turnstile, FingerprintJS, BrowserScan). OmOWright drives
its binary over the pipe transport — no CDP port, no agent-browser CLI.

## Binary discovery

```bash
python3 -c "import cloakbrowser, json; print(cloakbrowser.binary_info()['binary_path'])"
# → /Users/yeongyu/.cloakbrowser/chromium-<ver>/Chromium.app/Contents/MacOS/Chromium
```

If cloakbrowser is not installed: `uv pip install "cloakbrowser==0.5.7"` in a
venv, then `python -c "import cloakbrowser; cloakbrowser.ensure_binary()"`.

## CloakBrowser single-instance rule

CloakBrowser enforces **one running instance** (Chromium SingletonLock,
possibly strengthened by source patches). If an instance is already running,
`connectPipe` to spawn a new one hangs during early init — the CDP
`Browser.getVersion` handshake never answers and OmOWright times out.

**Before `connectPipe`, check for an existing instance:**

```bash
curl -s -m 2 http://127.0.0.1:9242/json/version
# If this returns Browser info → an instance is alive. Use connect() instead.
```

**If an instance exists, attach with `connect()` — do NOT spawn another:**

```js
const browser = await connect("http://127.0.0.1:9242");
// connect() returns BrowserConnection — NO newTab(). Use CDP Target.createTarget:
const { targetId } = await browser.cdp.send("Target.createTarget", { url: "https://target.com" });
const page = await browser.attachPage(targetId);
// ... work ...
await browser.cdp.send("Target.closeTarget", { targetId });  // close only YOUR tab
```

If no instance is running, `connectPipe` works normally.

## Launch

```js
const cloakPath = "/Users/yeongyu/.cloakbrowser/chromium-145.0.7632.109.2/Chromium.app/Contents/MacOS/Chromium";
const browser = await omwTools.connectPipe({
  browserPath: cloakPath,
  browserArgs: [
    "--no-first-run",
    `--user-data-dir=${profile}`,
    "--user-agent=Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.7680.177 Safari/537.36",
  ],
  storageRoot: profile,
});
```

- Omit `--headless` when the WAF is aggressive — headed mode has stronger
  trust signals. CloakBrowser's patches apply in both modes.
- Do NOT pass an init-script for `navigator.webdriver` — CloakBrowser patches
  it at C++ source. The only override worth passing is `--user-agent`.

## Verify stealth

```js
const page = await browser.newTab("about:blank");
await page.evaluate("navigator.webdriver");  // must be false
```

For a full check, load `https://bot.sannysoft.com` or
`https://browserscan.net` and read the result panel with a snapshot.

## Persistent profiles and cookies

- Reuse a stable `--user-data-dir` (not a temp dir) to keep logins across
  runs. WAF trust builds with profile age.
- To import cookies from a real browser profile, extract them to JSON, then
  inject with the package helper (handles CDP sanitization):

```js
import { injectCookies } from "/Users/yeongyu/local-workspaces/OmOWright/src/index.js";
const cookies = JSON.parse(await fs.promises.readFile(cookieFile, "utf8"));
await injectCookies(page, cookies);   // sanitize + Network.setCookies
await page.goto(url);  // cookies apply on navigation
```

`injectCookies` drops `expires <= 0`, forces `secure`+root path+url-scoping
for `__Host-` cookies, drops `SameSite=None` when not secure, and dedupes by
name+domain — raw cookie exports fail CDP validation without this.

- Cookie files contain live secrets: `0600` permissions, never commit them,
  never print them.

## NEVER extract and reuse cookies for Google or 1Password

**This is a hard rule, learned by killing the user's real sessions on
2026-08-23. Violating it logs the user out of their own browser.**

- **Google (any property: youtube.com, google.com, accounts.google.com,
  mail, drive, …)** — NEVER extract Google cookies from a real browser
  profile and inject them into an OmOWright browser. Google's risk engine
  detects reuse from a new device fingerprint and **invalidates the session
  server-side — the source browser gets logged out too.** One run succeeds,
  then the account is signed out everywhere the cookies came from. This is
  not a rotation you can race; it is a kill. To act as the user on Google,
  drive the user's own logged-in browser — do not clone its session.
- **1Password web (1password.com)** — NEVER bother extracting cookies at
  all: sessions are bound to full app state (IndexedDB device keys, SRP
  session derivation), not cookies. Injection always lands on the sign-in
  page, from any machine, same machine included. There is no cookie-only
  path into 1Password web.
- **1Password direct login also does NOT persist across tabs/sessions.**
  Even when you log in manually inside the browser, opening a new tab to
  my.1password.com asks for the password again. The device-bound session
  model means every fresh tab/session requires re-authentication. The
  original logged-in tab stays valid — keep it open and reuse it instead
  of opening new ones.

Cookie extraction + injection is still fine for sites with ordinary session
cookies (Grafana, internal tools, most SaaS). The rules below apply to those.

## Session reuse doctrine (for ordinary cookie sessions)

- **Do everything in ONE browser session.** Inject cookies, navigate, read,
  screenshot — one run. Cross-run cookie reuse dies:
- **Grafana rotates its session token per request** — a reused cookie works
  once, then the old token is dead server-side. Re-extracting gives the same
  dead cookie.
- When a session dies, the recovery is a fresh login in the source browser,
  then extract + use immediately in a single run.

## Chromium cookie decryption notes (macOS)

- Keychain `*- Safe Storage` password → PBKDF2(`saltysalt`, 1003) →
  AES-128-CBC with a 16-space IV; strip the `v10` prefix AND the 32-byte
  SHA256 domain hash prepended to the plaintext.
- Read over the bunshin mesh (LaunchAgent context), NOT plain SSH — the
  keychain denies secret reads (`-w`) from non-GUI sessions.
- Aside's cookie DB uses a rollback journal (empty `-journal`), so copying
  the main `Cookies` file is sufficient; other browsers may need their
  `-wal` copied alongside.

## When stealth is NOT needed

A plain headless shell is faster and sufficient for most sites. Reach for
CloakBrowser only when the plain path returns a challenge page (Cloudflare
"Verify you are human", DataDome, PerimeterX) or empty content.
