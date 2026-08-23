---
name: visual-browse
description: Read this when you need a coordinate fallback for visible browser UI that snapshots, refs, or locators cannot target reliably.
---

# Visual Browse

`createCua(page)` gives coordinate-level control when DOM targeting fails. Use
it only while the task genuinely depends on visible pixels.

## When to use

- **Canvas rendered apps**: slide/document/image editors, maps, games, charts, whiteboards
- **Custom visual controls**: drag handles, sliders, drawing surfaces, crop boxes, map pins
- **Unstable or missing refs**: visible controls whose snapshot refs are stale, absent, or obscured
- **Visual verification**: when DOM state is insufficient and the next action depends on rendered pixels

## When not to use

Reading ordinary page text, navigation-only work, or any button/link/input/menu
with a usable ref. Prefer `page.snapshot()`, refs, and locators whenever they
can target the UI reliably.

## Operating rules

- The CUA instance acts on the page it was created from. Open or focus the right tab first.
- When coordinates are not already known, look before acting: `cua.getVisibleScreenshot()`
  (base64 PNG) or `page.screenshot({ path })` to a file. `page.annotatedScreenshot()`
  overlays numbered boxes on interactive elements.
- After any CUA action that changes the page, verify with a fresh screenshot or snapshot before the next action.
- Return to snapshots, refs, and locators as soon as the visual task is done.
- If the same coordinate approach fails 2-3 times, switch strategy instead of repeating.

## API

```js
import { createCua } from "omowright";

const cua = createCua(page);
await cua.click({ x, y, button?, keypress? });        // keypress: modifiers held during click
await cua.doubleClick({ x, y, keypress? });
await cua.drag({ path: [{x,y}, ...], keys? });        // mousedown at first point, move through path, mouseup
await cua.move({ x, y, keys? });
await cua.scroll({ x, y, scrollX, scrollY, keypress? });
await cua.type({ text });
await cua.keypress({ keys: ["ControlOrMeta", "a"] }); // combo; ControlOrMeta = Meta on macOS, Control elsewhere
const base64Png = await cua.getVisibleScreenshot();
```

Modifier values: `Alt`, `Control`, `ControlOrMeta`, `Meta`, `Shift`. Aliases:
`Cmd`, `Command`, `Ctrl`, `Option`.

## Displaying a screenshot to the model

- In an eval/REPL kernel with a `display()` builtin: `display(Buffer.from(await cua.getVisibleScreenshot(), "base64"))`.
- Otherwise: `await page.screenshot({ path: "artifacts/shot.png" })` and reference the file.

## Recovery

- If a popup, modal, or cookie banner blocks interaction, handle that first.
- If an action does not visibly work, take a fresh screenshot before retrying.
- For layered canvas/editor surfaces, prefer coarse sidebar/tool controls over precise clicks on stacked objects.
