// Errors the Ego engine raises before or instead of a CDP answer.
import type { EgoCdpBindings, EgoCdpErrorOptions } from "./bindings.ts";

export function requireEgo<T extends EgoCdpBindings>(ego: T | undefined): T {
  if (!ego || typeof ego.sendCDPMessage !== "function") {
    throw new EgoCdpError(
      "ego_unavailable",
      "Ego Lite bindings are unavailable: run inside `ego-browser nodejs`, or pass { ego }",
    );
  }
  return ego;
}

export class EgoCdpError extends Error {
  declare code: string;
  declare method?: string;

  constructor(code: string, message: string, { method }: EgoCdpErrorOptions = {}) {
    super(message);
    this.name = "EgoCdpError";
    this.code = code;
    if (method) this.method = method;
  }
}
