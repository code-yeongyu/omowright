export interface TreeNode {
  ref: string;
  tree: string;
}

interface IndexedTree {
  nodes: Map<string, TreeNode>;
  focused: string | null;
  unreferenced: string;
}

interface Baseline extends IndexedTree {
  document: unknown;
  contexts: string;
  scopeKey: string;
}

/** The frame registry a snapshot diff keys its baseline on; core's PageFrameManager satisfies it. */
export interface SnapshotFrames {
  readonly mainFrameId: string | null;
  getFrame(frameId: string | null): { readonly isolatedContextId?: number | null | undefined } | null | undefined;
  collectDescendantFrames(frameId: string | null): ReadonlyArray<{ readonly frameId: string }>;
}

/** The snapshot() options this module reads; anything else is scope and only keys the baseline. */
export interface SnapshotQuery {
  [option: string]: unknown;
  diff?: unknown;
  find?: unknown;
  context?: unknown;
}

/** A SnapshotQuery that passed validateSnapshotOptions. */
export interface ValidSnapshotQuery extends SnapshotQuery {
  find?: string | RegExp | undefined;
  context?: number | undefined;
}

export interface SnapshotText<Ref> {
  tree?: string | undefined;
  refs?: Readonly<Record<string, Ref>> | null | undefined;
}

// A value the surrounding logic guarantees (an open parent, an in-range line, a capture group the pattern always
// fills, the baseline every early return without one has already left on).
function defined<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new RangeError(`${what} is missing`);
  return value;
}

const isInteger = (value: unknown): value is number => Number.isInteger(value);

const baselines = new WeakMap<SnapshotFrames, Baseline>();
const REF_LINE = /^(\s*)- [^\s"]+(?: "(?:\\.|[^"\\])*")? \[ref=((?:f\d+)?e\d+)\]/;

// Compare the final, frame-inlined tree so values, selected options and text children use
// exactly the same escaping and password redaction as a full snapshot.
function indexTree(tree: string): IndexedTree {
  const nodes = new Map<string, TreeNode>();
  const unreferenced: string[] = [];
  const parents: { depth: number; node: TreeNode }[] = [];
  let focused: string | null = null;
  for (const line of tree.split("\n")) {
    if (!line) continue;
    const depth = line.search(/\S/);
    while (parents.length && defined(parents.at(-1), "open parent").depth >= depth) parents.pop();
    const match = REF_LINE.exec(line);
    if (match) {
      const ref = defined(match[2], "ref group");
      const node = { ref, tree: line.trim().slice(2) };
      nodes.set(ref, node);
      parents.push({ depth, node });
      // Strip the quoted name before looking at state, not user-supplied name text.
      const state: readonly string[] = line.slice(match[0].length).match(/"(?:\\.|[^"\\])*"|\[focused\]/g) ?? [];
      if (state.includes("[focused]")) focused = ref;
    } else if (parents.length) {
      defined(parents.at(-1), "open parent").node.tree += ` | ${line.trim().slice(2)}`;
    } else if (!/^\s*- [\w-]+:?$/.test(line)) {
      unreferenced.push(line);
    }
  }
  return { nodes, focused, unreferenced: unreferenced.join("\n") };
}

const REF_ATTR = /\[ref=((?:f\d+)?e\d+)\]/g;
const QUOTED = /"(?:\\.|[^"\\])*"/g;

// Called by page.snapshot() before the in-page capture, so a bad call costs no capture.
export function validateSnapshotOptions(options: SnapshotQuery): asserts options is ValidSnapshotQuery {
  const { diff, find, context } = options;
  if (find === undefined) {
    if (context !== undefined) throw new TypeError("snapshot({ context }) needs find");
    return;
  }
  if (diff === true) throw new TypeError("snapshot() accepts diff or find, not both");
  if (!(find instanceof RegExp) && (typeof find !== "string" || find === "")) {
    throw new TypeError("snapshot({ find }) needs a non-empty string or a RegExp");
  }
  if (context !== undefined && (!isInteger(context) || context < 0 || context > 10)) {
    throw new TypeError("snapshot({ context }) must be an integer from 0 to 10");
  }
}

