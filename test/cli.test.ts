import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { page, tempDir, writeFiles } from "./helpers.js";

const CLI = path.resolve(import.meta.dirname, "../dist/cli.js");

function cli(cwd: string, args: string[], input = "", env: Record<string, string> = {}): { status: number | null; stdout: string; stderr: string } {
  if (!existsSync(CLI)) throw new Error("Run `npm run build` before the CLI tests.");
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd, input, encoding: "utf8", env: { ...process.env, SEO_SEATBELT_ALLOW: "", ...env } });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function git(root: string, ...args: string[]): void {
  const result = spawnSync("git", ["-c", "user.email=test@example.com", "-c", "user.name=Test", ...args], { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
}

describe("seo-seatbelt command", () => {
  it("baseline → check is clean, then a changed title exits 1, and a missing page is not a pass", () => {
    const root = tempDir();
    writeFiles(root, { "seo-seatbelt.config.json": JSON.stringify({ baseUrl: "https://example.com", dir: "site" }), "site/index.html": page() });
    expect(cli(root, ["baseline"]).status).toBe(0);
    const clean = cli(root, ["check"]);
    expect(clean.status).toBe(0);
    expect(clean.stdout).toContain("No ranking signals changed");

    writeFiles(root, { "site/index.html": page({ title: "Changed" }) });
    const changed = cli(root, ["check", "--json"]);
    expect(changed.status).toBe(1);
    expect(JSON.parse(changed.stdout)).toMatchObject({ changes: [{ page: "/", signal: "title", added: ["Changed"] }] });
  });

  it("exits 2 when there is no baseline to compare with", () => {
    const root = tempDir();
    writeFiles(root, { "seo-seatbelt.config.json": JSON.stringify({ dir: "." }), "index.html": page() });
    const missing = cli(root, ["check"]);
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain("No readable baseline");
  });

  it("guard --staged blocks a staged title change unless the owner allows it", () => {
    const root = tempDir();
    git(root, "init", "-q");
    writeFiles(root, { "index.html": page() });
    git(root, "add", ".");
    git(root, "commit", "-qm", "init");
    writeFileSync(path.join(root, "index.html"), page({ title: "Changed" }));
    git(root, "add", ".");
    const blocked = cli(root, ["guard", "--staged"]);
    expect(blocked.status).toBe(1);
    expect(blocked.stderr).toContain("+ title: Changed");
    expect(cli(root, ["guard", "--staged"], "", { SEO_SEATBELT_ALLOW: "1" }).status).toBe(0);
  });

  it("hook asks the owner for a risky edit and hands over (never waves through) an unreadable event", () => {
    const root = tempDir();
    writeFiles(root, { "index.html": page() });
    const raw = JSON.stringify({ cwd: root, tool_name: "Write", tool_input: { file_path: "robots.txt", content: "Disallow: /" } });
    expect(JSON.parse(cli(root, ["hook"], raw).stdout)).toMatchObject({ hookSpecificOutput: { permissionDecision: "ask" } });
    const broken = cli(root, ["hook"], "{not json");
    expect(broken.status).toBe(0);
    expect(JSON.parse(broken.stdout)).toMatchObject({ hookSpecificOutput: { permissionDecision: "ask" } });
  });

  it("prints help and rejects unknown commands", () => {
    const root = tempDir();
    expect(cli(root, ["--help"]).stdout).toContain("Usage: seo-seatbelt");
    expect(cli(root, ["nope"]).status).toBe(2);
  });
});
