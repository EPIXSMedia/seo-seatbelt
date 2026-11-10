import path from "node:path";
import type { FileChange } from "../guard/evaluate.js";
import { relativeToRoot } from "../paths.js";

/*
 * Reads a Codex-style `apply_patch` envelope:
 *   *** Begin Patch / *** Add File: p / *** Update File: p / *** Move to: q / *** Delete File: p / *** End Patch
 */

interface PatchOperation {
  kind: "add" | "update" | "delete";
  path: string;
  moveTo: string | null;
  lines: string[];
}

const OPERATION_KINDS: Record<string, PatchOperation["kind"]> = { Add: "add", Update: "update", Delete: "delete" };
const OPERATION_HEADER = /^\*\*\* (Add|Update|Delete) File:\s*(.+)$/u;
const MOVE_HEADER = /^\*\*\* Move to:\s*(.+)$/u;
const ENVELOPE_LINE = /^\*\*\* (Begin Patch|End Patch|End of File)\s*$/u;

type ReadFile = (absolute: string) => string | null;

const PATCH_BEGIN = /^\*\*\* Begin Patch\s*$/u;
const PATCH_END = /^\*\*\* End Patch\s*$/u;
const LINE_BREAK = /\r?\n/u;

export function changesFromPatch(patch: string, cwd: string, root: string, read: ReadFile): FileChange[] {
  const relative = (file: string): string => relativeToRoot(root, path.resolve(cwd, file));
  return parseOperations(patch).map((operation): FileChange => {
    const current = read(path.resolve(cwd, operation.path));
    const before = current === null ? null : current.replace(/\r\n/gu, "\n");
    if (operation.kind === "add") return { path: relative(operation.path), before, after: added(operation.lines).join("\n") };
    if (operation.kind === "delete") return { path: relative(operation.path), before, after: null };
    const target = relative(operation.moveTo ?? operation.path);
    const renamedFrom = operation.moveTo === null ? undefined : relative(operation.path);
    const after = before === null ? null : applyHunks(before, operation.lines);
    if (after !== null) return { path: target, before, after, renamedFrom };
    const unreadable = before === null ? "the file to update does not exist" : "the patch does not match the file as it is now";
    return { path: target, before, after: before, renamedFrom, unreadable };
  });
}

/** The operations inside the first `*** Begin Patch` … `*** End Patch` envelope. */
function parseOperations(patch: string): PatchOperation[] {
  const operations: PatchOperation[] = [];
  let inside = false;
  for (const line of patch.split(LINE_BREAK)) {
    if (!inside) {
      inside = PATCH_BEGIN.test(line);
      continue;
    }
    if (PATCH_END.test(line)) break;
    const header = OPERATION_HEADER.exec(line);
    const current = operations[operations.length - 1];
    const move = MOVE_HEADER.exec(line);
    if (header !== null) {
      const kind = OPERATION_KINDS[header[1] ?? ""] ?? "update";
      operations.push({ kind, path: (header[2] ?? "").trim(), moveTo: null, lines: [] });
    } else if (current !== undefined && move !== null) {
      current.moveTo = (move[1] ?? "").trim();
    } else if (current !== undefined && !ENVELOPE_LINE.test(line)) {
      current.lines.push(line);
    }
  }
  return operations;
}

function added(lines: readonly string[]): string[] {
  return lines.filter((line) => line.startsWith("+")).map((line) => line.slice(1));
}

/** Ways two lines may differ and still be the same line, tried from strictest to loosest (as Codex does). */
const LINE_MATCHERS: readonly ((line: string) => string)[] = [(line) => line, (line) => line.trimEnd(), (line) => line.trim()];

/** Apply each @@ hunk at the next place its old lines appear. Null when a hunk cannot be placed. */
function applyHunks(content: string, lines: readonly string[]): string | null {
  const result = content.split("\n");
  let cursor = 0;
  for (const hunk of splitHunks(lines)) {
    const oldLines = hunk.filter((line) => !line.startsWith("+")).map(stripMarker);
    const newLines = hunk.filter((line) => !line.startsWith("-")).map(stripMarker);
    const at = oldLines.length === 0 ? endOfContent(result) : findLines(result, oldLines, cursor);
    if (at === -1) return null;
    result.splice(at, oldLines.length, ...newLines);
    cursor = at + newLines.length;
  }
  return result.join("\n");
}

/** Where lines added with no context go: after the last line, before a final newline. */
function endOfContent(lines: readonly string[]): number {
  return lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
}

function findLines(haystack: readonly string[], needle: readonly string[], from: number): number {
  for (const normalize of LINE_MATCHERS) {
    for (let start = from; start + needle.length <= haystack.length; start += 1) {
      if (needle.every((line, offset) => normalize(haystack[start + offset] ?? "") === normalize(line))) return start;
    }
  }
  return -1;
}

function splitHunks(lines: readonly string[]): string[][] {
  const hunks: string[][] = [[]];
  for (const line of lines) {
    if (line.startsWith("@@")) hunks.push([]);
    else hunks[hunks.length - 1]?.push(line);
  }
  return hunks.filter((hunk) => hunk.length > 0);
}

function stripMarker(line: string): string {
  return line.startsWith(" ") || line.startsWith("-") || line.startsWith("+") ? line.slice(1) : line;
}
