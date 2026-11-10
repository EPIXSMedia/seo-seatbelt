#!/usr/bin/env node
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { loadConfig, type LoadedConfig } from "./config.js";
import { compareSnapshots } from "./diff/compare.js";
import { formatCheckReport } from "./diff/report.js";
import { errorMessage } from "./errors.js";
import { evaluateFileChange } from "./guard/evaluate.js";
import { compileFileRules } from "./guard/files.js";
import { ALLOW_ENV, formatFindings, isAllowedByOwner } from "./guard/message.js";
import { parseAgentEvent, runAgentHook } from "./hooks/agent.js";
import { stagedChanges } from "./hooks/git.js";
import { installClaudeHook, installGitHook, writeStarterConfig } from "./install.js";
import { formatJson, writeJsonFile } from "./paths.js";
import { takeSnapshot } from "./snapshot.js";
import { snapshotSchema, type Snapshot } from "./types.js";
import { VERSION } from "./version.js";

/** Exit codes: 0 = nothing to approve, 1 = changes need the owner's approval, 2 = could not check. */
const EXIT_CLEAN = 0;
const EXIT_CHANGES = 1;
const EXIT_ERROR = 2;

const HELP = `SEO Seatbelt ${VERSION} — stops ranking signals changing without the site owner's approval.

Usage: seo-seatbelt <command> [options]

  init [--url <site>] [--git] [--claude]   Create seo-seatbelt.config.json (and optionally install the hooks)
  baseline [--url <host>] [--dir <folder>]  Record the approved state of the site (alias: approve)
  check [--url <host>] [--dir <folder>] [--json]
                                            Compare the site with the approved baseline
                                            exit 0 = unchanged, 1 = changes need approval, 2 = could not check
  guard --staged                            Check staged files before a commit (used by the git hook)
  hook                                      PreToolUse hook for Claude Code and Codex (reads the event on stdin)
  install [--git] [--claude]                Install the git pre-commit hook and/or the Claude Code hook

  --url    check a different host than "baseUrl" — a preview deployment or http://localhost:3000
  --dir    read built HTML files from a folder (dist, out, public) instead of fetching pages

Owner approval: run the agent or commit with ${ALLOW_ENV}=1 once you have reviewed the change.
Docs: https://github.com/EPIXSMedia/seo-seatbelt`;

class UsageError extends Error {
  override name = "UsageError";
}

function out(text: string): void {
  process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
}

function err(text: string): void {
  process.stderr.write(text.endsWith("\n") ? text : `${text}\n`);
}

function parse(argv: readonly string[]): ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>> {
  return parseArgs({ args: [...argv], options: OPTIONS, allowPositionals: true, strict: true });
}

const OPTIONS = {
  url: { type: "string" },
  dir: { type: "string" },
  json: { type: "boolean" },
  staged: { type: "boolean" },
  git: { type: "boolean" },
  claude: { type: "boolean" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
} as const;

function baselinePath(loaded: LoadedConfig): string {
  return path.resolve(loaded.root, loaded.config.baseline);
}

function readBaseline(file: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new UsageError(`No readable baseline at ${file} (${errorMessage(error)}). Run "seo-seatbelt baseline" first.`);
  }
  const parsed = snapshotSchema.safeParse(raw);
  if (!parsed.success) {
    throw new UsageError(`${file} is not an SEO Seatbelt baseline (${z.prettifyError(parsed.error)}). Run "seo-seatbelt baseline" to make a new one.`);
  }
  return parsed.data;
}

async function commandBaseline(values: ReturnType<typeof parse>["values"]): Promise<number> {
  const loaded = loadConfig(process.cwd());
  const snapshot = await takeSnapshot({ config: loaded.config, root: loaded.root, target: values.url, dir: values.dir });
  const failed = Object.entries(snapshot.pages).filter(([, page]) => "error" in page);
  if (failed.length > 0) {
    err(`Baseline NOT saved — ${failed.length} page(s) could not be read, so it would not be a true record:`);
    for (const [page, result] of failed) err(`  ${page}: ${"error" in result ? result.error : ""}`);
    return EXIT_ERROR;
  }
  const file = baselinePath(loaded);
  mkdirSync(path.dirname(file), { recursive: true });
  writeJsonFile(file, snapshot);
  out(`✔ Baseline saved: ${Object.keys(snapshot.pages).length} pages from ${snapshot.source} → ${path.relative(process.cwd(), file) || file}`);
  out("Commit this file. Every later check is compared with it.");
  return EXIT_CLEAN;
}

