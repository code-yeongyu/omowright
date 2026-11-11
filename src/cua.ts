const MODIFIER_KEYS = new Set(["Alt", "Control", "Meta", "Shift"]);

export interface CuaPoint {
  x: number;
  y: number;
}

export interface CuaPage {
  keyboard: {
    down(key: string): Promise<unknown>;
    up(key: string): Promise<unknown>;
    press(key: string): Promise<unknown>;
    type(text: string): Promise<unknown>;
  };
  mouse: {
    click(x: number, y: number, options?: { button?: string; clickCount?: number }): Promise<unknown>;
    move(x: number, y: number): Promise<unknown>;
    down(): Promise<unknown>;
    up(): Promise<unknown>;
    wheel(deltaX: number, deltaY: number): Promise<unknown>;
  };
  screenshot(options: { type: "png" }): Promise<{ toString(encoding: "base64"): string }>;
}

function splitModifiers(keys: readonly string[] = []) {
  const modifiers = keys.filter(
    (key) => MODIFIER_KEYS.has(key) || /^(cmd|command|ctrl|option|controlormeta)$/i.test(key),
  );
  const rest = keys.filter((key) => !modifiers.includes(key));
  return { modifiers, rest };
}

export function createCua<P extends CuaPage>(page: P) {
  async function holdModifiers<T>(keys: readonly string[] | undefined, fn: () => Promise<T>) {
    const { modifiers } = splitModifiers(keys);
    for (const key of modifiers) await page.keyboard.down(key);
    try {
      return await fn();
    } finally {
      for (const key of modifiers.toReversed()) await page.keyboard.up(key);
    }
  }

  return {
    page,

    async click({ x, y, button = "left", keypress }: CuaPoint & { button?: string; keypress?: string[] }) {
      await holdModifiers(keypress, () => page.mouse.click(x, y, { button }));
    },

    async doubleClick({ x, y, keypress }: CuaPoint & { keypress?: string[] }) {
      await holdModifiers(keypress, () => page.mouse.click(x, y, { clickCount: 2 }));
    },

    async drag({ path, keys }: { path: [CuaPoint, CuaPoint, ...CuaPoint[]]; keys?: string[] }) {
      if (!Array.isArray(path) || path.length < 2) {
        throw new TypeError("cua.drag requires path with at least two points");
      }
      await holdModifiers(keys, async () => {
        const [first, ...rest] = path;
        await page.mouse.move(first.x, first.y);
        await page.mouse.down();
        try {
          for (const point of rest) await page.mouse.move(point.x, point.y);
        } finally {
          await page.mouse.up();
        }
      });
    },

    async getVisibleScreenshot() {
      const buffer = await page.screenshot({ type: "png" });
      return buffer.toString("base64");
    },

    async keypress({ keys }: { keys: string[] }) {
      if (!Array.isArray(keys) || keys.length === 0) {
        throw new TypeError("cua.keypress requires a non-empty keys array");
      }
      await page.keyboard.press(keys.join("+"));
    },

    async move({ x, y, keys }: CuaPoint & { keys?: string[] }) {
      await holdModifiers(keys, () => page.mouse.move(x, y));
    },

    async scroll({
      x,
      y,
      scrollX,
      scrollY,
      keypress,
    }: CuaPoint & { scrollX: number; scrollY: number; keypress?: string[] }) {
      await holdModifiers(keypress, async () => {
        await page.mouse.move(x, y);
        await page.mouse.wheel(scrollX, scrollY);
      });
    },

    async type({ text }: { text: string }) {
      await page.keyboard.type(text);
    },
  };
}
