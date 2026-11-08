import type { CdpTransport } from "./cdp-protocol.ts";

export interface ViewportSize {
  width: number;
  height: number;
}

/** A viewport as callers pass it; validateViewport checks both fields. */
export interface ViewportInput {
  width?: unknown;
  height?: unknown;
}

export interface ViewportPage {
  cdp: Pick<CdpTransport, "send">;
  resolveSessionId(): Promise<string>;
  setCachedViewportSize(size: ViewportSize): void;
}

export interface RepinViewportOptions {
  deviceScaleFactor?: number | undefined;
  mobile?: boolean | undefined;
}

export const DEFAULT_AGENT_VIEWPORT: Readonly<ViewportSize> = Object.freeze({ width: 1440, height: 900 });

function validateViewport(viewport: ViewportInput | null | undefined): ViewportSize {
  const width = viewport?.width;
  if (!viewport || typeof width !== "number" || !Number.isInteger(width) || width <= 0)
    throw new TypeError("viewport width and height must be positive integers");
  const height = viewport.height;
  if (typeof height !== "number" || !Number.isInteger(height) || height <= 0)
    throw new TypeError("viewport width and height must be positive integers");
  return { width, height };
}
export async function repinViewport(
  page: ViewportPage,
  viewport: ViewportInput | null | undefined,
  options: RepinViewportOptions = {},
) {
  const size = validateViewport(viewport);
  const sessionId = await page.resolveSessionId();
  await page.cdp.send(
    "Emulation.setDeviceMetricsOverride",
    {
      ...size,
      screenWidth: size.width,
      screenHeight: size.height,
      deviceScaleFactor: options.deviceScaleFactor ?? 1,
      mobile: options.mobile ?? false,
    },
    sessionId,
  );
  page.setCachedViewportSize(size);
  return { ...size };
}
export { validateViewport };
