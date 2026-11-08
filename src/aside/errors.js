export class AsideReplError extends Error {
  constructor(code, message, { output = [], setup } = {}) {
    super(message);
    this.name = "AsideReplError";
    this.code = code;
    this.output = output;
    if (setup) this.setup = setup;
  }
}
