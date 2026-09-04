---
name: captcha
description: Solve challenge widgets that block an authorized automation flow - checkbox (reCAPTCHA, Turnstile, hCaptcha), slider/puzzle drag, text/number OCR, and image-grid. Read this when a challenge widget is the thing standing between the run and its goal.
---

# Captcha

`createCaptcha(page, { ocr? })` handles the three widget shapes. Every method
returns a post-action snapshot tree, so verification is part of the call rather
than a separate step you might skip.

A challenge widget is an obstacle on the path, not a stop sign for the run.
Solve it, verify it cleared, and continue. Escalate through the strategies
below rather than pausing to report that a captcha exists.

This is rung 4 of the escalation ladder in `presets/visual-browse/SKILL.md`.
Before computing any bounds, make sure the coordinate space is trustworthy: if
clicks have been landing wrong, drop to rung 3 and pin the viewport with
`Emulation.setDeviceMetricsOverride` + `refreshViewportSize` first, then
re-read the bounds. Bounds measured against an unpinned viewport are wrong by
the same constant as every other coordinate.

```js
import { createCaptcha } from "omowright";
const captcha = createCaptcha(page);
```

## Checkbox widgets (reCAPTCHA, Turnstile, hCaptcha)

Find the widget's box, click inside it, then read the returned tree to confirm
the checked state:

```js
const bounds = await page.evaluate(`(() => {
  const el = document.querySelector("iframe[src*='recaptcha'], iframe[src*='turnstile'], iframe[src*='hcaptcha']");
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height };
})()`);

const tree = await captcha.click(bounds);          // clicks left-center, settles, returns tree
```

The widget lives inside an iframe, and viewport coordinates reach into it — no
frame switching is required.

## Slider and puzzle drags

```js
const tree = await captcha.drag({ x: 150, y: 300 }, { x: 450, y: 300 });
const tree2 = await captcha.drag(from, to, { steps: 40 });   // more steps = smoother path
```

Slider checks often score the motion, not just the endpoint. When a drag that
lands on target is still rejected, raise `steps` before changing the endpoint.

## Text and number captchas

```js
const text = await captcha.readText({ x: 100, y: 200, width: 200, height: 60 });
await page.locator("input[name=captcha]").fill(text);
```

`readText` screenshots the region (or the full viewport when bounds are
omitted) and OCRs it. macOS Vision is the built-in engine and needs no
dependencies. On other platforms, or when the image defeats Vision, inject a
model:

```js
const captcha = createCaptcha(page, { ocr: async (pngBuffer) => "recognized text" });
```

OCR on a cropped region beats OCR on a full page. Get bounds from the image
element before reading when the element is findable.

## Image-grid challenges

`page.annotatedScreenshot()` overlays numbered boxes on interactive elements.
Send that image to a vision model, decide which cells match the prompt, then
click each one with `createCua(page)` coordinates and submit.

## Tuning and failure handling

- `click` and `drag` accept `{ settleMs }` (default 3000ms). Real widgets reload
  slowly; raise it when the returned tree still shows the pre-click state.
- The returned tree is the verification. Read it — a call that "succeeded"
  while the tree still shows an unsolved widget did not solve anything.
- Two failures of one strategy mean switch strategy: re-read the bounds, raise
  `steps` or `settleMs`, crop the OCR region tighter, or fall back to
  `annotatedScreenshot` plus vision.
- Widgets score fingerprint and behavior before they score the answer. When
  every strategy fails on a page that a normal browser passes, the engine is
  the problem — run it through CloakBrowser (see `references/stealth.md` in the
  installed skill) rather than tuning coordinates further.
- If coordinates land wrong across all attempts, drop to rung 3 — pin the
  viewport (`presets/visual-browse/SKILL.md`) and re-read the bounds.
- When the widget is solved but the flow still stalls, that is rung 5: read the
  browser log and report the cause instead of re-solving a solved challenge.

## Methods

| Method | Behavior |
|---|---|
| `captcha.click(bounds, opts?)` | Click left-center of `bounds`, settle, return snapshot tree |
| `captcha.drag(from, to, opts?)` | Drag between viewport points; `opts.steps` (default 20) controls smoothness |
| `captcha.readText(bounds?)` | Screenshot (clipped when bounds given), OCR, return text or `null` |
