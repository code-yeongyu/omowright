const REF_SHAPE = /^@?e\d+$/;

export interface TargetSpec {
  ref?: string;
  selector?: string;
  captureId?: string;
  x?: number;
  y?: number;
}
export type Target = string | TargetSpec;
export type ResolvedTarget =
  | { ref: string }
  | { selector: string }
  | { capture_id: string; image_x: unknown; image_y: unknown };

interface LooseTargetSpec {
  ref?: unknown;
  selector?: unknown;
  captureId?: unknown;
  x?: unknown;
  y?: unknown;
}

export function resolveTarget(target: unknown): ResolvedTarget {
  if (typeof target === "string") {
    return REF_SHAPE.test(target) ? { ref: target } : { selector: target };
  }
  if (target && typeof target === "object") {
    const spec: LooseTargetSpec = target;
    if (typeof spec.ref === "string") return { ref: spec.ref };
    if (typeof spec.selector === "string") return { selector: spec.selector };
    if (typeof spec.captureId === "string") {
      return { capture_id: spec.captureId, image_x: spec.x, image_y: spec.y };
    }
  }
  throw new TypeError("target must be a ref ('e3' / '@e3'), a CSS selector, or {captureId, x, y}");
}

export function optionalTarget(target: unknown): ResolvedTarget | Record<string, never> {
  return target === undefined ? {} : resolveTarget(target);
}

export function compact(params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) if (value !== undefined) out[key] = value;
  return out;
}
