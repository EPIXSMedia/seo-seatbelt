import type { Change, CheckResult, PageSignals, Severity, SignalName, SiteSignals, Snapshot } from "../types.js";
import { countWords } from "../normalize.js";
import { isPageError } from "../types.js";
import { wordsChanged } from "./words.js";

export interface CompareOptions {
  wordCount: { percent: number; words: number };
  ignoreSignals: ReadonlySet<SignalName>;
}

type ScalarSignal = "status" | "xRobotsTag" | "lang" | "title" | "metaDescription" | "canonical";
type ListSignal = "redirects" | "metaRobots" | "hreflang" | "pagination" | "links" | "structuredData";

const SEVERITY: Record<SignalName, Severity> = {
  page: "critical", status: "critical", redirects: "critical", xRobotsTag: "critical", metaRobots: "critical",
  canonical: "critical", robotsTxt: "critical", sitemapUrls: "critical",
  title: "high", metaDescription: "high", hreflang: "high",
  lang: "medium", pagination: "medium", headings: "medium", links: "medium", wordCount: "medium", bodyCopy: "medium", structuredData: "medium",
};

const LABEL: Record<SignalName, string> = {
  page: "Page", status: "HTTP status", redirects: "Redirects", xRobotsTag: "X-Robots-Tag header",
  lang: "Page language", title: "Title", metaDescription: "Meta description", metaRobots: "Robots meta tag",
  canonical: "Canonical URL", hreflang: "hreflang alternates", pagination: "Pagination links", headings: "Headings",
  links: "Links", wordCount: "Word count", bodyCopy: "Body copy", structuredData: "Structured data (JSON-LD)",
  robotsTxt: "robots.txt", sitemapUrls: "Sitemap URLs",
};

const SCALAR_SIGNALS: readonly ScalarSignal[] = ["status", "xRobotsTag", "canonical", "title", "metaDescription", "lang"];
const LIST_SIGNALS: readonly ListSignal[] = ["redirects", "metaRobots", "hreflang", "pagination", "links", "structuredData"];
const PERCENT = 100;

export function compareSnapshots(baseline: Snapshot, current: Snapshot, options: CompareOptions): CheckResult {
  const changes = compareSite(baseline.site, current.site);
  const errors: CheckResult["errors"] = [];
  for (const [page, now] of Object.entries(current.pages)) {
    const before = baseline.pages[page];
    if (isPageError(now)) {
      errors.push({ page, error: now.error });
    } else if (before === undefined) {
      changes.push(change(page, "page", "New page — it is not in the approved baseline", [], [page]));
    } else if (isPageError(before)) {
      errors.push({ page, error: `the baseline has no reading for this page (${before.error}) — approve a fresh baseline` });
    } else {
      changes.push(...comparePage(page, before, now, options));
    }
  }
  return { changes: changes.filter((item) => !options.ignoreSignals.has(item.signal)), errors };
}

function change(page: string | null, signal: SignalName, summary: string, removed: string[], added: string[]): Change {
  return { page, signal, severity: SEVERITY[signal], summary, removed, added };
}

function compareSite(before: SiteSignals, after: SiteSignals): Change[] {
  const changes: Change[] = [];
  for (const signal of ["robotsTxt", "sitemapUrls"] as const) {
    const left = before[signal];
    const right = after[signal];
    if (left === null && right === null) continue;
    if (left === null || right === null) {
      const summary = `${LABEL[signal]} ${left === null ? "appeared" : "disappeared"}`;
      changes.push(change(null, signal, summary, left ?? [], right ?? []));
      continue;
    }
    const { removed, added } = multisetDifference(left, right);
    if (removed.length > 0 || added.length > 0) changes.push(change(null, signal, `${LABEL[signal]} changed`, removed, added));
  }
  return changes;
}

