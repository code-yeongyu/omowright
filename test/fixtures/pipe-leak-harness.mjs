// Harness child: runs the pipe transport against the fake browser. The test
// captures THIS process's stdout/stderr; any browser noise appearing there
// proves the transport leaked the browser's stdio to its parent (the TUI tty
// in production).
import { fileURLToPath } from "node:url";
import { PipeCdpClient } from "../../src/pipe.js";

const fixture = fileURLToPath(new URL("./fake-pipe-browser.mjs", import.meta.url));

const client = new PipeCdpClient({ browserPath: process.execPath, browserArgs: [fixture] });
await client.ensureConnected();
const { product } = await client.send("Browser.getVersion");
process.stdout.write(`HARNESS_OK ${product}\n`);
await client.close();
