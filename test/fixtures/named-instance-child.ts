// Child for the cross-process lock test: two of these call connectNamed on one
// name, released from a stdin barrier at the same instant, so the contention
// lands on the registry lock file instead of on one process's in-memory queue.
import { fileURLToPath } from "node:url";
import { connectNamed } from "../../src/instances.js";

const [registryRoot, name] = process.argv.slice(2);
const browserArgs = [
  fileURLToPath(new URL("./fake-named-browser.mjs", import.meta.url)),
];

process.stdout.write("READY\n");
await new Promise((resolve) => process.stdin.once("data", resolve));

const connection = await connectNamed(name, {
  registryRoot,
  browserPath: process.execPath,
  browserArgs,
});
process.stdout.write(
  `${JSON.stringify({
    launched: Boolean(connection.browserProcess),
    browserPid: connection.browserProcess?.pid ?? null,
    targets: await connection.listTargets(),
  })}\n`,
);
// close() from the launcher would terminate the browser the test inspects, so
// exit and let the test reap it.
process.exit(0);
