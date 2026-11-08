export interface ViewportSize {
  width: number;
  height: number;
}

export interface RepinViewportOptions {
  deviceScaleFactor?: number;
  mobile?: boolean;
}

export interface ViewportPage {
  resolveSessionId(): Promise<string | undefined>;
  cdp: { send(method: string, params: Record<string, unknown>, sessionId?: string): Promise<unknown> };
  setCachedViewportSize(size: ViewportSize): void;
}

export const DEFAULT_AGENT_VIEWPORT = Object.freeze({ width: 1440, height: 900 });

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function validateViewport(viewport: Partial<ViewportSize> | null | undefined): ViewportSize {
  if (!viewport || !isPositiveInteger(viewport.width) || !isPositiveInteger(viewport.height))
    throw new TypeError("viewport width and height must be positive integers");
  return { width: viewport.width, height: viewport.height };
}
export async function repinViewport(
  page: ViewportPage,
  viewport: Partial<ViewportSize> | null | undefined,
  options: RepinViewportOptions = {},
) {
  const size = validateViewport(viewport);
  const sessionId = await page.resolveSessionId();
  await page.cdp.send(
    "Emulation.setDeviceMetricsOverride",
    { ...size, deviceScaleFactor: options.deviceScaleFactor ?? 1, mobile: options.mobile ?? false },
    sessionId,
  );
  page.setCachedViewportSize(size);
  return { ...size };
}
export { validateViewport };
