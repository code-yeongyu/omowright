import { types } from "node:util";

// A value of this many code points or more is removed wherever it appears; a shorter one only as a whole token.
const REMOVED_ANYWHERE_FROM_LENGTH = 4;

type Scrub = (text: string) => string;
type Entries = ReadonlyArray<readonly [key: string | symbol, value: unknown]>;
type EntriesOf = (holder: object) => Entries;

/**
 * Strips a value being entered (fill/type) out of the error its failure raised, so a secret typed
 * into a form does not reach an agent transcript through that error (#335). The layers below (a CDP
 * transport, the BrowserSkill daemon) may quote the command they refused, raw or JSON-escaped, anywhere
 * in what they throw, so the graph of the error is read. This is a best-effort scrub of ordinary error
 * shapes, pinned by the cases in test/redact-value.test.ts; it is not a guarantee about every
 * JavaScript object.
 *
 * What comes back:
 * - An error in which the value is not found is returned as it is; the redaction writes nothing to it.
 * - An error in which the value is found (a native error of this realm or another, or an object that
 *   inherits from this realm's `Error`) is rewritten in place when it can be, so it keeps its identity and class
 *   wherever it sits: a cause, a member of an `AggregateError`, a field of a payload.
 * - One that cannot be rewritten (frozen, or holding a field that is neither writable nor
 *   configurable) is replaced by a scrubbed copy: a new native error with the same prototype.
 * - Anything else in which the value is found (a payload object, an array, a `Map`, a `Set`) is
 *   replaced by a scrubbed copy with the same prototype and is not written to: it may be an object the
 *   caller still uses, such as the command's own parameters. A boxed string, number or bigint is read
 *   as the value it holds and, when the value is found in it, becomes the scrubbed value.
 *   A part in which the value is not found stays the same object.
 * - When reading the error throws (a `Proxy` whose traps throw), a plain error that says so is
 *   returned instead: what cannot be read cannot be shown to be clean.
 *
 * Read: strings; numbers and bigints whose digits contain the value; own properties, string- and
 * symbol-keyed, enumerable or not; array elements; `Map` and `Set` entries. The redaction reads an
 * object's own property at most once per call, because an accessor can have effects; the engine may
 * call an error's `name` and `message` accessors again itself when `stack` is first read. An accessor
 * that returns the value becomes a data property holding the scrubbed result, and one that throws is
 * kept as it is, on a copy too.
 * Not read: property names; symbols and functions; private fields; the own properties of a boxed
 * string, number or bigint;
 * what only a prototype accessor or a method computes (the text of a `URL`, `Headers` or `Request`);
 * and these objects, which are returned as they are with their own properties: `ArrayBuffer`,
 * `SharedArrayBuffer` and their views, `Date`, `RegExp`, `Promise`, `WeakMap`, `WeakSet`. A copy
 * stands in for a `Proxy` or another exotic object only as far as its prototype and own properties go.
 *
 * A value of four or more code points is removed even where it touches a letter or a digit
 * (`field7<value>`); a shorter one is removed only as a whole token, because taking one or two
 * letters out of every word would leave the message unreadable (fill("a") must keep "locator").
 * That is a readability rule: a short value next to a letter or digit stays readable. The count in
 * `<redacted, N chars>` is the value's length in code points.
 */
export function redactValue(error: unknown, value: string): unknown {
  if (value.length === 0) return error;
  const codePoints = [...value].length;
  const replacement = `<redacted, ${codePoints} chars>`;
  // One pass over the raw and JSON-escaped forms, longest first, so inserted text is never rescanned.
  const forms = [...new Set([value, JSON.stringify(value).slice(1, -1)])]
    .toSorted((left, right) => right.length - left.length)
    .map((form) => form.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const anyForm = `(?:${forms.join("|")})`;
  const pattern = new RegExp(
    codePoints >= REMOVED_ANYWHERE_FROM_LENGTH ? anyForm : `(?<![\\p{L}\\p{N}])${anyForm}(?![\\p{L}\\p{N}])`,
    "gu",
  );
  const scrub: Scrub = (text) => text.replace(pattern, replacement);
  // Both passes read an object's properties through this, so the redaction calls an accessor once.
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

// The checks below ask the engine what an object is, so they hold for objects of another realm and run
// none of the object's own code (`instanceof` does neither).

function isError(member: unknown): member is Error {
  return types.isNativeError(member) || member instanceof Error;
}

// What a boxed string, number or bigint holds; anything else as it is.
function unboxed(member: unknown) {
  if (types.isStringObject(member)) return String.prototype.valueOf.call(member);
  if (types.isNumberObject(member)) return Number.prototype.valueOf.call(member);
  return types.isBigIntObject(member) ? BigInt.prototype.valueOf.call(member) : member;
}

// A Map's or Set's contents through the built-in methods: a subclass may override its own.
function mapEntries(map: Map<unknown, unknown>) {
  return [...Map.prototype.entries.call(map)];
}
function setValues(set: Set<unknown>) {
  return [...Set.prototype.values.call(set)];
}

// Objects that hold no text of their own and break when copied property by property.
function isOpaque(member: object) {
  return (
    ArrayBuffer.isView(member) ||
    types.isAnyArrayBuffer(member) ||
    types.isDate(member) ||
    types.isRegExp(member) ||
    types.isPromise(member) ||
    types.isWeakMap(member) ||
    types.isWeakSet(member)
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
    if (types.isMap(member) && mapEntries(member).some(([key, entry]) => visit(key) || visit(entry))) return true;
    if (types.isSet(member) && setValues(member).some((entry) => visit(entry))) return true;
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
  } else if (isError(member)) {
    // A native error (Error.isError, "[object Error]"), stripped of what its own creation recorded.
    copy = new Error();
    for (const key of Reflect.ownKeys(copy)) Reflect.deleteProperty(copy, key);
  } else if (types.isMap(member)) copy = new Map();
  else if (types.isSet(member)) copy = new Set();
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
      return scrub(String(member)) === String(member) ? boxed : replacement;
    }
    if (typeof member !== "object" || member === null || isOpaque(member)) return member;
    const known = results.get(member);
    if (known !== undefined) return known;
    const inPlace = isError(member) && rewritable(member);
    // A part that carries nothing keeps its identity; an Error is still walked, in place, for the Errors below it.
    if (!inPlace && !carries(member, scrub, entriesOf)) return member;
    const target = inPlace ? member : emptyLike(member);
    results.set(member, target);
    if (types.isMap(member) && types.isMap(target)) {
      for (const [key, entry] of mapEntries(member)) Map.prototype.set.call(target, clean(key), clean(entry));
    }
    if (types.isSet(member) && types.isSet(target)) {
      for (const entry of setValues(member)) Set.prototype.add.call(target, clean(entry));
    }
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
