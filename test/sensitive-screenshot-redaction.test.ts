import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { inflateSync } from "node:zlib";
import { sensitiveBlankInjectExpression, sensitiveBlankRemoveExpression } from "../src/sensitive-blank.ts";
import {
  openSensitiveTab,
  type PipePage,
  releaseSensitiveBrowser,
  skipWithoutShell,
} from "./fixtures/sensitive-browser.ts";

// Test authoring gate: (1) contract — security (#380): the pixels of an element the page seals
// with data-sensitive (any value except the exact string "false", the marker #379 introduced)
// never reach a capture omowright returns: every marked element renders as an opaque black
// block of its own box — its text, input values, children, images and pseudo-element content
// all invisible — including inside open shadow roots; elements outside marked subtrees render
// unchanged, including inert data-sensitive="false" blocks; and the page's DOM and computed
// styles are exactly restored once the capture returns. (2) regression — dropping the blanking
// from the capture path, or a restore that leaves the blanking style in the page after a
// failed or successful capture. (3) existing coverage — sensitive-redaction.test.ts owns the
// text surfaces of the same marker; nothing decodes pixels. (4) boundary — a real Chromium via
// connectPipe through the public API: page.screenshot (viewport and fullPage) and locator
// screenshots, PNG bytes decoded by a local decoder over node:zlib, because the package is
// ws+zod-only and this contract must not add an image dependency. The secret words are
// synthetic NATO filler standing in for a 24-word recovery phrase.

const BLANK: readonly number[] = [0, 0, 0];
const PUBLIC_BACKGROUND: readonly number[] = [0, 0, 255];
const INERT_BACKGROUND: readonly number[] = [0, 128, 0];
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const BLANK_STYLE_ID = "omowright-sensitive-blank";
const INSET_DEVICE_PX = 4;

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface DecodedPng {
  width: number;
  height: number;
  channels: number;
  data: Uint8Array;
}

// Chromium emits 8-bit, non-interlaced RGB or RGBA PNGs; that is exactly what this decodes,
// loudly refusing anything else instead of misreading pixels.
function decodePng(png: Buffer): DecodedPng {
  assert.ok(png.length > 8 && png.subarray(0, 8).equals(PNG_SIGNATURE), "capture is not a PNG");
  let width = 0;
  let height = 0;
  let bitDepth = -1;
  let colorType = -1;
  let interlace = -1;
  const idat: Buffer[] = [];
  let position = 8;
  while (position + 8 <= png.length) {
    const length = png.readUInt32BE(position);
    const type = png.toString("latin1", position + 4, position + 8);
    const data = png.subarray(position + 8, position + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8] ?? -1;
      colorType = data[9] ?? -1;
      interlace = data[12] ?? -1;
    } else if (type === "IDAT") {
      idat.push(data);
    }
    position += 12 + length;
  }
  assert.ok(width > 0 && height > 0, "PNG has no IHDR");
  assert.equal(bitDepth, 8, `unexpected PNG bit depth ${bitDepth}`);
  assert.equal(interlace, 0, "interlaced PNG is not supported");
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  assert.ok(channels > 0, `unexpected PNG color type ${colorType}`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const decoded = new Uint8Array(stride * height);
  let previous = new Uint8Array(stride);
  let read = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[read] ?? -1;
    read += 1;
    const line = raw.subarray(read, read + stride);
    read += stride;
    const row = decoded.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x += 1) {
      const rawByte = line[x] ?? 0;
      const left = x >= channels ? (row[x - channels] ?? 0) : 0;
      const up = previous[x] ?? 0;
      const upLeft = x >= channels ? (previous[x - channels] ?? 0) : 0;
      let value: number;
      switch (filter) {
        case 0:
          value = rawByte;
          break;
        case 1:
          value = rawByte + left;
          break;
        case 2:
          value = rawByte + up;
          break;
        case 3:
          value = rawByte + ((left + up) >> 1);
          break;
        case 4: {
          const predictor = left + up - upLeft;
          const pa = Math.abs(predictor - left);
          const pb = Math.abs(predictor - up);
          const pc = Math.abs(predictor - upLeft);
          value = rawByte + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft);
          break;
        }
        default:
          throw new Error(`unknown PNG filter ${filter}`);
      }
      row[x] = value & 0xff;
    }
    previous = row;
  }
  return { width, height, channels, data: decoded };
}

