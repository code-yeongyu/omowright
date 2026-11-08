// `value[key]` for a value whose shape a test does not own (a rejection, a reply): objects and
// functions read the property, anything else reads as undefined.
export function field(value: unknown, key: string): unknown {
  return (typeof value === "object" && value !== null) || typeof value === "function"
    ? Reflect.get(value, key)
    : undefined;
}
