import path from "node:path";
import { mkdir } from "node:fs/promises";
import { CdpClient, FrameManager, OmOPage, SessionManager } from "./core.ts";
import type { CdpClientOptions } from "./core.ts";
import type { CdpTransport, CdpUnsubscribe } from "./cdp-protocol.ts";
import type { ChildProcess } from "node:child_process";
import type { DialogPolicy } from "./dialog-policy.ts";
import { acquireSharedConnection, canShareConnection } from "./shared-connections.ts";
import { createAgentTabs, getAgentTabs } from "./agent-tabs.ts";
import { repinViewport } from "./viewport.ts";
import { BrowserContext } from "./browser-context.ts";

type OmOPageInstance = InstanceType<typeof OmOPage>;
type FrameManagerInstance = InstanceType<typeof FrameManager>;

interface PageEntry {
  frames: FrameManagerInstance;
  page: OmOPageInstance | null;
}

interface AttachedPageEntry extends PageEntry {
  page: OmOPageInstance;
}

interface PopupMetadata {
  url: unknown;
  windowName: unknown;
}

interface PendingPopup {
  resolve: (page: OmOPageInstance) => void;
  reject: (reason: unknown) => void;
  metadata: PopupMetadata;
  operation?: Promise<void>;
}

interface PopupTarget {
  targetId: string;
  error?: Error;
}

export interface ClosePageOptions {
  runBeforeUnload?: boolean | undefined;
}

export interface BrowserConnectionOptions {
  storageRoot?: string | undefined;
}

export interface ConnectOptions extends BrowserConnectionOptions {
  client?: CdpClientOptions | undefined;
  dialogPolicy?: DialogPolicy;
}

export class TabRepository {
  #client: CdpTransport;
  constructor(client: CdpTransport) {
    this.#client = client;
  }
  async listTargets() {
    return this.#client.discoverTargets();
  }
}

export class BrowserConnection {
  #client: CdpTransport;
  #sessions: InstanceType<typeof SessionManager>;
  #pages = new Map<string, AttachedPageEntry>();
  #contexts = new Map<string | undefined, BrowserContext>();
  #storageRoot: string;
  #popups = new Map<string, PendingPopup[]>();
  #popupTargets = new Map<string, PopupTarget[]>();
  #attachingPopups = new Map<string, PendingPopup>();
  #ownedPopups = new Set<string>();
  #popupOff: CdpUnsubscribe[] = [];
  tabs: TabRepository;
  /** Set by the pipe transport and the named-instance registry on a browser they launched. */
  declare browserProcess: ChildProcess | undefined;

