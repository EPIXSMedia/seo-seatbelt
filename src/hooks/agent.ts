import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { GuardConfig } from "../config.js";
import { evaluateFileChange, type FileChange, type GuardFinding } from "../guard/evaluate.js";
import { compileFileRules } from "../guard/files.js";
import { ALLOW_ENV, formatFindings } from "../guard/message.js";
import { relativeToRoot } from "../paths.js";
import { changesFromPatch } from "./patch.js";

/*
 * PreToolUse hook for AI coding agents. Claude Code sends Edit / Write / MultiEdit calls;
 * Codex sends apply_patch. Both understand the same JSON decision on stdout.
 */

const eventSchema = z.looseObject({
  cwd: z.string().optional(),
  tool_name: z.string().optional(),
  tool_input: z.record(z.string(), z.unknown()).optional(),
});

const editSchema = z.object({ old_string: z.string(), new_string: z.string(), replace_all: z.boolean().optional() });
const writeInput = z.looseObject({ file_path: z.string(), content: z.string() });
const editInput = z.looseObject({ file_path: z.string(), ...editSchema.shape });
const multiEditInput = z.looseObject({ file_path: z.string(), edits: z.array(editSchema) });

export type AgentEvent = z.infer<typeof eventSchema>;

export interface HookDecision {
  /** Exit code for the hook process. 0 = carry on (with any JSON decision), 2 = blocked. */
  exitCode: 0 | 2;
  stdout: string;
  stderr: string;
}

export function parseAgentEvent(raw: string): AgentEvent {
  return eventSchema.parse(JSON.parse(raw === "" ? "{}" : raw));
}

/** The text after an edit, or why the edit cannot be applied to the file as it is now. */
type EditResult = { text: string } | { problem: string };
type Edit = z.infer<typeof editSchema>;

/** Work out what files the tool call would write, with their content before and after. */
export function changesFromEvent(event: AgentEvent, root: string): FileChange[] {
  const input = event.tool_input ?? {};
  const cwd = event.cwd ?? root;
  const write = writeInput.safeParse(input);
  if (write.success) return [change(root, cwd, write.data.file_path, () => ({ text: write.data.content }))];
  const edit = editInput.safeParse(input);
  if (edit.success) return [change(root, cwd, edit.data.file_path, (before) => applyEdit(before, edit.data))];
  const multi = multiEditInput.safeParse(input);
  if (multi.success) return [change(root, cwd, multi.data.file_path, (before) => applyEdits(before, multi.data.edits))];
  const patch = patchText(input);
  if (patch !== null) return changesFromPatch(patch, cwd, root, readCurrent);
  return [];
}

function change(root: string, cwd: string, filePath: string, apply: (before: string | null) => EditResult): FileChange {
  const absolute = path.resolve(cwd, filePath);
  const relative = relativeToRoot(root, absolute);
  const current = readCurrent(absolute);
  const result = apply(current);
  if ("text" in result) return { path: relative, before: current, after: result.text };
  return { path: relative, before: current, after: current, unreadable: result.problem };
}

function readCurrent(absolute: string): string | null {
  return existsSync(absolute) ? readFileSync(absolute, "utf8") : null;
}

function applyEdits(before: string | null, edits: readonly Edit[]): EditResult {
  let text = before;
  for (const edit of edits) {
    const result = applyEdit(text, edit);
    if (!("text" in result)) return result;
    text = result.text;
  }
  return { text: text ?? "" };
}

/** Apply one find-and-replace edit. A file saved with Windows line endings is matched with them removed. */
function applyEdit(before: string | null, edit: Edit): EditResult {
  if (before === null) return edit.old_string === "" ? { text: edit.new_string } : { problem: "the file to edit does not exist" };
  if (edit.old_string === "") return { text: before };
  if (before.includes(edit.old_string)) return { text: replace(before, edit) };
  const lf = (text: string): string => text.replace(/\r\n/gu, "\n");
  const normalized = { ...edit, old_string: lf(edit.old_string), new_string: lf(edit.new_string) };
  if (lf(before).includes(normalized.old_string)) return { text: replace(lf(before), normalized) };
  return { problem: "the text to replace was not found in the file" };
}

function replace(text: string, edit: Edit): string {
  return edit.replace_all === true ? text.split(edit.old_string).join(edit.new_string) : text.replace(edit.old_string, () => edit.new_string);
}

function patchText(input: Record<string, unknown>): string | null {
  const candidates = [input.command, input.cmd, input.patch, input.input];
  for (const candidate of candidates) {
    const text = Array.isArray(candidate) ? candidate.map(String).join("\n") : candidate;
    if (typeof text === "string" && text.includes("*** Begin Patch")) return text;
  }
  return null;
}

export function decide(findings: readonly GuardFinding[], guard: GuardConfig, allowed: boolean): HookDecision {
  if (findings.length === 0 || allowed) return { exitCode: 0, stdout: "", stderr: "" };
  const howToAllow = guard.decision === "ask"
    ? "The owner can approve it at this prompt."
    : `If the owner has already approved it, they can start the agent with ${ALLOW_ENV}=1 for that session.`;
  const reason = formatFindings(findings, howToAllow);
  const stdout = JSON.stringify({
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: guard.decision, permissionDecisionReason: reason },
  });
  return guard.decision === "deny" ? { exitCode: 2, stdout, stderr: reason } : { exitCode: 0, stdout, stderr: "" };
}

export function runAgentHook(event: AgentEvent, root: string, guard: GuardConfig, allowed: boolean): HookDecision {
  const rules = compileFileRules(guard);
  const findings = changesFromEvent(event, root).flatMap((item) => evaluateFileChange(item, rules));
  return decide(findings, guard, allowed);
}
