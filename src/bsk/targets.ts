const REF_SHAPE = /^@?e\d+$/;

export interface TargetSpec {
  ref?: string;
  selector?: string;
  captureId?: string;
  x?: number;
  y?: number;
}
export type Target = string | TargetSpec;
// Every tool but click addresses an element only; screenshot coordinates are click's alone.
export type ElementTargetInput = string | Pick<TargetSpec, "ref" | "selector">;
export type ElementTarget = { ref: string } | { selector: string };
export type ResolvedTarget = ElementTarget | { capture_id: string; image_x: number; image_y: number };

interface LooseTargetSpec {
  ref?: unknown;
  selector?: unknown;
  captureId?: unknown;
  x?: unknown;
  y?: unknown;
}

function elementTarget(target: unknown): ElementTarget | undefined {
  if (typeof target === "string") {
    return REF_SHAPE.test(target) ? { ref: target } : { selector: target };
  }
  if (target && typeof target === "object") {
    const spec: LooseTargetSpec = target;
    if (typeof spec.ref === "string") return { ref: spec.ref };
    if (typeof spec.selector === "string") return { selector: spec.selector };
  }
  return undefined;
}

export function resolveTarget(target: unknown): ResolvedTarget {
  const element = elementTarget(target);
  if (element) return element;
  if (target && typeof target === "object") {
    const spec: LooseTargetSpec = target;
    if (typeof spec.captureId === "string") {
      if (typeof spec.x !== "number" || typeof spec.y !== "number")
        throw new TypeError("a {captureId, x, y} target needs numeric x and y image coordinates");
      return { capture_id: spec.captureId, image_x: spec.x, image_y: spec.y };
    }
  }
  throw new TypeError("target must be a ref ('e3' / '@e3'), a CSS selector, or {captureId, x, y}");
}

export function resolveElementTarget(target: unknown): ElementTarget {
  const element = elementTarget(target);
  if (element) return element;
  throw new TypeError("target must be a ref ('e3' / '@e3') or a CSS selector");
}

export function optionalElementTarget(target: unknown): ElementTarget | Record<string, never> {
  return target === undefined ? {} : resolveElementTarget(target);
}

export function compact(params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) if (value !== undefined) out[key] = value;
  return out;
}
