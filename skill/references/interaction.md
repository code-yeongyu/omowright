# Interaction — CUA, CAPTCHA, screenshots

Full operating rules live in the repo presets:
`/Users/yeongyu/local-workspaces/OmOWright/presets/visual-browse/SKILL.md` and
`presets/captcha/SKILL.md`. This file carries the facts you need without opening
them.

## Escalation ladder

One rung per two identical failures on the same target. The failure selects the
next rung; nothing waits on a human decision.

1. `page.snapshot()` + `page.locator(ref)` — everything with a usable ref.
2. `createCua(page)` coordinates — canvas, extension popups, custom controls.
3. Pin the viewport (below), then retry rung 2 — coordinate drift.
4. `createCaptcha(page)` — a challenge widget is the blocker.
5. Read the browser log — **A BROWSER-PROCESS CAUSE ENDS IN A WRITTEN
   DIAGNOSIS, NOT A SPECULATIVE CODE CHANGE.**

## Pin the viewport before trusting coordinates

CUA acts in viewport pixels. A resized window, a foreign tab, or a scale factor
other than 1 puts every coordinate off by a constant, so retrying repeats the
miss. Pin the render surface and the coordinate space to one box:

```js
await page._sendToTarget("Emulation.setDeviceMetricsOverride", {
  width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
  screenWidth: 1440, screenHeight: 900,
  viewport: { x: 0, y: 0, width: 1440, height: 900, scale: 1 },
});
const size = await page.refreshViewportSize();   // -> { width: 1440, height: 900 }
```

Pin every page you will act on, including tabs you did not open, then take a
fresh screenshot. Pin-then-retry, not retry, when: the click reports success but
nothing changes; the same offset is wrong on every target; screenshot dimensions
disagree with the coordinates you computed.

## CUA (coordinate control)

```js
const cua = createCua(page);
await cua.click({ x, y, button?, keypress? });
await cua.doubleClick({ x, y, keypress? });
await cua.drag({ path: [{ x, y }, ...], keys? });
await cua.move({ x, y, keys? });
await cua.scroll({ x, y, scrollX, scrollY, keypress? });
await cua.type({ text });
await cua.keypress({ keys: ["ControlOrMeta", "a"] });
const base64Png = await cua.getVisibleScreenshot();
```

- Modifiers: `Alt`, `Control`, `ControlOrMeta`, `Meta`, `Shift`; aliases `Cmd`,
  `Command`, `Ctrl`, `Option`.
- Screenshot first when coordinates are unknown. **VERIFY AFTER EVERY
  PAGE-CHANGING ACTION** — fresh screenshot for visual state, fresh snapshot for
  DOM state. Return to refs/locators as soon as DOM targeting works again.
- Browser chrome and OS-drawn UI (extension popups, passkey/Touch ID prompts,
  native pickers) have no DOM — rung 1 is skipped there. A click that cannot
  satisfy an OS credential dialog is rung 5: read the browser log.
- Values that leave the page through the system clipboard (an extension copying a
  one-time code) are read back with `pbpaste` and validated by shape before use;
  an unvalidated read silently carries stale clipboard content.

## CAPTCHA

`createCaptcha(page, { ocr? })` — checkbox, slider, and text captchas. Widgets
live in iframes; viewport coordinates reach them without frame switching.

```js
const captcha = createCaptcha(page);
const bounds = await page.evaluate(`(() => {
  const r = document.querySelector("iframe").getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height };
})()`);
const tree = await captcha.click(bounds);                                   // settles 3s, returns compact tree
const tree2 = await captcha.drag({ x: 150, y: 300 }, { x: 450, y: 300 }, { steps: 40 });
const text = await captcha.readText({ x: 100, y: 200, width: 200, height: 60 });
await page.locator("input").fill(text);
```

- `click`/`drag` accept `{ settleMs }` (default 3000ms — real captcha iframes
  reload slowly). `drag` default `steps` is 20.
- `readText` defaults to macOS Vision OCR (zero dependencies). Elsewhere, or for
  harder images, inject `createCaptcha(page, { ocr: async (pngBuffer) => string })`.
- Image grids: `page.annotatedScreenshot()` plus a vision model to pick cells,
  then `cua.click` each.
- **THE RETURNED TREE IS THE VERIFICATION.** A call whose tree still shows the
  unsolved widget solved nothing.

## Screenshots

```js
await page.screenshot({ path: "artifacts/shot.png" });
await page.screenshot({ fullPage: true, type: "jpeg", quality: 80 });
await page.screenshot({ clip: { x, y, width, height } });
await page.annotatedScreenshot();   // numbered boxes over interactive elements
```

Dialogs are auto-accepted (see quickstart): a click that triggers `window.print()`
or `alert()` will not hang; `page.on('dialog')` records it.
