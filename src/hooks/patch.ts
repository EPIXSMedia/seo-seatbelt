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

export function changesFromPatch(patch: string, cwd: string, root: string, read: ReadFile): FileChange[] {
  const relative = (file: string): string => relativeToRoot(root, path.resolve(cwd, file));
  return parseOperations(patch).map((operation) => {
    const before = read(path.resolve(cwd, operation.path));
    if (operation.kind === "add") return { path: relative(operation.path), before, after: added(operation.lines).join("\n") };
    if (operation.kind === "delete") return { path: relative(operation.path), before, after: null };
    const after = before === null ? null : applyHunks(before, operation.lines);
    const target = relative(operation.moveTo ?? operation.path);
    const renamedFrom = operation.moveTo === null ? undefined : relative(operation.path);
    if (after !== null) return { path: target, before, after, renamedFrom };
    // The hunks could not be placed exactly; compare just the lines being removed and added.
    return { path: target, before: removed(operation.lines).join("\n"), after: added(operation.lines).join("\n"), renamedFrom };
  });
}

function parseOperations(patch: string): PatchOperation[] {
  const operations: PatchOperation[] = [];
  for (const line of patch.split(/\r?\n/u)) {
    const header = OPERATION_HEADER.exec(line);
    const current = operations[operations.length - 1];
    if (header !== null) {
      const kind = OPERATION_KINDS[header[1] ?? ""] ?? "update";
      operations.push({ kind, path: (header[2] ?? "").trim(), moveTo: null, lines: [] });
    } else if (current !== undefined && MOVE_HEADER.test(line)) {
      current.moveTo = (MOVE_HEADER.exec(line)?.[1] ?? "").trim();
    } else if (current !== undefined && !ENVELOPE_LINE.test(line)) {
      current.lines.push(line);
    }
  }
  return operations;
}

function added(lines: readonly string[]): string[] {
  return lines.filter((line) => line.startsWith("+")).map((line) => line.slice(1));
}

function removed(lines: readonly string[]): string[] {
  return lines.filter((line) => line.startsWith("-")).map((line) => line.slice(1));
}

/** Apply each @@ hunk at the next place its old text appears. Null when a hunk cannot be placed. */
function applyHunks(content: string, lines: readonly string[]): string | null {
  let result = content;
  let cursor = 0;
  for (const hunk of splitHunks(lines)) {
    const oldText = hunk.filter((line) => !line.startsWith("+")).map(stripMarker).join("\n");
    const newText = hunk.filter((line) => !line.startsWith("-")).map(stripMarker).join("\n");
    const at = result.indexOf(oldText, cursor);
    if (at === -1) return null;
    result = `${result.slice(0, at)}${newText}${result.slice(at + oldText.length)}`;
    cursor = at + newText.length;
  }
  return result;
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
