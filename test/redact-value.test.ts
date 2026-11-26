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

// A structure JSON cannot serialize (a cycle) is scrubbed like any other: as a copy with the same shape, so
// the original, which the caller may still hold, is not rewritten (#366).
test("a cause with a cycle is scrubbed as a copy that keeps its shape", () => {
  const circular: Record<string, unknown> = { detail: SECRET };
  circular["self"] = circular;

  const error = redactValue(new Error("field rejected", { cause: circular }), SECRET);

  assert.ok(error instanceof Error);
  const cause = error.cause;
  assert.ok(typeof cause === "object" && cause !== null);
  assert.equal(Reflect.get(cause, "detail"), "<redacted, 22 chars>");
  assert.equal(Reflect.get(cause, "self"), cause);
  assert.equal(circular["detail"], SECRET);
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

// Contract (#366): what does not carry the value is not touched at all.
test("an error that does not carry the value comes back untouched, nested errors included", () => {
  const member = new RangeError("no detail");
  const payload = { child: member, list: [[member]] };
  const refused = Object.assign(new TypeError("fill failed"), { payload });

  const error = redactValue(refused, SECRET);

  assert.equal(error, refused);
  assert.equal(refused.payload, payload);
  assert.equal(payload.child, member);
  assert.ok(payload.list[0]?.[0] instanceof RangeError);
});

// Contract (#366): an Error keeps its identity and class wherever it sits; the data around it is copied,
// because it may be an object the caller still uses (the command's own parameters).
test("an Error inside a payload keeps its identity and class; the payload is copied, not rewritten", () => {
  const member = new RangeError(`out of range for ${SECRET}`);
  const params = { value: SECRET, nested: [[member]], child: member };
  const refused = Object.assign(new TypeError("fill failed"), { payload: params });

  const error = redactValue(refused, SECRET);

  assert.equal(error, refused);
  assert.deepEqual(
    everyStringIn(error).filter((text) => text.includes(SECRET)),
    [],
  );
  assert.notEqual(refused.payload, params);
  assert.equal(refused.payload.child, member);
  assert.equal(refused.payload.nested[0]?.[0], member);
  assert.ok(member instanceof RangeError);
  assert.equal(member.message, "out of range for <redacted, 22 chars>");
  assert.equal(params.value, SECRET);
});

test("an Error that cannot be rewritten is replaced by a scrubbed copy of the same class", () => {
  const frozen = Object.freeze(new RangeError(`frozen ${SECRET}`));
  const pinned = new TypeError("pinned");
  Object.defineProperty(pinned, "detail", { value: `pinned ${SECRET}`, writable: false, configurable: false });

  const fromFrozen = redactValue(frozen, SECRET);
  const fromPinned = redactValue(new Error("outer", { cause: pinned }), SECRET);

  assert.notEqual(fromFrozen, frozen);
  assert.ok(fromFrozen instanceof RangeError);
  assert.equal(fromFrozen.message, "frozen <redacted, 22 chars>");
  assert.ok(fromPinned instanceof Error);
  assert.ok(fromPinned.cause instanceof TypeError);
  assert.notEqual(fromPinned.cause, pinned);
  assert.deepEqual(
    [...everyStringIn(fromFrozen), ...everyStringIn(fromPinned)].filter((text) => text.includes(SECRET)),
    [],
  );
});

test("an accessor, a Map and a Set that carry the value are scrubbed", () => {
  const refused = Object.assign(new Error("fill failed"), {
    headers: new Map([["x-echo", SECRET]]),
    seen: new Set([SECRET, "plain"]),
    bytes: new Uint8Array([1, 2, 3]),
  });
  Object.defineProperty(refused, "echo", { get: () => `sent ${SECRET}`, enumerable: true, configurable: true });

  const error = redactValue(refused, SECRET);

  assert.equal(error, refused);
  assert.equal(Reflect.get(refused, "echo"), "sent <redacted, 22 chars>");
  assert.deepEqual([...refused.headers], [["x-echo", "<redacted, 22 chars>"]]);
  assert.deepEqual([...refused.seen], ["<redacted, 22 chars>", "plain"]);
  assert.ok(refused.bytes instanceof Uint8Array);
});
