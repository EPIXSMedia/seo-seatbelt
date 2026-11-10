import type { Change, CheckResult, Severity, Snapshot } from "../types.js";

const MAX_LINES_PER_SIDE = 10;
const MAX_VALUE_LENGTH = 300;
const SEVERITY_ORDER: Record<Severity, number> = { critical: 0, high: 1, medium: 2 };

export function formatCheckReport(result: CheckResult, baseline: Snapshot, current: Snapshot): string {
  const pageCount = Object.keys(current.pages).length;
  const lines = [
    `SEO Seatbelt — ${pageCount} page${pageCount === 1 ? "" : "s"} on ${current.source} checked against the baseline approved ${baseline.createdAt.slice(0, 10)} (${baseline.source})`,
    "",
  ];
  if (result.changes.length === 0 && result.errors.length === 0) {
    lines.push("✔ No ranking signals changed.");
    return lines.join("\n");
  }
  if (result.changes.length > 0) lines.push(...formatChanges(result.changes), ...versionNote(baseline, current));
  if (result.errors.length > 0) lines.push(...formatErrors(result.errors));
  lines.push(
    "Nothing was changed by this check.",
    "If the site owner approves every change above, record it with:  npx seo-seatbelt baseline",
  );
  return lines.join("\n");
}

function formatChanges(changes: readonly Change[]): string[] {
  const count = changes.length;
  const lines = [`✖ ${count} ranking change${count === 1 ? "" : "s"} need${count === 1 ? "s" : ""} the site owner's approval`, ""];
  const byPage = new Map<string, Change[]>();
  for (const item of [...changes].sort((left, right) => SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity])) {
    const key = item.page ?? "(whole site)";
    byPage.set(key, [...(byPage.get(key) ?? []), item]);
  }
  for (const [page, items] of byPage) {
    lines.push(`  ${page}`);
    for (const item of items) {
      lines.push(`    ✖ [${item.severity}] ${item.summary}`);
      lines.push(...formatSide("-", item.removed), ...formatSide("+", item.added));
    }
    lines.push("");
  }
  return lines;
}

function versionNote(baseline: Snapshot, current: Snapshot): string[] {
  if (baseline.toolVersion === current.toolVersion) return [];
  return [
    `Note: the baseline was recorded by SEO Seatbelt ${baseline.toolVersion ?? "(unknown version)"} and this check ran on ${current.toolVersion ?? "(unknown version)"}.`,
    "A newer version can read some text slightly differently. If the site itself was not changed, approve a fresh baseline.",
    "",
  ];
}

function formatSide(marker: "-" | "+", values: readonly string[]): string[] {
  const shown = values.slice(0, MAX_LINES_PER_SIDE).map((value) => `        ${marker} ${truncate(value)}`);
  const hidden = values.length - shown.length;
  return hidden > 0 ? [...shown, `        ${marker} … and ${hidden} more`] : shown;
}

function formatErrors(errors: CheckResult["errors"]): string[] {
  const count = errors.length;
  const lines = [`⚠ ${count} page${count === 1 ? "" : "s"} could not be read — this is NOT a pass, re-run the check:`];
  for (const { page, error } of errors) lines.push(`    ${page}: ${error}`);
  lines.push("");
  return lines;
}

function truncate(value: string): string {
  return value.length > MAX_VALUE_LENGTH ? `${value.slice(0, MAX_VALUE_LENGTH)}…` : value;
}