function pixel(image: DecodedPng, x: number, y: number): readonly number[] {
  const index = (y * image.width + x) * image.channels;
  return [image.data[index] ?? 0, image.data[index + 1] ?? 0, image.data[index + 2] ?? 0];
}

function isColor(actual: readonly number[], expected: readonly number[]): boolean {
  return actual[0] === expected[0] && actual[1] === expected[1] && actual[2] === expected[2];
}

function deviceRegion(image: DecodedPng, rect: Rect, dpr: number, inset: number): Rect {
  return {
    x: Math.round(rect.x * dpr) + inset,
    y: Math.round(rect.y * dpr) + inset,
    width: Math.round(rect.width * dpr) - 2 * inset,
    height: Math.round(rect.height * dpr) - 2 * inset,
  };
}

function assertRegionInside(image: DecodedPng, region: Rect, what: string) {
  assert.ok(
    region.x >= 0 && region.y >= 0 && region.width > 0 && region.height > 0,
    `${what} region degenerate: ${JSON.stringify(region)}`,
  );
  assert.ok(
    region.x + region.width <= image.width && region.y + region.height <= image.height,
    `${what} region ${JSON.stringify(region)} falls outside the captured ${image.width}x${image.height} image (full-page viewport fallback?)`,
  );
}

function assertRegionBlank(image: DecodedPng, rect: Rect, dpr: number, what: string) {
  const region = deviceRegion(image, rect, dpr, INSET_DEVICE_PX);
  assertRegionInside(image, region, what);
  for (let y = region.y; y < region.y + region.height; y += 1) {
    for (let x = region.x; x < region.x + region.width; x += 1) {
      const actual = pixel(image, x, y);
      if (!isColor(actual, BLANK)) {
        assert.fail(`${what} is not a uniform blank block: rgb(${actual.join(", ")}) at (${x}, ${y})`);
      }
    }
  }
}

// Unchanged means the block still shows its background with its text on top, which any
// over-blanking (a selector too broad, a style that never came off) would destroy.
function assertRegionUnchanged(
  image: DecodedPng,
  rect: Rect,
  dpr: number,
  background: readonly number[],
  what: string,
) {
  const region = deviceRegion(image, rect, dpr, INSET_DEVICE_PX);
  assertRegionInside(image, region, what);
  const total = region.width * region.height;
  let backgroundPixels = 0;
  let textPixels = 0;
  for (let y = region.y; y < region.y + region.height; y += 1) {
    for (let x = region.x; x < region.x + region.width; x += 1) {
      const actual = pixel(image, x, y);
      if (isColor(actual, background)) backgroundPixels += 1;
      else if (!isColor(actual, BLANK)) textPixels += 1;
    }
  }
  assert.ok(
    backgroundPixels >= total / 2,
    `${what} lost its background: ${backgroundPixels}/${total} pixels match rgb(${background.join(", ")})`,
  );
  assert.ok(textPixels >= 1, `${what} lost its text: no pixel differs from background or blank`);
}

// One browser serves the whole file: the shared data-sensitive fixture (sensitive-browser.ts)
// starts it lazily from the first test that runs and releases it in after(). That first test
// pays the cold chrome-headless-shell start, which alone takes the whole default per-test limit
// on windows-latest, so it carries the one explicit 30 s allowance; the rest run warm.
const skip = skipWithoutShell;
const openTab = openSensitiveTab;
after(releaseSensitiveBrowser);

