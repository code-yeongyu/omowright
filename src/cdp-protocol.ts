export interface CdpRemoteObject {
  type: string;
  subtype?: string;
  className?: string;
  value?: unknown;
  unserializableValue?: string;
  description?: string;
  objectId?: string;
}

export interface CdpCallFrame {
  functionName: string;
  scriptId?: string;
  url: string;
  lineNumber: number;
  columnNumber: number;
}

export interface CdpExceptionDetails {
  exceptionId?: number;
  text: string;
  lineNumber: number;
  columnNumber: number;
  url?: string;
  stackTrace?: { callFrames: CdpCallFrame[] };
  exception?: CdpRemoteObject;
  executionContextId?: number;
}

export interface CdpEvaluateResult {
  result: CdpRemoteObject;
  exceptionDetails?: CdpExceptionDetails;
}

export interface CdpTargetInfo {
  targetId: string;
  type: string;
  title: string;
  url: string;
  attached: boolean;
  openerId?: string;
  openerFrameId?: string;
  parentFrameId?: string;
  browserContextId?: string;
  canAccessOpener?: boolean;
  subtype?: string;
}

export interface CdpFrame {
  id: string;
  parentId?: string;
  loaderId: string;
  name?: string;
  url: string;
  urlFragment?: string;
  securityOrigin?: string;
  mimeType?: string;
}

export interface CdpFrameTree {
  frame: CdpFrame;
  childFrames?: CdpFrameTree[];
}

export interface CdpDomNode {
  nodeId: number;
  backendNodeId: number;
  nodeType: number;
  nodeName: string;
  localName: string;
  nodeValue: string;
  parentId?: number;
  childNodeCount?: number;
  children?: CdpDomNode[];
  attributes?: string[];
  frameId?: string;
  contentDocument?: CdpDomNode;
  shadowRoots?: CdpDomNode[];
}

export type CdpQuad = number[];

export interface CdpBoxModel {
  content: CdpQuad;
  padding: CdpQuad;
  border: CdpQuad;
  margin: CdpQuad;
  width: number;
  height: number;
}

export interface CdpRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CdpLayoutViewport {
  pageX: number;
  pageY: number;
  clientWidth: number;
  clientHeight: number;
}

export interface CdpVisualViewport {
  offsetX: number;
  offsetY: number;
  pageX: number;
  pageY: number;
  clientWidth: number;
  clientHeight: number;
  scale: number;
  zoom?: number;
}

export interface CdpLayoutMetrics {
  layoutViewport: CdpLayoutViewport;
  visualViewport: CdpVisualViewport;
  contentSize: CdpRect;
  cssLayoutViewport: CdpLayoutViewport;
  cssVisualViewport: CdpVisualViewport;
  cssContentSize: CdpRect;
}

export interface CdpNavigationEntry {
  id: number;
  url: string;
  userTypedURL: string;
  title: string;
  transitionType: string;
}

export interface CdpCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  size: number;
  httpOnly: boolean;
  secure: boolean;
  session: boolean;
  sameSite?: string;
  partitionKey?: { topLevelSite: string; hasCrossSiteAncestor: boolean };
}

export interface CdpRequest {
  url: string;
  urlFragment?: string;
  method: string;
  headers: Record<string, string>;
  postData?: string;
  hasPostData?: boolean;
}

export interface CdpResponse {
  url: string;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  mimeType: string;
  encodedDataLength?: number;
  remoteIPAddress?: string;
  protocol?: string;
}

export interface CdpBrowserVersion {
  protocolVersion: string;
  product: string;
  revision: string;
  userAgent: string;
  jsVersion: string;
}

type CdpEmpty = Record<string, never>;

