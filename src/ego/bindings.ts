// Types for Ego Lite's native bindings (globalThis.ego inside `ego-browser nodejs`) and the
// options of the Ego engine. Types only: nothing here exists at runtime.
import type { Dialog, normalizeDialogPolicy } from "../dialog-policy.ts";

export type DialogPolicyInput = Parameters<typeof normalizeDialogPolicy>[0];

// The binding slots the CDP client itself uses.
export interface EgoCdpBindings {
  sendCDPMessage(message: string): unknown;
  onCDPMessage?: ((payload: string) => unknown) | undefined;
  onSendCDPMessageError?: ((message: string, code?: string) => unknown) | undefined;
}

export interface EgoTaskSpace {
  readonly [key: string]: unknown;
  id: number;
  error?: unknown;
  error_code?: unknown;
}

// The full runtime binding inside `ego-browser nodejs`, with task-space selection.
export interface EgoBindings extends EgoCdpBindings {
  createTaskSpace?:
    | ((name: string, profileId?: string) => EgoTaskSpace | null | undefined | Promise<EgoTaskSpace | null | undefined>)
    | undefined;
  useTaskSpace(id: number): unknown;
}

declare global {
  var ego: EgoBindings | undefined;
}

export interface EgoCdpErrorOptions {
  method?: string;
}

export interface EgoCdpClientOptions {
  ego?: EgoCdpBindings | undefined;
  commandTimeoutMs?: number | undefined;
  logId?: string | undefined;
  dialogPolicy?: DialogPolicyInput;
}

export interface EgoSendOptions {
  capability?: symbol;
  timeoutMs?: number;
}

export interface EgoEventMeta {
  sessionId: string | undefined;
  dialog?: Dialog;
}

export interface EgoEvent {
  data: { payload: unknown; meta: EgoEventMeta };
}

export interface PendingCommand {
  method: string;
  sessionId: string | undefined;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timeout: ReturnType<typeof setTimeout> | undefined;
}

export interface EgoTarget {
  id: string | undefined;
  type: string | undefined;
  url: string;
  title: string;
  description: string | undefined;
  faviconUrl: string | undefined;
  parentId: string | undefined;
}

export interface TaskSpaceSelection {
  taskSpace?: number | undefined;
  taskName?: string | undefined;
  profileId?: string | undefined;
}

export interface ConnectEgoOptions extends EgoCdpClientOptions, TaskSpaceSelection {
  ego?: EgoBindings | undefined;
  storageRoot?: string | undefined;
}
