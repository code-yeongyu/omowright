// Speaks both `aside repl` contracts omowright has met, picked by FAKE_ASIDE_CLI:
// - 1.26.916 (the default): a piped `aside repl` prints a banner, then "repl > " prompts; every
//   line is evaluated on its own, its console output printed, then "[ok | Nms]" or "[error | Nms]".
//   The colour codes are byte-for-byte what the real CLI writes to a pipe.
// - 1.26.1107.24: a piped `aside repl` reads stdin to EOF and runs it as one script, as that
//   CLI's `aside repl --help` says; the long-lived session lives behind `aside mcp`, a JSON-RPC
//   server on stdio whose `repl` tool runs code in one REPL session for the life of the process.
// Globals persist for the life of the process in both. FAKE_ASIDE_MCP_TOOLS=none drops the `repl`
// tool, and FAKE_ASIDE_SILENT makes a line-protocol `aside repl` print nothing.
// FAKE_ASIDE_MCP_SERVER_REQUESTS makes `aside mcp` send its own requests (a `ping` reusing the
// call's id, then an unknown method) before answering each tools/call, and fail the call unless
// both got their JSON-RPC answers. FAKE_ASIDE_STUBBORN makes `aside mcp` ignore SIGTERM and stdin
// EOF. FAKE_ASIDE_HELP_HANG makes `aside repl --help` never answer; `aside mcp --help` lists tools.
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
  const rows = [
    `* u0  someone@example.com  ${state}  profiles: Profile 0\n  provider: google\n`,
    "  u1  Local Account  signed out  profiles: Profile 1\n",
  ] as const;
  process.stdout.write(account === "u1" ? rows[1] : account === "u0" ? rows[0] : rows.join(""));
  process.exit(0);
}
if (args[0] === "repl" && args.includes("--help") && process.env.FAKE_ASIDE_HELP_HANG) {
  setInterval(() => {}, 1 << 30);
  await new Promise(() => {});
}
if (args[0] === "mcp" && args.includes("--help") && SCRIPT_AT_EOF) {
  process.stdout.write(
    "Usage: aside mcp [options]\n\nRun an MCP server on stdio\n\nTools:\n  repl              Run browser automation JavaScript in one REPL session\n  browser_profiles  List browser profiles\n",
  );
  process.exit(0);
}
if (args[0] === "repl" && args.includes("--help")) {
  const notes = SCRIPT_AT_EOF
    ? "\nNotes:\n  Use console.log() to print return values. Without code, piped stdin runs as one script.\n"
    : "";
  process.stdout.write(
    `Usage: aside repl [options] [code...]\n\nRun browser automation JavaScript\n\nOptions:\n  -h, --help  Print help\n${notes}`,
  );
  process.exit(0);
}
if (args[0] !== "repl" && !(args[0] === "mcp" && SCRIPT_AT_EOF)) {
  process.stderr.write(`fake aside: unsupported command ${args.join(" ")}\n`);
  process.exit(2);
}

let sink = (text: string): unknown => process.stdout.write(text);
const write = (text: string) => sink(text);
// Reads a field off whatever the evaluated line threw or the client sent; vm errors come from
// another realm, so no instanceof.
const field = (value: unknown, key: string): unknown =>
  (typeof value === "object" && value !== null) || typeof value === "function" ? Reflect.get(value, key) : undefined;
const PROMPT = "\x1b[32mrepl\x1b[0m \x1b[33m>\x1b[0m ";
interface FakeTab {
  url(): string;
  title(): Promise<string>;
}
const tabs: FakeTab[] = [];
const context = vm.createContext({
  console: { log: (...values: unknown[]) => write(`${values.map(String).join(" ")}\n`) },
  JSON,
  Promise,
  Error,
  tabs,
  page: null,
  // Writes in two chunks with a pause, so the reader sees the first part as its own chunk.
  splitWrite: async (first: string, rest: string) => {
    write(first);
    await new Promise((resolve) => setTimeout(resolve, 50));
    write(rest);
  },
  openTab: async (url: string) => {
    const tab: FakeTab = { url: () => url, title: async () => `Title of ${url}` };
    tabs.push(tab);
    context.page = tab;
    write(`✔︎ Opened a new tab and set it active: tabs[${tabs.length - 1}]\n`);
    return tab;
  },
  snapshot: async () => ({
    tree: [
      '- heading "Store" [level=1]',
      '- link "Pay later" [ref=e1]',
      '- text: "Totals"',
      '- button "Pay now" [ref=e2]',
    ].join("\n"),
    diff: "",
  }),
});
const evaluate = (code: string): unknown => vm.runInContext(`(async () => { ${code}\n })()`, context);
const errorText = (error: unknown) => String(field(error, "message") ?? error);

