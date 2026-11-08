// Speaks the `aside repl` stdin protocol measured on Aside CLI 1.26.916: a banner, then
// "repl > " prompts; every line is evaluated on its own, its console output printed,
// then "[ok | Nms]" or "[error | Nms]". Globals persist for the life of the process.
// The colour codes are byte-for-byte what the real CLI writes to a pipe.
import { createInterface } from "node:readline";
import vm from "node:vm";

const argv = process.argv.slice(2);
const accountAt = argv.indexOf("--account");
const account = accountAt === -1 ? null : argv[accountAt + 1];
const args = accountAt === -1 ? argv : argv.filter((_, i) => i !== accountAt && i !== accountAt + 1);
if (args[0] === "--version") {
  process.stdout.write("1.26.916.1741\n");
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
if (args[0] !== "repl") {
  process.stderr.write(`fake aside: unsupported command ${args.join(" ")}\n`);
  process.exit(2);
}

const write = (text: string) => process.stdout.write(text);
// Reads a field off whatever the evaluated line threw; vm errors come from another realm, so no instanceof.
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

write(
  `\x1b[2maccount: ${account ?? "u0"} (someone@example.com)\nsessionDir: ~/.aside/u/0/sessions/fake\ntype 'help' for usage, 'state' to inspect tool state, 'exit' to quit\x1b[0m\n${PROMPT}`,
);
const input = createInterface({ input: process.stdin });
for await (const line of input) {
  if (line.trim() === "exit") break;
  try {
    await vm.runInContext(`(async () => { ${line}\n })()`, context);
    write("\x1b[2m[ok | 1ms]\x1b[0m\n");
  } catch (error) {
    write(
      `\x1b[31m${field(error, "name") ?? "Error"}: ${field(error, "message") ?? error}\n    at <eval> (repl.js:1:1)\x1b[0m\n\x1b[31m[error | 1ms]\x1b[0m\n`,
    );
  }
  write(PROMPT);
}
process.exit(0);
