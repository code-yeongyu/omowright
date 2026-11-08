import { readProperty } from "../read-property.ts";

export function optionalProperty(value: unknown, key: string): unknown {
  return value === null || value === undefined ? undefined : readProperty(value, key);
}

/** `value ?? []` for a field that must be a list; any other shape is a protocol fault, not an empty list. */
export function listOrEmpty(value: unknown, what: string): unknown[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError(`${what} is not a list`);
  const list: unknown[] = value;
  return list;
}
