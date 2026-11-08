const MODIFIER_KEYS = new Set(["Alt", "Control", "Meta", "Shift"]);

function splitModifiers(keys = []) {
  const modifiers = keys.filter(key => MODIFIER_KEYS.has(key) || /^(cmd|command|ctrl|option|controlormeta)$/i.test(key));
  const rest = keys.filter(key => !modifiers.includes(key));
  return { modifiers, rest };
}

export function createCua(page) {
  async function holdModifiers(keys, fn) {
    const { modifiers } = splitModifiers(keys);
    for (const key of modifiers) await page.keyboard.down(key);
    try {
      return await fn();
    } finally {
      for (const key of [...modifiers].reverse()) await page.keyboard.up(key);
    }
  }

  return {
    page,

    async click({ x, y, button = "left", keypress }) {
      await holdModifiers(keypress, () => page.mouse.click(x, y, { button }));
    },

    async doubleClick({ x, y, keypress }) {
      await holdModifiers(keypress, () => page.mouse.click(x, y, { clickCount: 2 }));
    },

    async drag({ path, keys }) {
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

    async keypress({ keys }) {
      if (!Array.isArray(keys) || keys.length === 0) {
        throw new TypeError("cua.keypress requires a non-empty keys array");
      }
      await page.keyboard.press(keys.join("+"));
    },

    async move({ x, y, keys }) {
      await holdModifiers(keys, () => page.mouse.move(x, y));
    },

    async scroll({ x, y, scrollX, scrollY, keypress }) {
      await holdModifiers(keypress, async () => {
        await page.mouse.move(x, y);
        await page.mouse.wheel(scrollX, scrollY);
      });
    },

    async type({ text }) {
      await page.keyboard.type(text);
    },
  };
}