async function rectOf(page: PipePage, expression: string): Promise<Rect> {
  const serialized = await page.evaluate(
    `(() => { const r = ${expression}.getBoundingClientRect(); return [r.x, r.y, r.width, r.height].map(String).join(","); })()`,
  );
  assert.ok(typeof serialized === "string", `${expression} returned no rect`);
  const fields = serialized.split(",").map(Number);
  assert.equal(fields.length, 4, `${expression} rect fields: ${serialized}`);
  for (const value of fields)
    assert.ok(Number.isFinite(value), `${expression} rect field is not a number: ${serialized}`);
  return { x: fields[0] ?? 0, y: fields[1] ?? 0, width: fields[2] ?? 0, height: fields[3] ?? 0 };
}

async function dprOf(page: PipePage): Promise<number> {
  const dpr = await page.evaluate<number>("window.devicePixelRatio");
  assert.ok(typeof dpr === "number" && dpr > 0, "window.devicePixelRatio is not a positive number");
  return dpr;
}

async function domSnapshot(page: PipePage): Promise<string> {
  return await page.evaluate<string>("document.documentElement.outerHTML");
}

async function assertPageRestored(page: PipePage, before: string) {
  assert.equal(await domSnapshot(page), before, "the DOM changed across the capture");
  assert.equal(
    await page.evaluate(`document.querySelector("#${BLANK_STYLE_ID}")`),
    null,
    "the blanking style stayed in the document",
  );
  assert.equal(
    (await page.evaluate(`document.querySelector("#shadow-host")?.shadowRoot?.querySelector("#${BLANK_STYLE_ID}")`)) ??
      null,
    null,
    "the blanking style stayed in the shadow root",
  );
  assert.equal(
    await page.evaluate(`getComputedStyle(document.getElementById("secret")).backgroundColor`),
    "rgb(255, 0, 0)",
    "the marked block's computed style changed",
  );
}

async function setBlocks(page: PipePage) {
  await page.evaluate(() => {
    document.body.style.margin = "0";
    document.body.innerHTML =
      '<div id="secret" data-sensitive style="width:300px;height:120px;background:#ff0000;color:#00ff00;font:48px bold sans-serif">alpha bravo</div>' +
      '<div id="public" style="width:300px;height:120px;background:#0000ff;color:#ffff00;font:48px bold sans-serif">delta echo</div>' +
      '<div id="inert" data-sensitive="false" style="width:300px;height:120px;background:#008000;color:#ffffff;font:48px bold sans-serif">foxtrot golf</div>' +
      '<div id="shadow-host"></div>';
    const host = document.getElementById("shadow-host");
    if (!host) throw new Error("shadow host missing");
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML =
      '<div data-sensitive style="width:300px;height:120px;background:#ff00ff;color:#000000;font:48px bold sans-serif">hotel india</div>';
  });
}

async function setTallPage(page: PipePage) {
  await page.evaluate(() => {
    document.body.style.margin = "0";
    document.body.innerHTML =
      '<div id="secret" data-sensitive style="width:300px;height:120px;background:#ff0000;color:#00ff00;font:48px bold sans-serif">alpha bravo</div>' +
      '<div id="public" style="width:300px;height:120px;background:#0000ff;color:#ffff00;font:48px bold sans-serif">delta echo</div>' +
      '<div style="height:700px"></div>' +
      '<div id="below" data-sensitive style="width:300px;height:120px;background:#ff0000;color:#00ff00;font:48px bold sans-serif">juliet kilo</div>';
  });
}

// The tests after the first three extend the same contract (#383 review): a marked replaced
// element or shadow host blanks what it paints, a page.video recording streams blanked frames,
// overlapping captures share one page-level hold, and a capture that cannot even blank the page
// fails within the caller's timeout with the capture timeout's own wording instead of hanging
// past the caller's budget. (2) regression — the review's five
// findings: replaced elements carrying the marker (img, canvas, video, iframe paint above the
// black background), a marked shadow host (a light-DOM stylesheet and the shadow copy's own
// selectors never reach the host from inside), screencast frames during a page.video recording,
// per-root reference counts that remove early when roots change between overlapping captures,
// and unbounded blanking evaluates that outlive the screenshot timeout.