  constructor(client: CdpTransport, options: BrowserConnectionOptions = {}) {
    this.#client = client;
    this.#sessions = new SessionManager(client);
    this.tabs = new TabRepository(client);
    this.#storageRoot = path.resolve(options.storageRoot ?? process.cwd());
    this.#popupOff.push(
      client.on("Target.targetCreated", ({ targetInfo }) => {
        const openerId = targetInfo?.openerId;
        if (targetInfo?.type !== "page" || !this.#acceptsPopup(openerId)) return;
        // Target discovery and Page.windowOpen are independently dispatched. Keep
        // the target's opener identity even when discovery wins that race.
        const targets = this.#popupTargets.get(openerId) ?? [];
        targets.push({ targetId: targetInfo.targetId });
        this.#popupTargets.set(openerId, targets);
        this.#matchPopups(openerId);
      }),
    );
    this.#popupOff.push(
      client.on("Target.targetDestroyed", ({ targetId }) => {
        this.#ownedPopups.delete(targetId);
        const error = Error("Popup closed before attachment completed");
        this.#attachingPopups.get(targetId)?.reject(error);
        for (const targets of this.#popupTargets.values()) {
          const target = targets.find((candidate) => candidate.targetId === targetId);
          if (target) target.error = error;
        }
      }),
    );
  }

  async initialize() {
    await this.#client.ensureConnected();
    return this;
  }

  get cdp() {
    return this.#client;
  }

  setDialogPolicy(policy: DialogPolicy) {
    if (typeof this.#client.setDialogPolicy !== "function") {
      throw new Error("dialog policy is not supported by this transport");
    }
    this.#client.setDialogPolicy(policy);
  }

  async listTargets() {
    return this.tabs.listTargets();
  }

  async newTab(url = "about:blank") {
    return (await (getAgentTabs(this) ?? createAgentTabs(this)).create(url)).page;
  }

  // An undefined opener never has an agent tab, so checking it first only skips that lookup.
  #acceptsPopup(openerId: string | undefined): openerId is string {
    return (
      openerId !== undefined &&
      !!getAgentTabs(this)?.get(openerId) &&
      (this.#pages.get(openerId)?.page.events.listenerCount("popup") ?? 0) > 0
    );
  }

  #matchPopups(openerId: string) {
    const targets = this.#popupTargets.get(openerId);
    const queue = this.#popups.get(openerId);
    while (targets?.length && queue?.length) {
      const target = targets.shift();
      const pending = queue.shift();
      // Both lengths were just checked, so neither shift comes back empty.
      if (target === undefined || pending === undefined) break;
      if (target.error) pending.reject(target.error);
      else {
        this.#attachingPopups.set(target.targetId, pending);
        this.#ownedPopups.add(target.targetId);
        pending.operation = this.#attachPopup(target.targetId, pending)
          .catch(pending.reject)
          .finally(() => {
            this.#attachingPopups.delete(target.targetId);
          });
      }
    }
    if (!targets?.length) this.#popupTargets.delete(openerId);
    if (!queue?.length) this.#popups.delete(openerId);
  }

  async #attachPopup(targetId: string, pending: PendingPopup) {
    const tabs = getAgentTabs(this) ?? createAgentTabs(this);
    const { page } = await tabs.adopt(targetId);
    if (page === null) throw new TypeError(`Popup target ${targetId} is still being adopted`);
    // OmOPage does not declare popupMetadata; Object.assign sets it exactly as `=` did.
    Object.assign(page, { popupMetadata: Object.freeze(pending.metadata) });
    await page.waitForLoadState("interactive");
    pending.resolve(page);
  }

  async attachPage(targetId: string): Promise<OmOPageInstance> {
    const attached = this.#pages.get(targetId);
    if (attached) return attached.page;
    const sessionId = await this.#sessions.resolvePageSession(targetId);
    const frames = new FrameManager(this.#client, targetId, sessionId);
    await frames.initialize();

    const entry: PageEntry = { frames, page: null };
    const host = this.#createPageHost(targetId, entry);
    const page = new OmOPage(this.#client, frames, targetId, sessionId, host);
    const { targetInfo } = await this.#client.send("Target.getTargetInfo", { targetId });
    const contextId = targetInfo.browserContextId;
    let context = this.#contexts.get(contextId);
    if (!context) {
      context = new BrowserContext(this, contextId);
      this.#contexts.set(contextId, context);
    }
    const pageContext = context;
    // OmOPage does not declare context(); Object.assign sets it exactly as `=` did.
    Object.assign(page, { context: () => pageContext });
    for (const frame of frames.frames.values()) pageContext.trackOrigin(frame.url);
    page.on("framenavigated", (frame: { url: string }) => pageContext.trackOrigin(frame.url));
    const attachedEntry: AttachedPageEntry = Object.assign(entry, { page });
    this.#pages.set(targetId, attachedEntry);
    return page;
  }

  #createPageHost(targetId: string, entry: PageEntry) {
    return {
      daemonSession: { accountId: 0, id: "standalone" },
      extensionBridgeRoute: {},
      page: null,
      resolvePageSession: (id: string, preferred?: string) => this.#sessions.resolvePageSession(id, preferred),
      setViewportSize: async (size: { width: number; height: number }) => {
        const tabs = getAgentTabs(this);
        if (tabs?.get(targetId)) await tabs.repin(targetId, size);
        else {
          // The host is used only by its page, which is set before any call; the JS original threw this TypeError otherwise.
          if (entry.page === null) throw new TypeError("Cannot read properties of null (reading 'resolveSessionId')");
          await repinViewport(entry.page, size);
        }
      },
      resolvePath: (value: string) => path.resolve(this.#storageRoot, value),
      ensurePath: async (value: string) => {
        const resolved = path.resolve(this.#storageRoot, value);
        await mkdir(path.dirname(resolved), { recursive: true });
        return resolved;
      },
      registerReadableDownloadPath: (value: string) => value,
      isReadableDownload: () => false,
      resolvePopup: async (metadata: PopupMetadata) => {
        if (!this.#acceptsPopup(targetId)) return;
        const queue = this.#popups.get(targetId) ?? [];
        const promise = new Promise<OmOPageInstance>((resolve, reject) =>
          queue.push({
            resolve,
            reject,
            metadata: { url: metadata.url, windowName: metadata.windowName },
          }),
        );
        this.#popups.set(targetId, queue);
        this.#matchPopups(targetId);
        return promise;
      },
      openPopupTab: async () => {
        throw Error("Popup tab control requires the extension bridge");
      },
      closeTab: async (_page: unknown, options: ClosePageOptions = {}) => {
        if (options.runBeforeUnload) {
          await this.#client.send("Page.close", undefined, await this.#sessions.resolvePageSession(targetId));
        } else {
          await this.#client.send("Target.closeTarget", { targetId });
        }
        await entry.page?.dispose();
        await entry.frames.dispose();
        this.#pages.delete(targetId);
      },
    };
  }

  async close() {
    for (const off of this.#popupOff) off();
    for (const queue of this.#popups.values()) {
      for (const pending of queue) pending.reject(Error("Browser connection closed"));
    }
    this.#popups.clear();
    this.#popupTargets.clear();
    for (const pending of this.#attachingPopups.values()) pending.reject(Error("Browser connection closed"));
    await Promise.all([...this.#attachingPopups.values()].map((pending) => pending.operation));
    const tabs = getAgentTabs(this);
    if (tabs) {
      await Promise.all([...this.#ownedPopups].filter((id) => tabs.get(id)).map((id) => tabs.close(id)));
      await tabs.dispose({ closeOwned: false });
    }
    for (const [targetId, entry] of [...this.#pages]) {
      await entry.page.dispose().catch(() => {});
      await entry.frames.dispose().catch(() => {});
      this.#pages.delete(targetId);
    }
    await this.#sessions.dispose();
    await this.#client.close();
  }

  // `await using browser = await connect(...)` closes the connection when the
  // scope ends, also on a throw, so an agent script exits on its own (#244).
  async [Symbol.asyncDispose]() {
    await this.close();
  }
}

// The browser's WebSocket URL carries its GUID: a ws:// URL is one already, an
// HTTP endpoint answers it on /json/version (no WebSocket, so no consent prompt).
async function browserKey(client: InstanceType<typeof CdpClient>, cdpUrl: string) {
  if (/^wss?:\/\//.test(cdpUrl)) return cdpUrl;
  return (await client.discoverVersion()).webSocketDebuggerUrl;
}

// Attaches in one process share one connection per browser (#76): each new
// connection to a user's Chrome is a new "Allow remote debugging?" prompt.
function createClient(cdpHttpUrl: unknown, options: ConnectOptions) {
  if (typeof cdpHttpUrl !== "string" || cdpHttpUrl.length === 0) {
    throw new TypeError("connect(cdpHttpUrl) requires a Chromium CDP HTTP URL");
  }
  return new CdpClient({
    cdpUrl: cdpHttpUrl,
    ...options.client,
    dialogPolicy: options.dialogPolicy ?? options.client?.dialogPolicy,
  });
}

// A connection of its own, never shared: for callers that lease or own the
// connection themselves (the named-instance registry).
export async function openConnection(cdpHttpUrl: string, options: ConnectOptions = {}) {
  return new BrowserConnection(createClient(cdpHttpUrl, options), options).initialize();
}

export async function connect(cdpHttpUrl: string, options: ConnectOptions = {}) {
  const client = createClient(cdpHttpUrl, options);
  if (!canShareConnection(options)) return new BrowserConnection(client, options).initialize();
  const key = await browserKey(client, cdpHttpUrl);
  // Opened on the resolved GUID URL, never the port: a reconnect then reaches
  // only this browser, and fails once it is gone (#79 review).
  return acquireSharedConnection(key, options, {
    open: (snapshot) => openConnection(key, snapshot),
  });
}
