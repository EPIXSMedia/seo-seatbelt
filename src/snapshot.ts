import path from "node:path";
import type { SeatbeltConfig } from "./config.js";
import { errorMessage } from "./errors.js";
import { extractPageSignals, type ExtractOptions } from "./extract/page.js";
import { normalizeSitemapUrls, parseRobotsTxt, parseSitemap, sitemapsListedInRobots } from "./extract/site.js";
import { normalizeUrl, originOf } from "./normalize.js";
import { mapWithConcurrency } from "./pool.js";
import { listHtmlFiles, readOptionalFile } from "./sources/directory.js";
import { fetchDocument, FetchError } from "./sources/http.js";
import type { PageResult, PageSignals, SiteSignals, Snapshot } from "./types.js";
import { VERSION } from "./version.js";

const MAX_SITEMAP_FILES = 50;
const MISSING_STATUSES = new Set([404, 410]);
const DIRECTORY_ORIGIN = "http://localhost";
const CLOSING_HTML_TAG = /<\/html\s*>/iu;
const TOO_MANY_REQUESTS = 429;
const FIRST_SERVER_ERROR = 500;

export interface SnapshotOptions {
  config: SeatbeltConfig;
  /** Folder the config lives in; a relative `dir` resolves against it. */
  root: string;
  /** Check this host instead of `baseUrl` (a preview deployment, or http://localhost:3000). */
  target?: string | undefined;
  /** Read built HTML from this folder instead of fetching. */
  dir?: string | undefined;
  /** Exactly these page paths (used when checking against a baseline). */
  pagePaths?: readonly string[] | undefined;
}

export class SnapshotError extends Error {
  override name = "SnapshotError";
}

export async function takeSnapshot(options: SnapshotOptions): Promise<Snapshot> {
  const dir = options.dir ?? options.config.dir;
  if (dir !== undefined) return snapshotDirectory(path.resolve(options.root, dir), options);
  const target = options.target ?? options.config.baseUrl;
  if (target === undefined) {
    throw new SnapshotError('Nothing to check: set "baseUrl" (or "dir") in seo-seatbelt.config.json, or pass --url / --dir.');
  }
  return snapshotHost(target.replace(/\/+$/u, ""), options);
}

function siteOriginsFor(config: SeatbeltConfig, extra: string): string[] {
  const origins = [config.baseUrl, extra].map((url) => (url === undefined ? null : originOf(url)));
  return [...new Set(origins.filter((origin): origin is string => origin !== null))];
}

function extractOptions(config: SeatbeltConfig, pageUrl: string, siteOrigins: readonly string[]): ExtractOptions {
  return {
    pageUrl,
    siteOrigins,
    ignoreSelectors: config.ignoreSelectors,
    ignoreJsonLdKeys: new Set(config.ignoreJsonLdKeys),
  };
}

function finishSnapshot(source: string, site: SiteSignals, pages: Map<string, PageResult>): Snapshot {
  const sorted = [...pages.entries()].sort(([left], [right]) => left.localeCompare(right));
  return {
    tool: "seo-seatbelt",
    schemaVersion: 1,
    toolVersion: VERSION,
    createdAt: new Date().toISOString(),
    source,
    site,
    pages: Object.fromEntries(sorted),
  };
}

function choosePaths(options: SnapshotOptions, discovered: readonly string[]): string[] {
  if (options.pagePaths !== undefined) return [...options.pagePaths];
  const configured = options.config.pages.map((page) => (page.startsWith("/") ? page : `/${page}`));
  const extra = options.config.discoverFromSitemap ? discovered.filter((page) => page.startsWith("/")) : [];
  return [...new Set([...configured, ...extra])].slice(0, options.config.maxPages);
}

/* ---------------------------------------------------------------- live host */

async function snapshotHost(target: string, options: SnapshotOptions): Promise<Snapshot> {
  const origins = siteOriginsFor(options.config, target);
  const robotsTxt = await readRobots(`${target}/robots.txt`, options.config.timeoutMs);
  const sitemapUrls = await readSitemaps(target, robotsTxt, origins, options.config.timeoutMs);
  const paths = choosePaths(options, sitemapUrls ?? []);
  const results = await mapWithConcurrency(paths, options.config.concurrency, async (pagePath) =>
    readLivePage(`${target}${pagePath}`, options.config, origins));
  return finishSnapshot(target, { robotsTxt, sitemapUrls }, new Map(paths.map((pagePath, index) => [pagePath, results[index] as PageResult])));
}

async function readRobots(url: string, timeoutMs: number): Promise<string[] | null> {
  const document = await fetchDocument(url, timeoutMs);
  if (MISSING_STATUSES.has(document.status)) return null;
  if (document.status !== 200) throw new SnapshotError(`robots.txt answered HTTP ${document.status} at ${url}`);
  return parseRobotsTxt(document.body);
}

