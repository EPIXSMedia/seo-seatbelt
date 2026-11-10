import { readFileSync } from "node:fs";

interface PackageManifest {
  version: string;
}

function readVersion(): string {
  try {
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as PackageManifest;
    return manifest.version;
  } catch {
    return "0.0.0";
  }
}

export const VERSION = readVersion();
