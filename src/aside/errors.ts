import type { AsideOnboardReport } from "./onboard.ts";
import type { AsideReplErrorOptions } from "./session-types.ts";

export class AsideReplError extends Error {
  declare code: string;
  declare output: string[];
  declare setup?: AsideOnboardReport;

  constructor(code: string, message: string, { output = [], setup }: AsideReplErrorOptions = {}) {
    super(message);
    this.name = "AsideReplError";
    this.code = code;
    this.output = output;
    if (setup) this.setup = setup;
  }
}
