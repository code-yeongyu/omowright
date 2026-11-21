// The pre-push hook (.husky/pre-push; husky activates it on `bun install`) runs `bun run check:push` before a push
// leaves the machine. CI's test job runs that same script as its first gate, so the hook and CI cannot drift: a check
// added to `check:push` is checked in both places. The test suites stay with CI; they take minutes, not seconds.
//
// The checks read the working tree, so they only judge what is pushed when the push sends HEAD from a clean tree.
// Any other push (another branch's commit, uncommitted edits) is refused with the reason instead of checking the
// wrong tree. Tags and branch deletions carry no tree to check and pass.
const ZERO = /^0{40}$/;

// Branch commits a push sends, from git's pre-push stdin: `<local ref> <local sha> <remote ref> <remote sha>` per line.
export function pushedBranchCommits(stdin: string): string[] {
  const commits: string[] = [];
  for (const line of stdin.split("\n")) {
    const [localRef, localSha, remoteRef] = line.trim().split(/\s+/);
    if (localSha === undefined || remoteRef === undefined || ZERO.test(localSha)) continue;
    if (remoteRef.startsWith("refs/heads/") && localRef !== undefined) commits.push(localSha);
  }
  return commits;
}

export function pushRefusal(commits: readonly string[], head: string, dirty: boolean): string | undefined {
  const other = commits.find((commit) => commit !== head);
  if (other !== undefined)
    return `pre-push: the push sends ${other.slice(0, 10)}, which is not HEAD (${head.slice(0, 10)}); the checks read the working tree, so check out what you push and push again`;
  if (commits.length > 0 && dirty)
    return "pre-push: the working tree has uncommitted changes, so the checks would not judge the pushed commit; commit or stash them and push again";
  return undefined;
}

const git = async (...args: string[]) => (await Bun.$`git ${args}`.quiet().text()).trim();

if (import.meta.main) {
  const commits = pushedBranchCommits(await Bun.stdin.text());
  if (commits.length > 0) {
    const refusal = pushRefusal(commits, await git("rev-parse", "HEAD"), (await git("status", "--porcelain")) !== "");
    if (refusal !== undefined) {
      console.error(refusal);
      process.exit(1);
    }
    const checked = Bun.spawn(["bun", "run", "check:push"], { stdio: ["ignore", "inherit", "inherit"] });
    const code = await checked.exited;
    if (code !== 0) {
      console.error("pre-push: `bun run check:push` failed (the same gate CI runs first); fix it and push again");
      process.exit(code);
    }
  }
}
