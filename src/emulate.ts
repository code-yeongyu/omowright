// Device presets for emulation
export const DEVICE_PRESETS = Object.freeze({
  "iphone-14": {
    width: 390,
    height: 844,
    deviceScaleFactor: 3,
    mobile: true,
    hasTouch: true,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 16_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.1 Mobile/15E148 Safari/604.1",
    platform: "iPhone",
  },
  "pixel-7": {
    width: 412,
    height: 915,
    deviceScaleFactor: 2.625,
    mobile: true,
    hasTouch: true,
    userAgent: "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Mobile Safari/537.36",
    platform: "Linux armv8l",
  },
  "ipad-air": {
    width: 820,
    height: 1180,
    deviceScaleFactor: 2,
    mobile: true,
    hasTouch: true,
    userAgent: "Mozilla/5.0 (iPad; CPU OS 16_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.1 Mobile/15E148 Safari/604.1",
    platform: "MacIntel",
  },
  "desktop-1440": {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
    hasTouch: false,
    userAgent: undefined,
    platform: undefined,
  },
});

// WeakMap to store original UA per page
const originalUAs = new WeakMap();

/**
 * Emulate a device on the given page.
 * @param {object} page - The page object with cdp.send(), resolveSessionId(), evaluate(), refreshViewportSize()
 * @param {string|object|null} presetNameOrObject - Preset name, object, or null to restore
 * @returns {object} The resolved preset object
 */
export async function emulate(page, presetNameOrObject) {
  // Resolve preset
  let preset;
  if (presetNameOrObject === null) {
    // Restore mode: resolve to a clear object
    preset = null;
  } else if (typeof presetNameOrObject === "string") {
    if (!DEVICE_PRESETS[presetNameOrObject]) {
      throw new Error(`unknown device preset: ${presetNameOrObject}`);
    }
    preset = DEVICE_PRESETS[presetNameOrObject];
  } else {
    preset = presetNameOrObject;
  }

  const sessionId = await page.resolveSessionId();

  if (preset === null) {
    // Restore mode: clear metrics and restore original UA
    await page.cdp.send("Emulation.clearDeviceMetricsOverride", {}, sessionId);
    await page.cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false }, sessionId);
    
    const originalUA = originalUAs.get(page);
    if (originalUA) {
      await page.cdp.send("Emulation.setUserAgentOverride", { userAgent: originalUA }, sessionId);
    }
  } else {
    // Emulation mode: set metrics and UA
    // Capture original UA on first emulation if not already done
    if (!originalUAs.has(page)) {
      const ua = await page.evaluate(() => navigator.userAgent);
      originalUAs.set(page, ua);
    }

    // Set device metrics
    await page.cdp.send(
      "Emulation.setDeviceMetricsOverride",
      {
        width: preset.width,
        height: preset.height,
        deviceScaleFactor: preset.deviceScaleFactor,
        mobile: preset.mobile,
        screenWidth: preset.width,
        screenHeight: preset.height,
      },
      sessionId
    );

    // Set touch emulation
    await page.cdp.send(
      "Emulation.setTouchEmulationEnabled",
      {
        enabled: preset.hasTouch,
        maxTouchPoints: preset.hasTouch ? 5 : 1,
      },
      sessionId
    );

    // Set user agent if defined
    if (preset.userAgent !== undefined) {
      await page.cdp.send(
        "Emulation.setUserAgentOverride",
        {
          userAgent: preset.userAgent,
          platform: preset.platform,
        },
        sessionId
      );
    }
  }

  // Refresh viewport size
  if (page.refreshViewportSize) {
    await page.refreshViewportSize();
  }

  return preset;
}
