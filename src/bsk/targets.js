const REF_SHAPE = /^@?e\d+$/;

export function resolveTarget(target) {
  if (typeof target === "string") {
    return REF_SHAPE.test(target) ? { ref: target } : { selector: target };
  }
  if (target && typeof target === "object") {
    if (typeof target.ref === "string") return { ref: target.ref };
    if (typeof target.selector === "string") return { selector: target.selector };
    if (typeof target.captureId === "string") {
      return { capture_id: target.captureId, image_x: target.x, image_y: target.y };
    }
  }
  throw new TypeError("target must be a ref ('e3' / '@e3'), a CSS selector, or {captureId, x, y}");
}

export function optionalTarget(target) {
  return target === undefined ? {} : resolveTarget(target);
}

export function compact(params) {
  const out = {};
  for (const [key, value] of Object.entries(params)) if (value !== undefined) out[key] = value;
  return out;
}
