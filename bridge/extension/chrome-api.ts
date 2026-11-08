export interface ChromeEvent<Args extends unknown[]> {
  addListener(listener: (...args: Args) => void): void;
}

export interface NativePort {
  postMessage(message: unknown): void;
  readonly onMessage: ChromeEvent<[message: unknown]>;
  readonly onDisconnect: ChromeEvent<[]>;
}

export type TabGroupColor = "grey" | "blue" | "red" | "yellow" | "green" | "pink" | "purple" | "cyan" | "orange";

export interface TabGroupUpdate {
  readonly collapsed?: boolean;
  readonly color?: TabGroupColor;
  readonly title?: string | null;
}

export interface ChromeApi {
  readonly runtime: {
    readonly id: string;
    readonly lastError: unknown;
    getManifest(): { readonly version: string };
    connectNative(application: string): NativePort;
  };
  readonly bookmarks: {
    create(details: object): Promise<unknown>;
    move(id: string, destination: object): Promise<unknown>;
    remove(id: string): Promise<unknown>;
  };
  readonly history: {
    deleteUrl(details: { readonly url: string }): Promise<unknown>;
    deleteRange(range: { readonly startTime: number; readonly endTime: number }): Promise<unknown>;
  };
  readonly tabGroups: {
    update(groupId: number, updateProperties: TabGroupUpdate): Promise<unknown>;
    readonly onCreated: ChromeEvent<[group: unknown]>;
    readonly onUpdated: ChromeEvent<[group: unknown]>;
    readonly onMoved: ChromeEvent<[group: unknown]>;
  };
  readonly debugger: {
    attach(target: { readonly tabId: number }, requiredVersion: string): Promise<void>;
    detach(target: { readonly tabId: number }): Promise<void>;
  };
  readonly notifications: {
    readonly onShown: ChromeEvent<[notificationId: string]>;
    readonly onClicked: ChromeEvent<[notificationId: string]>;
    readonly onClosed: ChromeEvent<[notificationId: string, byUser: boolean]>;
  };
  readonly tabs: {
    readonly onActivated: ChromeEvent<[activeInfo: unknown]>;
  };
  readonly windows: {
    readonly onFocusChanged: ChromeEvent<[windowId: number]>;
  };
}
