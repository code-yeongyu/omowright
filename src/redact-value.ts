// A value this long or longer is removed wherever it appears; a shorter one only as a whole token.
const REMOVED_ANYWHERE_FROM_LENGTH = 4;

/**
 * Strips a value being entered (fill/type) out of the error its failure raised, so a secret typed
 * into a form never reaches an agent transcript (#335). The layers below (a CDP transport, the
 * BrowserSkill daemon) may quote the command they refused, raw or JSON-escaped, in the message,
 * the stack, a `data` payload or a cause of any type; each is rewritten in place down the cause chain.
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

  if (!(error instanceof Error)) return scrubPayload(error);
  const seen = new Set<Error>();
  for (let link: unknown = error; link instanceof Error && !seen.has(link); link = link.cause) {
    seen.add(link);
    link.message = scrub(link.message);
    if (link.stack !== undefined) link.stack = scrub(link.stack);
    const data: unknown = Reflect.get(link, "data");
    if (data !== undefined) Reflect.set(link, "data", scrubPayload(data));
    if (link.cause !== undefined && !(link.cause instanceof Error)) link.cause = scrubPayload(link.cause);
  }
  return error;
}
