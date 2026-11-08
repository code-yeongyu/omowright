// Windows half of native-messaging host registration (#90 cluster 3). Chrome on Windows finds a host through the
// per-user registry value HKCU\Software\<vendor>\<browser>\NativeMessagingHosts\<name> (default value = manifest path),
// and file safety lives in the owner SID and ACL, not in uid/mode bits. The policy below is the ACL analogue of the
// POSIX checks in bridge-transport.js: only the user, SYSTEM, Administrators and TrustedInstaller may be able to
// change the host executable, the directory it starts in, the manifest or its directory, or replace any directory on
// the path to them. For a .cmd/.bat host only the wrapper and its directory are covered, not what the script runs.
import { execFile, type ExecFileException } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rmdir, unlink } from "node:fs/promises";
import path from "node:path";
import { readProperty } from "./read-property.ts";

const SYSTEM = "S-1-5-18";
const ADMINISTRATORS = "S-1-5-32-544";
const TRUSTED_INSTALLER = "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464";
const OWNER_RIGHTS = "S-1-3-4";
const CREATOR_OWNER = "S-1-3-0";

// FileSystemRights bits (winnt.h). Directory names in brackets.
const WRITE_DATA = 0x2; // [AddFile]
const APPEND_DATA = 0x4; // [AddSubdirectory]
const WRITE_EA = 0x10;
const DELETE_CHILD = 0x40;
const WRITE_ATTRIBUTES = 0x100;
const DELETE = 0x10000;
const WRITE_DAC = 0x40000;
const WRITE_OWNER = 0x80000;
const GENERIC_ALL = 0x10000000;
const GENERIC_WRITE = 0x40000000;

// Rights that let a principal change an object's content, metadata, ACL or owner, or delete it.
const MODIFY =
  WRITE_DATA |
  APPEND_DATA |
  WRITE_EA |
  WRITE_ATTRIBUTES |
  DELETE |
  WRITE_DAC |
  WRITE_OWNER |
  GENERIC_ALL |
  GENERIC_WRITE;
// What an untrusted principal must not hold on each kind of path component. "final" is a directory whose content
// matters: the manifest directory, and the host's own directory (Chrome starts the host there, so an .exe loads DLLs
// and a .cmd resolves bare commands from it).
const FORBIDDEN = {
  executable: MODIFY,
  manifest: MODIFY,
  final: MODIFY | DELETE_CHILD,
  // An ancestor may let others add entries (default C:\ grants Users AddSubdirectory, the analogue of a sticky root
  // /tmp), but nobody untrusted may delete or rename an existing child, delete the ancestor, or take its ACL.
  ancestor: DELETE_CHILD | DELETE | WRITE_DAC | WRITE_OWNER | GENERIC_ALL,
};

export type Win32PathKind = keyof typeof FORBIDDEN;

// One path as the PowerShell ACL report describes it. The report is parsed JSON, so every field it supplies is read as
// unknown and judged by truthiness or identity; `aces` entries are read with readProperty for the same reason.
export interface Win32PathItem {
  readonly path: string;
  readonly exists?: unknown;
  readonly inaccessible?: unknown;
  readonly directory?: unknown;
  readonly reparse?: unknown;
  readonly owner?: unknown;
  readonly aces?: readonly unknown[];
}

export interface Win32NativeHostInstall<Manifest> {
  hostName: string;
  hostPath: string;
  dir: string;
  registryKey: string;
  force?: boolean | undefined;
  writeManifest: (file: string) => Promise<Manifest>;
}

interface RunResult {
  code: ExecFileException["code"];
  stdout: string;
  stderr: string;
}

export const WIN32_REGISTRY_KEYS = Object.freeze({
  chrome: "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts",
  chromium: "HKCU\\Software\\Chromium\\NativeMessagingHosts",
});

