import type { GuardFinding } from "./evaluate.js";

const MAX_LINES_PER_SIDE = 6;
const MAX_LINE_LENGTH = 160;

export const ALLOW_ENV = "SEO_SEATBELT_ALLOW";

export function isAllowedByOwner(environment: NodeJS.ProcessEnv): boolean {
  const value = (environment[ALLOW_ENV] ?? "").trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

/** One readable explanation for a person or an AI agent: what changes, and why it needs the owner. */
export function formatFindings(findings: readonly GuardFinding[], howToAllow: string): string {
  const lines = ["SEO Seatbelt: this change can move the site's Google rankings, so it needs the site owner's approval.", ""];
  for (const finding of findings) {
    lines.push(`  ${finding.path} — ${finding.summary}`);
    lines.push(...side("-", finding.removed), ...side("+", finding.added));
  }
  lines.push(
    "",
    "Titles, descriptions, headings, links, canonicals, robots rules, redirects, URLs and written content are ranking signals.",
    "Do not work around this check. Describe the change to the owner and wait for a clear yes.",
    howToAllow,
  );
  return lines.join("\n");
}

function side(marker: "-" | "+", values: readonly string[]): string[] {
  const shown = values.slice(0, MAX_LINES_PER_SIDE).map((value) => {
    const trimmed = value.length > MAX_LINE_LENGTH ? `${value.slice(0, MAX_LINE_LENGTH)}…` : value;
    return `      ${marker} ${trimmed}`;
  });
  const hidden = values.length - shown.length;
  return hidden > 0 ? [...shown, `      ${marker} … and ${hidden} more`] : shown;
}
