// Which REPL contract an Aside CLI speaks, read from the CLI's own `aside repl --help`, never
// from its version number. Up to 1.26.916 a piped `aside repl` printed a banner and a prompt and
// evaluated each stdin line. From 1.26.1107 a piped `aside repl` reads stdin to EOF and runs it
// as one script, and its help says so ("Without code, piped stdin runs as one script."); its
// long-lived REPL session lives behind `aside mcp` (the `repl` tool) instead.
const SCRIPT_AT_EOF = /piped stdin runs as one script/i;

function captureCli({ spawn, command, args, env, timeoutMs }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command[0], [...command.slice(1), ...args], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch {
      resolve(null);
      return;
    }
    let out = "";
    const timer = setTimeout(() => {
      child.kill();
      resolve(null);
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => { out += chunk; });
    child.stderr?.on("data", (chunk) => { out += chunk; });
    child.once("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? out : null);
    });
  });
}

// "mcp" when piped `aside repl` runs stdin as one script; "line" otherwise, including when the
// help cannot be read, which keeps the protocol every earlier CLI spoke.
export async function replTransportFor(options) {
  const help = await captureCli({ ...options, args: ["repl", "--help"] });
  return help !== null && SCRIPT_AT_EOF.test(help) ? "mcp" : "line";
}

export async function asideCliVersion(options) {
  const out = await captureCli({ ...options, args: ["--version"] });
  return out?.trim() || null;
}