export const isWin32RegistryKey = (key: unknown): key is string =>
  typeof key === "string" && /^HKCU\\Software(\\[^\\/:*?"<>|\r\n]+)*\\NativeMessagingHosts$/i.test(key);

// Returns null when the inspected path is safe as `kind` ("executable", "manifest", "final" or "ancestor"), else the
// reason. `item` is one entry of inspectWin32Paths(); `userSid` is the current user's SID.
export function win32PathRisk(item: Win32PathItem | undefined, kind: Win32PathKind, userSid: string): string | null {
  const trusted = new Set<unknown>([userSid, SYSTEM, ADMINISTRATORS, TRUSTED_INSTALLER]);
  if (item?.inaccessible) return "could not be inspected";
  if (!item?.exists) return "is missing";
  if (item.reparse) return "is a symlink, junction or other reparse point";
  if (kind === "executable" || kind === "manifest") {
    if (item.directory) return "is not a regular file";
    if (kind === "executable" && !/\.(exe|cmd|bat|com)$/i.test(item.path))
      return "is not a .exe, .cmd, .bat or .com file";
  } else if (!item.directory) return "is not a directory";
  if (!trusted.has(item.owner)) return `is owned by untrusted ${item.owner}`;
  trusted.add(OWNER_RIGHTS).add(CREATOR_OWNER); // OWNER RIGHTS = the (trusted) owner; CREATOR OWNER = whoever creates a child
  for (const ace of item.aces ?? []) {
    if (!readProperty(ace, "allow") || trusted.has(readProperty(ace, "sid"))) continue;
    // An inherit-only ACE does not apply to this object, but on a final directory an object-inheriting one lands on
    // every file created in it (the manifest, a DLL next to the host), so it counts with the file rights.
    const mask = !readProperty(ace, "inheritOnly")
      ? FORBIDDEN[kind]
      : kind === "final" && readProperty(ace, "objectInherit")
        ? MODIFY
        : 0;
    if ((Number(readProperty(ace, "rights")) & mask) !== 0) return `grants ${readProperty(ace, "sid")} write access`;
  }
  return null;
}

const systemBinary = (...segments: string[]) => {
  const file = path.win32.join(process.env.SystemRoot || "C:\\Windows", "System32", ...segments);
  if (!existsSync(file)) throw new Error(`${file} is missing`);
  return file;
};

// Exit code of a finished child; a spawn failure, a timeout or a kill rejects (the caller fails closed).
function run(file: string, args: readonly string[]) {
  return new Promise<RunResult>((resolve, reject) => {
    execFile(
      file,
      args,
      { timeout: 15_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error && (typeof error.code !== "number" || error.killed)) reject(error);
        else resolve({ code: error ? error.code : 0, stdout, stderr });
      },
    );
  });
}

// One bounded PowerShell call that reports, for each path in order: whether it exists or could not be read, whether it
// is a directory or a reparse point, its owner SID and its ACEs (SID, allow/deny, rights mask, inherit-only,
// object-inherit); plus the current user SID. Paths travel base64-encoded inside the script and nothing path-shaped
// comes back, so no console code page can garble them. Under Constrained Language Mode the .NET calls fail, and so
// does the whole inspection: the caller fails closed.
const INSPECT = `$ErrorActionPreference = 'Stop'
$paths = ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__PATHS__')))
$sid = [System.Security.Principal.SecurityIdentifier]
$items = @(foreach ($p in $paths) {
  try { $i = Get-Item -LiteralPath $p -Force; $acl = Get-Acl -LiteralPath $p }
  catch [System.Management.Automation.ItemNotFoundException] { [pscustomobject]@{ exists = $false; inaccessible = $false }; continue }
  catch { [pscustomobject]@{ exists = $false; inaccessible = $true }; continue }
  $aces = @(foreach ($r in $acl.GetAccessRules($true, $true, $sid)) { [pscustomobject]@{
    sid = $r.IdentityReference.Value; allow = ($r.AccessControlType -eq 'Allow'); rights = [int64]$r.FileSystemRights
    inheritOnly = (($r.PropagationFlags -band [System.Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0)
    objectInherit = (($r.InheritanceFlags -band [System.Security.AccessControl.InheritanceFlags]::ObjectInherit) -ne 0) } })
  [pscustomobject]@{ exists = $true; inaccessible = $false; directory = [bool]$i.PSIsContainer; owner = $acl.GetOwner($sid).Value
    aces = $aces; reparse = (($i.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) }
})
ConvertTo-Json -Depth 6 -Compress @{ user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; items = $items }`;

// One report entry paired with the path it describes. A null entry throws, as reading its `aces` always did.
const reportItem = (raw: unknown, file: string): Win32PathItem => ({
  exists: readProperty(raw, "exists"),
  inaccessible: readProperty(raw, "inaccessible"),
  directory: readProperty(raw, "directory"),
  owner: readProperty(raw, "owner"),
  reparse: readProperty(raw, "reparse"),
  path: file,
  aces: [readProperty(raw, "aces") ?? []].flat(),
});

// Last entry of a directory chain; win32DirectoryChain always starts one with the drive root.
function lastDirectory(chain: readonly string[]): string {
  const last = chain.at(-1);
  if (last === undefined) throw new Error("empty directory chain");
  return last;
}

const kindAt = (chain: readonly string[], index: number) => (index === chain.length - 1 ? "final" : "ancestor");

export async function inspectWin32Paths(paths: readonly string[]): Promise<{ user: string; items: Win32PathItem[] }> {
  let out: unknown;
  try {
    const script = INSPECT.replace("__PATHS__", Buffer.from(JSON.stringify(paths), "utf8").toString("base64"));
    const powershell = systemBinary("WindowsPowerShell", "v1.0", "powershell.exe");
    const result = await run(powershell, [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ]);
    if (result.code !== 0) throw new Error(String(result.stderr).trim() || `exit ${result.code}`);
    out = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(
      `native host security could not be verified (the PowerShell ACL inspection failed; Constrained Language Mode or a policy may block it): ${readProperty(error, "message")}`,
      { cause: error },
    );
  }
  const items = [readProperty(out, "items") ?? []].flat();
  const user = readProperty(out, "user");
  if (typeof user !== "string" || items.length !== paths.length)
    throw new Error("native host security could not be verified: unexpected ACL report");
  return { user, items: paths.map((file, index) => reportItem(items[index], file)) };
}

// Every directory from the drive root down to `dir`, root first. Only local drive-letter paths are accepted: a UNC or
// \\?\ root has an ACL this host does not own and cannot be walked the same way.
export function win32DirectoryChain(dir: string): string[] {
  const absolute = path.win32.resolve(dir);
  const { root } = path.win32.parse(absolute);
  if (!/^[A-Za-z]:\\$/.test(root) || dir.startsWith("\\\\"))
    throw new Error(`${dir} is not on a local drive-letter path`);
  const chain = [root];
  for (const part of absolute.slice(root.length).split("\\").filter(Boolean))
    chain.push(path.win32.join(lastDirectory(chain), part));
  return chain;
}

async function registryDefault(key: string, view?: string) {
  const result = await run(systemBinary("reg.exe"), ["query", key, "/ve", ...(view ? [`/reg:${view}`] : [])]);
  if (result.code !== 0) return null;
  return /REG_SZ\s+(.*?)\s*$/m.exec(result.stdout)?.[1] ?? "";
}

// Verifies the host and the manifest directory, writes the manifest through `writeManifest(file)` (the shared atomic
// writer), re-verifies the written file, then points the per-user registry value at it.
export async function installWin32NativeHost<Manifest>({
  hostName,
  hostPath,
  dir,
  registryKey,
  force,
  writeManifest,
}: Win32NativeHostInstall<Manifest>) {
  const hostChain = win32DirectoryChain(path.win32.dirname(hostPath));
  win32DirectoryChain(hostPath);
  const dirChain = win32DirectoryChain(dir);
  const { user, items } = await inspectWin32Paths([hostPath, ...hostChain, ...dirChain]);
  // `item` is defined here (inspectWin32Paths returns one entry per path); readProperty keeps the TypeError it would raise.
  const reject = (prefix: string, item: Win32PathItem | undefined, kind: Win32PathKind) => {
    const risk = win32PathRisk(item, kind, user);
    if (risk) throw new Error(`${prefix}: ${readProperty(item, "path")} ${risk}`);
  };
  reject("hostPath must be a securely owned executable file", items[0], "executable");
  items
    .slice(1, 1 + hostChain.length)
    .forEach((item, index) => reject("hostPath directory security rejected", item, kindAt(hostChain, index)));
  const dirItems = items.slice(1 + hostChain.length);
  const firstMissing = dirItems.findIndex((item) => !item.exists && !item.inaccessible);
  dirItems
    .slice(0, firstMissing === -1 ? undefined : firstMissing)
    .forEach((item, index) => reject("nativeMessagingHostDir security rejected", item, kindAt(dirChain, index)));
  if (firstMissing === 0) throw new Error(`nativeMessagingHostDir security rejected: ${dirChain[0]} is missing`);
  const created = firstMissing > 0 ? dirChain.slice(firstMissing) : [];
  const file = path.win32.join(lastDirectory(dirChain), `${hostName}.json`);
  // Only what this call itself created is removed on failure: the directories its own mkdir made (a concurrent install
  // may have made them first) and the manifest only after its own write produced it.
  const firstMade = created.length ? await mkdir(lastDirectory(dirChain), { recursive: true }) : undefined;
  // mkdir creates a tail of dirChain and reports its first directory, possibly in \\?\ or long-name form, so locate it
  // by depth rather than by spelling: C:\a\b has three components and is dirChain[2].
  const madeDepth =
    firstMade === undefined
      ? 0
      : firstMade
          .replace(/^\\\\\?\\/, "")
          .split(/[\\/]+/)
          .filter(Boolean).length;
  const made = madeDepth > 0 && madeDepth <= dirChain.length ? dirChain.slice(madeDepth - 1) : [];
  let wroteManifest = false;
  try {
    if (created.length) {
      const again = await inspectWin32Paths(created);
      if (again.user !== user) throw new Error("native host security could not be verified: user changed");
      again.items.forEach((item, offset) =>
        reject("nativeMessagingHostDir security rejected", item, kindAt(dirChain, firstMissing + offset)),
      );
    }
    const hostKey = `${registryKey}\\${hostName}`;
    // Chromium reads HKLM before HKCU, so a machine-level entry would win; refuse before writing anything.
    const machineKey = `HKLM\\${hostKey.slice("HKCU\\".length)}`;
    for (const view of ["32", "64"]) {
      if ((await registryDefault(machineKey, view)) !== null)
        throw new Error(`${hostKey} is shadowed by a machine-level registration at ${machineKey} (/reg:${view})`);
    }
    const current = await registryDefault(hostKey);
    if (current !== null && current.toLowerCase() !== file.toLowerCase() && !force)
      throw new Error(`${hostKey} already points at ${current}; use force`);
    const manifest = await writeManifest(file);
    wroteManifest = true;
    const written = await inspectWin32Paths([file]);
    const manifestRisk = win32PathRisk(written.items[0], "manifest", user);
    // On a force reinstall the HKCU value may already name this path; it then points at a missing file, which Chrome
    // treats as no host, and nobody untrusted can recreate the file in the verified directory.
    if (manifestRisk) {
      await unlink(file).catch(() => {});
      throw new Error(`native messaging manifest security rejected: ${file} ${manifestRisk}`);
    }
    const added = await run(systemBinary("reg.exe"), ["add", hostKey, "/ve", "/t", "REG_SZ", "/d", file, "/f"]);
    if (added.code !== 0) throw new Error(`native host registry write failed: ${String(added.stderr).trim()}`);
    return { path: file, manifest, registryKey: hostKey };
  } catch (error) {
    // rmdir (not recursive) leaves a directory alone once another install has put a file in it.
    if (made.length) {
      if (wroteManifest) await unlink(file).catch(() => {});
      for (const entry of made.toReversed()) await rmdir(entry).catch(() => {});
    }
    throw error;
  }
}
