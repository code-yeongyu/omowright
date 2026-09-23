# 1Password web vault

Reading an item from the 1Password web app through OmOWright. Everything here
follows from one fact: the web vault is a zero-knowledge client.

## The session lives in one tab

The unlocked vault key sits in **that tab's `sessionStorage`** (`mpa_session`),
not in a cookie. The `_tsession` cookie alone authenticates nothing. So:

- A new tab pointed at `/app` redirects to `/signin`, even with a signed-in tab
  open beside it. That is 1Password working correctly, not a bug to route around.
- **Reuse the signed-in tab.** Closing it, or navigating it away from the vault,
  loses access until someone signs in again.
- **Never extract or inject 1Password cookies.** Sessions are device-bound; a
  cookie copied into another profile never produces a vault.

## Signing in is a human step

Sign in interactively, inside a persistent profile (`connectCloakProfile()`, see
`stealth.md`), and hand the master password, Secret Key, and second factor to
a person with `requestHuman()` (`frames-layers-human.md`). Do not script
credential entry and do not retry a failed sign-in in a loop. When the tab sits
on `/signin`, stop and say so. Automatic recovery never applies here.

Do not restart the browser to "fix" a signed-out tab: with a temporary profile,
a restart discards the login instead of refreshing it.

## Checking you are signed in

Check `location.href`: a live session contains `/app#/` and never `/signin`.
Do **not** trust `document.title`. The single-page app changes its URL hash
without updating the title, so the title can read "sign in" while the vault is
open.

```js
const url = await page.evaluate(() => location.href);
if (!url.includes("/app#/")) throw new Error("1password: not signed in");
```

## Searching and reading an item

Two lists coexist on the page, and mixing them up gives wrong answers:

- the search box's autocomplete `listbox` holds **your** query's results;
- the item-list region holds whatever query was last committed, possibly by
  someone else sharing the browser.

Read only the autocomplete listbox, and drop its trailing "show all matches" row,
which is a navigation control, not an item. The listbox re-renders as you type,
so wait until two consecutive snapshots give the same title list.

Clear the search box before typing, since it may hold a previous query. Prefer
click and type over `locator.fill()` on a tab another automation also drives:
`fill()` installs an init script that can time out on a busy tab.

```js
const { compactSnapshot } = await import("omowright");
await page.locator(searchRef).click();
await page.keyboard.press("Meta+a");
await page.keyboard.press("Backspace");
await page.keyboard.type(query);
const tree = compactSnapshot(await page.snapshot({ interactive: true }));
```

Refs are reissued on every snapshot. Re-snapshot after each action, then click
the item and snapshot its detail region. Match on roles, not labels: the same
account can render in different UI languages.

## Handling secrets

- Report metadata freely: item title, vault, username, URL, which fields exist.
- Concealed values render as `••••••`. Reveal a value only when the user asked
  for that exact field, and return it to the caller. Never log it.
- Never write secrets into screenshots, trace files, HAR output, or logs.
  Prefer a text snapshot to a screenshot, which can capture neighbouring entries.
- Report only the requested item's field, never other entries that happened to
  appear in the same list.
- When done, clear the search and leave the tab on All Items.
