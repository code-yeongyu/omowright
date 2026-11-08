/**
 * Scroll-driven collection over a network snoop (see ./network-snoop.js).
 */
async function viewportOf(page) {
  return page.viewportSize() ?? await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
}

async function scrollOnce(page, mode) {
  if (mode === "end") {
    await page.evaluate(() => scrollTo(0, document.scrollingElement.scrollHeight));
    return;
  }
  const viewport = await viewportOf(page);
  await page.mouse.move(Math.floor(viewport.width / 2), Math.floor(viewport.height / 2));
  await page.mouse.wheel(0, Math.floor(viewport.height * 0.9));
}

/**
 * Scrolls a page while draining JSON responses out of a snoop.
 *
 * Yields every extracted item and returns { rounds, total, stoppedBecause } when it stops.
 */
export async function* collectWhileScrolling(page, snoop, options = {}) {
  const {
    minItems = Infinity,
    maxScrolls = 10,
    extract = json => (Array.isArray(json) ? json : []),
    scroll = "wheel",
    settleMs = 800,
  } = options;
  if (scroll !== "wheel" && scroll !== "end") throw new TypeError(`Unknown scroll mode: ${String(scroll)}`);

  let rounds = 0;
  let total = 0;
  let lastHeight = null;
  let unchanged = 0;
  let stoppedBecause = "maxScrolls";

  for (;;) {
    for (const json of snoop.popJson()) {
      for (const item of extract(json)) {
        total += 1;
        yield item;
      }
    }
    if (total >= minItems) {
      stoppedBecause = "minItems";
      break;
    }
    if (rounds >= maxScrolls) {
      stoppedBecause = "maxScrolls";
      break;
    }

    const height = await page.evaluate(() => document.scrollingElement.scrollHeight);
    if (lastHeight !== null && height === lastHeight) {
      unchanged += 1;
      if (unchanged >= 2) {
        stoppedBecause = "noGrowth";
        break;
      }
    } else {
      unchanged = 0;
    }
    lastHeight = height;

    await scrollOnce(page, scroll);
    rounds += 1;
    await new Promise(resolve => setTimeout(resolve, settleMs));
  }

  return { rounds, total, stoppedBecause };
}
