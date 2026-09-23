// Discovery of a running BrowserSkill daemon: `$BSK_HOME/daemon.json` is the
// file the daemon writes at start-up (`crates/bsk-cli/src/daemon/info.rs`)
// and the CLI reads to find the IPC socket. Nothing here talks to the socket.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

export function resolveBskHome(env = process.env) {
  const override = env.BSK_HOME;
  if (typeof override === "string" && override.length > 0) return override;
  const home = env.HOME && env.HOME.length > 0 ? env.HOME : homedir();
  return path.join(home, ".bsk");
}

export function daemonInfoPath(home) {
  return path.join(home, "daemon.json");
}

export function readDaemonInfo(home) {
  let raw;
  try { raw = readFileSync(daemonInfoPath(home), "utf8"); } catch { return null; }
  let info;
  try { info = JSON.parse(raw); } catch { return null; }
  if (!info || typeof info.sock_path !== "string" || info.sock_path.length === 0) return null;
  return info;
}

export function findBskBinary(env = process.env) {
  const home = env.HOME && env.HOME.length > 0 ? env.HOME : homedir();
  const candidates = [
    env.BSK_BIN,
    path.join(home, ".local", "bin", process.platform === "win32" ? "bsk.exe" : "bsk"),
  ].filter(Boolean);
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  return "bsk";
}

export function startDaemonWithCli({ home, env = process.env, bskBin = findBskBinary(env), timeoutMs = 20_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bskBin, ["status", "--json"], {
      env: { ...env, BSK_HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-4096); });
    child.stdout.on("data", () => {});
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`bsk status did not return within ${timeoutMs}ms`));
    }, timeoutMs);
    child.on("error", (error) => { clearTimeout(timer); reject(new Error(`could not run ${bskBin}: ${error.message}`)); });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`bsk status exited with ${code}${stderr ? `: ${stderr.trim()}` : ""}`));
    });
  });
}
