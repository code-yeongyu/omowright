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

## Signing in to the vault is a human step

Sign in interactively, inside a persistent profile (`connectCloakProfile()`, see
`stealth.md`), and hand the master password, Secret Key, and second factor to
a person with `requestHuman()` (`frames-layers-human.md`). Do not script
credential entry and do not retry a failed sign-in in a loop. When the tab sits
on `/signin` and no saved login is offered (next section), stop and say so.

## Signing in with the extension's inline menu

When the 1Password browser extension is installed and unlocked, let **it** fill
the login. Its inline menu puts the secret into the field without the value ever
passing through your code, tool arguments, or logs. This covers both a 1Password
account sign-in page and any other site that needs a saved login or one-time code.

1. Take a fresh snapshot first. If the destination already shows its signed-in
   home and the expected account, no sign-in is needed.
2. Click the username, password, or one-time-code field and snapshot again to see
   the extension's inline menu. Pick the entry whose **host and account both
   match**. Several accounts can be offered on the same host, so never pick by
   position.
3. **If the menu does not appear**, click the field again, then press
   `ArrowDown` while it has focus, then snapshot. A field focused before a
   sign-in finished often needs a fresh click. One missing menu does not prove the
   extension is locked; only an explicit locked state does, and that is a human
   step.
4. A sign-in-only tab may **close itself** after authenticating. That is the
   expected handoff. Reattach the original tab, take a fresh snapshot, and repeat
   step 2 on the field that was waiting (for example a one-time-code field behind
   single sign-on).
5. Selecting an entry can fill **and** submit. Submit at most once; while the page
   shows a signing-in state, wait and snapshot instead of resubmitting.
6. Done means the destination shows its signed-in page and the right identity. A
   filled field or a spinner is not done. Then carry on with the task that needed
   the login; do not stop at "signed in".

If the inline menu keeps failing on a page that needs it, use the vault's own
copy control instead: open the item in the signed-in vault tab, click its copy
button, confirm the copied toast, then paste into the verified field with a real
key press (`ControlOrMeta+v` through the computer-use keyboard; a synthetic
`keyboard.press` can leave the field empty). Check only that the field is
non-empty. Never read the clipboard to test it, and never type or print the value.

Never print, screenshot, or store an item pane, a one-time code, or a sign-in
callback URL (anything carrying `code=` or `state=` parameters), and never
navigate to a callback URL saved in an item: it is stale and single-use.

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
