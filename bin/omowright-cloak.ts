#!/usr/bin/env bun

import { compactSnapshot, connectCloakProfile, resolveCloakProfile } from "../src/index.ts";
import os from "node:os";
import path from "node:path";

const HELP = `Usage: omowright-cloak [options]

Launch CloakBrowser through OmOWright with a stable persistent profile.

Options:
  --profile <dir>    Persistent Chromium profile directory
  --seed <10000-99999>
                     Pin the fingerprint seed on first use
  --browser <path>   CloakBrowser Chromium binary path
  --url <url>        Open a URL (default: about:blank)
  --once             Print state, close the browser, preserve the profile
  --snapshot         Include an interactive accessibility snapshot
  --help             Show this help

Environment:
  CLOAK_PROFILE_DIR       Default profile directory override
  CLOAK_FINGERPRINT_SEED  First-use seed override
  CLOAKBROWSER_BIN        CloakBrowser binary path override
`;

interface CliOptions {
  help?: undefined;
  url: string;
  once: boolean;
  snapshot: boolean;
  profile?: string;
  seed?: string;
  browser?: string;
}

type ParsedArgs = CliOptions | { help: true };

const VALUE_OPTIONS = {
  "--profile": "profile",
  "--seed": "seed",
  "--browser": "browser",
  "--url": "url",
} as const;

function isValueOption(arg: string | undefined): arg is keyof typeof VALUE_OPTIONS {
  return arg !== undefined && Object.hasOwn(VALUE_OPTIONS, arg);
}


/** `connectPipe` (src/pipe.js) attaches `newTab` to the connection it returns. */
interface CloakResult {
  ok: true;
  url: string;
  title: string;
  profileDir: string;
  fingerprintSeed: number;
  metadataPath: string;
  snapshot?: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  const options: CliOptions = { url: "about:blank", once: false, snapshot: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help") return { help: true };
    if (arg === "--once") {
      options.once = true;
      continue;
    }
    if (arg === "--snapshot") {
      options.snapshot = true;
      continue;
    }
    if (isValueOption(arg)) {
      const value = argv[++index];
      if (!value) throw new Error(`${arg} requires a value`);
      options[VALUE_OPTIONS[arg]] = value;
      continue;
    }
    throw new Error(`unknown option: ${String(arg)}`);
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  console.log(HELP);
  process.exit(0);
}

const profileDir = path.resolve(
  options.profile ?? process.env.CLOAK_PROFILE_DIR ?? path.join(os.homedir(), ".local", "share", "omowright-cloak"),
);
const profileRequest = { profileDir, fingerprintSeed: options.seed };
const profile = await resolveCloakProfile(profileRequest);
let browser: Awaited<ReturnType<typeof connectCloakProfile>> | undefined;
let shuttingDown = false;
async function shutdown(code = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  await browser?.close();
  process.exit(code);
}

process.once("SIGINT", () => void shutdown(130));
process.once("SIGTERM", () => void shutdown(143));

try {
  browser = await connectCloakProfile({
    profileDir,
    fingerprintSeed: profile.fingerprintSeed,
    browserPath: options.browser,
  });
  const page = await browser.newTab(options.url);
  const result: CloakResult = {
    ok: true,
    url: await page.url(),
    title: await page.title(),
    profileDir,
    fingerprintSeed: profile.fingerprintSeed,
    metadataPath: profile.metadataPath,
  };
  if (options.snapshot) {
    result.snapshot = compactSnapshot(await page.snapshot({ interactive: true }));
  }
  console.log(JSON.stringify(result, null, 2));
  if (!options.once) {
    await new Promise(() => {});
  }
} finally {
  if (!shuttingDown) await browser?.close();
}