function comparePage(page: string, before: PageSignals, after: PageSignals, options: CompareOptions): Change[] {
  const changes: Change[] = [];
  for (const signal of SCALAR_SIGNALS) {
    const left = before[signal];
    const right = after[signal];
    if (left === right) continue;
    changes.push(change(page, signal, `${LABEL[signal]} changed`, left === null ? [] : [String(left)], right === null ? [] : [String(right)]));
  }
  for (const signal of LIST_SIGNALS) {
    const { removed, added } = multisetDifference(before[signal], after[signal]);
    if (removed.length === 0 && added.length === 0) continue;
    changes.push(change(page, signal, listSummary(signal, removed.length, added.length), removed, added));
  }
  const headings = compareHeadings(page, before.headings, after.headings);
  if (headings !== null) changes.push(headings);
  const words = compareWordCount(page, before.wordCount, after.wordCount, options.wordCount);
  if (words !== null) changes.push(words);
  const copy = compareBodyCopy(page, before.bodyCopy, after.bodyCopy, options.wordCount);
  if (copy !== null) changes.push(copy);
  return changes;
}

function listSummary(signal: ListSignal, removed: number, added: number): string {
  const parts = [removed > 0 ? `${removed} removed` : "", added > 0 ? `${added} added` : ""].filter((part) => part !== "");
  return `${LABEL[signal]} changed (${parts.join(", ")})`;
}

function compareHeadings(page: string, before: string[], after: string[]): Change | null {
  const { removed, added } = multisetDifference(before, after);
  if (removed.length === 0 && added.length === 0) {
    if (before.join("\n") === after.join("\n")) return null;
    return change(page, "headings", "Headings were reordered", before, after);
  }
  const touchesH1 = [...removed, ...added].some((heading) => heading.startsWith("h1:"));
  const item = change(page, "headings", `${touchesH1 ? "H1 / headings" : "Headings"} changed`, removed, added);
  return touchesH1 ? { ...item, severity: "high" } : item;
}

function compareWordCount(page: string, before: number, after: number, limit: CompareOptions["wordCount"]): Change | null {
  const delta = Math.abs(after - before);
  const percent = percentChange(before, delta);
  if (delta <= limit.words || percent <= limit.percent) return null;
  const direction = after > before ? "+" : "-";
  return change(page, "wordCount", `Word count changed ${before} → ${after} (${direction}${percent.toFixed(1)}%)`, [String(before)], [String(after)]);
}

/**
 * Rewritten copy, measured in words added plus words removed, so a rewrite that keeps the
 * word count is still seen. Like the word count, it is flagged only past both limits.
 */
function compareBodyCopy(page: string, before: string[] | undefined, after: string[] | undefined, limit: CompareOptions["wordCount"]): Change | null {
  if (before === undefined || after === undefined) return null;
  const { removed, added } = multisetDifference(before, after);
  if (removed.length === 0 && added.length === 0) return null;
  const changed = wordsChanged(removed.join(" "), added.join(" "));
  const percent = percentChange(countWords(before.join(" ")), changed);
  if (changed <= limit.words || percent <= limit.percent) return null;
  return change(page, "bodyCopy", `Body copy rewritten (${changed} words added or removed, ${percent.toFixed(1)}%)`, removed, added);
}

function percentChange(before: number, delta: number): number {
  if (before === 0) return delta === 0 ? 0 : PERCENT;
  return (delta / before) * PERCENT;
}

/** Items in `before` but not `after`, and the reverse, counting duplicates. */
export function multisetDifference(before: readonly string[], after: readonly string[]): { removed: string[]; added: string[] } {
  const counts = new Map<string, number>();
  for (const item of before) counts.set(item, (counts.get(item) ?? 0) + 1);
  const added: string[] = [];
  for (const item of after) {
    const remaining = counts.get(item) ?? 0;
    if (remaining > 0) counts.set(item, remaining - 1);
    else added.push(item);
  }
  const removed = [...counts.entries()].flatMap(([item, count]) => Array.from({ length: count }, () => item));
  return { removed, added };
}
