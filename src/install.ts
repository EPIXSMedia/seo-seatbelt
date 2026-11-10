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
  const already = preToolUse.some((entry) => (entry.hooks ?? []).some((hook) => (hook.command ?? "").includes(HOOK_MARKER)));
  if (already) return `${file} already runs SEO Seatbelt`;
  const entry = { matcher: AGENT_TOOLS_MATCHER, hooks: [{ type: "command", command: seatbeltCommand(root, "hook") }] };
  const next = { ...settings, hooks: { ...(settings.hooks ?? {}), PreToolUse: [...preToolUse, entry] } };
  mkdirSync(path.dirname(file), { recursive: true });
  writeJsonFile(file, next);
  return `installed the Claude Code hook in ${file}`;
}
