import { multisetDifference } from "../diff/compare.js";
import type { FileRules } from "./files.js";
import { sourceSignals } from "./signals.js";

export interface FileChange {
  /** Path relative to the project root, with forward slashes. */
  path: string;
  /** File content before the change; null when the file is being created. */
  before: string | null;
  /** File content after the change; null when the file is being deleted. */
  after: string | null;
  /** Set when the file is being renamed (git); the old path. */
  renamedFrom?: string | undefined;
  /** Set when the change could not be read (binary, too large, or an edit that does not apply); the reason. */
  unreadable?: string | undefined;
}

export interface GuardFinding {
  path: string;
  summary: string;
  removed: string[];
  added: string[];
}

export function evaluateFileChange(change: FileChange, rules: FileRules): GuardFinding[] {
  const { renamedFrom } = change;
  if (renamedFrom !== undefined && rules.roleOf(renamedFrom) !== rules.roleOf(change.path)) {
    // A rename that changes how a file is read (robots.txt → robots.txt.bak) is a delete plus a create.
    return [
      ...evaluateFileChange({ path: renamedFrom, before: change.before, after: null }, rules),
      ...evaluateFileChange({ path: change.path, before: null, after: change.after }, rules),
    ];
  }
  const role = rules.roleOf(change.path);
  if (role === "ignored") return [];
  const finding = (summary: string, removed: string[] = [], added: string[] = []): GuardFinding[] => [{ path: change.path, summary, removed, added }];
  const bothMissing = change.before === null && change.after === null && renamedFrom === undefined;
  if (change.unreadable !== undefined || bothMissing) {
    if (role === "other" && !rules.isRoute(change.path)) return [];
    return finding(`could not read this file to check it (${change.unreadable ?? "no readable content"})`);
  }
  if (change.before === change.after && renamedFrom === undefined) return [];
  if (role === "protected") return finding("changes a file search engines read directly (robots, sitemap or redirects)");
  if (role === "seatbelt") return change.before === null ? [] : finding("changes SEO Seatbelt's own settings or approved baseline");
  return [...routeFindings(change, rules), ...signalFindings(change, role, finding)];
}

function routeFindings(change: FileChange, rules: FileRules): GuardFinding[] {
  const summary = (text: string): GuardFinding[] => [{ path: change.path, summary: text, removed: [], added: [] }];
  if (change.renamedFrom !== undefined && (rules.isRoute(change.path) || rules.isRoute(change.renamedFrom))) {
    return summary(`renames a page file (${change.renamedFrom} → ${change.path}), which changes its URL`);
  }
  if (change.before === null && rules.isRoute(change.path)) return summary("creates a new page file, which adds a URL to the site");
  if (change.after === null && rules.isRoute(change.path)) return summary("deletes a page file, which removes a URL from the site");
  return [];
}

function signalFindings(
  change: FileChange,
  role: ReturnType<FileRules["roleOf"]>,
  finding: (summary: string, removed: string[], added: string[]) => GuardFinding[],
): GuardFinding[] {
  const { removed, added } = multisetDifference(
    sourceSignals(change.before ?? "", change.path, role),
    sourceSignals(change.after ?? "", change.path, role),
  );
  return removed.length > 0 || added.length > 0 ? finding(describeSignals([...removed, ...added]), removed, added) : [];
}

/** Plain-English subject for each kind of signal line; the first matching prefix wins. */
const SIGNAL_SUBJECTS: readonly (readonly [string, string])[] = [
  ["title", "the page title"],
  ["meta description", "the meta description"],
  ["meta refresh", "a redirect"],
  ["meta ", "robots / indexing tags"],
  ["indexing", "robots / indexing tags"],
  ["link rel=canonical", "the canonical URL"],
  ["link rel=alternate", "hreflang alternates"],
  ["link rel=", "pagination links"],
  ["link", "links or anchor text"],
  ["structured data", "structured data"],
  ["metadata", "page metadata (title / description / robots)"],
  ["wordpress", "WordPress SEO or redirect code"],
  ["frontmatter", "page settings (title, slug, date…)"],
  ["body copy", "the written content"],
  ["config", "redirect / URL / indexing settings"],
  ["routing", "redirects or rewrites in code"],
  ["copy", "page text (translation files)"],
  ["seatbelt", "the SEO Seatbelt hook that guards these changes"],
];

function subjectOf(label: string): string {
  if (label === "h1") return "the H1 heading";
  if (/^h[2-6]$/u.test(label)) return "headings";
  return SIGNAL_SUBJECTS.find(([prefix]) => label.startsWith(prefix))?.[1] ?? label;
}

function describeSignals(signals: readonly string[]): string {
  const subjects = new Set(signals.map((signal) => subjectOf(signal.slice(0, signal.indexOf(":")))));
  return `changes ${[...subjects].join(", ")}`;
}
