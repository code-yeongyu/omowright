---
name: visual-browse
description: Coordinate-level browser control for UI that snapshots, refs, and locators cannot target - canvas apps, extension popups, OS-drawn dialogs, custom drag surfaces. Read this when a DOM-targeted action fails twice, when the next decision depends on rendered pixels, or when CUA clicks land on the wrong element.
---

# Visual Browse

`createCua(page)` drives the page by viewport coordinates when DOM targeting
cannot. It is the second rung of the escalation ladder, not a last resort you
reach after asking permission.

## Escalation ladder

Climb one rung whenever the current rung fails twice on the same target. Never
pause to ask which rung to use; the failure itself selects the next one.

| Rung | Use | Advance when |
|---|---|---|
| 1. `page.snapshot()` + `page.locator(ref)` | Everything with a usable ref | Ref is absent, stale, obscured, or the click lands on the wrong node twice |
| 2. `createCua(page)` coordinates | Canvas, extension popups, custom controls, drag surfaces | The click misses, or the screenshot and the coordinates disagree |
| 3. **Pin the viewport**, then retry rung 2 | Coordinate drift: the window resized, DPI scaled, or the tab was created at a different size | Coordinates now land correctly but the widget still refuses input |
| 4. `createCaptcha(page)` | A challenge widget is what blocks progress | The widget is solved but the flow still stalls |
| 5. Environment diagnosis | Browser-level failure (entitlements, extension service worker, FIDO) | Logs name a cause outside the page |

Rung 5 ends in a written diagnosis, not a code change. A failure whose cause is
the browser process is not fixed by editing automation code.

## Pin the viewport before trusting coordinates

CUA acts in viewport pixels. When the render surface and the coordinate space
disagree — a resized window, a tab opened at a different size, a scale factor
other than 1 — every coordinate is wrong by a constant offset, and retrying the
same click repeats the same miss. Pin both to the same box first:

```js
await page._sendToTarget("Emulation.setDeviceMetricsOverride", {
  width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
  screenWidth: 1440, screenHeight: 900,
  viewport: { x: 0, y: 0, width: 1440, height: 900, scale: 1 },
});
const size = await page.refreshViewportSize();   // → { width: 1440, height: 900 }
```

Pin every page you will act on, including tabs you did not open. After pinning,
take a fresh screenshot: coordinates read off an unpinned screenshot are stale.

Symptoms that mean "pin the viewport" rather than "retry the click": the click
reports success but nothing changes; the same offset is wrong on every target;
the screenshot dimensions differ from the coordinates you computed against.

## Operating rules

- The CUA instance is bound to the page it was created from. Focus or attach the
  right tab before acting.
- Look before acting when coordinates are unknown: `cua.getVisibleScreenshot()`
  (base64 PNG), `page.screenshot({ path })` for a file, or
  `page.annotatedScreenshot()` for numbered boxes over interactive elements.
- Verify after every action that changes the page — fresh screenshot for visual
  state, fresh snapshot for DOM state. A CUA action that is not verified has not
  happened.
- Return to refs and locators as soon as DOM targeting works again. Coordinates
  are the expensive path; stay on them only while pixels are what matter.
- Two identical failures mean the approach is wrong, not that it needs a third
  try. Change rung, change target, or change strategy.

## API

```js
import { createCua } from "omowright";

const cua = createCua(page);
await cua.click({ x, y, button?, keypress? });        // keypress: modifiers held during click
await cua.doubleClick({ x, y, keypress? });
await cua.drag({ path: [{ x, y }, ...], keys? });     // mousedown at first point, move through path, mouseup
await cua.move({ x, y, keys? });
await cua.scroll({ x, y, scrollX, scrollY, keypress? });
await cua.type({ text });
await cua.keypress({ keys: ["ControlOrMeta", "a"] }); // ControlOrMeta = Meta on macOS, Control elsewhere
const base64Png = await cua.getVisibleScreenshot();
```

Modifier values: `Alt`, `Control`, `ControlOrMeta`, `Meta`, `Shift`. Aliases:
`Cmd`, `Command`, `Ctrl`, `Option`.

## Surfaces that only CUA reaches

Browser chrome and OS-drawn UI have no DOM at all. Refs will never exist for
them, so rung 1 is skipped entirely:

- **Extension popups** (password managers, wallets): click the toolbar icon by
  coordinate, then act inside the popup by coordinate.
- **Platform credential dialogs** (passkey, Touch ID, OS password prompts):
  these are drawn by the OS. If a click cannot dismiss or satisfy them, that is
  rung 5 — read the browser log rather than clicking harder.
- **Native select popups and file pickers**: prefer
  `locator.selectOption()` / `locator.setInputFiles()`; use coordinates only
  when the control is custom-rendered.

Values that leave the page through the system clipboard (a one-time code copied
by an extension, for example) are read back with `pbpaste` on macOS and
validated by shape before use — an unvalidated clipboard read silently carries
whatever was there before.

## Displaying a screenshot to the model

- Eval/REPL kernel with a `display()` builtin:
  `display(Buffer.from(await cua.getVisibleScreenshot(), "base64"))`.
- Otherwise: `await page.screenshot({ path: "artifacts/shot.png" })` and cite the
  path.

## Recovery

- A popup, modal, or cookie banner that overlays the target is handled first;
  everything behind it is unreachable until it is gone.
- If an action does not visibly work, take a fresh screenshot before retrying —
  the page may have moved under you.
- For layered canvas and editor surfaces, prefer coarse sidebar and toolbar
  controls over precise clicks on stacked objects.
- When the browser log names the cause (extension service worker failure,
  missing entitlement, FIDO unavailable), stop retrying and report the cause.
  Automation code cannot fix a browser process problem.