async function commandCheck(values: ReturnType<typeof parse>["values"]): Promise<number> {
  const loaded = loadConfig(process.cwd());
  const baseline = readBaseline(baselinePath(loaded));
  const current = await takeSnapshot({
    config: loaded.config, root: loaded.root, target: values.url, dir: values.dir, pagePaths: Object.keys(baseline.pages),
  });
  const result = compareSnapshots(baseline, current, {
    wordCount: loaded.config.wordCount,
    ignoreSignals: new Set(loaded.config.ignoreSignals),
  });
  if (values.json === true) {
    out(formatJson({
      baseline: { createdAt: baseline.createdAt, source: baseline.source, toolVersion: baseline.toolVersion },
      current: { source: current.source, toolVersion: current.toolVersion },
      ...result,
    }));
  } else {
    out(formatCheckReport(result, baseline, current));
  }
  if (result.errors.length > 0) return EXIT_ERROR;
  return result.changes.length > 0 ? EXIT_CHANGES : EXIT_CLEAN;
}

async function commandGuardStaged(): Promise<number> {
  if (isAllowedByOwner(process.env)) return EXIT_CLEAN;
  const rules = compileFileRules(loadConfig(process.cwd()).config.guard);
  const { changes } = await stagedChanges(process.cwd());
  const findings = changes.flatMap((change) => evaluateFileChange(change, rules));
  if (findings.length === 0) return EXIT_CLEAN;
  err(formatFindings(findings, `Commit blocked. If the site owner approves, commit again with ${ALLOW_ENV}=1 git commit …`));
  return EXIT_CHANGES;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  return Buffer.concat(chunks).toString("utf8");
}

async function commandHook(): Promise<number> {
  const event = parseAgentEvent(await readStdin());
  const loaded = loadConfig(event.cwd ?? process.cwd());
  const decision = runAgentHook(event, loaded.root, loaded.config.guard, isAllowedByOwner(process.env));
  if (decision.stdout !== "") out(decision.stdout);
  if (decision.stderr !== "") err(decision.stderr);
  return decision.exitCode;
}

/** A hook that cannot check must not wave the change through: it asks, or refuses when the owner chose "deny". */
function hookFailure(error: unknown): number {
  if (isAllowedByOwner(process.env)) return EXIT_CLEAN;
  const reason = `SEO Seatbelt could not check this change (${errorMessage(error)}). Ask the site owner before going ahead if it touches titles, descriptions, headings, links, URLs, robots rules or page text.`;
  if (configuredDecision() === "deny") {
    err(reason);
    return EXIT_ERROR;
  }
  out(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: reason } }));
  return EXIT_CLEAN;
}

function configuredDecision(): "ask" | "deny" {
  try {
    return loadConfig(process.cwd()).config.guard.decision;
  } catch {
    return "ask";
  }
}

async function commandInstall(values: ReturnType<typeof parse>["values"], root: string): Promise<number> {
  const both = values.git !== true && values.claude !== true;
  if (both || values.git === true) out(await installGitHook(root));
  if (both || values.claude === true) out(installClaudeHook(root));
  return EXIT_CLEAN;
}

async function commandInit(values: ReturnType<typeof parse>["values"]): Promise<number> {
  const root = process.cwd();
  out(`✔ Created ${writeStarterConfig(root, values.url)}`);
  if (values.git === true || values.claude === true) await commandInstall(values, root);
  out('Next: run "seo-seatbelt baseline" to record the approved state of the site.');
  return EXIT_CLEAN;
}

async function run(argv: readonly string[]): Promise<number> {
  const { values, positionals } = parse(argv);
  const [command] = positionals;
  if (values.version === true) return printAndExit(VERSION);
  if (values.help === true || command === undefined || command === "help") return printAndExit(HELP);
  switch (command) {
    case "init": return commandInit(values);
    case "baseline":
    case "approve": return commandBaseline(values);
    case "check": return commandCheck(values);
    case "guard":
      if (values.staged !== true) throw new UsageError('Use "seo-seatbelt guard --staged".');
      return commandGuardStaged();
    case "hook": return commandHook().catch(hookFailure);
    case "install": return commandInstall(values, loadConfig(process.cwd()).root);
    default: throw new UsageError(`Unknown command "${command}". Run "seo-seatbelt --help".`);
  }
}

function printAndExit(text: string): number {
  out(text);
  return EXIT_CLEAN;
}

try {
  process.exitCode = await run(process.argv.slice(2));
} catch (error) {
  err(`seo-seatbelt: ${errorMessage(error)}`);
  process.exitCode = EXIT_ERROR;
}