test(
  "viewport screenshots blank data-sensitive pixels and restore the page exactly (security contract #380)",
  { skip, timeout: 30_000 },
  async () => {
    const page = await openTab();
    try {
      await setBlocks(page);
      const dpr = await dprOf(page);
      const secret = await rectOf(page, `document.getElementById("secret")`);
      const publicBlock = await rectOf(page, `document.getElementById("public")`);
      const inert = await rectOf(page, `document.getElementById("inert")`);
      const shadow = await rectOf(page, `document.getElementById("shadow-host").shadowRoot.querySelector("div")`);
      const before = await domSnapshot(page);

      const image = decodePng(await page.screenshot());

      assertRegionBlank(image, secret, dpr, "the marked block");
      assertRegionUnchanged(image, publicBlock, dpr, PUBLIC_BACKGROUND, "the unmarked block");
      assertRegionUnchanged(image, inert, dpr, INERT_BACKGROUND, 'the data-sensitive="false" block');
      assertRegionBlank(image, shadow, dpr, "the marked block inside the open shadow root");
      await assertPageRestored(page, before);
    } finally {
      await page.close();
    }
  },
);

test(
  "locator screenshots return only the blanked box for a marked element (security contract #380)",
  { skip },
  async () => {
    const page = await openTab();
    try {
      await setBlocks(page);
      const dpr = await dprOf(page);
      const secret = await rectOf(page, `document.getElementById("secret")`);
      const publicBlock = await rectOf(page, `document.getElementById("public")`);
      const before = await domSnapshot(page);

      // locator.screenshot defaults to webp with a surrounding margin; png + margin 0 makes
      // the returned image exactly the element's box, so every pixel must be blank.
      const secretImage = decodePng(await page.locator("#secret").screenshot({ type: "png", margin: 0 }));
      assertRegionBlank(secretImage, { ...secret, x: 0, y: 0 }, dpr, "the element capture of the marked block");

      const publicImage = decodePng(await page.locator("#public").screenshot({ type: "png", margin: 0 }));
      assertRegionUnchanged(
        publicImage,
        { ...publicBlock, x: 0, y: 0 },
        dpr,
        PUBLIC_BACKGROUND,
        "the element capture of the unmarked block",
      );
      await assertPageRestored(page, before);
    } finally {
      await page.close();
    }
  },
);

test("full-page screenshots blank below-the-fold marked content (security contract #380)", { skip }, async () => {
  const page = await openTab();
  try {
    await setTallPage(page);
    const dpr = await dprOf(page);
    const secret = await rectOf(page, `document.getElementById("secret")`);
    const publicBlock = await rectOf(page, `document.getElementById("public")`);
    const below = await rectOf(page, `document.getElementById("below")`);
    const before = await domSnapshot(page);

    const image = decodePng(await page.screenshot({ fullPage: true }));

    assert.ok(
      image.height >= Math.round((below.y + below.height) * dpr),
      `full-page capture is only ${image.height} device px tall; the below-fold block starts at ${Math.round(below.y * dpr)}`,
    );
    assertRegionBlank(image, secret, dpr, "the above-fold marked block");
    assertRegionUnchanged(image, publicBlock, dpr, PUBLIC_BACKGROUND, "the above-fold unmarked block");
    assertRegionBlank(image, below, dpr, "the below-fold marked block");
    await assertPageRestored(page, before);
  } finally {
    await page.close();
  }
});

// ffmpeg resolution for the video-recording test, the same capability check the page-video tests
// in integration.test.ts use: the encoder needs libvpx and the null muxer.
function findFfmpeg() {
  const binary = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  const candidates = (process.env["PATH"] ?? "")
    .split(path.delimiter)
    .filter(Boolean)
    .map((dir) => path.join(dir, binary));
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const { status, stdout } = spawnSync(candidate, ["-hide_banner", "-encoders"], {
      encoding: "utf8",
      timeout: 5000,
    });
    if (status !== 0 || !/^\s*V\S*\s+libvpx\s/m.test(stdout)) continue;
    const muxers = spawnSync(candidate, ["-hide_banner", "-muxers"], { encoding: "utf8", timeout: 5000 });
    if (muxers.status === 0 && /^\s*E\s+null\s/m.test(muxers.stdout)) return candidate;
  }
  return null;
}

