import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createNetworkSnoop } from "./network-snoop.ts";
import type { NetworkEntry } from "./network-snoop.ts";
import type { NetworkPage } from "./network-events.ts";
import type { BrowserEventPayloads } from "./events.ts";
import { toHar } from "./har.ts";
import { readProperty } from "./read-property.ts";

type TraceDownloadEvent = "downloadStarted" | "downloadFinished";

/** What the trace reads from a page "dialog" event (the Dialog in dialog-policy.ts). */
export interface TraceDialog {
  type(): string | undefined;
  message(): string | undefined;
  defaultValue(): string;
  readonly url: string | undefined;
}

export interface TracePage extends NetworkPage {
  on(event: "dialog", listener: (dialog: TraceDialog) => unknown): () => void;
  screenshot(options: { type: "png" }): Promise<Buffer | Uint8Array>;
  url(): string;
  /** A PageConsole with logs(), or a method returning the buffered entries. */
  console?: unknown;
}

export interface TraceOptions {
  /** Required: createTrace throws a TypeError without it. */
  dir?: string | undefined;
  screenshots?: boolean | undefined;
  network?: boolean | undefined;
  console?: boolean | undefined;
  maxBodyBytes?: number | undefined;
  events?:
    | {
        on<N extends TraceDownloadEvent>(name: N, listener: (payload: BrowserEventPayloads[N]) => unknown): () => void;
      }
    | undefined;
}

interface TraceRecord {
  kind: string;
  ts: number;
  seq: number;
}

interface StepRecord {
  kind: "step";
  name: string;
  startedAt: number;
  screenshots: Record<string, string>;
  error?: string;
  endedAt?: number;
  durationMs?: number;
}

export interface TraceSummary {
  steps: number;
  events: number;
  network: number;
  startedAt: number;
  endedAt: number;
  url: string;
}

const SLUG_MAX = 48;
const SNOOP_MAX_ENTRIES = 5000;

