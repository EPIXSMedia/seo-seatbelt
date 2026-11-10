import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { CONFIG_FILE_NAME } from "./config.js";
import { errorMessage } from "./errors.js";
import { customHooksPath, gitHooksDir } from "./hooks/git.js";
import { writeJsonFile } from "./paths.js";

const HOOK_MARKER = "seo-seatbelt";
const EXECUTABLE_MODE = 0o755;
const AGENT_TOOLS_MATCHER = "Edit|Write|MultiEdit";
/** Claude Code lets an edit through when a hook crashes with any exit code but 2; this makes a crash block it. */
const BLOCK_ON_FAILURE = " || exit 2";

export class InstallError extends Error {
  override name = "InstallError";
}

/** The command an installed hook runs: the project's own copy when there is one, otherwise a global install. */
export function seatbeltCommand(root: string, subcommand: string): string {
  const local = existsSync(path.join(root, "node_modules", ".bin", "seo-seatbelt"));
  return local ? `npx --no-install seo-seatbelt ${subcommand}` : `seo-seatbelt ${subcommand}`;
}

export function writeStarterConfig(root: string, baseUrl: string | undefined): string {
  const file = path.join(root, CONFIG_FILE_NAME);
  if (existsSync(file)) throw new InstallError(`${CONFIG_FILE_NAME} already exists — leaving it as it is.`);
  const config = {
    ...(baseUrl === undefined ? {} : { baseUrl: baseUrl.replace(/\/+$/u, "") }),
    pages: ["/"],
    discoverFromSitemap: baseUrl !== undefined,
    maxPages: 50,
    baseline: ".seo-seatbelt/baseline.json",
    ignoreSelectors: [],
    guard: { decision: "ask" },
  };
  writeJsonFile(file, config);
  return file;
}

export async function installGitHook(root: string): Promise<string> {
  const line = seatbeltCommand(root, "guard --staged");
  const custom = await customHooksPath(root);
  if (custom !== null) {
    throw new InstallError(`This repository runs its hooks from "${custom}" (core.hooksPath), so the hook was not installed there. Add this line to its pre-commit hook:\n  ${line} || exit 1`);
  }
  const hooksDir = await gitHooksDir(root);
  const file = path.join(hooksDir, "pre-commit");
  if (existsSync(file)) {
    const existing = readFileSync(file, "utf8");
    if (existing.includes(HOOK_MARKER)) return `${file} already runs SEO Seatbelt`;
    throw new InstallError(`${file} already exists. Add this line to it yourself (before any final "exit"):\n  ${line} || exit 1`);
  }
  mkdirSync(hooksDir, { recursive: true });
  writeFileSync(file, `#!/bin/sh\n# ${HOOK_MARKER}: stop commits that change ranking signals without the owner's approval\n${line} || exit 1\n`);
  chmodSync(file, EXECUTABLE_MODE);
  return `installed ${file}`;
}

const hookEntrySchema = z.looseObject({ matcher: z.string().optional(), hooks: z.array(z.looseObject({ command: z.string().optional() })).optional() });
const settingsSchema = z.looseObject({ hooks: z.looseObject({ PreToolUse: z.array(hookEntrySchema).optional() }).optional() });

type HookCommand = z.infer<typeof hookEntrySchema>["hooks"] extends (infer Hook)[] | undefined ? Hook : never;

function isSeatbeltHook(hook: HookCommand): boolean {
  return (hook.command ?? "").includes(HOOK_MARKER);
}

function blocksOnFailure(hook: HookCommand): boolean {
  return (hook.command ?? "").includes(BLOCK_ON_FAILURE.trim());
}

/** An SEO Seatbelt hook installed by an older version gains `|| exit 2`; other hooks are left alone. */
function withBlockOnFailure(hook: HookCommand): HookCommand {
  if (!isSeatbeltHook(hook) || blocksOnFailure(hook)) return hook;
  return { ...hook, command: `${hook.command ?? ""}${BLOCK_ON_FAILURE}` };
}

export function installClaudeHook(root: string): string {
  const file = path.join(root, ".claude", "settings.json");
  let settings: z.infer<typeof settingsSchema> = {};
  if (existsSync(file)) {
    try {
      settings = settingsSchema.parse(JSON.parse(readFileSync(file, "utf8")));
    } catch (error) {
      throw new InstallError(`${file} could not be read (${errorMessage(error)}) — fix it, then run install again.`);
    }
  }
  const preToolUse = settings.hooks?.PreToolUse ?? [];
  const command = `${seatbeltCommand(root, "hook")}${BLOCK_ON_FAILURE}`;
  const existing = preToolUse.flatMap((entry) => entry.hooks ?? []).filter(isSeatbeltHook);
  if (existing.length > 0 && existing.every(blocksOnFailure)) return `${file} already runs SEO Seatbelt`;
  const upgraded = preToolUse.map((entry) => ({ ...entry, hooks: entry.hooks?.map(withBlockOnFailure) }));
  const entry = { matcher: AGENT_TOOLS_MATCHER, hooks: [{ type: "command", command }] };
  const entries = existing.length > 0 ? upgraded : [...preToolUse, entry];
  const next = { ...settings, hooks: { ...(settings.hooks ?? {}), PreToolUse: entries } };
  mkdirSync(path.dirname(file), { recursive: true });
  writeJsonFile(file, next);
  return existing.length > 0 ? `updated the Claude Code hook in ${file} so a crash blocks the edit` : `installed the Claude Code hook in ${file}`;
}
