import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { FileChange } from "../guard/evaluate.js";

const run = promisify(execFile);
const MAX_BUFFER = 64 * 1024 * 1024;
const MAX_FILE_BYTES = 4 * 1024 * 1024;

interface StagedEntry {
  status: string;
  path: string;
  renamedFrom?: string;
}

async function git(args: readonly string[], cwd: string): Promise<string> {
  const { stdout } = await run("git", [...args], { cwd, maxBuffer: MAX_BUFFER, encoding: "utf8" });
  return stdout;
}

type Blob = { kind: "content"; text: string } | { kind: "missing" } | { kind: "unreadable"; reason: string };

/** A blob's content; "missing" when it does not exist at that revision, "unreadable" when it is too big, binary or git fails. */
async function blob(spec: string, cwd: string): Promise<Blob> {
  let size: number;
  try {
    size = Number((await git(["cat-file", "-s", spec], cwd)).trim());
  } catch {
    return { kind: "missing" };
  }
  if (size > MAX_FILE_BYTES) return { kind: "unreadable", reason: "larger than 4 MiB" };
  try {
    const text = await git(["cat-file", "blob", spec], cwd);
    return text.includes("\u0000") ? { kind: "unreadable", reason: "binary content" } : { kind: "content", text };
  } catch {
    return { kind: "unreadable", reason: "git could not read it" };
  }
}

const NOT_PRESENT: Blob = { kind: "missing" };

function textOf(value: Blob): string | null {
  return value.kind === "content" ? value.text : null;
}

export async function gitRoot(cwd: string): Promise<string> {
  return (await git(["rev-parse", "--show-toplevel"], cwd)).trim();
}

export function parseNameStatus(output: string): StagedEntry[] {
  const parts = output.split("\u0000").filter((part) => part !== "");
  const entries: StagedEntry[] = [];
  for (let index = 0; index < parts.length; ) {
    const status = parts[index] ?? "";
    if (status.startsWith("R") || status.startsWith("C")) {
      entries.push({ status: status.charAt(0), renamedFrom: parts[index + 1] ?? "", path: parts[index + 2] ?? "" });
      index += 3;
    } else {
      entries.push({ status: status.charAt(0), path: parts[index + 1] ?? "" });
      index += 2;
    }
  }
  return entries;
}

/** Every staged file with its committed (HEAD) and staged content, ready for the guard. */
export async function stagedChanges(cwd: string): Promise<{ root: string; changes: FileChange[] }> {
  const root = await gitRoot(cwd);
  const entries = parseNameStatus(await git(["diff", "--cached", "--name-status", "-z", "-M", "--no-ext-diff"], root));
  const changes = await Promise.all(entries.map(async (entry): Promise<FileChange> => {
    const before = entry.status === "A" ? NOT_PRESENT : await blob(`HEAD:${entry.renamedFrom ?? entry.path}`, root);
    const after = entry.status === "D" ? NOT_PRESENT : await blob(`:${entry.path}`, root);
    const unreadable = [before, after].find((side) => side.kind === "unreadable");
    return {
      path: entry.path,
      before: textOf(before),
      after: textOf(after),
      renamedFrom: entry.status === "R" ? entry.renamedFrom : undefined,
      unreadable: unreadable?.kind === "unreadable" ? unreadable.reason : undefined,
    };
  }));
  return { root, changes };
}

/** The custom hooks folder (Husky, a shared global folder…) when one is configured, else null. */
export async function customHooksPath(cwd: string): Promise<string | null> {
  try {
    const value = (await git(["config", "--get", "core.hooksPath"], cwd)).trim();
    return value === "" ? null : value;
  } catch {
    return null;
  }
}

export async function gitHooksDir(cwd: string): Promise<string> {
  return (await git(["rev-parse", "--path-format=absolute", "--git-path", "hooks"], cwd)).trim();
}
