import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

const HTML_EXTENSIONS = new Set([".html", ".htm"]);

/** Map a built file to the URL path a static host serves it at. */
export function filePathToUrlPath(relativeFile: string, cleanUrls: boolean): string {
  const posix = relativeFile.split(path.sep).join("/");
  if (posix === "index.html") return "/";
  if (posix.endsWith("/index.html")) return `/${posix.slice(0, -"index.html".length)}`;
  if (cleanUrls) return `/${posix.replace(/\.html?$/u, "")}`;
  return `/${posix}`;
}

/** Every HTML file under a build folder, keyed by the URL path it would be served at. */
export async function listHtmlFiles(dir: string, cleanUrls: boolean): Promise<Map<string, string>> {
  if (!existsSync(dir)) throw new Error(`build folder not found: ${dir}`);
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const pages = new Map<string, string>();
  for (const entry of entries) {
    if (!HTML_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
    const absolute = path.join(entry.parentPath, entry.name);
    if (!entry.isFile() && !(entry.isSymbolicLink() && (await isLinkedFile(absolute)))) continue;
    pages.set(filePathToUrlPath(path.relative(dir, absolute), cleanUrls), absolute);
  }
  return new Map([...pages.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

export async function readOptionalFile(file: string): Promise<string | null> {
  if (!existsSync(file)) return null;
  return readFile(file, "utf8");
}

/** Whether a path is a file once links are followed (some builds link pages in rather than copying them). */
async function isLinkedFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

/** A file named by a URL path, read only when it sits inside `dir`. Null when there is none. */
export async function readFileInside(dir: string, urlPath: string): Promise<string | null> {
  let relative: string;
  try {
    relative = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  const file = path.resolve(dir, `./${relative}`);
  const inside = path.relative(dir, file);
  if (inside === ".." || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)) return null;
  if (!(await isLinkedFile(file))) return null;
  return readFile(file, "utf8");
}
