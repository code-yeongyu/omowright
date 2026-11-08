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
