import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export const BROWSERSKILL_EXTENSION_IDS = Object.freeze({
  chrome: "hhcmgoofomhgciiibhipgmgkgnoenaoi",
  edge: "emacgiaaaiojkkpkddmmdfhmokgmnikg",
});

export const STORE_UPDATE_URLS = Object.freeze({
  chrome: "https://clients2.google.com/service/update2/crx",
  edge: "https://edge.microsoft.com/extensionwebstorebase/v1/crx",
});

export const STORE_PAGE_URLS = Object.freeze({
  chrome: `https://chromewebstore.google.com/detail/${BROWSERSKILL_EXTENSION_IDS.chrome}`,
  edge: `https://microsoftedge.microsoft.com/addons/detail/browserskill/${BROWSERSKILL_EXTENSION_IDS.edge}`,
});

const MAC = [
  { id: "chrome", store: "chrome", userData: "Library/Application Support/Google/Chrome", binary: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", bundleId: "com.google.Chrome" },
  { id: "edge", store: "edge", userData: "Library/Application Support/Microsoft Edge", binary: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", bundleId: "com.microsoft.edgemac" },
  { id: "brave", store: "chrome", userData: "Library/Application Support/BraveSoftware/Brave-Browser", binary: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser", bundleId: "com.brave.Browser" },
  { id: "chromium", store: "chrome", userData: "Library/Application Support/Chromium", binary: "/Applications/Chromium.app/Contents/MacOS/Chromium", bundleId: "org.chromium.Chromium" },
];

const LINUX = [
  { id: "chrome", store: "chrome", userData: ".config/google-chrome", binaries: ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/opt/google/chrome/chrome"], externalDir: "/opt/google/chrome/extensions", userExternalDir: false },
  { id: "chromium", store: "chrome", userData: ".config/chromium", binaries: ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/snap/bin/chromium"], externalDir: "/usr/share/chromium/extensions", userExternalDir: true },
  { id: "edge", store: "edge", userData: ".config/microsoft-edge", binaries: ["/usr/bin/microsoft-edge", "/opt/microsoft/msedge/msedge"], externalDir: "/usr/share/microsoft-edge/extensions", userExternalDir: false },
  { id: "brave", store: "chrome", userData: ".config/BraveSoftware/Brave-Browser", binaries: ["/usr/bin/brave-browser", "/opt/brave.com/brave/brave"], externalDir: "/usr/share/brave/extensions", userExternalDir: false },
];

const WINDOWS = [
  { id: "chrome", store: "chrome", userData: "Google/Chrome/User Data", registryKey: "HKCU\\Software\\Google\\Chrome\\Extensions", binaryRel: "Google/Chrome/Application/chrome.exe" },
  { id: "edge", store: "edge", userData: "Microsoft/Edge/User Data", registryKey: "HKCU\\Software\\Microsoft\\Edge\\Extensions", binaryRel: "Microsoft/Edge/Application/msedge.exe" },
  { id: "brave", store: "chrome", userData: "BraveSoftware/Brave-Browser/User Data", registryKey: "HKCU\\Software\\BraveSoftware\\Brave-Browser\\Extensions", binaryRel: "BraveSoftware/Brave-Browser/Application/brave.exe" },
];

export function detectBrowsers({ platform = process.platform, home = homedir(), env = process.env, exists = existsSync } = {}) {
  if (platform === "darwin") {
    return MAC.filter((b) => exists(path.join(home, b.userData))).map((b) => ({
      id: b.id, store: b.store, userDataDir: path.join(home, b.userData), binary: b.binary, bundleId: b.bundleId,
    }));
  }
  if (platform === "linux") {
    return LINUX.filter((b) => exists(path.join(home, b.userData))).map((b) => ({
      id: b.id, store: b.store, userDataDir: path.join(home, b.userData),
      binary: b.binaries.find((p) => exists(p)) ?? null, externalDir: b.externalDir, userExternalDir: b.userExternalDir,
    }));
  }
  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA ?? path.join(home, "AppData", "Local");
    const programFiles = [env.PROGRAMFILES, env["PROGRAMFILES(X86)"], "C:\\Program Files", "C:\\Program Files (x86)"].filter(Boolean);
    return WINDOWS.filter((b) => exists(path.join(localAppData, b.userData))).map((b) => ({
      id: b.id, store: b.store, userDataDir: path.join(localAppData, b.userData), registryKey: b.registryKey,
      binary: programFiles.map((root) => path.join(root, b.binaryRel)).find((p) => exists(p)) ?? null,
    }));
  }
  return [];
}
