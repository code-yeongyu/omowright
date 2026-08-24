# Interaction — CUA, CAPTCHA, screenshots

## CUA (coordinate fallback)

`createCua(page)` for UI that refs cannot target: canvas apps, custom
controls, stale/obscured refs, visual verification.

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

- Modifiers: `Alt`, `Control`, `ControlOrMeta`, `Meta`, `Shift`; aliases
  `Cmd`, `Command`, `Ctrl`, `Option`.
- Look before acting: screenshot first when coordinates are unknown.
- Return to refs/locators as soon as DOM targeting works again.

Full operating rules: `/Users/yeongyu/local-workspaces/OmOWright/presets/visual-browse/SKILL.md`.

## CAPTCHA

`createCaptcha(page, { ocr? })` — checkbox, slider, and text captchas.

```js
const captcha = createCaptcha(page);

// Checkbox: click inside the widget bounds, get a post-action snapshot tree
const bounds = await page.evaluate(`(() => {
  const r = document.querySelector("iframe").getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height };
})()`);
const tree = await captcha.click(bounds);            // settles 3s, returns compact tree

// Slider / puzzle drag
const tree2 = await captcha.drag({ x: 150, y: 300 }, { x: 450, y: 300 }, { steps: 40 });

// Text captcha OCR
const text = await captcha.readText({ x: 100, y: 200, width: 200, height: 60 });
await page.locator("input").fill(text);
```

- `click`/`drag` accept `{ settleMs }` to tune the post-action wait (default
  3000ms — real captcha iframes reload slowly).
- `readText` defaults to macOS Vision OCR (zero dependencies). On other
  platforms or for harder images, inject a vision model:
  `createCaptcha(page, { ocr: async (pngBuffer) => string })`.
- CAPTCHA widgets live in iframes; viewport coordinates reach them.
- For image-grid challenges, use `page.annotatedScreenshot()` plus a vision
  model to pick cells, then `cua.click` each.

## Screenshots

```js
await page.screenshot({ path: "artifacts/shot.png" });
await page.screenshot({ fullPage: true, type: "jpeg", quality: 80 });
await page.screenshot({ clip: { x, y, width, height } });
await page.annotatedScreenshot();   // numbered boxes over interactive elements
```

## Dialogs during interaction

Dialogs are auto-accepted (see quickstart). A click that triggers
`window.print()` or `alert()` will not hang; `page.on('dialog')` records it.
