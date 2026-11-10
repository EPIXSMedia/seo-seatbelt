import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseNameStatus, stagedChanges } from "../src/hooks/git.js";
import { installClaudeHook, installGitHook, writeStarterConfig } from "../src/install.js";
import { page, tempDir, writeFiles } from "./helpers.js";

function git(root: string, ...args: string[]): void {
  execFileSync("git", ["-c", "user.email=test@example.com", "-c", "user.name=Test", ...args], { cwd: root, stdio: "ignore" });
}

function repo(): string {
  const root = tempDir();
  git(root, "init", "-q");
  writeFiles(root, { "index.html": page(), "about.html": page() });
  git(root, "add", ".");
  git(root, "commit", "-qm", "init");
  return root;
}

describe("git staged changes", () => {
  it("parses renames and plain entries from -z output", () => {
    expect(parseNameStatus("M\u0000a.html\u0000R100\u0000old.html\u0000new.html\u0000")).toEqual([
      { status: "M", path: "a.html" },
      { status: "R", renamedFrom: "old.html", path: "new.html" },
    ]);
  });

  it("returns the committed and staged content of each file", async () => {
    const root = repo();
    writeFileSync(path.join(root, "index.html"), page({ title: "Staged title" }));
    git(root, "mv", "about.html", "about-us.html");
    git(root, "add", ".");
    const { changes } = await stagedChanges(root);
    const index = changes.find((change) => change.path === "index.html");
    expect(index?.before).toBe(page());
    expect(index?.after).toContain("Staged title");
    expect(changes.find((change) => change.path === "about-us.html")?.renamedFrom).toBe("about.html");
  });
});

describe("installer", () => {
  it("writes a starter config once, and refuses to overwrite it", () => {
    const root = tempDir();
    const file = writeStarterConfig(root, "https://example.com/");
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ baseUrl: "https://example.com", discoverFromSitemap: true });
    expect(() => writeStarterConfig(root, undefined)).toThrow("already exists");
  });

  it("installs the git hook once and never overwrites someone else's hook", async () => {
    const root = repo();
    expect(await installGitHook(root)).toContain("installed");
    expect(await installGitHook(root)).toContain("already runs");
    const other = repo();
    writeFiles(other, { ".git/hooks/pre-commit": "#!/bin/sh\nnpm test\n" });
    await expect(installGitHook(other)).rejects.toThrow("Add this line");
  });

  it("does not write into a custom hooks folder such as Husky's", async () => {
    const root = repo();
    git(root, "config", "core.hooksPath", ".husky");
    await expect(installGitHook(root)).rejects.toThrow("core.hooksPath");
  });

  it("merges into existing Claude settings without losing them", () => {
    const root = tempDir();
    writeFiles(root, { ".claude/settings.json": JSON.stringify({ permissions: { allow: ["Bash(ls)"] }, hooks: { PreToolUse: [{ matcher: "Bash", hooks: [] }] } }) });
    installClaudeHook(root);
    installClaudeHook(root);
    const settings = JSON.parse(readFileSync(path.join(root, ".claude/settings.json"), "utf8")) as { permissions: unknown; hooks: { PreToolUse: unknown[] } };
    expect(settings.permissions).toEqual({ allow: ["Bash(ls)"] });
    expect(settings.hooks.PreToolUse).toHaveLength(2);
    expect(existsSync(path.join(root, ".claude/settings.json"))).toBe(true);
  });
});