export interface CdpCommandResults {
  "Browser.close": CdpEmpty;
  "Browser.getVersion": CdpBrowserVersion;
  "Browser.getWindowForTarget": { windowId: number; bounds: Partial<CdpRect> & { windowState?: string } };
  "Browser.setDownloadBehavior": CdpEmpty;
  "DOM.describeNode": { node: CdpDomNode };
  "DOM.enable": CdpEmpty;
  "DOM.getBoxModel": { model: CdpBoxModel };
  "DOM.getContentQuads": { quads: CdpQuad[] };
  "DOM.getDocument": { root: CdpDomNode };
  "DOM.querySelectorAll": { nodeIds: number[] };
  "DOM.resolveNode": { object: CdpRemoteObject };
  "DOM.scrollIntoViewIfNeeded": CdpEmpty;
  "DOM.setFileInputFiles": CdpEmpty;
  "Emulation.clearDeviceMetricsOverride": CdpEmpty;
  "Emulation.setDeviceMetricsOverride": CdpEmpty;
  "Emulation.setFocusEmulationEnabled": CdpEmpty;
  "Emulation.setTouchEmulationEnabled": CdpEmpty;
  "DOMStorage.getDOMStorageItems": { entries: [string, string][] };
  "Emulation.setUserAgentOverride": CdpEmpty;
  "Fetch.continueRequest": CdpEmpty;
  "Fetch.disable": CdpEmpty;
  "Fetch.enable": CdpEmpty;
  "Fetch.failRequest": CdpEmpty;
  "Fetch.fulfillRequest": CdpEmpty;
  "Input.dispatchKeyEvent": CdpEmpty;
  "Input.dispatchMouseEvent": CdpEmpty;
  "Input.insertText": CdpEmpty;
  "Inspector.enable": CdpEmpty;
  "Network.enable": CdpEmpty;
  "Network.getCookies": { cookies: CdpCookie[] };
  "Network.getResponseBody": { body: string; base64Encoded: boolean };
  "Network.setCookies": CdpEmpty;
  "OmO.waitForDownload": { absolutePath: string; downloadId?: string | number };
  "Page.addScriptToEvaluateOnNewDocument": { identifier: string };
  "Page.bringToFront": CdpEmpty;
  "Page.captureScreenshot": { data: string };
  "Page.close": CdpEmpty;
  "Page.createIsolatedWorld": { executionContextId: number };
  "Page.enable": CdpEmpty;
  "Page.getFrameTree": { frameTree: CdpFrameTree };
  "Page.getLayoutMetrics": CdpLayoutMetrics;
  "Page.getNavigationHistory": { currentIndex: number; entries: CdpNavigationEntry[] };
  "Page.handleJavaScriptDialog": CdpEmpty;
  "Page.navigate": { frameId: string; loaderId?: string; errorText?: string };
  "Page.navigateToHistoryEntry": CdpEmpty;
  "Page.printToPDF": { data: string; stream?: string };
  "Page.reload": CdpEmpty;
  "Page.removeScriptToEvaluateOnNewDocument": CdpEmpty;
  "Page.screencastFrameAck": CdpEmpty;
  "Page.setInterceptFileChooserDialog": CdpEmpty;
  "Page.setWebLifecycleState": CdpEmpty;
  "Page.startScreencast": CdpEmpty;
  "Page.stopScreencast": CdpEmpty;
  "Runtime.callFunctionOn": CdpEvaluateResult;
  "Runtime.evaluate": CdpEvaluateResult;
  "Runtime.releaseObject": CdpEmpty;
  "Storage.getCookies": { cookies: CdpCookie[] };
  "Target.activateTarget": CdpEmpty;
  "Target.attachToTarget": { sessionId: string };
  "Target.closeTarget": { success: boolean };
  "Target.createTarget": { targetId: string };
  "Target.detachFromTarget": CdpEmpty;
  "Target.getTargetInfo": { targetInfo: CdpTargetInfo };
  "Target.getTargets": { targetInfos: CdpTargetInfo[] };
  "Target.setAutoAttach": CdpEmpty;
  "Target.setDiscoverTargets": CdpEmpty;
}

export interface CdpDownloadWillBegin {
  frameId: string;
  guid: string;
  url: string;
  suggestedFilename: string;
}

