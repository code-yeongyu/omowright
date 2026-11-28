import { after, test } from "node:test";
import assert from "node:assert/strict";
import { globSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { inflateSync } from "node:zlib";
import { connectPipe } from "../src/index.ts";
import { removeTreeSync } from "./fixtures/remove-tree.ts";

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

function findHeadlessShell() {
  const home = process.env["HOME"] ?? "";
  const candidates = [
    ...globSync(
      path.join(
        home,
        "Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-mac-arm64/chrome-headless-shell",
      ),
    ),
    ...globSync(
      path.join(
        home,
        ".cache/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell",
      ),
    ),
  ];
  return candidates.toSorted().at(-1);
}

const SHELL = process.env["SHELL_BIN"] ?? findHeadlessShell();

type PipeBrowser = Awaited<ReturnType<typeof connectPipe>>;
type PipePage = Awaited<ReturnType<PipeBrowser["newTab"]>>;

// One browser serves the whole file, started lazily by the first test that runs and released
// in after(), newest first (the browser before its user-data dir), the same lifecycle
// sensitive-redaction.test.ts uses. The first test pays the cold chrome-headless-shell start,
// which alone takes the whole default per-test limit on windows-latest, so it carries the one
// explicit 30 s allowance; the rest run against the warm browser.
const skip = !SHELL && "no chromium binary found";
type Release = () => unknown;
const releases: Release[] = [];
let shared: Promise<PipeBrowser> | undefined;

async function start(): Promise<PipeBrowser> {
  assert.ok(SHELL, "no chromium binary found");
  const ud = mkdtempSync(path.join(tmpdir(), "omowright-sensitive-shot-"));
  releases.push(() => removeTreeSync(ud));
  const browser = await connectPipe({
    browserPath: SHELL,
    browserArgs: ["--headless", "--no-first-run", `--user-data-dir=${ud}`],
    storageRoot: ud,
  });
  releases.push(() => browser.close());
  return browser;
}

after(async () => {
  await shared?.catch(() => undefined);
  const failures: unknown[] = [];
  for (const step of releases.toReversed()) {
    try {
      await step();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0)
    throw new AggregateError(failures, "the sensitive-screenshot fixture did not release cleanly");
});

async function openTab(): Promise<PipePage> {
  shared ??= start();
  const browser = await shared;
  return await browser.newTab("about:blank");
}

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