async function readSitemaps(target: string, robotsTxt: string[] | null, origins: string[], timeoutMs: number): Promise<string[] | null> {
  const listed = sitemapsListedInRobots(robotsTxt ?? []).map((url) => onTarget(url, target, origins));
  const queue = listed.length > 0 ? listed : [`${target}/sitemap.xml`];
  const seen = new Set<string>();
  const urls: string[] = [];
  let found = false;
  while (queue.length > 0 && seen.size < MAX_SITEMAP_FILES) {
    const next = queue.shift() as string;
    if (seen.has(next)) continue;
    seen.add(next);
    const document = await fetchDocument(next, timeoutMs);
    if (MISSING_STATUSES.has(document.status)) continue;
    if (document.status !== 200) throw new SnapshotError(`sitemap answered HTTP ${document.status} at ${next}`);
    found = true;
    const parsed = parseSitemap(document.body);
    urls.push(...parsed.urls);
    queue.push(...parsed.childSitemaps.map((url) => onTarget(url, target, origins)));
  }
  return found ? normalizeSitemapUrls(urls, origins) : null;
}

/** A same-site URL rewritten onto the host being checked (so staging reads staging's sitemap). */
function onTarget(url: string, target: string, origins: string[]): string {
  const normalized = normalizeUrl(url, target, origins);
  if (normalized === null || !normalized.startsWith("/")) return url;
  return `${target}${normalized}`;
}

async function readLivePage(url: string, config: SeatbeltConfig, origins: string[]): Promise<PageResult> {
  try {
    const document = await fetchDocument(url, config.timeoutMs);
    if (document.status === TOO_MANY_REQUESTS || document.status >= FIRST_SERVER_ERROR) {
      return { error: `the server answered HTTP ${document.status} (busy or failing), so the page could not be read — re-run the check later` };
    }
    if (document.status === 200 && !CLOSING_HTML_TAG.test(document.body)) {
      return { error: "the page arrived cut off (no closing </html> tag) — re-run the check" };
    }
    const redirects = document.redirects.map((hop) => normalizeUrl(hop, url, origins) ?? hop);
    return extractPageSignals(
      document.body,
      { status: document.status, redirects, xRobotsTag: document.xRobotsTag },
      extractOptions(config, document.finalUrl, origins),
    );
  } catch (error) {
    if (error instanceof FetchError) return { error: error.message };
    return { error: `could not read ${url}: ${errorMessage(error)}` };
  }
}

/* ------------------------------------------------------------- build folder */

async function snapshotDirectory(dir: string, options: SnapshotOptions): Promise<Snapshot> {
  const origins = siteOriginsFor(options.config, DIRECTORY_ORIGIN);
  const files = await listHtmlFiles(dir, options.config.cleanUrls);
  const robotsBody = await readOptionalFile(path.join(dir, "robots.txt"));
  const sitemapBody = await readOptionalFile(path.join(dir, "sitemap.xml"));
  const sitemapUrls = sitemapBody === null ? null : normalizeSitemapUrls(parseSitemap(sitemapBody).urls, origins);
  // Every built page is read even when checking against a baseline, so a page added to the build shows up as new.
  const built = [...files.keys()].slice(0, options.config.maxPages);
  const paths = [...new Set([...(options.pagePaths ?? []), ...built])];
  const pageOrigin = options.config.baseUrl === undefined ? DIRECTORY_ORIGIN : (originOf(options.config.baseUrl) ?? DIRECTORY_ORIGIN);
  const pages = new Map<string, PageResult>();
  for (const pagePath of paths) {
    const file = files.get(pagePath);
    pages.set(pagePath, file === undefined ? missingPage() : await readBuiltPage(file, `${pageOrigin}${pagePath}`, options.config, origins));
  }
  const site = { robotsTxt: robotsBody === null ? null : parseRobotsTxt(robotsBody), sitemapUrls };
  return finishSnapshot(`dir:${path.relative(options.root, dir) || "."}`, site, pages);
}

async function readBuiltPage(file: string, pageUrl: string, config: SeatbeltConfig, origins: string[]): Promise<PageResult> {
  const html = await readOptionalFile(file);
  if (html === null) return missingPage();
  return extractPageSignals(html, { status: 200, redirects: [], xRobotsTag: null }, extractOptions(config, pageUrl, origins));
}

function missingPage(): PageSignals {
  return {
    status: 404, redirects: [], xRobotsTag: null, lang: null, title: null, metaDescription: null,
    metaRobots: [], canonical: null, hreflang: [], pagination: [], headings: [], links: [],
    wordCount: 0, structuredData: [],
  };
}
