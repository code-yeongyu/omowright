// Minimal stand-in for a Chromium launched with --remote-debugging-pipe:
// answers NUL-delimited CDP JSON on fd 3 (read) / fd 4 (write) and emits the
// same startup noise a real macOS Chrome emits on stdout/stderr, including the
// PartitionAlloc shim line (allocator_shim_override_apple_default_zone.h).
import { createReadStream, createWriteStream } from "node:fs";

const mode = process.env.FAKE_BROWSER_MODE ?? "ready";

process.stderr.write("Trying to load the allocator multiple times. This is *not* supported.\n");
process.stdout.write("fake-browser stdout noise\n");

if (mode === "mute-cdp") {
  process.stderr.write("BOOM diagnostics 123\n");
  setInterval(() => {}, 60_000); // stay alive, never answer CDP
} else {
  const input = createReadStream(null, { fd: 3 });
  const output = createWriteStream(null, { fd: 4 });
  let buffer = Buffer.alloc(0);
  input.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    let idx;
    while ((idx = buffer.indexOf(0)) !== -1) {
      const raw = buffer.subarray(0, idx).toString("utf8");
      buffer = buffer.subarray(idx + 1);
      if (raw.length === 0) continue;
      let msg;
      try { msg = JSON.parse(raw); } catch { continue; }
      const result = msg.method === "Browser.getVersion"
        ? { product: "FakeChrome/1.0", protocolVersion: "1.3" }
        : {};
      output.write(JSON.stringify({ id: msg.id, result }) + "\0");
    }
  });
  input.on("end", () => process.exit(0));
}
