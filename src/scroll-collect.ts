/**
 * Scroll-driven collection over a network snoop (see ./network-snoop.ts).
 */
export interface ScrollPage {
  viewportSize(): { width: number; height: number } | null | undefined;
  evaluate<T>(pageFunction: () => T): Promise<T>;
  mouse: {
    move(x: number, y: number): Promise<unknown>;
    wheel(deltaX: number, deltaY: number): Promise<unknown>;
  };
}

export interface JsonSnoop {
  popJson(): Iterable<unknown>;
}

export type ScrollMode = "wheel" | "end";

export interface CollectWhileScrollingOptions {
  minItems?: number;
  maxScrolls?: number;
  extract?: (json: unknown) => Iterable<unknown>;
  scroll?: ScrollMode;
  settleMs?: number;
}

export interface CollectWhileScrollingResult {
  rounds: number;
  total: number;
  stoppedBecause: "minItems" | "maxScrolls" | "noGrowth";
}

async function viewportOf(page: ScrollPage) {
  return page.viewportSize() ?? (await page.evaluate(() => ({ width: innerWidth, height: innerHeight })));
}

async function scrollOnce(page: ScrollPage, mode: ScrollMode) {
  if (mode === "end") {
    await page.evaluate(() => {
      const element = document.scrollingElement;
      if (!element) throw new TypeError("Cannot read properties of null (reading 'scrollHeight')");
      scrollTo(0, element.scrollHeight);
    });
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
export async function* collectWhileScrolling(
  page: ScrollPage,
  snoop: JsonSnoop,
  options: CollectWhileScrollingOptions = {},
): AsyncGenerator<unknown, CollectWhileScrollingResult, undefined> {
  const {
    minItems = Infinity,
    maxScrolls = 10,
    extract = (json: unknown): Iterable<unknown> => (Array.isArray(json) ? json : []),
    scroll = "wheel",
    settleMs = 800,
  } = options;
  if (scroll !== "wheel" && scroll !== "end") throw new TypeError(`Unknown scroll mode: ${String(scroll)}`);

  let rounds = 0;
  let total = 0;
  let lastHeight: number | null = null;
  let unchanged = 0;
  let stoppedBecause: CollectWhileScrollingResult["stoppedBecause"] = "maxScrolls";

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

    const height = await page.evaluate(() => {
      const element = document.scrollingElement;
      if (!element) throw new TypeError("Cannot read properties of null (reading 'scrollHeight')");
      return element.scrollHeight;
    });
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
    await new Promise((resolve) => setTimeout(resolve, settleMs));
  }

  return { rounds, total, stoppedBecause };
}
