---
name: omowright
description: "Drive any browser from code — the optimized path for ALL browsing work, replacing ultimate-browsing: token-efficient a11y snapshots (57% smaller via compactSnapshot), ref-based clicking/filling, coordinate fallback (CUA/visual browsing), CAPTCHA solving (reCAPTCHA, Turnstile, hCaptcha, slider, text OCR via macOS Vision), Chrome MV3 APIs (tabs/bookmarks/history/downloads/topSites), and stealth browsing through CloakBrowser as the DEFAULT engine — all with zero exposed CDP ports. MUST USE for any browser task: scraping, blocked/WAF/JS-rendered pages, login flows, form filling, screenshots, page QA, CAPTCHAs, and as the browsing lane for ulw-research. Works inside eval cells (persistent kernel browser), with headless or headed Chromium, and attached to real user browsers. Triggers: browse, open page, click, fill form, scrape, snapshot, screenshot, captcha, recaptcha, turnstile, hcaptcha, cloudflare/WAF bypass, stealth browser, drive chrome, browser automation, web QA, ulw-research browsing."
---

# OmOWright

Browser automation as a code library — no external CLI, no daemon, no open CDP
port. The package lives at `/Users/yeongyu/local-workspaces/OmOWright` and is
imported directly by absolute path. Runs on Node >= 20 and Bun.

## Default engine: CloakBrowser

**Use the CloakBrowser binary by default**, not a plain headless shell — most
real targets are behind WAFs or bot scoring, and CloakBrowser's source-level
fingerprint patches (Cloudflare Turnstile, FingerprintJS, BrowserScan) make it
the safe default. Plain headless shell is the fallback for trivially open
pages where speed matters.

```bash
python3 -c "import cloakbrowser; print(cloakbrowser.binary_info()['binary_path'])"
# → /Users/yeongyu/.cloakbrowser/chromium-<ver>/Chromium.app/Contents/MacOS/Chromium
```

**CloakBrowser single-instance check:** before `connectPipe` with CloakBrowser,
probe for an existing instance (`curl -s -m 2 http://127.0.0.1:9242/json/version`).
If one is alive, `connectPipe` will hang — use `connect()` to attach instead.
See `references/stealth.md` for the full pattern.

Fallback (no WAF, max speed): any Chrome/Chromium or the Playwright headless
shell (`~/Library/Caches/ms-playwright/chromium_headless_shell-*/.../chrome-headless-shell`).
Full stealth setup, verification, and cookie rules: `references/stealth.md`.

## Core loop

```js
const { connectPipe, compactSnapshot } = await import("/Users/yeongyu/local-workspaces/OmOWright/src/index.js");
const browser = await connectPipe({
  browserPath: "<CloakBrowser binary>",           // DEFAULT engine
  browserArgs: ["--no-first-run", `--user-data-dir=${profileDir}`],
  storageRoot: profileDir,
});
const page = await browser.newTab("https://example.com");
const tree = compactSnapshot(await page.snapshot());  // ALWAYS compact before reading
await page.locator("e1").click();                     // refs from the snapshot
await browser.close();                                // kills the process; rm the profile dir
```

## Route by task — visual browsing and CAPTCHAs first

| Task | Read |
|---|---|
| **CAPTCHA** (reCAPTCHA, Turnstile, hCaptcha, slider, text) | `references/interaction.md` — usually DELEGATE, see below |
| **Visual browsing** (canvas apps, coordinate UI, pixel verification) | `references/interaction.md` — usually DELEGATE, see below |
| WAF/Cloudflare/bot-detection pages, CloakBrowser, cookie rules | `references/stealth.md` |
| First use, page API, snapshot options, locator rules, dialogs | `references/quickstart.md` |
| Driving a browser inside `eval` cells, kernel persistence, parallel lanes | `references/eval-kernel.md` |
| Tabs/windows/bookmarks/history/downloads/topSites (Chrome MV3) | `references/chrome-api.md` |

## Delegate CAPTCHA and visual-browsing work to `deep` subagents

CAPTCHA solving and pixel-level visual browsing are multi-step, iterative work
(screenshot → reason → act → verify, repeated). Don't burn your own context on
the loop — delegate each blocked page to a `deep` category subagent that loads
this skill's references:

```
task(category: "deep", run_in_background: true, prompt: `
TASK: Solve the CAPTCHA blocking <url> and return the post-solve state.
1. Read ~/.agents/skills/omowright/references/interaction.md and stealth.md.
2. connectPipe with the CloakBrowser binary (default engine).
3. createCaptcha(page) — click(bounds) for checkbox captchas (reCAPTCHA/
   Turnstile), drag(from, to, {steps}) for sliders, readText(bounds) for text
   captchas (macOS Vision OCR is the default; inject ocr: for a vision model).
4. For image-grid challenges: page.annotatedScreenshot() + cua.click per cell.
5. VERIFY with a fresh compactSnapshot that the challenge is gone; retry with
   a different strategy after 2-3 failures (fresh screenshot first).
STOP WHEN the page is past the CAPTCHA or 3 strategies are exhausted.
Return: post-solve snapshot tree + screenshot path.`)
```

Same pattern for visual browsing (canvas editors, maps, custom drag handles):
delegate to `deep` with `createCua(page)` — `click/drag/scroll/type` at
viewport coordinates, `getVisibleScreenshot()` before acting, return to
refs/locators once DOM targeting works again. Both flows are documented in
`references/interaction.md` — the subagent reads it there; you only pass the
URL and the goal.

## Hard rules

- **NEVER extract and inject cookies for Google or 1Password** — Google's
  risk engine kills the session server-side and logs the user out of their
  own browser; 1Password sessions are device-bound and never work from
  cookies. Full detail in `references/stealth.md`. Cookie reuse is fine for
  ordinary sessions (Grafana, internal tools) — see the session doctrine
  there too.
- **Always `compactSnapshot()`** a snapshot before sending it to a model — the
  refs map is ~54% of bytes and resolves in-page, so dropping it is free.
- **Refs die on every new snapshot.** `page.locator("e1")` straight from the
  latest snapshot; never reuse a ref across snapshots, never put a ref in CSS.
- **Dialogs never block.** `alert/confirm/prompt/beforeunload` are auto-accepted
  at the transport layer (`confirm() → true`, `prompt() → ""`). Observe them
  with `page.on('dialog')`.
- **`goto` waits for meaningful content**, not `readyState`: body plus
  (interactive elements OR landmarks OR ≥20 text chars). Near-empty pages
  time out — use `page.goto(url, { waitUntil: "commit" })` for those.
- **Cleanup is paired**: `await browser.close()` then `rm -rf` the profile dir
  in the same `finally`.

## Choosing this over everything else

- Plain `webfetch`/`curl` is fine for one static page. The moment a page needs
  JS, interaction, login, screenshots, CAPTCHAs, or WAF bypass — use this
  skill, not ultimate-browsing: one library covers tiers 1-2 with a persistent
  browser, smaller snapshots, and no agent-browser/CloakBrowser CLI plumbing.
- ulw-research browsing lanes: spawn `deep` lanes that `import()` this package
  in eval cells — the browser persists across cells via `globalThis`, and
  `compactSnapshot` keeps dozens of pages inside the context budget.
