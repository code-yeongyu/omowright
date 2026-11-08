/** `value[key]` for a value of unknown shape: null/undefined raise a TypeError, primitives read through their wrapper. */
export function readProperty(value: unknown, key: PropertyKey): unknown {
  if (value === null || value === undefined) {
    throw new TypeError(`Cannot read properties of ${value} (reading '${String(key)}')`);
  }
  return Reflect.get(new Object(value), key);
}
