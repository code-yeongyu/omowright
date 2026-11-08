/** Diagnostics a transport attaches to a failed command; each field is copied onto the error. */
export interface CdpCommandErrorDetails {
  method?: string | undefined;
  /** As the transport saw it on the wire: a session id string, or null when the command had none. */
  sessionId?: unknown;
  targetId?: unknown;
  launchId?: string | undefined;
  elapsedSinceLaunchMs?: number | undefined;
  commandElapsedMs?: number | undefined;
  receivedReplyBytes?: boolean | undefined;
  receivedBytesSinceSend?: number | undefined;
  malformedFrameCount?: number | undefined;
}

class CdpCommandError extends Error {
  declare method?: string | undefined;
  declare sessionId?: unknown;
  declare targetId?: unknown;
  declare launchId?: string | undefined;
  declare elapsedSinceLaunchMs?: number | undefined;
  declare commandElapsedMs?: number | undefined;
  declare receivedReplyBytes?: boolean | undefined;
  declare receivedBytesSinceSend?: number | undefined;
  declare malformedFrameCount?: number | undefined;

  constructor(name: string, message: string, details?: CdpCommandErrorDetails) {
    super(message);
    Object.assign(this, details);
    this.name = name;
  }
}

export class CdpCommandTimeoutError extends CdpCommandError {
  constructor(message: string, details?: CdpCommandErrorDetails) { super("CdpCommandTimeoutError", message, details); }
}

export class CdpPipeClosedError extends CdpCommandError {
  constructor(message: string, details?: CdpCommandErrorDetails) { super("CdpPipeClosedError", message, details); }
}

export class CdpSessionDetachedError extends CdpCommandError {
  constructor(message: string, details?: CdpCommandErrorDetails) { super("CdpSessionDetachedError", message, details); }
}

export class CdpSessionCrashedError extends CdpCommandError {
  constructor(message: string, details?: CdpCommandErrorDetails) { super("CdpSessionCrashedError", message, details); }
}
