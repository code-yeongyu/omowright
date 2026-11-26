// A value this long or longer is removed wherever it appears; a shorter one only as a whole token.
const REMOVED_ANYWHERE_FROM_LENGTH = 4;

type Scrub = (text: string) => string;
type Entries = ReadonlyArray<readonly [key: string | symbol, value: unknown]>;
type EntriesOf = (holder: object) => Entries;

/**
 * Strips a value being entered (fill/type) out of the error its failure raised, so a secret typed
 * into a form does not reach an agent transcript through that error (#335). The layers below (a CDP
 * transport, the BrowserSkill daemon) may quote the command they refused, raw or JSON-escaped, anywhere
 * in what they throw, so the graph of the error is read (#362, #366, #369).
 *
 * What comes back:
 * - An error that does not carry the value is returned as it is; nothing in its graph is written.
 * - An `Error` that carries the value and can be rewritten is rewritten in place, so it keeps its
 *   identity and class wherever it sits: a cause, a member of an `AggregateError`, a field of a payload.
 * - An `Error` that cannot be rewritten (frozen, or holding a field that is neither writable nor
 *   configurable) is replaced by a scrubbed copy: a native error with the same prototype, so it is an
 *   instance of the same classes, but a different object.
 * - Anything else that carries the value (a payload object, an array, a `Map`, a `Set`) is replaced by a
 *   scrubbed copy with the same prototype and is never mutated: it may be an object the caller still
 *   uses, such as the command's own parameters. A boxed string becomes a scrubbed string. A part that
 *   does not carry the value stays the same object.
 * - An error that cannot be read at all (a `Proxy` whose traps throw) is replaced by a plain error that
 *   says so: what cannot be read cannot be shown to be clean.
 *
 * Reached: strings; numbers and bigints whose digits contain the value; own properties, string- and
 * symbol-keyed, enumerable or not; array elements; `Map` and `Set` entries. Each own accessor is called
 * once per call: one that returns the value becomes a data property holding the scrubbed result, and one
 * that throws is kept as it is, on a copy too.
 * Not reached: property names; symbols and functions; private fields; what only a prototype accessor or
 * a method computes (the text of a `URL`, `Headers` or `Request`); and objects returned as they are, own
 * properties included: binary buffers, `Date`, `RegExp`, `Promise`, `WeakMap`, `WeakSet`. A copy stands
 * in for a `Proxy` or an exotic object only as far as its prototype and own properties go.
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
  // Both passes read an object's properties through this, so an accessor runs once per call.
  const read = new Map<object, Entries>();
  const entriesOf: EntriesOf = (holder) => {
    const known = read.get(holder);
    if (known !== undefined) return known;
    const entries = ownEntries(holder);
    read.set(holder, entries);
    return entries;
  };
  try {
    return carries(error, scrub, entriesOf) ? scrubbed(error, scrub, replacement, entriesOf) : error;
  } catch {
    return new Error("omowright: the error a failed fill raised could not be read for redaction, so it is withheld");
  }
}

// The text of a boxed string; anything else as it is. Asking the string's own valueOf runs no code of the
// object's (a class check or a tag lookup could), and it refuses everything that is not a boxed string.
function unboxed(member: unknown) {
  if (typeof member !== "object" || member === null) return member;
  try {
    return String.prototype.valueOf.call(member);
  } catch {
    return member;
  }
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

function ownEntries(holder: object): Entries {
  const entries: Array<readonly [string | symbol, unknown]> = [];
  for (const key of Reflect.ownKeys(holder)) {
    if (Array.isArray(holder) && key === "length") continue;
    const own = ownValue(holder, key);
    if (own.readable) entries.push([key, own.value]);
  }
  return entries;
}

function carries(root: unknown, scrub: Scrub, entriesOf: EntriesOf): boolean {
  const seen = new Set<object>();
  const visit = (boxed: unknown): boolean => {
    const member = unboxed(boxed);
    if (typeof member === "string") return scrub(member) !== member;
    if (typeof member === "number" || typeof member === "bigint") return scrub(String(member)) !== String(member);
    if (typeof member !== "object" || member === null || seen.has(member) || isOpaque(member)) return false;
    seen.add(member);
    if (member instanceof Map && [...member].some(([key, entry]) => visit(key) || visit(entry))) return true;
    if (member instanceof Set && [...member].some((entry) => visit(entry))) return true;
    return entriesOf(member).some(([, entry]) => visit(entry));
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

// An empty object of the same kind and prototype, to receive the scrubbed properties.
function emptyLike(member: object): object {
  const prototype = Reflect.getPrototypeOf(member);
  let copy: object;
  if (Array.isArray(member)) {
    const list: unknown[] = [];
    list.length = member.length;
    copy = list;
  } else if (member instanceof Error) {
    // A native error (Error.isError, "[object Error]"), stripped of what its own creation recorded.
    copy = new Error();
    for (const key of Reflect.ownKeys(copy)) Reflect.deleteProperty(copy, key);
  } else if (member instanceof Map) copy = new Map();
  else if (member instanceof Set) copy = new Set();
  else return Object.create(prototype);
  Reflect.setPrototypeOf(copy, prototype);
  return copy;
}

function scrubbed(root: unknown, scrub: Scrub, replacement: string, entriesOf: EntriesOf): unknown {
  const results = new Map<object, object>();
  const clean = (boxed: unknown): unknown => {
    const member = unboxed(boxed);
    if (typeof member === "string") return scrub(member) === member ? boxed : scrub(member);
    if (typeof member === "number" || typeof member === "bigint") {
      return scrub(String(member)) === String(member) ? member : replacement;
    }
    if (typeof member !== "object" || member === null || isOpaque(member)) return member;
    const known = results.get(member);
    if (known !== undefined) return known;
    const inPlace = member instanceof Error && rewritable(member);
    // A part that carries nothing keeps its identity; an Error is still walked, in place, for the Errors below it.
    if (!inPlace && !carries(member, scrub, entriesOf)) return member;
    const target = inPlace ? member : emptyLike(member);
    results.set(member, target);
    if (member instanceof Map && target instanceof Map)
      for (const [key, entry] of member) target.set(clean(key), clean(entry));
    if (member instanceof Set && target instanceof Set) for (const entry of member) target.add(clean(entry));
    for (const [key, entry] of entriesOf(member)) {
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
    if (inPlace) return target;
    // What could not be read (an accessor that throws) moves to the copy as it is.
    for (const key of Reflect.ownKeys(member)) {
      const descriptor = Reflect.getOwnPropertyDescriptor(member, key);
      const copied = Reflect.getOwnPropertyDescriptor(target, key) !== undefined;
      if (descriptor !== undefined && !copied) Reflect.defineProperty(target, key, descriptor);
    }
    return target;
  };
  return clean(root);
}
