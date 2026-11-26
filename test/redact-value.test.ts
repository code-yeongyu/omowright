import { test } from "node:test";
import assert from "node:assert/strict";
import { redactValue } from "../src/redact-value.ts";

const SECRET = "sk-redact-sentinel-352";

function everythingIn(error: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  for (let link: unknown = error; link !== undefined && link !== null && !seen.has(link);) {
    seen.add(link);
    if (link instanceof Error) {
      parts.push(link.message, String(link.stack), JSON.stringify(Reflect.get(link, "data") ?? null));
      link = link.cause;
    } else {
      parts.push(typeof link === "string" ? link : (JSON.stringify(link) ?? String(link)));
      break;
    }
  }
  return parts.join("\n");
}

function everyStringIn(root: unknown): string[] {
  const strings: string[] = [];
  const seen = new Set<unknown>();
  const visit = (value: unknown) => {
    if (typeof value === "string") strings.push(value);
    if (typeof value !== "object" || value === null || seen.has(value)) return;
    seen.add(value);
    for (const key of Reflect.ownKeys(value)) visit(Reflect.get(value, key));
  };
  visit(root);
  return strings;
}

// Security contract (#335, #362): the value is gone from every string reachable from the error, whatever
// subtype it is and whatever fields the layer that raised it added.
test("an aggregate error's members and any added field lose the value, and stay the same errors", () => {
  const member = new Error(`attempt 1 quoted ${SECRET}`);
  const aggregate = new AggregateError([member, `attempt 2: ${SECRET}`, { detail: SECRET }], "every attempt failed");
  const retried = new Error(`retry sent ${SECRET}`);
  const refused = Object.assign(new Error("fill failed", { cause: aggregate }), {
    request: { method: "tool.fill", params: { value: SECRET } },
    attempts: [retried],
    status: 422,
  });

  const error = redactValue(refused, SECRET);

  assert.deepEqual(
    everyStringIn(error).filter((text) => text.includes(SECRET)),
    [],
  );
  assert.equal(error, refused);
  assert.equal(aggregate.errors[0], member);
  assert.equal(member.message, "attempt 1 quoted <redacted, 22 chars>");
  assert.deepEqual(aggregate.errors.slice(1), ["attempt 2: <redacted, 22 chars>", { detail: "<redacted, 22 chars>" }]);
  assert.deepEqual(refused.request, { method: "tool.fill", params: { value: "<redacted, 22 chars>" } });
  assert.equal(refused.attempts[0], retried);
  assert.equal(retried.message, "retry sent <redacted, 22 chars>");
  assert.equal(refused.status, 422);
});

test("a cause that is not an Error loses the value too", () => {
  const stringCause = redactValue(new Error("field rejected", { cause: SECRET }), SECRET);
  assert.ok(stringCause instanceof Error);
  assert.equal(stringCause.cause, "<redacted, 22 chars>");

  const objectCause = redactValue(
    new Error("field rejected", { cause: { detail: `no field for ${SECRET}`, code: 7 } }),
    SECRET,
  );
  assert.ok(objectCause instanceof Error);
  assert.deepEqual(objectCause.cause, { detail: "no field for <redacted, 22 chars>", code: 7 });

  const nested = redactValue(new Error("outer", { cause: new Error("inner", { cause: `raw ${SECRET}` }) }), SECRET);
  assert.ok(!everythingIn(nested).includes(SECRET));
});

test("a cause that cannot be serialized is dropped, never passed through", () => {
  const circular: Record<string, unknown> = { detail: SECRET };
  circular["self"] = circular;

  const error = redactValue(new Error("field rejected", { cause: circular }), SECRET);

  assert.ok(error instanceof Error);
  assert.equal(typeof error.cause, "string");
  assert.ok(!String(error.cause).includes(SECRET));
});

test("a thrown value that is not an Error is scrubbed as well", () => {
  assert.deepEqual(redactValue({ reason: `bad ${SECRET}` }, SECRET), { reason: "bad <redacted, 22 chars>" });
});

test("a value of four characters or more is removed even against a letter or a digit", () => {
  const error = redactValue(new Error(`field7${SECRET}x refused, see log${SECRET}`), SECRET);

  assert.ok(error instanceof Error);
  assert.equal(error.message, "field7<redacted, 22 chars>x refused, see log<redacted, 22 chars>");
  assert.equal(redactValue("pin1234ok", "1234"), "pin<redacted, 4 chars>ok");
});

test("a value shorter than four characters is removed only as a whole token", () => {
  assert.equal(
    redactValue('locator("e3") would not accept "ab"', "ab"),
    'locator("e3") would not accept "<redacted, 2 chars>"',
  );
  assert.equal(redactValue("label table abc", "ab"), "label table abc");
});
