/**
 * Strips a value being entered (fill/type) out of the error its failure raised, so a secret typed
 * into a form never reaches an agent transcript (#335). The layers below (a CDP transport, the
 * BrowserSkill daemon) may quote the command they refused, raw or JSON-escaped, in the message,
 * the stack, a `data` payload or a cause; each is rewritten in place down the cause chain.
 */
export function redactValue(error: unknown, value: string): unknown {
  if (value.length === 0) return error;
  const replacement = `<redacted, ${value.length} chars>`;
  // One pass over the raw and JSON-escaped forms, longest first, so inserted text is never rescanned; the
  // value matches only as a token, never inside a word (fill("a") must leave "locator" readable).
  const forms = [...new Set([value, JSON.stringify(value).slice(1, -1)])]
    .toSorted((left, right) => right.length - left.length)
    .map((form) => form.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])(?:${forms.join("|")})(?![\\p{L}\\p{N}])`, "gu");
  const scrub = (text: string) => text.replace(pattern, replacement);
  if (typeof error === "string") return scrub(error);
  const seen = new Set<Error>();
  for (let link: unknown = error; link instanceof Error && !seen.has(link); link = link.cause) {
    seen.add(link);
    link.message = scrub(link.message);
    if (link.stack !== undefined) link.stack = scrub(link.stack);
    const data: unknown = Reflect.get(link, "data");
    if (data !== undefined) Reflect.set(link, "data", JSON.parse(scrub(JSON.stringify(data) ?? "null")));
  }
  return error;
}
