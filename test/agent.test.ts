import { writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { changesFromEvent, decide, parseAgentEvent, runAgentHook } from "../src/hooks/agent.js";
import { config, page, tempDir } from "./helpers.js";

const guard = config().guard;

function setup(): string {
  const root = tempDir();
  writeFileSync(path.join(root, "index.html"), page());
  return root;
}

function event(root: string, tool: string, input: Record<string, unknown>): string {
  return JSON.stringify({ cwd: root, hook_event_name: "PreToolUse", tool_name: tool, tool_input: input });
}

describe("agent hook", () => {
  it("negative control: an unrelated edit passes silently", () => {
    const root = setup();
    const raw = event(root, "Edit", { file_path: path.join(root, "index.html"), old_string: '<main id="main">', new_string: '<main id="main" class="x">' });
    expect(runAgentHook(parseAgentEvent(raw), root, guard, false)).toEqual({ exitCode: 0, stdout: "", stderr: "" });
  });

  it("positive control: a title edit asks the owner, with the before and after", () => {
    const root = setup();
    const raw = event(root, "Edit", { file_path: "index.html", old_string: "Home Loan EMI Calculator", new_string: "EMI Calculator" });
    const decision = runAgentHook(parseAgentEvent(raw), root, guard, false);
    const output = JSON.parse(decision.stdout) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } };
    expect(decision.exitCode).toBe(0);
    expect(output.hookSpecificOutput.permissionDecision).toBe("ask");
    expect(output.hookSpecificOutput.permissionDecisionReason).toContain("- title: Home Loan EMI Calculator");
    expect(output.hookSpecificOutput.permissionDecisionReason).toContain("+ title: EMI Calculator");
  });

  it("deny mode blocks with exit code 2 and explains on stderr", () => {
    const root = setup();
    const raw = event(root, "Write", { file_path: path.join(root, "robots.txt"), content: "User-agent: *\nDisallow: /\n" });
    const decision = runAgentHook(parseAgentEvent(raw), root, { ...guard, decision: "deny" }, false);
    expect(decision.exitCode).toBe(2);
    expect(decision.stderr).toContain("robots.txt");
  });

  it("lets the owner's approval through", () => {
    const root = setup();
    const raw = event(root, "Write", { file_path: path.join(root, "robots.txt"), content: "x" });
    expect(runAgentHook(parseAgentEvent(raw), root, guard, true).exitCode).toBe(0);
  });

  it("applies every MultiEdit step before judging", () => {
    const root = setup();
    const edits = [{ old_string: "EMI Calculator</h1>", new_string: "Loan EMI</h1>" }, { old_string: "Loan EMI</h1>", new_string: "EMI Calculator</h1>" }];
    expect(changesFromEvent(parseAgentEvent(event(root, "MultiEdit", { file_path: "index.html", edits })), root)[0]?.after).toBe(page());
  });

  it("reads a Codex apply_patch envelope", () => {
    const root = setup();
    const patch = ["*** Begin Patch", "*** Update File: index.html", "@@", "-  <title>Home Loan EMI Calculator</title>", "+  <title>Cheap loans</title>", "*** End Patch"].join("\n");
    const decision = runAgentHook(parseAgentEvent(event(root, "apply_patch", { command: ["apply_patch", patch] })), root, guard, false);
    expect(decision.stdout).toContain("Cheap loans");
  });

  it("decide() stays quiet with no findings", () => {
    expect(decide([], guard, false).stdout).toBe("");
  });
});
