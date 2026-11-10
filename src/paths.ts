import { writeFileSync } from "node:fs";
import path from "node:path";

const JSON_INDENT = 2;

/** Write a readable JSON file with a trailing newline, the way people and git expect it. */
export function writeJsonFile(file: string, value: unknown): void {
  writeFileSync(file, `${formatJson(value)}\n`);
}

export function formatJson(value: unknown): string {
  return JSON.stringify(value, null, JSON_INDENT);
}

/** A path relative to the project root with forward slashes; absolute (minus the leading slash) when outside it. */
export function relativeToRoot(root: string, absolute: string): string {
  const relative = path.relative(root, absolute);
  const outside = relative.startsWith("..") || path.isAbsolute(relative);
  return (outside ? absolute : relative).split(path.sep).join("/").replace(/^\/+/u, "");
}
