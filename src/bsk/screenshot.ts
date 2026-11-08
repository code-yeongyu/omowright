import { readProperty } from "../read-property.ts";

export interface ToolSession {
  tool(name: string, params?: Record<string, unknown>): Promise<unknown>;
}

export interface ScreenshotOptions {
  ref?: string;
  tabId?: number;
  fullPage?: boolean;
  scope?: string;
  timeoutMs?: number;
  context?: string;
  dependsOn?: readonly string[];
}

export interface Screenshot {
  buffer: Buffer;
  width: unknown;
  height: unknown;
  format: unknown;
  captureId: unknown;
  captureUnavailable?: unknown;
  scope?: unknown;
  tabId: unknown;
  dialogs: unknown;
}

// Buffer.from rejected a non-string field with a TypeError; only base64 text is decoded.
function fromBase64(value: unknown, field: string): Buffer {
  if (typeof value !== "string") throw new TypeError(`${field} is not base64 text`);
  return Buffer.from(value, "base64");
}

export async function captureScreenshot(
  session: ToolSession,
  { ref, tabId, fullPage = false, scope, timeoutMs, context, dependsOn }: ScreenshotOptions = {},
): Promise<Screenshot> {
  if (!fullPage) {
    const result = await session.tool("screenshot", { ref, tab_id: tabId });
    return {
      buffer: fromBase64(readProperty(result, "image_base64"), "image_base64"),
      width: readProperty(result, "width"),
      height: readProperty(result, "height"),
      format: readProperty(result, "format"),
      captureId: readProperty(result, "capture_id") ?? null,
      captureUnavailable: readProperty(result, "capture_unavailable") ?? null,
      tabId: readProperty(result, "tab_id"),
      dialogs: readProperty(result, "dialogs") ?? [],
    };
  }
  const started = await session.tool("screenshot_full_page", {
    scope,
    tab_id: tabId,
    timeout_ms: timeoutMs,
    context_id: context,
    depends_on: dependsOn,
  });
  const buffer = await readCapture(session, readProperty(started, "capture_id"), readProperty(started, "byte_size"));
  return {
    buffer,
    width: readProperty(started, "width"),
    height: readProperty(started, "height"),
    format: readProperty(started, "format"),
    captureId: readProperty(started, "capture_id"),
    scope: readProperty(started, "scope") ?? scope ?? null,
    tabId: readProperty(started, "tab_id"),
    dialogs: readProperty(started, "dialogs") ?? [],
  };
}

async function readCapture(session: ToolSession, captureId: unknown, byteSize: unknown): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let offset = 0;
  try {
    for (;;) {
      const chunk = await session.tool("screenshot_read", { capture_id: captureId, offset });
      const bytes = fromBase64(readProperty(chunk, "data_base64") ?? "", "data_base64");
      chunks.push(bytes);
      if (readProperty(chunk, "eof") || bytes.length === 0) break;
      const nextOffset = readProperty(chunk, "next_offset");
      if (typeof nextOffset !== "number" || nextOffset <= offset)
        throw new Error(`screenshot_read did not advance past offset ${offset}`);
      offset = nextOffset;
    }
  } finally {
    await session.tool("screenshot_release", { capture_id: captureId }).catch(() => {});
  }
  const buffer = Buffer.concat(chunks);
  if (typeof byteSize === "number" && buffer.length !== byteSize) {
    throw new Error(`screenshot capture ${captureId}: expected ${byteSize} bytes, assembled ${buffer.length}`);
  }
  return buffer;
}
