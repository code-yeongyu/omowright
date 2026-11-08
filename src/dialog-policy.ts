export function normalizeDialogPolicy(policy) {
  return policy ?? { accept: true };
}

function dialogFromOpening(params = {}) {
  return {
    type: params.type,
    message: params.message,
    defaultPrompt: params.defaultPrompt ?? "",
    url: params.url,
  };
}

function decisionFromResult(result) {
  if (typeof result === "boolean") return { accept: result };
  if (result && typeof result === "object") {
    const decision = { accept: result.accept !== false };
    if (result.promptText !== undefined) decision.promptText = result.promptText;
    return decision;
  }
  return { accept: true };
}

export async function resolveDialogAction(policy, params = {}) {
  try {
    const result = typeof policy === "function"
      ? await policy(dialogFromOpening(params))
      : policy;
    return decisionFromResult(result);
  } catch {
    return { accept: true };
  }
}
