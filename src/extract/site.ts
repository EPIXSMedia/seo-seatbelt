import * as cheerio from "cheerio";
import { normalizeText, normalizeUrl } from "../normalize.js";

/**
 * robots.txt as a list of meaningful rule lines: comments and blank lines dropped,
 * directive names lower-cased, so reformatting never reads as a change.
 */
export function parseRobotsTxt(body: string): string[] {
  return body
    .split(/\r?\n/u)
    .map((line) => normalizeText(line.replace(/#.*$/u, "")))
    .filter((line) => line !== "")
    .map((line) => {
      const separator = line.indexOf(":");
      if (separator === -1) return line;
      return `${line.slice(0, separator).trim().toLowerCase()}: ${line.slice(separator + 1).trim()}`;
    });
}

export function sitemapsListedInRobots(robotsLines: readonly string[]): string[] {
  return robotsLines
    .filter((line) => line.startsWith("sitemap: "))
    .map((line) => line.slice("sitemap: ".length));
}

export interface ParsedSitemap {
  /** Page URLs listed in a <urlset>. */
  urls: string[];
  /** Child sitemaps listed in a <sitemapindex>. */
  childSitemaps: string[];
}

export function parseSitemap(xml: string): ParsedSitemap {
  const $ = cheerio.load(xml, { xml: true });
  const locs = (selector: string): string[] =>
    $(selector).map((_, element) => normalizeText($(element).text())).get().filter((loc) => loc !== "");
  return {
    urls: locs("urlset > url > loc"),
    childSitemaps: locs("sitemapindex > sitemap > loc"),
  };
}

/** Sitemap URLs as site paths (same-site) so a sitemap read on staging matches production. */
export function normalizeSitemapUrls(urls: readonly string[], siteOrigins: readonly string[]): string[] {
  const base = siteOrigins[0] ?? "http://localhost";
  return [...new Set(urls.map((url) => normalizeUrl(url, base, siteOrigins) ?? url))].sort();
}