export function findSnapshotLines<Ref>(snapshot: SnapshotText<Ref>, find: string | RegExp, context = 2) {
  // Matching is per line: g and y would carry lastIndex between lines or pin a match to
  // column 0, so drop them on a private copy and leave the caller's RegExp untouched.
  const query =
    find instanceof RegExp
      ? { pattern: new RegExp(find.source, find.flags.replace(/[gy]/g, "")), needle: null }
      : { pattern: null, needle: find.toLowerCase() };
  const lines = snapshot.tree ? snapshot.tree.split("\n") : [];
  const matched: number[] = [];
  lines.forEach((line, index) => {
    if (query.pattern ? query.pattern.test(line) : line.toLowerCase().includes(query.needle)) matched.push(index);
  });
  const included = new Set<number>();
  for (const index of matched) {
    for (let i = Math.max(0, index - context); i <= Math.min(lines.length - 1, index + context); i++) included.add(i);
  }
  const out: string[] = [];
  let previous = -1;
  for (const index of [...included].toSorted((a, b) => a - b)) {
    if (out.length && index > previous + 1) out.push("...");
    out.push(defined(lines[index], "line"));
    previous = index;
  }
  const tree = out.join("\n");
  const refs: Record<string, Ref> = {};
  // An accessible name can contain "[ref=e9]" as text; only the line's own ref attribute counts.
  for (const match of tree.replace(QUOTED, "").matchAll(REF_ATTR)) {
    const ref = defined(match[1], "ref group");
    const value = snapshot.refs?.[ref];
    if (value) refs[ref] = value;
  }
  return { tree, refs, find: { query: String(find), matches: matched.length } };
}

export function snapshotResult<Ref>(
  frameManager: SnapshotFrames,
  options: ValidSnapshotQuery,
  snapshot: SnapshotText<Ref> & { tree: string },
) {
  const { diff, find, context, ...scope } = options;
  // A search is a partial read: leave the diff baseline at the last full or diff read.
  if (find !== undefined) return findSnapshotLines(snapshot, find, context);
  const document = frameManager.getFrame(frameManager.mainFrameId);
  const contexts = JSON.stringify(
    frameManager
      .collectDescendantFrames(frameManager.mainFrameId)
      .map(({ frameId }) => [frameId, frameManager.getFrame(frameId)?.isolatedContextId]),
  );
  const scopeKey = JSON.stringify(scope);
  const current = indexTree(snapshot.tree);
  const previous = baselines.get(frameManager);
  // Store private, derived data, not the caller-mutable refs map or returned delta entries.
  baselines.set(frameManager, { ...current, document, contexts, scopeKey });
  if (diff !== true) return snapshot;
  let reason: string | undefined;
  if (!previous) reason = "no-baseline";
  else if (previous.document !== document || previous.contexts !== contexts) reason = "navigation";
  else if (previous.scopeKey !== scopeKey) reason = "options-changed";
  else if (previous.unreferenced !== current.unreferenced) reason = "unreferenced-content";
  if (reason) return { ...snapshot, full: true, reason };
  const before = defined(previous, "baseline");

  const added: TreeNode[] = [];
  const changed: TreeNode[] = [];
  const removed: string[] = [];
  for (const [ref, node] of current.nodes) {
    const old = before.nodes.get(ref);
    if (!old) added.push({ ...node });
    else if (old.tree !== node.tree) {
      // A stable ref already identifies the role and name. Do not resend its unchanged
      // label or placeholder on every keystroke; the remaining text is current state/value.
      const label = /^[^\s"]+(?: "(?:\\.|[^"\\])*")? /;
      let tree = node.tree;
      const heading = label.exec(tree)?.[0];
      if (heading && heading === label.exec(old.tree)?.[0]) tree = tree.slice(heading.length);
      const placeholder = / \[placeholder="(?:\\.|[^"\\])*"\]/.exec(tree)?.[0];
      if (placeholder && old.tree.includes(placeholder)) tree = tree.replace(placeholder, "");
      changed.push({ ref, tree });
    }
  }
  for (const ref of before.nodes.keys()) if (!current.nodes.has(ref)) removed.push(ref);
  const result = { diff: { added, changed, removed, focused: current.focused }, full: false };
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > Buffer.byteLength(snapshot.tree, "utf8")) {
    return { ...snapshot, full: true, reason: "diff-larger-than-full" };
  }
  return result;
}