function slug(name: unknown) {
  const value = String(name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return (value || "step").slice(0, SLUG_MAX);
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function readConsole(page: TracePage): Promise<unknown[]> {
  // core.js exposes `page.console` as a PageConsole getter with logs(); simpler pages
  // expose it as a method. Both hand back the buffered in-page entries.
  const api = page.console;
  let entries: unknown;
  if (typeof api === "function") entries = await api.call(page);
  else {
    const logs = api === null || api === undefined ? undefined : readProperty(api, "logs");
    if (logs !== null && logs !== undefined) {
      // `api?.logs?.()` threw this TypeError for a non-callable logs.
      if (typeof logs !== "function") throw new TypeError("api.logs is not a function");
      entries = await logs.call(api);
    }
  }
  return Array.isArray(entries) ? entries : [];
}

/**
 * Records a flight recorder trace for one page: steps, screenshots, network, console,
 * dialogs, navigations and downloads, flushed to `dir` as trace.jsonl, trace.har and
 * summary.json when {@link stop} runs.
 */
export function createTrace(page: TracePage, options: TraceOptions = {}) {
  if (!page?.cdp || typeof page.resolveSessionId !== "function") {
    throw new TypeError("createTrace requires a page with cdp and resolveSessionId");
  }
  const {
    dir,
    screenshots = true,
    network = true,
    console: consoleLogs = true,
    maxBodyBytes = 1_000_000,
    events,
  } = options;
  if (typeof dir !== "string" || dir.length === 0) throw new TypeError("createTrace requires a dir");
  const traceDir = dir;

  const shotDir = path.join(dir, "screenshots");
  const ready = mkdir(shotDir, { recursive: true });
  const startedAt = Date.now();
  const records: TraceRecord[] = [];
  const netEntries: NetworkEntry[] = [];
  const unsubscribers: Array<() => void> = [];
  const snoop = network
    ? createNetworkSnoop(page, { bodies: true, maxBodyBytes, maxEntries: SNOOP_MAX_ENTRIES })
    : null;
  let seq = 0;
  let consoleSeen = 0;
  let sessionId: string | null = null;
  let stopped = false;
  let stopping: Promise<TraceSummary> | null = null;

  function record<E extends { kind: string }>(event: E): E & TraceRecord {
    const entry = { ...event, ts: Date.now(), seq: seq++ };
    records.push(entry);
    return entry;
  }

  const sessionReady = Promise.resolve(page.resolveSessionId()).then((id) => {
    sessionId = id;
  });
  sessionReady.catch((error: unknown) => record({ kind: "warning", scope: "session", message: messageOf(error) }));

  unsubscribers.push(
    page.cdp.on("Page.frameNavigated", (params, meta) => {
      if (stopped || params?.frame?.parentId) return;
      const add = () =>
        record({ kind: "navigation", url: params?.frame?.url ?? "", frameId: params?.frame?.id ?? null });
      if (sessionId === null) {
        // The session id resolves asynchronously; hold early events until it is known.
        sessionReady
          .then(() => {
            if (!stopped && meta?.sessionId === sessionId) add();
          })
          .catch(() => {});
        return;
      }
      if (meta?.sessionId === sessionId) add();
    }),
  );

  unsubscribers.push(
    page.on("dialog", (dialog) =>
      record({
        kind: "dialog",
        type: dialog.type() ?? null,
        message: dialog.message() ?? "",
        defaultPrompt: dialog.defaultValue(),
        url: dialog.url ?? null,
      }),
    ),
  );

  if (events) {
    unsubscribers.push(
      events.on("downloadStarted", (payload) => record({ kind: "download", phase: "started", ...payload })),
    );
    unsubscribers.push(
      events.on("downloadFinished", (payload) => record({ kind: "download", phase: "finished", ...payload })),
    );
  }

  async function capture(stepRecord: StepRecord & TraceRecord, phase: "before" | "after") {
    const file = path.join(shotDir, `${stepRecord.seq}-${slug(stepRecord.name)}-${phase}.png`);
    try {
      // The buffer is written here rather than through screenshot({ path }) so the file
      // always lands in the trace directory, whatever the page's path resolution does.
      await writeFile(file, await page.screenshot({ type: "png" }));
      stepRecord.screenshots[phase] = file;
    } catch (error) {
      record({ kind: "warning", scope: `screenshot:${phase}`, step: stepRecord.seq, message: messageOf(error) });
    }
  }

  function drainNetwork() {
    for (const entry of snoop?.pop() ?? []) {
      if (typeof entry.body === "string" && Buffer.byteLength(entry.body) > maxBodyBytes) {
        entry.body = null;
        entry.bodySkipped = true;
      }
      netEntries.push(entry);
      record({ kind: "network", ...entry });
    }
  }

  async function drainConsole() {
    if (!consoleLogs) return;
    let entries: unknown[];
    try {
      entries = await readConsole(page);
    } catch {
      // A closed or navigating page cannot report its console; keep the rest of the trace.
      return;
    }
    if (entries.length < consoleSeen) consoleSeen = 0;
    // Object.assign copies exactly what the object spread did for these plain entries.
    for (const entry of entries.slice(consoleSeen)) record(Object.assign({ kind: "console" }, entry));
    consoleSeen = entries.length;
  }

  async function drain() {
    drainNetwork();
    await drainConsole();
  }

  async function step<T>(name: unknown, fn: () => T | Promise<T>): Promise<T> {
    if (typeof fn !== "function") throw new TypeError("trace.step requires a function");
    await ready;
    const entry = record<StepRecord>({ kind: "step", name: String(name), startedAt: Date.now(), screenshots: {} });
    if (screenshots) await capture(entry, "before");
    try {
      return await fn();
    } catch (error) {
      entry.error = messageOf(error);
      throw error;
    } finally {
      entry.endedAt = Date.now();
      entry.durationMs = entry.endedAt - entry.startedAt;
      if (screenshots) await capture(entry, "after");
      await drain();
    }
  }

  function mark(name: unknown, data?: unknown) {
    return record({ kind: "mark", name: String(name), data: data ?? null });
  }

  async function finish(): Promise<TraceSummary> {
    await ready;
    await drain();
    stopped = true;
    for (const off of unsubscribers.splice(0, unsubscribers.length)) off();
    snoop?.dispose();
    const ordered = records.toSorted((a, b) => a.seq - b.seq);
    const summary: TraceSummary = {
      steps: ordered.filter((entry) => entry.kind === "step").length,
      events: ordered.length,
      network: netEntries.length,
      startedAt,
      endedAt: Date.now(),
      url: page.url(),
    };
    await writeFile(path.join(traceDir, "trace.jsonl"), ordered.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
    await writeFile(path.join(traceDir, "trace.har"), `${JSON.stringify(toHar(netEntries), null, 2)}\n`);
    await writeFile(path.join(traceDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
    return summary;
  }

  function stop() {
    return (stopping ??= finish());
  }

  return {
    step,
    mark,
    stop,
    get dir() {
      return dir;
    },
  };
}
