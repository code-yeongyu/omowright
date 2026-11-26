// A value this long or longer is removed wherever it appears; a shorter one only as a whole token.
const REMOVED_ANYWHERE_FROM_LENGTH = 4;

type Scrub = (text: string) => string;

/**
 * Strips a value being entered (fill/type) out of the error its failure raised, so a secret typed
 * into a form never reaches an agent transcript (#335). The layers below (a CDP transport, the
 * BrowserSkill daemon) may quote the command they refused, raw or JSON-escaped, anywhere in what they
 * throw, so the whole graph of the error is read (#362, #366):
 *
 * - An error that does not carry the value is returned untouched.
 * - Every `Error` in the graph is rewritten in place and keeps its identity and class, wherever it sits:
 *   a cause, a member of an `AggregateError`, a field of a payload.
 * - Anything else that carries the value (a payload object, an array, a `Map`, a `Set`) is replaced by a
 *   scrubbed copy and never mutated: it may be an object the caller still uses, such as the command's
 *   own parameters. A part that does not carry the value stays the same object.
 * - An `Error` that cannot be rewritten (frozen, or holding a field that is neither writable nor
 *   configurable) is replaced by a scrubbed copy of the same class.
 *
 * Reached: own properties (an accessor is read once and, when it carries the value, replaced by the
 * scrubbed result), array elements, `Map` and `Set` entries, numbers whose digits contain the value.
 * Not reached: property names, private fields, what only a prototype accessor computes, binary buffers.
 *
 * A value of four characters or more is removed even where it touches a letter or a digit
 * (`field7<value>`); a shorter one is removed only as a whole token, because taking one or two
 * letters out of every word would leave the message unreadable (fill("a") must keep "locator").
 * That is a readability rule: a short value next to a letter or digit stays readable.
 */
export function redactValue(error: unknown, value: string): unknown {
  if (value.length === 0) return error;
  const replacement = `<redacted, ${value.length} chars>`;
  // One pass over the raw and JSON-escaped forms, longest first, so inserted text is never rescanned.
  const forms = [...new Set([value, JSON.stringify(value).slice(1, -1)])]
    .toSorted((left, right) => right.length - left.length)
    .map((form) => form.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const anyForm = `(?:${forms.join("|")})`;
  const pattern = new RegExp(
    value.length >= REMOVED_ANYWHERE_FROM_LENGTH ? anyForm : `(?<![\\p{L}\\p{N}])${anyForm}(?![\\p{L}\\p{N}])`,
    "gu",
  );
  const scrub: Scrub = (text) => text.replace(pattern, replacement);
  return carries(error, scrub) ? scrubbed(error, scrub, replacement) : error;
}

// Objects that hold no text of their own and break when copied property by property.
function isOpaque(member: object) {
  return (
    ArrayBuffer.isView(member) ||
    member instanceof ArrayBuffer ||
    member instanceof Date ||
    member instanceof RegExp ||
    member instanceof Promise ||
    member instanceof WeakMap ||
    member instanceof WeakSet
  );
}

// What an own property holds; an accessor is called, and one that throws counts as unreadable.
function ownValue(holder: object, key: string | symbol): { readable: boolean; value?: unknown } {
  const descriptor = Reflect.getOwnPropertyDescriptor(holder, key);
  if (descriptor === undefined) return { readable: false };
  if ("value" in descriptor) return { readable: true, value: descriptor.value };
  try {
    return { readable: true, value: descriptor.get?.call(holder) };
  } catch {
    return { readable: false };
  }
}

function ownEntries(holder: object): Array<[key: string | symbol, value: unknown]> {
  const entries: Array<[string | symbol, unknown]> = [];
  for (const key of Reflect.ownKeys(holder)) {
    if (Array.isArray(holder) && key === "length") continue;
    const own = ownValue(holder, key);
    if (own.readable) entries.push([key, own.value]);
  }
  return entries;
}

function carries(root: unknown, scrub: Scrub): boolean {
  const seen = new Set<object>();
  const visit = (member: unknown): boolean => {
    if (typeof member === "string") return scrub(member) !== member;
    if (typeof member === "number" || typeof member === "bigint") return scrub(String(member)) !== String(member);
    if (typeof member !== "object" || member === null || seen.has(member) || isOpaque(member)) return false;
    seen.add(member);
    if (member instanceof Map && [...member].some(([key, entry]) => visit(key) || visit(entry))) return true;
    if (member instanceof Set && [...member].some((entry) => visit(entry))) return true;
    return ownEntries(member).some(([, entry]) => visit(entry));
  };
  return visit(root);
}

// An Error whose every own property can be redefined; any other is replaced by a copy.
function rewritable(error: Error) {
  if (Object.isFrozen(error)) return false;
  return Reflect.ownKeys(error).every((key) => {
    const descriptor = Reflect.getOwnPropertyDescriptor(error, key);
    return descriptor === undefined || descriptor.configurable === true || descriptor.writable === true;
  });
}

function emptyLike(member: object): object {
  if (Array.isArray(member)) return [];
  if (member instanceof Map) return new Map();
  if (member instanceof Set) return new Set();
  return Object.create(Reflect.getPrototypeOf(member));
}

function scrubbed(root: unknown, scrub: Scrub, replacement: string): unknown {
  const results = new Map<object, object>();
  const clean = (member: unknown): unknown => {
    if (typeof member === "string") return scrub(member);
    if (typeof member === "number" || typeof member === "bigint") {
      return scrub(String(member)) === String(member) ? member : replacement;
    }
    if (typeof member !== "object" || member === null || isOpaque(member)) return member;
    const known = results.get(member);
    if (known !== undefined) return known;
    const inPlace = member instanceof Error && rewritable(member);
    // A part that carries nothing keeps its identity; an Error is still walked, in place, for the Errors below it.
    if (!inPlace && !carries(member, scrub)) return member;
    const target = inPlace ? member : emptyLike(member);
    results.set(member, target);
    if (member instanceof Map && target instanceof Map)
      for (const [key, entry] of member) target.set(clean(key), clean(entry));
    if (member instanceof Set && target instanceof Set) for (const entry of member) target.add(clean(entry));
    for (const [key, entry] of ownEntries(member)) {
      const next = clean(entry);
      if (inPlace && Object.is(next, entry)) continue;
      const descriptor = Reflect.getOwnPropertyDescriptor(member, key);
      // A data field of an Error rewritten in place keeps its attributes; anything else becomes a plain data field.
      if (inPlace && descriptor !== undefined && "value" in descriptor)
        Reflect.defineProperty(target, key, { value: next });
      else {
        const enumerable = descriptor?.enumerable === true;
        Reflect.defineProperty(target, key, { value: next, writable: true, enumerable, configurable: true });
      }
    }
    return target;
  };
  return clean(root);
}
