# Stealth — CloakBrowser through OmOWright

CloakBrowser is a stealth Chromium with source-level fingerprint patches (passes
Cloudflare Turnstile, FingerprintJS, BrowserScan). OmOWright drives its binary
over the pipe transport — no CDP port, no agent-browser CLI.

## Binary discovery

```bash
python3 -c "import cloakbrowser, json; print(cloakbrowser.binary_info()['binary_path'])"
# -> /Users/yeongyu/.cloakbrowser/chromium-<ver>/Chromium.app/Contents/MacOS/Chromium
```

Not installed: `uv pip install "cloakbrowser==0.5.7"` in a venv, then
`python -c "import cloakbrowser; cloakbrowser.ensure_binary()"`.

## Single-instance rule

CloakBrowser enforces **ONE RUNNING INSTANCE** (Chromium SingletonLock, possibly
strengthened by source patches). If one is already running, `connectPipe` HANGS
during early init — the `Browser.getVersion` handshake never answers and
OmOWright times out.

```bash
curl -s -m 2 http://127.0.0.1:9242/json/version   # Browser info -> an instance is alive
```

If alive, attach — do NOT spawn another. `connect()` returns `BrowserConnection`,
which has no `newTab()`:

```js
const browser = await connect("http://127.0.0.1:9242");
const { targetId } = await browser.cdp.send("Target.createTarget", { url: "https://target.com" });
const page = await browser.attachPage(targetId);
// ... work ...
await browser.cdp.send("Target.closeTarget", { targetId });  // close only YOUR tab
```

## Launch

```js
const { connectCloakProfile } = await import("/Users/yeongyu/local-workspaces/OmOWright/src/index.js");
const browser = await connectCloakProfile({
  profileDir: "/Users/yeongyu/.local/share/omowright-cloak",
  fingerprintSeed: 63498,   // first use pins it; later runs reuse it and reject a mismatch
});
```

CLI equivalent:
`omowright-cloak --profile "$HOME/.local/share/omowright-cloak" --url https://target.example --once --snapshot`

- Omit `--headless` when the WAF is aggressive — headed mode carries stronger
  trust signals. The patches apply in both modes.
- Do NOT pass an init-script for `navigator.webdriver` — CloakBrowser patches it
  at C++ source. `--user-agent` is the only override worth passing.
- The seed lives in `.omowright-cloak.json` (mode `0600`) and is passed as the
  same `--fingerprint=<seed>` on every launch. Do not pass `--user-data-dir`,
  `--fingerprint`, or `--fingerprint-platform` through `browserArgs`; conflicting
  identity overrides are rejected.
- The helper uses `connectPipe()`, so there is no listening CDP TCP port. One
  process per profile.

Verify: `await page.evaluate("navigator.webdriver")` must be `false`. For a full
check load `https://bot.sannysoft.com` or `https://browserscan.net` and read the
result panel with a snapshot.

## Persistent profiles and cookies

Reuse a stable `--user-data-dir` (not a temp dir) to keep logins across runs —
WAF trust builds with profile age. To import cookies from a real browser profile,
extract them to JSON and inject with the package helper:

```js
import { injectCookies } from "/Users/yeongyu/local-workspaces/OmOWright/src/index.js";
const cookies = JSON.parse(await fs.promises.readFile(cookieFile, "utf8"));
await injectCookies(page, cookies);   // sanitize + Network.setCookies
await page.goto(url);                 // cookies apply on navigation
```

`injectCookies` drops `expires <= 0`, forces `secure` + root path + url-scoping
for `__Host-` cookies, drops `SameSite=None` when not secure, and dedupes by
name+domain — raw exports fail CDP validation without this. Cookie files are
live secrets: `0600`, never committed, never printed.

## NEVER extract and reuse cookies for Google or 1Password

**HARD RULE, LEARNED BY KILLING THE USER'S REAL SESSIONS ON 2026-08-23. VIOLATING
IT LOGS THE USER OUT OF THEIR OWN BROWSER.**

- **Google (any property: youtube.com, google.com, accounts.google.com, mail,
  drive, ...)** — Google's risk engine detects reuse from a new device
  fingerprint and **invalidates the session server-side; the source browser is
  logged out too.** One run succeeds, then the account is signed out everywhere
  the cookies came from. Not a rotation you can race — a kill. To act as the
  user on Google, drive the user's own logged-in browser.
- **1Password web (1password.com)** — sessions are bound to full app state
  (IndexedDB device keys, SRP session derivation), not cookies. Injection always
  lands on the sign-in page, from any machine including the same one. There is
  no cookie-only path in.
- 1Password direct login does not persist across tabs either: a new tab to
  my.1password.com asks for the password again. The original logged-in tab stays
  valid — keep it open and reuse it.
- 1Password auto-lock extends to 8 hours max (Settings > Security > 자동 잠금 >
  8시간), but closing the browser ALWAYS locks it — hardcoded. Keep the browser
  running and the tab open.

Cookie extraction + injection stays fine for sites with ordinary session cookies
(Grafana, internal tools, most SaaS).

## Session reuse doctrine (ordinary cookie sessions)

Do everything in ONE browser session: inject, navigate, read, screenshot, one
run. Cross-run reuse dies — Grafana rotates its session token per request, so a
reused cookie works once and re-extracting yields the same dead token. Recovery
is a fresh login in the source browser, then extract + use immediately.

## Chromium cookie decryption notes (macOS)

- Keychain `*- Safe Storage` password -> PBKDF2(`saltysalt`, 1003) ->
  AES-128-CBC with a 16-space IV; strip the `v10` prefix AND the 32-byte SHA256
  domain hash prepended to the plaintext.
- Read over the bunshin mesh (LaunchAgent context), NOT plain SSH — the keychain
  denies secret reads (`-w`) from non-GUI sessions.
- Aside's cookie DB uses a rollback journal (empty `-journal`), so copying the
  main `Cookies` file suffices; other browsers may need `-wal` copied alongside.

## When stealth is NOT needed

A plain headless shell is faster and sufficient for most sites. Reach for
CloakBrowser when the plain path returns a challenge page (Cloudflare "Verify
you are human", DataDome, PerimeterX) or empty content.
