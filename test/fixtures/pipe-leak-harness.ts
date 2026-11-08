// Harness child: runs the pipe transport against the fake browser. The test
// captures THIS process's stdout/stderr; any browser noise appearing there
// proves the transport leaked the browser's stdio to its parent (the TUI tty
// in production).
import { fileURLToPath } from "node:url";
import { PipeCdpClient } from "../../src/pipe.ts";

const fixture = fileURLToPath(new URL("./fake-pipe-browser.ts", import.meta.url));
const browserArgs: string[] = [fixture];

const client = new PipeCdpClient({ browserPath: process.execPath, browserArgs });
await client.ensureConnected();
const version: { product: string } = await client.send("Browser.getVersion");
process.stdout.write(`HARNESS_OK ${version.product}\n`);
await client.close();
