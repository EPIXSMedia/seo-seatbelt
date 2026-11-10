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
}

export interface GuardFinding {
  path: string;
  summary: string;
  removed: string[];
  added: string[];
}

export function evaluateFileChange(change: FileChange, rules: FileRules): GuardFinding[] {
  const role = rules.roleOf(change.path);
  if (role === "ignored" || (change.before === change.after && change.renamedFrom === undefined)) return [];
  const findings: GuardFinding[] = [];
  const finding = (summary: string, removed: string[] = [], added: string[] = []): void => {
    findings.push({ path: change.path, summary, removed, added });
  };
  if (role === "protected") {
    finding("changes a file search engines read directly (robots, sitemap or redirects)");
    return findings;
  }
  if (change.renamedFrom !== undefined && (rules.isRoute(change.path) || rules.isRoute(change.renamedFrom))) {
    finding(`renames a page file (${change.renamedFrom} → ${change.path}), which changes its URL`);
  } else if (change.before === null && rules.isRoute(change.path)) {
    finding("creates a new page file, which adds a URL to the site");
  } else if (change.after === null && rules.isRoute(change.path)) {
    finding("deletes a page file, which removes a URL from the site");
  }
  const isContent = rules.isContent(change.path);
  const { removed, added } = multisetDifference(
    sourceSignals(change.before ?? "", change.path, role, isContent),
    sourceSignals(change.after ?? "", change.path, role, isContent),
  );
  if (removed.length > 0 || added.length > 0) finding(describeSignals([...removed, ...added]), removed, added);
  return findings;
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
