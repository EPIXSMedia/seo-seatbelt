/** Collapse runs of whitespace (including non-breaking and zero-width spaces) to single spaces and trim. */
export function normalizeText(value: string): string {
  return value.replace(/[\s\u200b]+/gu, " ").trim();
}

export function nullIfEmpty(value: string | undefined | null): string | null {
  if (value === undefined || value === null) return null;
  const normalized = normalizeText(value);
  return normalized === "" ? null : normalized;
}

/**
 * Turn a link target into a stable key. Same-site URLs become a path (+ query), so a
 * baseline taken on production compares cleanly with a check run on localhost or a
 * preview deployment. Other sites keep their full URL. Fragments are dropped.
 */
export function normalizeUrl(raw: string, pageUrl: string, siteOrigins: readonly string[]): string | null {
  let resolved: URL;
  try {
    resolved = new URL(raw.trim(), pageUrl);
  } catch {
    return null;
  }
  if (resolved.protocol !== "http:" && resolved.protocol !== "https:") return null;
  resolved.hash = "";
  if (siteOrigins.includes(resolved.origin)) {
    return `${resolved.pathname}${resolved.search}`;
  }
  return resolved.href;
}

export function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** Count words the way a reader sees them, in any script (Latin, Devanagari, Telugu…). */
export function countWords(text: string): number {
  return wordsOf(text).length;
}

/** The words of a text: whitespace-separated tokens holding at least one letter or digit. */
export function wordsOf(text: string): string[] {
  return text.split(/\s+/u).filter((token) => /[\p{L}\p{N}]/u.test(token));
}

/** JSON.stringify with object keys sorted, so key order never reads as a change. */
export function stableStringify(value: unknown, ignoreKeys: ReadonlySet<string> = new Set()): string {
  return JSON.stringify(sortKeys(value, ignoreKeys));
}

function sortKeys(value: unknown, ignoreKeys: ReadonlySet<string>): unknown {
  if (Array.isArray(value)) return value.map((item) => sortKeys(item, ignoreKeys));
  if (value === null || typeof value !== "object") return value;
  const entries = Object.entries(value)
    .filter(([key]) => !ignoreKeys.has(key))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => [key, sortKeys(child, ignoreKeys)] as const);
  return Object.fromEntries(entries);
}

/** The `rel` values that change how search engines treat a link, sorted so their order never reads as a change. */
const RANKING_REL_TOKENS = new Set(["nofollow", "sponsored", "ugc"]);

export function rankingRelTokens(rel: string | undefined): string[] {
  return (rel ?? "").toLowerCase().split(/\s+/u).filter((token) => RANKING_REL_TOKENS.has(token)).sort();
}