if (args[0] === "mcp") {
  const send = (message: Readonly<Record<string, unknown>>) =>
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  const tools = process.env.FAKE_ASIDE_MCP_TOOLS === "none" ? [] : [{ name: "repl", inputSchema: { type: "object" } }];
  const replies = new Map<unknown, (reply: unknown) => void>();
  const ask = (id: unknown, method: string) =>
    new Promise<unknown>((resolve) => {
      replies.set(id, resolve);
      send({ id, method });
    });
  if (process.env.FAKE_ASIDE_STUBBORN) {
    process.on("SIGTERM", () => {});
    setInterval(() => {}, 1 << 30);
  }
  const input = createInterface({ input: process.stdin });
  input.on("close", () => {
    if (!process.env.FAKE_ASIDE_STUBBORN) process.exit(0);
  });
  input.on("line", async (line) => {
    const message: unknown = JSON.parse(line);
    const id = field(message, "id");
    const method = field(message, "method");
    const params = field(message, "params");
    if (method === undefined) {
      replies.get(id)?.(message);
      replies.delete(id);
      return;
    }
    if (id === undefined) return;
    if (method === "tools/call" && process.env.FAKE_ASIDE_MCP_SERVER_REQUESTS) {
      const [ping, unknown] = await Promise.all([ask(id, "ping"), ask(`server-${String(id)}`, "roots/list")]);
      if (JSON.stringify(field(ping, "result")) !== "{}" || field(field(unknown, "error"), "code") !== -32601) {
        send({
          id,
          result: {
            content: [{ type: "text", text: `Error: server requests got ${JSON.stringify([ping, unknown])}` }],
            isError: true,
          },
        });
        return;
      }
    }
    const toolName = field(params, "name");
    if (method === "initialize")
      send({
        id,
        result: {
          protocolVersion: field(params, "protocolVersion"),
          capabilities: { tools: {} },
          serverInfo: { name: "aside", version: VERSION },
        },
      });
    else if (method === "tools/list")
      send({ id, result: { tools: [...tools, { name: "browser_profiles", inputSchema: { type: "object" } }] } });
    else if (method === "tools/call" && tools.some((tool) => tool.name === toolName)) {
      let text = "";
      sink = (chunk) => {
        text += chunk;
      };
      try {
        await evaluate(String(field(field(params, "arguments"), "code")));
        send({ id, result: { content: text ? [{ type: "text", text }] : [], isError: false } });
      } catch (error) {
        send({
          id,
          result: {
            content: [{ type: "text", text: `Error: ${errorText(error)}` }, ...(text ? [{ type: "text", text }] : [])],
            isError: true,
          },
        });
      }
    } else
      send({
        id,
        error: { code: -32601, message: `unknown method ${String(method)} ${String(toolName ?? "")}`.trim() },
      });
  });
  await new Promise(() => {});
}

if (SCRIPT_AT_EOF) {
  const code =
    args.slice(1).join(" ").trim() ||
    (await new Promise<string>((resolve) => {
      let text = "";
      process.stdin
        .setEncoding("utf8")
        .on("data", (chunk) => {
          text += String(chunk);
        })
        .on("end", () => resolve(text.trim()));
    }));
  try {
    await evaluate(code);
    process.stderr.write("[ok | 1ms]\n");
    process.exit(0);
  } catch (error) {
    process.stderr.write(`${errorText(error)}\n[error | 1ms]\n`);
    process.exit(1);
  }
}
if (process.env.FAKE_ASIDE_SILENT) {
  process.stdin.resume();
  await new Promise(() => {});
}

write(
  `\x1b[2maccount: ${account ?? "u0"} (someone@example.com)\nsessionDir: ~/.aside/u/0/sessions/fake\ntype 'help' for usage, 'state' to inspect tool state, 'exit' to quit\x1b[0m\n${PROMPT}`,
);
const input = createInterface({ input: process.stdin });
for await (const line of input) {
  if (line.trim() === "exit") break;
  try {
    await evaluate(line);
    write("\x1b[2m[ok | 1ms]\x1b[0m\n");
  } catch (error) {
    write(
      `\x1b[31m${String(field(error, "name") ?? "Error")}: ${errorText(error)}\n    at <eval> (repl.js:1:1)\x1b[0m\n\x1b[31m[error | 1ms]\x1b[0m\n`,
    );
  }
  write(PROMPT);
}
process.exit(0);
