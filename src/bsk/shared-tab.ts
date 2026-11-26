import type { ActionExpectation, BskToolParams } from "./protocol/params.generated.ts";

export type ToolMethod = keyof BskToolParams;
// What a typed call puts on the wire; BskSession.tool() adds session_id.
export type WireParams<M extends ToolMethod> = Omit<BskToolParams[M], "session_id">;
// The part of BskSession a module that issues tool calls needs: typed per method, so a stub can stand in.
export interface ToolSession<M extends ToolMethod> {
  tool<N extends M>(name: N, params: WireParams<N>): Promise<unknown>;
}

// The action metadata BrowserSkill 0.5.0 composes into every guarded action's params (bsk-protocol README,
// "Guarded action metadata and expectations"). Strict policy consumes `context` after one action; target policy
// reuses it for DOM-targeted actions and needs an unused `observation` for scripts, untargeted keys and navigation
// unless `expect` states the facts the action relies on. `dependsOn` is strict-only.
export interface SharedTabOptions {
  context?: string | undefined;
  observation?: string | undefined;
  expect?: readonly ActionExpectation[] | undefined;
  dependsOn?: readonly string[] | undefined;
}

export type MetadataKey = "context_id" | "observation_id" | "expect" | "depends_on";
// The methods whose schema carries the action metadata.
export type SharedTabMethod = {
  [M in ToolMethod]: MetadataKey extends keyof BskToolParams[M] ? M : never;
}[ToolMethod];

// The extension refuses a guarded action whose metadata is missing, and the daemon never fills it in. Any key left
// over after a method's own options is a misspelling (for example `contextId`) that would otherwise send no context,
// so it throws.
export function sharedTab({ context, observation, expect, dependsOn, ...unknown }: SharedTabOptions): {
  context_id: string | undefined;
  observation_id: string | undefined;
  expect: readonly ActionExpectation[] | undefined;
  depends_on: readonly string[] | undefined;
} {
  const extra = Object.keys(unknown);
  if (extra.length > 0) {
    throw new TypeError(
      `unknown option ${extra.map((key) => JSON.stringify(key)).join(", ")}: a shared-tab action takes { context, observation, expect, dependsOn } besides its own options`,
    );
  }
  return { context_id: context, observation_id: observation, expect, depends_on: dependsOn };
}
