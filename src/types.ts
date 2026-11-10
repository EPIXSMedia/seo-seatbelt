import { z } from "zod";

/** Everything about one page that search engines use to decide rankings. */
export const pageSignalsSchema = z.object({
  status: z.number().int(),
  /** Redirect chain the page went through, as site paths or absolute URLs. Empty when none. */
  redirects: z.array(z.string()),
  xRobotsTag: z.string().nullable(),
  lang: z.string().nullable(),
  title: z.string().nullable(),
  metaDescription: z.string().nullable(),
  metaRobots: z.array(z.string()),
  canonical: z.string().nullable(),
  hreflang: z.array(z.string()),
  pagination: z.array(z.string()),
  headings: z.array(z.string()),
  links: z.array(z.string()),
  wordCount: z.number().int().min(0),
  /** Blocks of body copy. Missing in baselines recorded before it was read; then only the word count is compared. */
  bodyCopy: z.array(z.string()).optional(),
  structuredData: z.array(z.string()),
});

export const pageErrorSchema = z.object({ error: z.string() });

export const siteSignalsSchema = z.object({
  robotsTxt: z.array(z.string()).nullable(),
  sitemapUrls: z.array(z.string()).nullable(),
});

/** The saved, approved record of a site (also the shape of every later reading). */
export const snapshotSchema = z.object({
  tool: z.literal("seo-seatbelt"),
  schemaVersion: z.literal(1),
  /** The SEO Seatbelt version that took the reading; a different version may read some text differently. */
  toolVersion: z.string().optional(),
  createdAt: z.string(),
  source: z.string(),
  site: siteSignalsSchema,
  pages: z.record(z.string(), z.union([pageErrorSchema, pageSignalsSchema])),
});

export type PageSignals = z.infer<typeof pageSignalsSchema>;
export type PageError = z.infer<typeof pageErrorSchema>;
export type PageResult = PageSignals | PageError;
export type SiteSignals = z.infer<typeof siteSignalsSchema>;
export type Snapshot = z.infer<typeof snapshotSchema>;

export type Severity = "critical" | "high" | "medium";

export type SignalName =
  | "page"
  | "status"
  | "redirects"
  | "xRobotsTag"
  | "lang"
  | "title"
  | "metaDescription"
  | "metaRobots"
  | "canonical"
  | "hreflang"
  | "pagination"
  | "headings"
  | "links"
  | "wordCount"
  | "bodyCopy"
  | "structuredData"
  | "robotsTxt"
  | "sitemapUrls";

export interface Change {
  /** Site path of the page, or null for site-wide files such as robots.txt. */
  page: string | null;
  signal: SignalName;
  severity: Severity;
  summary: string;
  removed: string[];
  added: string[];
}

export interface CheckResult {
  changes: Change[];
  /** Pages that could not be read. A failed read is never a pass. */
  errors: { page: string; error: string }[];
}

export function isPageError(result: PageResult): result is PageError {
  return "error" in result;
}
