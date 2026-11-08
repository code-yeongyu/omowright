import path from "node:path";
import { mkdir } from "node:fs/promises";
import { CdpClient, FrameManager, OmOPage, SessionManager } from "./core.ts";
import type { CdpClientOptions } from "./core.ts";
import type { CdpTransport } from "./cdp-protocol.ts";

type Page = InstanceType<typeof OmOPage>;

interface PageEntry {
  frames: FrameManager;
  page: Page | null;
}

interface AttachedPageEntry {
  frames: FrameManager;
  page: Page;
}

export interface BrowserConnectionOptions {
  storageRoot?: string;
}

export interface ConnectOptions extends BrowserConnectionOptions {
  client?: CdpClientOptions;
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
  #sessions: SessionManager;
  #pages = new Map<string, AttachedPageEntry>();
  #storageRoot: string;
  tabs: TabRepository;

  constructor(client: CdpTransport, options: BrowserConnectionOptions = {}) {
    this.#client = client;
    this.#sessions = new SessionManager(client);
    this.tabs = new TabRepository(client);
    this.#storageRoot = path.resolve(options.storageRoot ?? process.cwd());
  }

  async initialize() {
    await this.#client.ensureConnected();
    return this;
  }

  get cdp() {
    return this.#client;
  }

  setDialogPolicy(policy: unknown) {
    if (typeof this.#client.setDialogPolicy !== "function") {
      throw new Error("dialog policy is not supported by this transport");
    }
    this.#client.setDialogPolicy(policy);
  }

  async listTargets() {
    return this.tabs.listTargets();
  }

  async attachPage(targetId: string): Promise<Page> {
    const attached = this.#pages.get(targetId);
    if (attached) return attached.page;
    const sessionId = await this.#sessions.resolvePageSession(targetId);
    const frames = new FrameManager(this.#client, targetId, sessionId);
    await frames.initialize();

    const entry: PageEntry = { frames, page: null };
    const host = this.#createPageHost(targetId, entry);
    const page = new OmOPage(this.#client, frames, targetId, sessionId, host);
    this.#pages.set(targetId, Object.assign(entry, { page }));
    return page;
  }

  #createPageHost(targetId: string, entry: PageEntry) {
    return {
      daemonSession: { accountId: 0, id: "standalone" },
      extensionBridgeRoute: {},
      page: null,
      resolvePageSession: (id: string, preferred?: string) => this.#sessions.resolvePageSession(id, preferred),
      resolvePath: (value: string) => path.resolve(this.#storageRoot, value),
      ensurePath: async (value: string) => {
        const resolved = path.resolve(this.#storageRoot, value);
        await mkdir(path.dirname(resolved), { recursive: true });
        return resolved;
      },
      registerReadableDownload: <T>(value: T) => value,
      isReadableDownload: () => false,
      openPopupTab: async () => {
        throw Error("Popup tab control requires the extension bridge");
      },
      closeTab: async (_page: unknown, options: { runBeforeUnload?: boolean } = {}) => {
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
    // Snapshot first: entries are deleted, and closeTab may run, while each dispose is awaited.
    for (const [targetId, entry] of Array.from(this.#pages)) {
      await entry.page.dispose().catch(() => {});
      await entry.frames.dispose().catch(() => {});
      this.#pages.delete(targetId);
    }
    await this.#sessions.dispose();
    await this.#client.close();
  }
}

export async function connect(cdpHttpUrl: string, options: ConnectOptions = {}) {
  if (typeof cdpHttpUrl !== "string" || cdpHttpUrl.length === 0) {
    throw new TypeError("connect(cdpHttpUrl) requires a Chromium CDP HTTP URL");
  }
  const client = new CdpClient({ cdpUrl: cdpHttpUrl, ...options.client });
  return new BrowserConnection(client, options).initialize();
}