const FFMPEG = findFfmpeg();
// A recorded frame went through JPEG and VP8, which turn pure black into near-black; the
// unblanked frame reads rgb(250, 0, 2), far outside this bound.
const CODEC_BLANK_TOLERANCE = 16;

function assertRegionNearBlank(image: DecodedPng, rect: Rect, what: string) {
  const region = deviceRegion(image, rect, 1, INSET_DEVICE_PX);
  assertRegionInside(image, region, what);
  for (let y = region.y; y < region.y + region.height; y += 1) {
    for (let x = region.x; x < region.x + region.width; x += 1) {
      const actual = pixel(image, x, y);
      if (actual.some((channel) => channel > CODEC_BLANK_TOLERANCE)) {
        assert.fail(`${what} is not blank: rgb(${actual.join(", ")}) at (${x}, ${y})`);
      }
    }
  }
}

const skipVideo = skip || (!FFMPEG && "no ffmpeg on PATH with the libvpx encoder and null muxer");

// A replaced element carrying the marker paints its own content above the black background and
// has no element children for the visibility rule to hide (H1).
async function setReplacedElementsPage(page: PipePage) {
  await page.evaluate(() => {
    document.body.style.margin = "0";
    const red =
      "data:image/svg+xml;charset=utf-8," +
      encodeURIComponent(
        "<svg xmlns='http://www.w3.org/2000/svg' width='300' height='120'><rect width='300' height='120' fill='#ff0000'/></svg>",
      );
    document.body.innerHTML =
      `<img data-sensitive id="marked-img" src="${red}" style="width:300px;height:120px;display:block">` +
      `<canvas data-sensitive id="marked-canvas" width="300" height="120" style="width:300px;height:120px;display:block"></canvas>` +
      `<video data-sensitive id="marked-video" poster="${red}" style="width:300px;height:120px;display:block"></video>` +
      `<iframe data-sensitive id="marked-frame" style="width:300px;height:120px;display:block;border:0"></iframe>`;
    const canvas = document.getElementById("marked-canvas");
    if (!(canvas instanceof HTMLCanvasElement)) throw new Error("canvas missing");
    const context = canvas.getContext("2d");
    if (!context) throw new Error("canvas 2d context unavailable");
    context.fillStyle = "#00ff00";
    context.fillRect(0, 0, 300, 120);
    context.fillStyle = "#ff0000";
    context.font = "48px bold sans-serif";
    context.fillText("alpha bravo", 10, 80);
    const frame = document.getElementById("marked-frame");
    if (!(frame instanceof HTMLIFrameElement)) throw new Error("iframe missing");
    frame.srcdoc =
      '<div style="width:300px;height:120px;background:#ff0000;color:#0000ff;font:48px bold sans-serif">hotel india</div>';
  });
  await page.evaluate(
    `new Promise((resolve) => {
      const frame = document.getElementById("marked-frame");
      if (!frame || (frame.contentDocument && frame.contentDocument.readyState === "complete")) { resolve(1); return; }
      frame.addEventListener("load", () => resolve(1), { once: true });
    })`,
  );
}

test(
  "marked replaced elements blank: img, canvas, video poster, iframe (security contract #380)",
  { skip },
  async () => {
    const page = await openTab();
    try {
      await setReplacedElementsPage(page);
      const dpr = await dprOf(page);
      const image = decodePng(await page.screenshot());
      for (const id of ["marked-img", "marked-canvas", "marked-video", "marked-frame"]) {
        const rect = await rectOf(page, `document.getElementById("${id}")`);
        assertRegionBlank(image, rect, dpr, `the marked element #${id}`);
      }
    } finally {
      await page.close();
    }
  },
);

