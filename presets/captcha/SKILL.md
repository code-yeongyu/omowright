---
name: captcha
description: Solve challenge widgets that block an authorized automation flow - checkbox (reCAPTCHA, Turnstile, hCaptcha), slider/puzzle drag, text/number OCR, and image-grid. Read this when a challenge widget is the thing standing between the run and its goal.
---

# Captcha

`createCaptcha(page, { ocr? })` handles the three widget shapes. Every method
returns a post-action snapshot tree, so verification is part of the call.

A challenge widget is an obstacle on the path, not a stop sign. Solve it, confirm
it cleared, continue — do not pause to report that a captcha exists.

This is rung 4 of the ladder in `presets/visual-browse/SKILL.md`. **BOUNDS
MEASURED AGAINST AN UNPINNED VIEWPORT ARE WRONG BY A CONSTANT OFFSET.** If clicks
have been landing wrong, drop to rung 3 first (`Emulation.setDeviceMetricsOverride`
+ `refreshViewportSize`), then re-read the bounds.

```js
import { createCaptcha } from "omowright";
const captcha = createCaptcha(page);
```

## Checkbox widgets (reCAPTCHA, Turnstile, hCaptcha)

Widgets live inside iframes and viewport coordinates reach into them — no frame
switching. Find the box, click it, read the returned tree:

```js
const bounds = await page.evaluate(`(() => {
  const el = document.querySelector("iframe[src*='recaptcha'], iframe[src*='turnstile'], iframe[src*='hcaptcha']");
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height };
})()`);

const tree = await captcha.click(bounds);          // clicks left-center, settles, returns tree
```

## Slider and puzzle drags

```js
const tree = await captcha.drag({ x: 150, y: 300 }, { x: 450, y: 300 }, { steps: 40 });
```

Slider checks score the motion, not just the endpoint. When a drag that lands on
target is still rejected, raise `steps` before changing the endpoint.

## Text and number captchas

```js
const text = await captcha.readText({ x: 100, y: 200, width: 200, height: 60 });
await page.locator("input[name=captcha]").fill(text);
```

macOS Vision is the built-in engine and needs no dependencies. Elsewhere, or when
the image defeats Vision, inject a model:
`createCaptcha(page, { ocr: async (pngBuffer) => "recognized text" })`.
OCR on a cropped region beats OCR on a full page — take bounds from the image
element when it is findable.

## Image-grid challenges

`page.annotatedScreenshot()` overlays numbered boxes on interactive elements. Send
that image to a vision model, pick the matching cells, click each with
`createCua(page)` coordinates, submit.

## Methods

| Method | Behavior |
|---|---|
| `captcha.click(bounds, opts?)` | Click left-center of `bounds`, settle, return snapshot tree |
| `captcha.drag(from, to, opts?)` | Drag between viewport points; `opts.steps` (default 20) controls smoothness |
| `captcha.readText(bounds?)` | Screenshot (clipped when bounds given), OCR, return text or `null` |

`click` and `drag` accept `{ settleMs }`, default 3000ms; raise it when the
returned tree still shows the pre-click state.

## Failure handling

**THE RETURNED TREE IS THE VERIFICATION.** A call that "succeeded" while the tree
still shows an unsolved widget solved nothing.

Two failures of one strategy mean switch strategy: re-read the bounds, raise
`steps` or `settleMs`, crop the OCR region tighter, or fall back to
`annotatedScreenshot` plus vision. If coordinates land wrong across every attempt,
drop to rung 3 and pin the viewport.

Widgets score fingerprint and behavior before they score the answer. **WHEN EVERY
STRATEGY FAILS ON A PAGE A NORMAL BROWSER PASSES, THE ENGINE IS THE PROBLEM** —
run it through CloakBrowser (`skills/omowright/references/stealth.md`)
rather than tuning coordinates further. When the widget is solved but the flow
still stalls, that is rung 5: read the browser log and report the cause.
