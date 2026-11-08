import { readFileSync } from "node:fs";

export const pageBundle = readFileSync(new URL("./page-bundle.js", import.meta.url), "utf8");