// A frame of another origin is a separate document the parent's stylesheet cannot enter, so only
// the marked owner's own painting can blank it.
test("a marked cross-origin iframe blanks its content (security contract #380)", { skip }, async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(
      '<body style="margin:0"><div style="width:300px;height:120px;background:#ff0000;color:#0000ff;font:48px bold sans-serif">hotel india</div></body>',
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const page = await openTab();
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object", "the frame server has no port");
    await page.evaluate(
      `new Promise((resolve) => {
        document.body.style.margin = "0";
        const frame = document.createElement("iframe");
        frame.id = "foreign-frame";
        frame.setAttribute("data-sensitive", "");
        frame.style.cssText = "width:300px;height:120px;display:block;border:0";
        frame.addEventListener("load", () => resolve(1), { once: true });
        frame.src = "http://127.0.0.1:${address.port}/";
        document.body.append(frame);
      })`,
    );
    assert.equal(
      await page.evaluate(`document.getElementById("foreign-frame").contentDocument`),
      null,
      "the frame is not cross-origin to the page, so this would not test the cross-origin case",
    );
    const dpr = await dprOf(page);
    const rect = await rectOf(page, `document.getElementById("foreign-frame")`);
    const image = decodePng(await page.screenshot());
    assertRegionBlank(image, rect, dpr, "the marked cross-origin iframe");
  } finally {
    await page.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

// #385 seals the frame a sealed owner hosts (<iframe>, <frame>, <object>, <embed>; marked, or
// inside a marked element) and every frame below it; each of those shapes must stay blank in
// pixels too, here with cross-origin content the parent's stylesheet cannot enter. The parent is
// an http page because chrome-headless-shell paints nothing for a cross-origin <object>/<embed>
// under about:blank, and every region must first show its content under an inert attribute, so
// a shape that never painted cannot pass as blank.
async function listen(body: string): Promise<{ url: string; close: () => Promise<unknown> }> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object", "the server has no port");
  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: async () => await new Promise((resolve) => server.close(resolve)),
  };
}

const SEALED_FRAME_CONTENT_BACKGROUND: readonly number[] = [255, 0, 0];

test(
  "every frame the text outputs seal (#385) stays blank in screenshots (security contract #380)",
  { skip },
  async () => {
    const parent = await listen('<body style="margin:0"></body>');
    const content = await listen(
      '<body style="margin:0"><div style="width:300px;height:120px;background:#ff0000;color:#0000ff;font:48px bold sans-serif">hotel india</div></body>',
    );
    const page = await openTab();
    try {
      await page.goto(parent.url);
      const url = content.url;
      const box = "width:300px;height:120px;display:block;border:0";
      // data-mark stands where data-sensitive goes; it is switched over after the first capture.
      const owners: ReadonlyArray<readonly [string, string]> = [
        [
          "in-wrapper",
          `<div data-mark id="in-wrapper" style="width:300px;height:120px"><iframe src="${url}" style="${box}"></iframe></div>`,
        ],
        [
          "nested",
          `<iframe data-mark id="nested" style="${box}" srcdoc="<body style='margin:0'><iframe src='${url}' style='${box}'></iframe></body>"></iframe>`,
        ],
        ["object", `<object data-mark id="object" type="text/html" data="${url}" style="${box}"></object>`],
        ["embed", `<embed data-mark id="embed" type="text/html" src="${url}" style="${box}">`],
        [
          "frameset",
          `<iframe id="frameset" style="${box}" srcdoc="<frameset rows='*'><frame data-mark src='${url}'></frameset>"></iframe>`,
        ],
      ];
      await page.evaluate(
        `new Promise((resolve) => {
        document.body.innerHTML = ${JSON.stringify(owners.map(([, html]) => html).join(""))};
        const loading = ${JSON.stringify(owners.map(([id]) => id))}.map((id) => {
          const owner = document.getElementById(id);
          const element = owner.tagName === "DIV" ? owner.firstElementChild : owner;
          return new Promise((done) => element.addEventListener("load", done, { once: true }));
        });
        Promise.all(loading).then(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve(1))));
      })`,
      );
      const dpr = await dprOf(page);
      const rects = new Map<string, Rect>();
      for (const [id] of owners) rects.set(id, await rectOf(page, `document.getElementById("${id}")`));

      const shown = decodePng(await page.screenshot());
      for (const [id, rect] of rects)
        assertRegionUnchanged(shown, rect, dpr, SEALED_FRAME_CONTENT_BACKGROUND, `the unsealed frame shape "${id}"`);

      await page.evaluate(`(() => {
        const marks = [...document.querySelectorAll("[data-mark]"),
          ...document.getElementById("frameset").contentDocument.querySelectorAll("[data-mark]")];
        for (const element of marks) {
          element.removeAttribute("data-mark");
          element.setAttribute("data-sensitive", "");
        }
        return marks.length;
      })()`);
      const sealed = decodePng(await page.screenshot());
      for (const [id, rect] of rects) assertRegionBlank(sealed, rect, dpr, `the sealed frame shape "${id}"`);
    } finally {
      await page.close();
      await content.close();
      await parent.close();
    }
  },
);

