const baselines = new WeakMap();
const REF_LINE = /^(\s*)- [^\s"]+(?: "(?:\\.|[^"\\])*")? \[ref=((?:f\d+)?e\d+)\]/;

// Compare the final, frame-inlined tree so values, selected options and text children use
// exactly the same escaping and password redaction as a full snapshot.
function indexTree(tree) {
  const nodes = new Map();
  const unreferenced = [];
  const parents = [];
  let focused = null;
  for (const line of tree.split("\n")) {
    if (!line) continue;
    const depth = line.search(/\S/);
    while (parents.length && parents.at(-1).depth >= depth) parents.pop();
    const match = REF_LINE.exec(line);
    if (match) {
      const ref = match[2];
      const node = { ref, tree: line.trim().slice(2) };
      nodes.set(ref, node);
      parents.push({ depth, node });
      // Strip the quoted name before looking at state, not user-supplied name text.
      const state = line.slice(match[0].length).match(/"(?:\\.|[^"\\])*"|\[focused\]/g) ?? [];
      if (state.includes("[focused]")) focused = ref;
    } else if (parents.length) {
      parents.at(-1).node.tree += ` | ${line.trim().slice(2)}`;
    } else if (!/^\s*- [\w-]+:?$/.test(line)) {
      unreferenced.push(line);
    }
  }
  return { nodes, focused, unreferenced: unreferenced.join("\n") };
}

const REF_ATTR = /\[ref=((?:f\d+)?e\d+)\]/g;
const QUOTED = /"(?:\\.|[^"\\])*"/g;

// Called by page.snapshot() before the in-page capture, so a bad call costs no capture.
export function validateSnapshotOptions(options) {
  const { diff, find, context } = options;
  if (find === undefined) {
    if (context !== undefined) throw new TypeError("snapshot({ context }) needs find");
    return;
  }
  if (diff === true) throw new TypeError("snapshot() accepts diff or find, not both");
  if (!(find instanceof RegExp) && (typeof find !== "string" || find === "")) {
    throw new TypeError("snapshot({ find }) needs a non-empty string or a RegExp");
  }
  if (context !== undefined && (!Number.isInteger(context) || context < 0 || context > 10)) {
    throw new TypeError("snapshot({ context }) must be an integer from 0 to 10");
  }
}

function findLines(snapshot, find, context = 2) {
  // Matching is per line: g and y would carry lastIndex between lines or pin a match to
  // column 0, so drop them on a private copy and leave the caller's RegExp untouched.
  const pattern = find instanceof RegExp ? new RegExp(find.source, find.flags.replace(/[gy]/g, "")) : null;
  const needle = pattern ? null : find.toLowerCase();
  const lines = snapshot.tree ? snapshot.tree.split("\n") : [];
  const matched = [];
  lines.forEach((line, index) => {
    if (pattern ? pattern.test(line) : line.toLowerCase().includes(needle)) matched.push(index);
  });
  const included = new Set();
  for (const index of matched) {
    for (let i = Math.max(0, index - context); i <= Math.min(lines.length - 1, index + context); i++) included.add(i);
  }
  const out = [];
  let previous = -1;
  for (const index of [...included].sort((a, b) => a - b)) {
    if (out.length && index > previous + 1) out.push("...");
    out.push(lines[index]);
    previous = index;
  }
  const tree = out.join("\n");
  const refs = {};
  // An accessible name can contain "[ref=e9]" as text; only the line's own ref attribute counts.
  for (const [, ref] of tree.replace(QUOTED, "").matchAll(REF_ATTR)) if (snapshot.refs?.[ref]) refs[ref] = snapshot.refs[ref];
  return { tree, refs, find: { query: String(find), matches: matched.length } };
}

export function snapshotResult(frameManager, options, snapshot) {
  const { diff, find, context, ...scope } = options;
  // A search is a partial read: leave the diff baseline at the last full or diff read.
  if (find !== undefined) return findLines(snapshot, find, context);
  const document = frameManager.getFrame(frameManager.mainFrameId);
  const contexts = JSON.stringify(frameManager.collectDescendantFrames(frameManager.mainFrameId)
    .map(({ frameId }) => [frameId, frameManager.getFrame(frameId)?.isolatedContextId]));
  const scopeKey = JSON.stringify(scope);
  const current = indexTree(snapshot.tree);
  const previous = baselines.get(frameManager);
  // Store private, derived data, not the caller-mutable refs map or returned delta entries.
  baselines.set(frameManager, { ...current, document, contexts, scopeKey });
  if (diff !== true) return snapshot;
  let reason;
  if (!previous) reason = "no-baseline";
  else if (previous.document !== document || previous.contexts !== contexts) reason = "navigation";
  else if (previous.scopeKey !== scopeKey) reason = "options-changed";
  else if (previous.unreferenced !== current.unreferenced) reason = "unreferenced-content";
  if (reason) return { ...snapshot, full: true, reason };

  const added = [];
  const changed = [];
  const removed = [];
  for (const [ref, node] of current.nodes) {
    const before = previous.nodes.get(ref);
    if (!before) added.push({ ...node });
    else if (before.tree !== node.tree) {
      // A stable ref already identifies the role and name. Do not resend its unchanged
      // label or placeholder on every keystroke; the remaining text is current state/value.
      const label = /^[^\s"]+(?: "(?:\\.|[^"\\])*")? /;
      let tree = node.tree;
      const heading = label.exec(tree)?.[0];
      if (heading && heading === label.exec(before.tree)?.[0]) tree = tree.slice(heading.length);
      const placeholder = / \[placeholder="(?:\\.|[^"\\])*"\]/.exec(tree)?.[0];
      if (placeholder && before.tree.includes(placeholder)) tree = tree.replace(placeholder, "");
      changed.push({ ref, tree });
    }
  }
  for (const ref of previous.nodes.keys()) if (!current.nodes.has(ref)) removed.push(ref);
  const result = { diff: { added, changed, removed, focused: current.focused }, full: false };
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > Buffer.byteLength(snapshot.tree, "utf8")) {
    return { ...snapshot, full: true, reason: "diff-larger-than-full" };
  }
  return result;
}
