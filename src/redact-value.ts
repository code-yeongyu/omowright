// A value this long or longer is removed wherever it appears; a shorter one only as a whole token.
const REMOVED_ANYWHERE_FROM_LENGTH = 4;

/**
 * Strips a value being entered (fill/type) out of the error its failure raised, so a secret typed
 * into a form never reaches an agent transcript (#335). The layers below (a CDP transport, the
 * BrowserSkill daemon) may quote the command they refused, raw or JSON-escaped, anywhere in what they
 * throw: the message, the stack, a cause of any type, an `AggregateError`'s members, or a field of
 * their own (`data`, `request`). Every own property of every error reachable from the one raised is
 * rewritten in place, so no list of known error shapes has to keep up with them (#362).
 * A value of four characters or more is removed even where it touches a letter or a digit
 * (`field7<value>`); a shorter one is removed only as a whole token, because taking one or two
 * letters out of every word would leave the message unreadable (fill("a") must keep "locator").
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
  const scrub = (text: string) => text.replace(pattern, replacement);
  // Anything that is not an Error: a string is scrubbed, a structure goes through its JSON text, and
  // what cannot be serialized (a cycle, a BigInt) is replaced outright rather than passed through.
  const scrubPayload = (payload: unknown): unknown => {
    if (typeof payload === "string") return scrub(payload);
    if (payload === undefined || payload === null) return payload;
    try {
      const text: unknown = JSON.stringify(payload);
      return typeof text === "string" ? JSON.parse(scrub(text)) : payload;
    } catch {
      return `<redacted, unreadable ${typeof payload}>`;
    }
  };

  const seen = new Set<Error>();
  // An Error keeps its identity (callers match on its class) and is rewritten in place; so is each
  // Error in a list, which is how an AggregateError holds its members.
  function scrubMember(member: unknown): unknown {
    if (member instanceof Error) {
      scrubError(member);
      return member;
    }
    if (Array.isArray(member)) {
      const items: readonly unknown[] = member;
      if (items.some((item) => item instanceof Error)) return items.map((item) => scrubMember(item));
    }
    return scrubPayload(member);
  }
  function scrubError(link: Error) {
    if (seen.has(link)) return;
    seen.add(link);
    link.message = scrub(link.message);
    if (link.stack !== undefined) link.stack = scrub(link.stack);
    for (const key of Reflect.ownKeys(link)) {
      if (key === "message" || key === "stack") continue;
      const descriptor = Reflect.getOwnPropertyDescriptor(link, key);
      if (descriptor === undefined || !("value" in descriptor)) continue;
      const scrubbed: unknown = scrubMember(descriptor.value);
      if (!Reflect.set(link, key, scrubbed)) Reflect.defineProperty(link, key, { ...descriptor, value: scrubbed });
    }
  }

  return scrubMember(error);
}
