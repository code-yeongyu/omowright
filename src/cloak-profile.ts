import { randomInt } from "node:crypto";
import { chmod, mkdir, open, readFile } from "node:fs/promises";
import { globSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { connectPipe } from "./pipe.ts";

const MIN_FINGERPRINT_SEED = 10_000;
const MAX_FINGERPRINT_SEED = 99_999;
const METADATA_FILE = ".omowright-cloak.json";
const DEFAULT_PROFILE_DIR = path.join(os.homedir(), ".local", "share", "omowright-cloak");

type FingerprintSeedInput = number | string;

type PipeOptions = NonNullable<Parameters<typeof connectPipe>[0]>;

export interface CloakBrowserArgsOptions {
  profileDir?: string;
  fingerprintSeed?: FingerprintSeedInput;
  extraArgs?: string[];
}

export interface CloakProfileRequest {
  profileDir?: string;
  fingerprintSeed?: FingerprintSeedInput;
  randomSeed?: () => number;
}

export interface CloakProfile {
  profileDir: string;
  metadataPath: string;
  fingerprintSeed: number;
  browserArgs: string[];
}

export type CloakConnectOptions = Omit<PipeOptions, "browserPath" | "browserArgs" | "storageRoot"> & {
  browserPath?: string;
  profileDir?: string;
  fingerprintSeed?: FingerprintSeedInput;
  browserArgs?: string[];
  storageRoot?: string;
};

function errorCode(error: unknown): unknown {
  return (typeof error === "object" || typeof error === "function") && error !== null && "code" in error
    ? error.code
    : undefined;
}

function normalizeFingerprintSeed(value: unknown): number {
  const seed = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (
    typeof seed !== "number" ||
    !Number.isInteger(seed) ||
    seed < MIN_FINGERPRINT_SEED ||
    seed > MAX_FINGERPRINT_SEED
  ) {
    throw new RangeError(`fingerprint seed must be an integer from ${MIN_FINGERPRINT_SEED} to ${MAX_FINGERPRINT_SEED}`);
  }
  return seed;
}

function platformFingerprint() {
  return process.platform === "darwin" ? "macos" : "windows";
}

function identityFlag(value: string) {
  return /^(--user-data-dir|--fingerprint|--fingerprint-platform)(?:=|$)/.test(value);
}

export function buildCloakBrowserArgs({
  profileDir,
  fingerprintSeed,
  extraArgs = [],
}: CloakBrowserArgsOptions = {}): string[] {
  const profile = path.resolve(profileDir ?? DEFAULT_PROFILE_DIR);
  const seed = normalizeFingerprintSeed(fingerprintSeed);
  const conflicting = extraArgs.filter(identityFlag);
  if (conflicting.length > 0) {
    throw new Error(`extraArgs cannot override fixed profile identity: ${conflicting.join(", ")}`);
  }
  return [
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-session-crashed-bubble",
    `--user-data-dir=${profile}`,
    `--fingerprint=${seed}`,
    `--fingerprint-platform=${platformFingerprint()}`,
    ...extraArgs,
  ];
}

async function readMetadata(metadataPath: string): Promise<number | null> {
  try {
    // JSON boundary: the file is ours, but its shape is only checked by normalizeFingerprintSeed.
    const parsed: { fingerprintSeed?: unknown } = JSON.parse(await readFile(metadataPath, "utf8"));
    return normalizeFingerprintSeed(parsed.fingerprintSeed);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    if (error instanceof SyntaxError) {
      throw new Error(`invalid CloakBrowser profile metadata: ${metadataPath}`, { cause: error });
    }
    throw error;
  }
}

async function writeMetadata(metadataPath: string, fingerprintSeed: number) {
  const handle = await open(metadataPath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify({ fingerprintSeed }, null, 2)}\n`, "utf8");
  } finally {
    await handle.close();
  }
  await chmod(metadataPath, 0o600);
}

export async function resolveCloakProfile({
  profileDir = DEFAULT_PROFILE_DIR,
  fingerprintSeed,
  randomSeed = () => randomInt(MIN_FINGERPRINT_SEED, MAX_FINGERPRINT_SEED + 1),
}: CloakProfileRequest = {}): Promise<CloakProfile> {
  const resolvedProfile = path.resolve(profileDir);
  const metadataPath = path.join(resolvedProfile, METADATA_FILE);
  await mkdir(resolvedProfile, { recursive: true, mode: 0o700 });
  await chmod(resolvedProfile, 0o700);

  const requested = fingerprintSeed === undefined ? null : normalizeFingerprintSeed(fingerprintSeed);
  let stored = await readMetadata(metadataPath);

  if (stored === null) {
    const candidate = requested ?? normalizeFingerprintSeed(randomSeed());
    try {
      await writeMetadata(metadataPath, candidate);
      stored = candidate;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      stored = await readMetadata(metadataPath);
      if (stored === null) {
        throw new Error(`CloakBrowser profile seed metadata disappeared: ${metadataPath}`, { cause: error });
      }
    }
  }

  if (requested !== null && requested !== stored) {
    throw new Error(`fingerprint seed mismatch: profile is fixed at ${stored}, requested ${requested}`);
  }

  await chmod(metadataPath, 0o600);

  return {
    profileDir: resolvedProfile,
    metadataPath,
    fingerprintSeed: stored,
    browserArgs: buildCloakBrowserArgs({
      profileDir: resolvedProfile,
      fingerprintSeed: stored,
    }),
  };
}

export function findCloakBrowserPath({
  browserRoot = path.join(os.homedir(), ".cloakbrowser"),
}: { browserRoot?: string } = {}): string {
  const candidates = globSync(
    path.join(path.resolve(browserRoot), "chromium-*", "Chromium.app", "Contents", "MacOS", "Chromium"),
  ).toSorted();
  const browserPath = candidates.at(-1);
  if (!browserPath) {
    throw new Error(`CloakBrowser binary not found under ${path.resolve(browserRoot)}; set CLOAKBROWSER_BIN`);
  }
  return browserPath;
}

export async function connectCloakProfile({
  browserPath = process.env.CLOAKBROWSER_BIN ?? findCloakBrowserPath(),
  profileDir = process.env.CLOAK_PROFILE_DIR ?? DEFAULT_PROFILE_DIR,
  fingerprintSeed = process.env.CLOAK_FINGERPRINT_SEED,
  browserArgs = [],
  storageRoot,
  ...options
}: CloakConnectOptions = {}) {
  const profile = await resolveCloakProfile({ profileDir, fingerprintSeed });
  return connectPipe({
    browserPath,
    browserArgs: buildCloakBrowserArgs({
      profileDir: profile.profileDir,
      fingerprintSeed: profile.fingerprintSeed,
      extraArgs: browserArgs,
    }),
    storageRoot: storageRoot ?? profile.profileDir,
    ...options,
  });
}
