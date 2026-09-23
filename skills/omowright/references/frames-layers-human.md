# Frames, layers, human handoff, device emulation

Four modules for the moments when the plain snapshot-and-click loop stalls.
All come from the package entrypoint:

```js
const { reconcileFrames, snapshotWithFrames, describeLayers, layersHeader, snapshotWithLayers,
  requestHuman, DEVICE_PRESETS, emulate, compactSnapshot } = await import("omowright");
```

## Out-of-process iframes and shadow DOM

Cross-origin iframes (payment widgets, embedded editors, CAPTCHA frames) run in
their own process. The snapshot stitches each one in as a child tree under the
owning `- iframe [ref=eK]:` line, and child refs carry a frame prefix:

```
- iframe [ref=e12]:
  - textbox "Card number" [ref=f1e3]
  - button "Pay" [ref=f1e4]
```

Refs stay page-level. `page.locator("f1e3").fill("4242...")` routes to the
right frame session; there is no frame handle to fetch and no `FrameLocator`
to build by hand. Plain `page.snapshot()` sees frames that existed before
`attachPage()`, so this is the normal path, not a special one.

Two shapes worth recognising:

- An `iframe` line with no children means the child tree wasn't reachable. Run
  `reconcileFrames(page)` (returns the frames it re-linked) and snapshot again,
  or call `snapshotWithFrames(page)`, which does the repair first and adds a
  `missingFrames` list only when a frame still couldn't be entered.
- A closed shadow root hides the host link, so the frame inside it shows up as
  an orphan `- iframe:` block at the end of the tree. Its `f<N>e<M>` refs work
  the same way.

Rough edge: the first click into a freshly adopted OOPIF can land on the
embedder instead of the frame. Take a fresh snapshot and click the ref again;
the second attempt lands.

```js
const snap = await snapshotWithFrames(page, { interactive: true });
if (snap.missingFrames) console.log("unreachable frames:", snap.missingFrames);
await page.locator("f1e3").fill("4242 4242 4242 4242");
```

## Layers: why did the same click miss twice?

A cookie banner, a modal, or a full-page loader sitting above the target
swallows clicks while the a11y tree still lists the element you aimed at. After
two identical misses, ask what's on top before switching to coordinates:

```js
const layers = await describeLayers(page);
console.log(layersHeader(layers));
// @layers blocking=dialog "Cookie preferences" coverage=100% hint=#onetrust-banner-sdk
if (layers.blocking) {
  // Dismiss through a fresh ref: snapshot the overlay by its hint, click its button.
  const tree = compactSnapshot(await page.snapshot({ selector: layers.blocking.selectorHint, interactive: true }));
  await page.locator(/\[ref=(e\d+)\]/.exec(tree)[1]).click();   // first interactive ref inside the overlay
}
```

`selectorHint` is `#id` when the overlay has one and a bare tag or
`tag.class` otherwise; a bare tag is too broad for a CSS click, which is why
the recipe scopes a snapshot to it instead of clicking through it.

`describeLayers` hit-tests a 5x5 grid over the viewport (pass `{ grid }` to
change it), pierces open shadow roots, and reports the topmost element that
covers at least 60% of the points as `blocking`, with `role`, `name`,
`coverage`, `position`, `ariaModal`, and a `selectorHint`. `candidates` lists
the runners-up. `@layers none` means nothing is covering the page and the miss
has another cause (stale ref, off-screen target, disabled control).

`snapshotWithLayers(page, opts)` folds this into the read you were already
doing: the header becomes the first line of `tree`, and the raw result sits in
`snapshot.layers`. Use it as the default read on sites known for overlays.

## Human handoff: login, OTP, CAPTCHA you can't solve

When every rung fails on a login wall, a one-time code, or a challenge the
captcha preset can't clear, hand the tab to the person and wait for a signal:

```js
const result = await requestHuman(page, {
  prompt: "Sign in with your account, then click Done.",
  until: { url: /\/dashboard/ },      // or { selector: "nav.account" } or async page => boolean
  timeoutMs: 300000,
});
// { outcome: "continued" | "timed_out" | "cancelled", elapsedMs, reason: "until" | "done-button" | "timed_out" | "signal" }
if (result.outcome !== "continued") throw new Error(`handoff ${result.outcome}`);
```

The call brings the window to the front, injects a shadow-DOM banner with your
prompt and a Done button, then polls every `pollMs` for `until` or the button.
Pass an `AbortSignal` as `signal` to cancel from your side. The banner is
removed on every exit path, so the next snapshot is clean.

The cookie rule from `stealth.md` (next to this file) still holds here: the handoff is
the way to get into Google or 1Password, since injecting their cookies gets the
user logged out server-side. Let the human sign in inside the automated
browser and continue from that session.

## Device emulation for responsive QA

`emulate` sets viewport metrics, touch, and user agent in one call:

```js
await emulate(page, "iphone-14");        // 390x844 @3x, touch, iOS Safari UA
await page.goto("https://example.com");
await page.screenshot({ path: "/tmp/home-iphone.png" });
await emulate(page, "desktop-1440");     // 1440x900, mouse
await emulate(page, null);               // clear the override, restore the original UA
```

Presets in `DEVICE_PRESETS`: `iphone-14` (390x844), `pixel-7` (412x915),
`ipad-air` (820x1180), `desktop-1440` (1440x900). Pass an object with the same
fields (`width, height, deviceScaleFactor, mobile, hasTouch, userAgent,
platform`) for a custom device. The original UA is captured on the first call
per page, so `null` always returns to where you started. Re-snapshot after
switching: layout changes move refs, and a mobile layout often swaps a nav bar
for a menu button.
