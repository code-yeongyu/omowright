export interface DialogOpeningParams {
  type?: string;
  message?: string;
  defaultPrompt?: string;
  url?: string;
}

export interface DialogInfo {
  type: string | undefined;
  message: string | undefined;
  defaultPrompt: string;
  url: string | undefined;
}

export interface DialogDecision {
  accept: boolean;
  promptText?: string;
}

export type DialogPolicyResult = boolean | { accept?: boolean; promptText?: string } | null | undefined;

export type DialogPolicy =
  | DialogPolicyResult
  | ((dialog: DialogInfo) => DialogPolicyResult | Promise<DialogPolicyResult>);

export type DialogSend = (action: DialogDecision) => unknown;

export function normalizeDialogPolicy(policy: DialogPolicy) {
  return policy ?? { accept: true };
}

function dialogFromOpening(params: DialogOpeningParams = {}): DialogInfo {
  return {
    type: params.type,
    message: params.message,
    defaultPrompt: params.defaultPrompt ?? "",
    url: params.url,
  };
}

function decisionFromResult(result: DialogPolicyResult): DialogDecision {
  if (typeof result === "boolean") return { accept: result };
  if (result && typeof result === "object") {
    const decision: DialogDecision = { accept: result.accept !== false };
    if (result.promptText !== undefined) decision.promptText = result.promptText;
    return decision;
  }
  return { accept: true };
}

export async function resolveDialogAction(policy: DialogPolicy, params: DialogOpeningParams = {}) {
  try {
    const result = typeof policy === "function" ? await policy(dialogFromOpening(params)) : policy;
    return decisionFromResult(result);
  } catch {
    return { accept: true };
  }
}

let isAnswered: (dialog: Dialog) => boolean;
let answer: (dialog: Dialog, action: DialogDecision) => Promise<void>;

// The "dialog" event object, shaped like Playwright's Dialog. The client makes one
// per Page.javascriptDialogOpening and hands it to listeners; it is answered at
// most once, by a listener through accept()/dismiss() or else by the policy.
export class Dialog {
  #params: DialogOpeningParams;
  #send: DialogSend;
  #answered = false;

  constructor(params: DialogOpeningParams | null | undefined, send: DialogSend) {
    this.#params = params ?? {};
    this.#send = send;
  }

  get url() {
    return this.#params.url;
  }
  type() {
    return this.#params.type;
  }
  message() {
    return this.#params.message;
  }
  defaultValue() {
    return this.#params.defaultPrompt ?? "";
  }
  accept(promptText?: string) {
    return this.#answer(promptText === undefined ? { accept: true } : { accept: true, promptText });
  }
  dismiss() {
    return this.#answer({ accept: false });
  }

  // Marks the dialog answered before the first await, so a listener that
  // answers synchronously always wins over the policy.
  async #answer(action: DialogDecision) {
    if (this.#answered) throw new Error("this dialog is already handled");
    this.#answered = true;
    await this.#send(action);
  }

  static {
    isAnswered = (dialog) => dialog.#answered;
    answer = (dialog, action) => dialog.#answer(action);
  }
}

// Runs once the dialog's listeners have run: the policy answers only a dialog
// none of them answered.
/**
 * The value `answerWithPolicy` wants: CDP can hand the same event a non-object,
 * and its signature takes no null. Shared so core and the ego client agree.
 */
export function dialogPolicyParams(params: unknown): DialogOpeningParams | undefined {
  return typeof params === "object" && params !== null ? params : undefined;
}

export async function answerWithPolicy(dialog: Dialog, policy: DialogPolicy, params?: DialogOpeningParams) {
  if (isAnswered(dialog)) return;
  const action = await resolveDialogAction(policy, params);
  if (!isAnswered(dialog)) await answer(dialog, action);
}