test("a marked shadow host blanks its shadow content (security contract #380)", { skip }, async () => {
  const page = await openTab();
  try {
    await page.evaluate(() => {
      document.body.style.margin = "0";
      document.body.innerHTML = '<div id="host" data-sensitive></div><div id="closed-host" data-sensitive></div>';
      for (const [id, mode] of [
        ["host", "open"],
        ["closed-host", "closed"],
      ] as const) {
        const host = document.getElementById(id);
        if (!host) throw new Error(`${id} missing`);
        const shadow = host.attachShadow({ mode });
        shadow.innerHTML =
          '<div style="width:300px;height:120px;background:#ff00ff;color:#000000;font:48px bold sans-serif">hotel india</div>';
      }
    });
    const dpr = await dprOf(page);
    const host = await rectOf(page, `document.getElementById("host")`);
    const closedHost = await rectOf(page, `document.getElementById("closed-host")`);
    const image = decodePng(await page.screenshot());
    assertRegionBlank(image, host, dpr, "the shadow content of the marked open host");
    assertRegionBlank(image, closedHost, dpr, "the shadow content of the marked closed host");
  } finally {
    await page.close();
  }
});

test(
  "video recording frames blank a marked page mid-recording (security contract #380)",
  { skip: skipVideo },
  async () => {
    assert.ok(FFMPEG, "no ffmpeg on PATH with the libvpx encoder and null muxer");
    const page = await openTab();
    const originalPath = process.env["PATH"];
    try {
      process.env["PATH"] = `${path.dirname(FFMPEG)}${path.delimiter}${originalPath ?? ""}`;
      await setBlocks(page);
      const sessionId = await page.resolveSessionId();
      let frames = 0;
      const firstFrame = Promise.withResolvers<void>();
      const unsubscribe = page.cdp.on("Page.screencastFrame", (_frame, meta) => {
        if (meta.sessionId !== sessionId) return;
        frames += 1;
        firstFrame.resolve();
      });
      try {
        const viewport = await page.refreshViewportSize();
        const video = page.video();
        await video.start({ path: "marked/raw.webm", size: { width: viewport.width, height: viewport.height } });
        await page.evaluate(() => {
          document.body.style.background = "#ffffff";
        });
        // A screencast frame must land before stopScreencast cancels the stream; the test's own
        // limit bounds the wait.
        await firstFrame.promise;
        await video.stop({ path: "marked/finished.webm" });
        assert.ok(frames >= 1, "no screencast frame arrived during the recording");
        const clip = await video.path();
        const frame0 = path.join(path.dirname(clip), "frame0.png");
        execFileSync(FFMPEG, ["-y", "-v", "error", "-i", clip, "-vframes", "1", frame0], { stdio: "pipe" });
        const image = decodePng(readFileSync(frame0));
        assert.ok(
          image.width === viewport.width && image.height === viewport.height,
          `the recorded frame is ${image.width}x${image.height}, not the viewport ${viewport.width}x${viewport.height}`,
        );
        const secret = await rectOf(page, `document.getElementById("secret")`);
        assertRegionNearBlank(image, secret, "the marked block in a mid-recording screencast frame");
      } finally {
        unsubscribe();
      }
    } finally {
      if (originalPath === undefined) delete process.env["PATH"];
      else process.env["PATH"] = originalPath;
      await page.close();
    }
  },
);

