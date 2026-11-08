// Speaks both `aside repl` contracts omowright has met, picked by FAKE_ASIDE_CLI:
// - 1.26.916 (the default): a piped `aside repl` prints a banner, then "repl > " prompts; every
//   line is evaluated on its own, its console output printed, then "[ok | Nms]" or "[error | Nms]".
//   The colour codes are byte-for-byte what the real CLI writes to a pipe.
// - 1.26.1107.24: a piped `aside repl` reads stdin to EOF and runs it as one script, as that
//   CLI's `aside repl --help` says; the long-lived session lives behind `aside mcp`, a JSON-RPC
//   server on stdio whose `repl` tool runs code in one REPL session for the life of the process.
// Globals persist for the life of the process in both. FAKE_ASIDE_MCP_TOOLS=none drops the `repl`
// tool, and FAKE_ASIDE_SILENT makes a line-protocol `aside repl` print nothing.
import { createInterface } from "node:readline";
import vm from "node:vm";

const VERSION = process.env.FAKE_ASIDE_CLI ?? "1.26.916.1741";
const SCRIPT_AT_EOF = VERSION.startsWith("1.26.1107");
const argv = process.argv.slice(2);
const accountAt = argv.indexOf("--account");
const account = accountAt === -1 ? null : argv[accountAt + 1];
const args = accountAt === -1 ? argv : argv.filter((_, i) => i !== accountAt && i !== accountAt + 1);
if (args[0] === "--version") {
  process.stdout.write(`${VERSION}\n`);
  process.exit(0);
}
if (args[0] === "account" && args[1] === "status") {
  const state = process.env.FAKE_ASIDE_SIGNED_OUT ? "signed out" : "signed in";
  const rows = [`* u0  someone@example.com  ${state}  profiles: Profile 0\n  provider: google\n`, "  u1  Local Account  signed out  profiles: Profile 1\n"];
  process.stdout.write(account === "u1" ? rows[1] : account === "u0" ? rows[0] : rows.join(""));
  process.exit(0);
}
if (args[0] === "repl" && args.includes("--help")) {
  const notes = SCRIPT_AT_EOF ? "\nNotes:\n  Use console.log() to print return values. Without code, piped stdin runs as one script.\n" : "";
  process.stdout.write(`Usage: aside repl [options] [code...]\n\nRun browser automation JavaScript\n\nOptions:\n  -h, --help  Print help\n${notes}`);
  process.exit(0);
}
if (args[0] !== "repl" && !(args[0] === "mcp" && SCRIPT_AT_EOF)) {
  process.stderr.write(`fake aside: unsupported command ${args.join(" ")}\n`);
  process.exit(2);
}

let sink = (text) => process.stdout.write(text);
const write = (text) => sink(text);
const PROMPT = "\x1b[32mrepl\x1b[0m \x1b[33m>\x1b[0m ";
const tabs = [];
const context = vm.createContext({
  console: { log: (...values) => write(`${values.map(String).join(" ")}\n`) },
  JSON,
  Promise,
  Error,
  tabs,
  page: null,
  // Writes in two chunks with a pause, so the reader sees the first part as its own chunk.
  splitWrite: async (first, rest) => {
    write(first);
    await new Promise((resolve) => setTimeout(resolve, 50));
    write(rest);
  },
  openTab: async (url) => {
    const tab = { url: () => url, title: async () => `Title of ${url}` };
    tabs.push(tab);
    context.page = tab;
    write(`✔︎ Opened a new tab and set it active: tabs[${tabs.length - 1}]\n`);
    return tab;
  },
  snapshot: async () => ({
    tree: ['- heading "Store" [level=1]', '- link "Pay later" [ref=e1]', '- text: "Totals"', '- button "Pay now" [ref=e2]'].join("\n"),
    diff: "",
  }),
});
const evaluate = (code) => vm.runInContext(`(async () => { ${code}\n })()`, context);

if (args[0] === "mcp") {
  const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  const tools = process.env.FAKE_ASIDE_MCP_TOOLS === "none" ? [] : [{ name: "repl", inputSchema: { type: "object" } }];
  for await (const line of createInterface({ input: process.stdin })) {
    const { id, method, params } = JSON.parse(line);
    if (id === undefined) continue;
    if (method === "initialize") send({ id, result: { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "aside", version: VERSION } } });
    else if (method === "tools/list") send({ id, result: { tools: [...tools, { name: "browser_profiles", inputSchema: { type: "object" } }] } });
    else if (method === "tools/call" && tools.some((tool) => tool.name === params.name)) {
      let text = "";
      sink = (chunk) => { text += chunk; };
      try {
        await evaluate(params.arguments.code);
        send({ id, result: { content: text ? [{ type: "text", text }] : [], isError: false } });
      } catch (error) {
        send({ id, result: { content: [{ type: "text", text: `Error: ${error?.message ?? error}` }, ...(text ? [{ type: "text", text }] : [])], isError: true } });
      }
    } else send({ id, error: { code: -32601, message: `unknown method ${method} ${params?.name ?? ""}`.trim() } });
  }
  process.exit(0);
}

if (SCRIPT_AT_EOF) {
  const code = args.slice(1).join(" ").trim() || (await new Promise((resolve) => {
    let text = "";
    process.stdin.setEncoding("utf8").on("data", (chunk) => { text += chunk; }).on("end", () => resolve(text.trim()));
  }));
  try {
    await evaluate(code);
    process.stderr.write("[ok | 1ms]\n");
    process.exit(0);
  } catch (error) {
    process.stderr.write(`${error?.message ?? error}\n[error | 1ms]\n`);
    process.exit(1);
  }
}
if (process.env.FAKE_ASIDE_SILENT) {
  process.stdin.resume();
  await new Promise(() => {});
}

write(`\x1b[2maccount: ${account ?? "u0"} (someone@example.com)\nsessionDir: ~/.aside/u/0/sessions/fake\ntype 'help' for usage, 'state' to inspect tool state, 'exit' to quit\x1b[0m\n${PROMPT}`);
const input = createInterface({ input: process.stdin });
for await (const line of input) {
  if (line.trim() === "exit") break;
  try {
    await evaluate(line);
    write("\x1b[2m[ok | 1ms]\x1b[0m\n");
  } catch (error) {
    write(`\x1b[31m${error?.name ?? "Error"}: ${error?.message ?? error}\n    at <eval> (repl.js:1:1)\x1b[0m\n\x1b[31m[error | 1ms]\x1b[0m\n`);
  }
  write(PROMPT);
}
process.exit(0);