export interface CdpEventPayloads {
  "Browser.downloadProgress": {
    guid: string;
    totalBytes: number;
    receivedBytes: number;
    state: "inProgress" | "completed" | "canceled";
    filePath?: string;
  };
  "Browser.downloadWillBegin": CdpDownloadWillBegin;
  "Fetch.requestPaused": {
    requestId: string;
    request: CdpRequest;
    frameId: string;
    resourceType: string;
    responseErrorReason?: string;
    responseStatusCode?: number;
    responseStatusText?: string;
    responseHeaders?: Array<{ name: string; value: string }>;
    networkId?: string;
  };
  "Inspector.targetCrashed": CdpEmpty;
  "Network.loadingFailed": {
    requestId: string;
    timestamp: number;
    type?: string;
    errorText: string;
    canceled?: boolean;
    blockedReason?: string;
  };
  "Network.loadingFinished": { requestId: string; timestamp: number; encodedDataLength: number };
  "Network.requestWillBeSent": {
    requestId: string;
    loaderId: string;
    documentURL: string;
    request: CdpRequest;
    timestamp: number;
    wallTime: number;
    type?: string;
    frameId?: string;
    redirectResponse?: CdpResponse;
  };
  "Network.responseReceived": {
    requestId: string;
    loaderId: string;
    timestamp: number;
    type: string;
    response: CdpResponse;
    frameId?: string;
  };
  "Page.domContentEventFired": { timestamp: number };
  "Page.downloadWillBegin": CdpDownloadWillBegin;
  "Page.fileChooserOpened": { frameId: string; mode: "selectSingle" | "selectMultiple"; backendNodeId?: number };
  "Page.frameAttached": { frameId: string; parentFrameId: string };
  "Page.frameDetached": { frameId: string; reason?: string };
  "Page.frameNavigated": { frame: CdpFrame; type?: string };
  "Page.javascriptDialogOpening": {
    url: string;
    message: string;
    type: string;
    hasBrowserHandler: boolean;
    defaultPrompt?: string;
  };
  "Page.loadEventFired": { timestamp: number };
  "Page.screencastFrame": {
    data: string;
    sessionId: number;
    metadata: {
      offsetTop: number;
      pageScaleFactor: number;
      deviceWidth: number;
      deviceHeight: number;
      scrollOffsetX: number;
      scrollOffsetY: number;
      timestamp?: number;
    };
  };
  "Page.windowOpen": { url: string; windowName: string; windowFeatures: string[]; userGesture: boolean };
  "Target.attachedToTarget": { sessionId: string; targetInfo: CdpTargetInfo; waitingForDebugger: boolean };
  "Target.detachedFromTarget": { sessionId: string; targetId?: string };
  "Target.targetCrashed": { targetId: string; status: string; errorCode: number };
  "Target.targetCreated": { targetInfo: CdpTargetInfo };
  "Target.targetDestroyed": { targetId: string };
  "Target.targetInfoChanged": { targetInfo: CdpTargetInfo };
}

export type CdpResult<M extends string> = M extends keyof CdpCommandResults ? CdpCommandResults[M] : unknown;
export type CdpEventPayload<E extends string> = E extends keyof CdpEventPayloads ? CdpEventPayloads[E] : unknown;

export interface CdpEventMeta {
  sessionId?: string | undefined;
}

export interface CdpSendOptions {
  timeoutMs?: number | undefined;
  capability?: symbol;
  extensionBridge?: object;
}

export type CdpUnsubscribe = () => void;

export type CdpSend = <M extends string>(
  method: M,
  params?: object,
  sessionId?: string,
  options?: CdpSendOptions,
) => Promise<CdpResult<M>>;

export type CdpOn = <E extends string>(
  event: E,
  handler: (payload: CdpEventPayload<E>, meta: CdpEventMeta) => unknown,
) => CdpUnsubscribe;

export interface CdpTransportEvents {
  on(name: string, listener: () => unknown): () => void;
}

export interface CdpTargetSummary {
  id: string;
  type: string;
  url: string;
  title: string;
  description?: string | undefined;
  faviconUrl?: string | undefined;
  parentId?: string | undefined;
}

export interface CdpTransport {
  send: CdpSend;
  on: CdpOn;
  ensureConnected(): Promise<void>;
  close(): Promise<void>;
  discoverTargets(): Promise<CdpTargetSummary[]>;
  transportEvents?: CdpTransportEvents;
  isHeadless?: boolean;
  setDialogPolicy?(policy: unknown): void;
}
