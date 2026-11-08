import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createNetworkSnoop } from "./network-snoop.ts";
import { toHar } from "./har.ts";
import type { CdpTransport } from "./cdp-protocol.ts";
import type { NetworkEntry } from "./network-snoop.ts";

const SLUG_MAX = 48;
const SNOOP_MAX_ENTRIES = 5000;

type Unsubscribe = () => void;
type ConsoleEntries = object[];
type ShotPhase = "before" | "after";

/** `page.console` is either a PageConsole-like object with logs() or a plain method. */
export type TraceConsoleSource =
  | (() => ConsoleEntries | Promise<ConsoleEntries>)
  | { logs?: () => ConsoleEntries | Promise<ConsoleEntries> };

export interface TraceDialog {
  type?: string | null;
  message?: string;
  defaultPrompt?: string;
  url?: string | null;
}

export interface TracePage {
  readonly cdp: Pick<CdpTransport, "on" | "send">;
  resolveSessionId(): string | Promise<string>;
  on(event: "dialog", listener: (dialog: TraceDialog | null | undefined) => unknown): Unsubscribe;
  screenshot(options: { type: "png" }): Promise<Uint8Array>;
  url(): string;
  readonly console?: TraceConsoleSource | null;
}

export interface TraceEvents {
  on(event: "downloadStarted" | "downloadFinished", listener: (payload: object) => unknown): Unsubscribe;
}

export interface TraceOptions {
  dir?: string;
  screenshots?: boolean;
  network?: boolean;
  console?: boolean;
  maxBodyBytes?: number;
  events?: TraceEvents | null;
}

export interface TraceSummary {
  steps: number;
  events: number;
  network: number;
  startedAt: number;
  endedAt: number;
  url: string;
}

interface TraceEvent {
  kind: string;
}

type Recorded<T extends TraceEvent> = T & { ts: number; seq: number };

interface StepEvent extends TraceEvent {
  kind: "step";
  name: string;
  startedAt: number;
  screenshots: Partial<Record<ShotPhase, string>>;
  error?: string;
  endedAt?: number;
  durationMs?: number;
}

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

async function readConsole(page: TracePage): Promise<ConsoleEntries> {
  // core.ts exposes `page.console` as a PageConsole getter with logs(); simpler pages
  // expose it as a method. Both hand back the buffered in-page entries.
  const api = page.console;
  const entries = typeof api === "function" ? await api.call(page) : await api?.logs?.();
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
    dir: dirOption,
    screenshots = true,
    network = true,
    console: consoleLogs = true,
    maxBodyBytes = 1_000_000,
    events,
  } = options;
  if (typeof dirOption !== "string" || dirOption.length === 0) throw new TypeError("createTrace requires a dir");
  // Rebound so the narrowed string reaches the hoisted function declarations below.
  const dir = dirOption;

  const shotDir = path.join(dir, "screenshots");
  const ready = mkdir(shotDir, { recursive: true });
  const startedAt = Date.now();
  const records: Recorded<TraceEvent>[] = [];
  const netEntries: NetworkEntry[] = [];
  const unsubscribers: Unsubscribe[] = [];
  const snoop = network
    ? createNetworkSnoop(page, { bodies: true, maxBodyBytes, maxEntries: SNOOP_MAX_ENTRIES })
    : null;
  let seq = 0;
  let consoleSeen = 0;
  let sessionId: string | null = null;
  let stopped = false;
  let stopping: Promise<TraceSummary> | null = null;

  function record<T extends TraceEvent>(event: T): Recorded<T> {
    const entry = { ...event, ts: Date.now(), seq: seq++ };
    records.push(entry);
    return entry;
  }

  const sessionReady = Promise.resolve(page.resolveSessionId()).then((id) => {
    sessionId = id;
    return undefined;
  });
  sessionReady.catch((error) => record({ kind: "warning", scope: "session", message: messageOf(error) }));

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
            return undefined;
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
        type: dialog?.type ?? null,
        message: dialog?.message ?? "",
        defaultPrompt: dialog?.defaultPrompt ?? "",
        url: dialog?.url ?? null,
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

  async function capture(stepEntry: Recorded<StepEvent>, phase: ShotPhase) {
    const file = path.join(shotDir, `${stepEntry.seq}-${slug(stepEntry.name)}-${phase}.png`);
    try {
      // The buffer is written here rather than through screenshot({ path }) so the file
      // always lands in the trace directory, whatever the page's path resolution does.
      await writeFile(file, await page.screenshot({ type: "png" }));
      stepEntry.screenshots[phase] = file;
    } catch (error) {
      record({ kind: "warning", scope: `screenshot:${phase}`, step: stepEntry.seq, message: messageOf(error) });
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
    let entries;
    try {
      entries = await readConsole(page);
    } catch {
      // A closed or navigating page cannot report its console; keep the rest of the trace.
      return;
    }
    if (entries.length < consoleSeen) consoleSeen = 0;
    for (const entry of entries.slice(consoleSeen)) record({ kind: "console", ...entry });
    consoleSeen = entries.length;
  }

  async function drain() {
    drainNetwork();
    await drainConsole();
  }

  async function step<T>(name: unknown, fn: () => T | Promise<T>): Promise<T> {
    if (typeof fn !== "function") throw new TypeError("trace.step requires a function");
    await ready;
    const entry = record<StepEvent>({ kind: "step", name: String(name), startedAt: Date.now(), screenshots: {} });
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
    const summary = {
      steps: ordered.filter((entry) => entry.kind === "step").length,
      events: ordered.length,
      network: netEntries.length,
      startedAt,
      endedAt: Date.now(),
      url: page.url(),
    };
    await writeFile(path.join(dir, "trace.jsonl"), ordered.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
    await writeFile(path.join(dir, "trace.har"), `${JSON.stringify(toHar(netEntries), null, 2)}\n`);
    await writeFile(path.join(dir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
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
