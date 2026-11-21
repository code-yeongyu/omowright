import { expect, test } from "bun:test";
import { pushedBranchCommits, pushRefusal } from "./pre-push.ts";

// Hook contract: the checks read the working tree, so the hook judges a push only when it sends HEAD from a clean tree.
// A regression that drops the refusal would pass a push whose commit was never checked.
const HEAD = "a".repeat(40);
const OTHER = "b".repeat(40);
const ZERO = "0".repeat(40);

test("a push judges the commits it sends to branches; tags and deletions are not judged", () => {
  const stdin = [
    `refs/heads/x ${HEAD} refs/heads/x ${OTHER}`,
    `refs/tags/v1 ${OTHER} refs/tags/v1 ${ZERO}`,
    `(delete) ${ZERO} refs/heads/gone ${OTHER}`,
  ].join("\n");
  expect(pushedBranchCommits(stdin)).toEqual([HEAD]);
  expect(pushedBranchCommits("")).toEqual([]);
});

test("HEAD from a clean tree is judged; another commit or a dirty tree is refused", () => {
  expect(pushRefusal([HEAD], HEAD, false)).toBeUndefined();
  expect(pushRefusal([OTHER], HEAD, false)).toContain("not HEAD");
  expect(pushRefusal([HEAD], HEAD, true)).toContain("uncommitted");
  expect(pushRefusal([], HEAD, true)).toBeUndefined();
});
