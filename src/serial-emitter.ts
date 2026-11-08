// Event emitter for the pipe transport: listeners run one after another, in
// registration order, and emit() resolves once the last one has settled.
export class SerialEmitter<Data> {
  #listeners = new Map<string, Array<(data: Data) => unknown>>();
  on(event: string, fn: (data: Data) => unknown) {
    const list = this.#listeners.get(event) ?? [];
    list.push(fn);
    this.#listeners.set(event, list);
    return () => {
      const cur = this.#listeners.get(event) ?? [];
      this.#listeners.set(event, cur.filter(f => f !== fn));
    };
  }
  async emit(event: string, data: Data) {
    for (const fn of this.#listeners.get(event) ?? []) await fn(data);
  }
}