test(
  "overlapping blank holders never remove early, never release another's hold, and leave no style (security contract #380)",
  { skip },
  async () => {
    const page = await openTab();
    try {
      await setBlocks(page);
      assert.equal(await page.evaluate(sensitiveBlankInjectExpression("a")), true);
      assert.equal(await page.evaluate(sensitiveBlankInjectExpression("b")), true);
      await page.evaluate(() => {
        const host = document.createElement("div");
        host.id = "late-host";
        document.body.append(host);
        const shadow = host.attachShadow({ mode: "open" });
        shadow.innerHTML = '<div data-sensitive style="width:50px;height:50px;background:#ff0000">late</div>';
      });
      assert.equal(await page.evaluate(sensitiveBlankInjectExpression("c")), true);
      assert.equal(
        await page.evaluate(sensitiveBlankRemoveExpression("a")),
        0,
        "a release while other captures hold the blank removed styles",
      );
      assert.equal(
        await page.evaluate(
          `document.querySelector("#late-host")?.shadowRoot?.querySelector("#${BLANK_STYLE_ID}") !== null`,
        ),
        true,
        "the late shadow root lost its blanking while a capture still held it",
      );
      assert.equal(await page.evaluate(sensitiveBlankRemoveExpression("b")), 0);
      const removed = await page.evaluate(sensitiveBlankRemoveExpression("c"));
      assert.ok(typeof removed === "number" && removed >= 1, "the final release did not remove the injected styles");
      assert.equal(await page.evaluate(`document.querySelector("#${BLANK_STYLE_ID}")`), null);
      assert.equal(
        await page.evaluate(`document.querySelector("#shadow-host")?.shadowRoot?.querySelector("#${BLANK_STYLE_ID}")`),
        null,
      );
      assert.equal(
        await page.evaluate(`document.querySelector("#late-host")?.shadowRoot?.querySelector("#${BLANK_STYLE_ID}")`),
        null,
      );

      // A recording holds even a page with no marker yet; a capture that found nothing to blank
      // took no hold, so its compensating release (the one queued after a timed-out inject) must
      // leave the recording's blanking in place.
      await page.evaluate(() => {
        document.body.innerHTML = "";
      });
      assert.equal(await page.evaluate(sensitiveBlankInjectExpression("recording", "recording")), true);
      assert.equal(await page.evaluate(sensitiveBlankInjectExpression("capture")), false);
      assert.equal(await page.evaluate(sensitiveBlankRemoveExpression("capture")), 0);
      assert.notEqual(
        await page.evaluate(`document.querySelector("#${BLANK_STYLE_ID}")`),
        null,
        "a capture that took no hold released the recording's blanking",
      );
      assert.equal(await page.evaluate(sensitiveBlankRemoveExpression("recording")), 1);
    } finally {
      await page.close();
    }
  },
);

test(
  "a hung page fails the blanking within the screenshot timeout, reported like a capture timeout (security contract #380)",
  { skip },
  async () => {
    const page = await openTab();
    try {
      await setBlocks(page);
      await page.evaluate("setTimeout(() => { const until = Date.now() + 1500; while (Date.now() < until); }, 0)");
      const started = Date.now();
      await assert.rejects(
        page.screenshot({ timeout: 400 }),
        /page\.screenshot: browser CDP command timed out while capturing sensitive blanking/,
      );
      assert.ok(Date.now() - started < 1500, "the blanking hang did not fail within its timeout");
      // The timed-out inject still runs once the page is free; the release queued behind it on
      // the same session runs next, so this read, queued after both, sees the page restored.
      assert.equal(
        await page.evaluate(`document.querySelector("#${BLANK_STYLE_ID}")`),
        null,
        "the late inject of a timed-out capture stayed in the page",
      );
    } finally {
      await page.close();
    }
  },
);
