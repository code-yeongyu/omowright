export interface ToolSession {
  tool(name: string, params?: Record<string, unknown>): Promise<unknown>;
}

export interface ScreenshotOptions {
  ref?: string;
  tabId?: number;
  fullPage?: boolean;
  scope?: string;
  timeoutMs?: number;
}

export interface Screenshot {
  buffer: Buffer;
  width: number;
  height: number;
  format: string;
  captureId: string | null;
  captureUnavailable?: unknown;
  scope?: string | null;
  tabId: number;
  dialogs: unknown[];
}

interface ScreenshotReply {
  image_base64: string;
  width: number;
  height: number;
  format: string;
  capture_id?: string | null;
  capture_unavailable?: unknown;
  tab_id: number;
  dialogs?: unknown[];
}

interface FullPageReply {
  capture_id: string;
  byte_size?: number;
  width: number;
  height: number;
  format: string;
  scope?: string | null;
  tab_id: number;
  dialogs?: unknown[];
}

interface ReadChunkReply {
  data_base64?: string | null;
  eof?: boolean;
  next_offset: number;
}

export async function captureScreenshot(
  session: ToolSession,
  { ref, tabId, fullPage = false, scope, timeoutMs }: ScreenshotOptions = {},
): Promise<Screenshot> {
  if (!fullPage) {
    const result = (await session.tool("screenshot", { ref, tab_id: tabId })) as ScreenshotReply;
    return {
      buffer: Buffer.from(result.image_base64, "base64"),
      width: result.width,
      height: result.height,
      format: result.format,
      captureId: result.capture_id ?? null,
      captureUnavailable: result.capture_unavailable ?? null,
      tabId: result.tab_id,
      dialogs: result.dialogs ?? [],
    };
  }
  const started = (await session.tool("screenshot_full_page", {
    scope,
    tab_id: tabId,
    timeout_ms: timeoutMs,
  })) as FullPageReply;
  const buffer = await readCapture(session, started.capture_id, started.byte_size);
  return {
    buffer,
    width: started.width,
    height: started.height,
    format: started.format,
    captureId: started.capture_id,
    scope: started.scope ?? scope ?? null,
    tabId: started.tab_id,
    dialogs: started.dialogs ?? [],
  };
}

// Reads chunks strictly in order: each read starts at the offset the previous chunk reported.
async function readChunks(session: ToolSession, captureId: string, offset: number, chunks: Buffer[]): Promise<void> {
  const chunk = (await session.tool("screenshot_read", { capture_id: captureId, offset })) as ReadChunkReply;
  const bytes = Buffer.from(chunk.data_base64 ?? "", "base64");
  chunks.push(bytes);
  if (chunk.eof || bytes.length === 0) return;
  if (chunk.next_offset <= offset) throw new Error(`screenshot_read did not advance past offset ${offset}`);
  return readChunks(session, captureId, chunk.next_offset, chunks);
}

async function readCapture(session: ToolSession, captureId: string, byteSize: number | undefined): Promise<Buffer> {
  const chunks: Buffer[] = [];
  try {
    await readChunks(session, captureId, 0, chunks);
  } finally {
    await session.tool("screenshot_release", { capture_id: captureId }).catch(() => {});
  }
  const buffer = Buffer.concat(chunks);
  if (typeof byteSize === "number" && buffer.length !== byteSize) {
    throw new Error(`screenshot capture ${captureId}: expected ${byteSize} bytes, assembled ${buffer.length}`);
  }
  return buffer;
}
