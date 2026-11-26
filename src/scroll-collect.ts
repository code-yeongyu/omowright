/**
 * Scroll-driven collection over a network snoop (see ./network-snoop.ts).
 */
import { JSON_MIME } from "./network-snoop.ts";

export interface ScrollPage {
  viewportSize(): { width: number; height: number } | null | undefined;
  evaluate<T>(pageFunction: () => T): Promise<T>;
  evaluate<T, A>(pageFunction: (arg: A) => T | PromiseLike<T>, arg: A): Promise<T>;
  mouse: {
    move(x: number, y: number): Promise<unknown>;
    wheel(deltaX: number, deltaY: number): Promise<unknown>;
  };
}

export interface JsonSnoop {
  popJson(): Iterable<unknown>;
  /** Resolves on the next buffered entry the predicate accepts; rejects after timeoutMs. */
  waitFor(match: (entry: { mimeType: string | null }) => unknown, options: { timeoutMs: number }): Promise<unknown>;
}

export type ScrollMode = "wheel" | "end";

/** The timer that bounds each round; defaults to the global setTimeout/clearTimeout. */
export interface ScrollClock {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface CollectWhileScrollingOptions {
  minItems?: number;
  maxScrolls?: number;
  extract?: (json: unknown) => Iterable<unknown>;
  scroll?: ScrollMode;
  settleMs?: number;
  clock?: ScrollClock;
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
  const clock: ScrollClock = options.clock ?? globalThis;
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

    // The round ends on the first of: a JSON response buffered in the snoop, scrollHeight growing past
    // the height just measured, or the settleMs timer. Both signals are subscribed before the scroll;
    // a signal that fails or gives up falls back to the timer, which stays the round's only bound.
    let timer: unknown;
    const deadline = new Promise<void>((resolve) => {
      timer = clock.setTimeout(resolve, settleMs);
    });
    const response = snoop
      .waitFor((entry) => JSON_MIME.test(String(entry.mimeType ?? "")), { timeoutMs: settleMs })
      .catch(() => deadline);
    const growth = page
      .evaluate(
        ({ baseline, cleanupMs }) =>
          new Promise<boolean>((resolve) => {
            const element = document.scrollingElement;
            if (!element) throw new TypeError("Cannot read properties of null (reading 'scrollHeight')");
            const finish = (grew: boolean) => {
              observer.disconnect();
              clearTimeout(cleanup);
              resolve(grew);
            };
            const observer = new ResizeObserver(() => {
              if (element.scrollHeight > baseline) finish(true);
            });
            // Releases the observer once the host timer has ended the round; it never ends a round itself.
            const cleanup = setTimeout(() => finish(false), cleanupMs);
            observer.observe(element);
            if (element.scrollHeight > baseline) finish(true);
          }),
        { baseline: height, cleanupMs: settleMs },
      )
      .then(
        (grew) => (grew ? undefined : deadline),
        () => deadline,
      );
    await scrollOnce(page, scroll);
    rounds += 1;
    await Promise.race([deadline, response, growth]);
    clock.clearTimeout(timer);
  }

  return { rounds, total, stoppedBecause };
}
