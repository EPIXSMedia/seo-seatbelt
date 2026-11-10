import * as cheerio from "cheerio";
import type { CheerioAPI } from "cheerio";
import type { AnyNode } from "domhandler";
import { countWords, normalizeText, normalizeUrl, nullIfEmpty, rankingRelTokens, stableStringify } from "../normalize.js";
import type { PageSignals } from "../types.js";

export interface ExtractOptions {
  /** The URL this HTML was served at; relative links resolve against it. */
  pageUrl: string;
  /** Origins that count as "this site" (the live site plus wherever the check runs). */
  siteOrigins: readonly string[];
  ignoreSelectors: readonly string[];
  ignoreJsonLdKeys: ReadonlySet<string>;
}

export interface HttpFacts {
  status: number;
  redirects: string[];
  xRobotsTag: string | null;
}

const ROBOTS_META_NAMES = ["robots", "googlebot", "bingbot"];
const NON_TEXT_ELEMENTS = "script, style, noscript, template, svg, iframe, object";
const INVALID_JSON_PREVIEW_LENGTH = 200;
const TEXT_NODE_TYPE = 3;

export function extractPageSignals(html: string, http: HttpFacts, options: ExtractOptions): PageSignals {
  const $ = cheerio.load(html);
  const head = readHeadSignals($, options);
  for (const selector of options.ignoreSelectors) $(selector).remove();
  return {
    status: http.status,
    redirects: http.redirects,
    xRobotsTag: http.xRobotsTag,
    ...head,
    headings: readHeadings($),
    links: readLinks($, options),
    wordCount: readWordCount($),
    structuredData: readStructuredData($, options.ignoreJsonLdKeys),
  };
}

type HeadSignals = Pick<PageSignals, "lang" | "title" | "metaDescription" | "metaRobots" | "canonical" | "hreflang" | "pagination">;

function readHeadSignals($: CheerioAPI, options: ExtractOptions): HeadSignals {
  const url = (raw: string | undefined): string | null =>
    raw === undefined ? null : normalizeUrl(raw, options.pageUrl, options.siteOrigins);
  const title = $("title").filter((_, element) => $(element).closest("svg").length === 0).first();
  const canonicals = $('link[rel~="canonical" i]')
    .map((_, element) => url($(element).attr("href")))
    .get();
  return {
    lang: nullIfEmpty($("html").attr("lang"))?.toLowerCase() ?? null,
    title: nullIfEmpty(title.text()),
    metaDescription: nullIfEmpty($('meta[name="description" i]').first().attr("content")),
    metaRobots: readMetaRobots($),
    canonical: canonicals.length === 0 ? null : canonicals.join(" | "),
    hreflang: $('link[rel~="alternate" i][hreflang]')
      .map((_, element) => `${($(element).attr("hreflang") ?? "").toLowerCase()} ${url($(element).attr("href")) ?? ""}`)
      .get()
      .sort(),
    pagination: $('link[rel~="next" i], link[rel~="prev" i]')
      .map((_, element) => `${($(element).attr("rel") ?? "").toLowerCase()} ${url($(element).attr("href")) ?? ""}`)
      .get()
      .sort(),
  };
}

function readMetaRobots($: CheerioAPI): string[] {
  return $("meta[name]")
    .map((_, element) => {
      const name = ($(element).attr("name") ?? "").toLowerCase();
      if (!ROBOTS_META_NAMES.includes(name)) return null;
      return `${name}: ${normalizeText($(element).attr("content") ?? "").toLowerCase()}`;
    })
    .get()
    .sort();
}

function readHeadings($: CheerioAPI): string[] {
  return $("body")
    .find("h1, h2, h3, h4, h5, h6")
    .map((_, element) => {
      const text = normalizeText(spacedText($, element)) || nullIfEmpty($(element).find("img[alt]").attr("alt")) || "(empty)";
      return `${element.tagName.toLowerCase()}: ${text}`;
    })
    .get();
}

function readLinks($: CheerioAPI, options: ExtractOptions): string[] {
  return $("body")
    .find("a[href]")
    .map((_, element) => {
      const anchor = $(element);
      const raw = anchor.attr("href") ?? "";
      if (raw.trim().startsWith("#")) return null;
      const href = normalizeUrl(raw, options.pageUrl, options.siteOrigins);
      if (href === null) return null;
      const text = normalizeText(spacedText($, element))
        || nullIfEmpty(anchor.find("img[alt]").attr("alt"))
        || nullIfEmpty(anchor.attr("aria-label"))
        || nullIfEmpty(anchor.attr("title"))
        || "";
      const rel = rankingRelTokens(anchor.attr("rel"));
      return `${href} "${text}"${rel.length > 0 ? ` [rel=${rel.join(" ")}]` : ""}`;
    })
    .get()
    .sort();
}

/** Text with a space between child elements, so "<h3>Title</h3><p>Text</p>" inside a link reads "Title Text". */
function spacedText($: CheerioAPI, node: AnyNode): string {
  if (node.nodeType === TEXT_NODE_TYPE) return $(node).text();
  return $(node).contents().toArray().map((child) => spacedText($, child)).join(" ");
}

/** Words in the main content (or the whole body when there is no <main>), text nodes only. */
function readWordCount($: CheerioAPI): number {
  const main = $("main").first();
  const scope = (main.length > 0 ? main : $("body")).clone();
  scope.find(NON_TEXT_ELEMENTS).remove();
  return scope
    .find("*")
    .addBack()
    .contents()
    .filter((_, node) => node.nodeType === TEXT_NODE_TYPE)
    .map((_, node) => countWords($(node).text()))
    .get()
    .reduce((total: number, count: number) => total + count, 0);
}

function readStructuredData($: CheerioAPI, ignoreKeys: ReadonlySet<string>): string[] {
  return $('script[type="application/ld+json" i]')
    .map((_, element) => {
      const body = $(element).text();
      try {
        return stableStringify(JSON.parse(body) as unknown, ignoreKeys);
      } catch {
        return `invalid JSON-LD: ${normalizeText(body).slice(0, INVALID_JSON_PREVIEW_LENGTH)}`;
      }
    })
    .get()
    .sort();
}
