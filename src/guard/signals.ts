import { createHash } from "node:crypto";
import { countWords, normalizeText, rankingRelTokens } from "../normalize.js";
import { extensionOf, type FileRole } from "./files.js";

/*
 * Reads ranking signals straight out of source files — templates, components, markdown,
 * WordPress PHP and site config — so an edit can be judged BEFORE it is written or committed.
 * Each signal is one readable line; an edit is risky when the set of lines changes.
 */

const TITLE_TAG = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/giu;
const META_TAG = /<meta\b[^>]*>/giu;
const LINK_TAG = /<link\b[^>]*>/giu;
const HEADING_TAG = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/giu;
const ANCHOR_TAG = /<(a|Link|NuxtLink|RouterLink|router-link|nuxt-link)\b([^>]*)>([\s\S]*?)<\/\1\s*>/gu;
const JSON_LD_BLOCK = /<script\b[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script\s*>/giu;
const ATTRIBUTE = /([\w:@.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|\{([^}]*)\}|([^\s"'>]+))/gu;
const ANY_TAG = /<[^>]*>/gu;
const INDEXING_LINE = /noindex|nofollow|x-robots-tag|hreflang|rel=["'{]?canonical|application\/ld\+json|http-equiv=["']?refresh/iu;
const METADATA_MARKER = /\b(metadata|generateMetadata|useHead|useSeoMeta|definePageMeta|NextSeo|DefaultSeo|Helmet)\b|<Head\b|<svelte:head|<Seo\b|<SEO\b/u;
const METADATA_LINE = /\b(title|description|canonical|robots|noindex|nofollow|alternates|languages|keywords|titleTemplate|defaultTitle)\b["']?\s*[:=]/u;
const WORDPRESS_LINE = /wp_title|document_title|pre_get_document_title|wpseo_|rank_math|aioseo|seopress|wp_robots|rel_canonical|get_canonical_url|redirect_canonical|wp_sitemaps|wp_redirect|wp_safe_redirect|add_rewrite_rule|add_filter\s*\(\s*['"]the_(content|title|excerpt)/iu;
const CONFIG_LINE = /redirect|rewrite|trailingslash|basepath|cleanurls|permalink|baseurl|base_url|\bsite\s*[:=]|\bbase\s*[:=]|i18n|locale|hreflang|canonical|noindex|nofollow|x-robots-tag|sitemap|robots|["']?\b(source|destination|permanent|statuscode|status|from|to|force|url)\b["']?\s*[:=]|errordocument|directoryindex/iu;
const COMMENT_LINE = /^\s*(#|\/\/)/u;
const SEO_META_NAMES = new Set(["description", "robots", "googlebot", "bingbot"]);
const SEO_LINK_RELS = new Set(["canonical", "alternate", "next", "prev", "amphtml"]);
const FRONTMATTER_KEYS = new Set([
  "title", "description", "slug", "permalink", "canonical", "canonicalurl", "canonical_url", "robots", "noindex",
  "draft", "published", "url", "aliases", "redirect_from", "redirect_to", "lang", "date", "lastmod", "updated", "seo",
]);
const MARKDOWN_EXTENSIONS = new Set(["md", "mdx", "markdown"]);
const SCRIPT_EXTENSIONS = new Set(["js", "jsx", "ts", "tsx", "mjs", "cjs", "vue", "svelte", "astro", "mdx"]);
const PHP_EXTENSIONS = new Set(["php", "phtml"]);
const BODY_PREVIEW_LENGTH = 60;
const FINGERPRINT_LENGTH = 10;

export function sourceSignals(text: string, relativePath: string, role: FileRole, isContent: boolean): string[] {
  if (role === "config") return lineSignals(text, CONFIG_LINE, "config");
  if (role !== "markup") return [];
  const extension = extensionOf(relativePath);
  const signals = [...markupSignals(text), ...lineSignals(text, INDEXING_LINE, "indexing", /<(meta|link)\b/iu)];
  if (SCRIPT_EXTENSIONS.has(extension) && METADATA_MARKER.test(text)) signals.push(...lineSignals(text, METADATA_LINE, "metadata"));
  if (PHP_EXTENSIONS.has(extension)) signals.push(...lineSignals(text, WORDPRESS_LINE, "wordpress"));
  if (MARKDOWN_EXTENSIONS.has(extension)) signals.push(...markdownSignals(text, isContent));
  return signals;
}

function markupSignals(text: string): string[] {
  const signals: string[] = [];
  for (const match of text.matchAll(TITLE_TAG)) signals.push(`title: ${innerText(match[1])}`);
  for (const match of text.matchAll(META_TAG)) {
    const attributes = parseAttributes(match[0]);
    const name = (attributes.name ?? attributes.property ?? "").toLowerCase();
    if (SEO_META_NAMES.has(name)) signals.push(`meta ${name}: ${normalizeText(attributes.content ?? "")}`);
    if ((attributes["http-equiv"] ?? "").toLowerCase() === "refresh") signals.push(`meta refresh: ${attributes.content ?? ""}`);
  }
  for (const match of text.matchAll(LINK_TAG)) {
    const attributes = parseAttributes(match[0]);
    const rel = (attributes.rel ?? "").toLowerCase();
    if (!SEO_LINK_RELS.has(rel)) continue;
    signals.push(`link rel=${rel}: ${attributes.href ?? ""}${attributes.hreflang === undefined ? "" : ` (${attributes.hreflang})`}`);
  }
  for (const match of text.matchAll(HEADING_TAG)) signals.push(`h${match[1] ?? ""}: ${innerText(match[2])}`);
  for (const match of text.matchAll(ANCHOR_TAG)) signals.push(anchorSignal(match[2] ?? "", match[3] ?? ""));
  for (const match of text.matchAll(JSON_LD_BLOCK)) signals.push(`structured data: ${normalizeText(match[1] ?? "")}`);
  return signals;
}

function anchorSignal(attributeText: string, inner: string): string {
  const attributes = parseAttributes(attributeText);
  const href = attributes.href ?? attributes.to ?? "";
  const rel = rankingRelTokens(attributes.rel);
  return `link: ${normalizeText(href)} "${innerText(inner)}"${rel.length > 0 ? ` [rel=${rel.join(" ")}]` : ""}`;
}

export function parseAttributes(tag: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const match of tag.matchAll(ATTRIBUTE)) {
    const name = (match[1] ?? "").toLowerCase();
    attributes[name] = match[2] ?? match[3] ?? match[4] ?? match[5] ?? "";
  }
  return attributes;
}

function innerText(html: string | undefined): string {
  return normalizeText((html ?? "").replace(ANY_TAG, " "));
}

function lineSignals(text: string, pattern: RegExp, label: string, skip?: RegExp): string[] {
  return text
    .split(/\r?\n/u)
    .filter((line) => !COMMENT_LINE.test(line) && pattern.test(line) && (skip === undefined || !skip.test(line)))
    .map((line) => `${label}: ${normalizeText(line)}`);
}

/* ------------------------------------------------------------------ markdown */

function markdownSignals(text: string, isContent: boolean): string[] {
  const { frontmatter, body } = splitFrontmatter(text);
  const signals = frontmatterSignals(frontmatter);
  let inFence = false;
  for (const line of body.split(/\r?\n/u)) {
    if (/^\s*(```|~~~)/u.test(line)) inFence = !inFence;
    if (inFence) continue;
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/u.exec(line);
    if (heading !== null) signals.push(`h${heading[1]?.length ?? 0}: ${normalizeText(heading[2] ?? "")}`);
    for (const link of line.matchAll(/(?<!!)\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/gu)) {
      signals.push(`link: ${link[2] ?? ""} "${normalizeText(link[1] ?? "")}"`);
    }
  }
  if (isContent) signals.push(bodyCopySignal(body));
  return signals;
}

function splitFrontmatter(text: string): { frontmatter: string; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[^\S\r\n]*(?:\r?\n|$)/u.exec(text);
  if (match === null) return { frontmatter: "", body: text };
  return { frontmatter: match[1] ?? "", body: text.slice(match[0].length) };
}

function frontmatterSignals(frontmatter: string): string[] {
  const signals: string[] = [];
  let current: string | null = null;
  for (const line of frontmatter.split(/\r?\n/u)) {
    const key = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/u.exec(line);
    if (key !== null) {
      current = FRONTMATTER_KEYS.has((key[1] ?? "").toLowerCase()) ? `frontmatter ${key[1] ?? ""}: ${normalizeText(key[2] ?? "")}` : null;
      if (current !== null) signals.push(current);
    } else if (current !== null && /^\s+\S/u.test(line)) {
      signals[signals.length - 1] = `${signals[signals.length - 1] ?? ""} ${normalizeText(line)}`;
    }
  }
  return signals;
}

function bodyCopySignal(body: string): string {
  const text = normalizeText(body);
  const fingerprint = createHash("sha256").update(text).digest("hex").slice(0, FINGERPRINT_LENGTH);
  const preview = text.length > BODY_PREVIEW_LENGTH ? `${text.slice(0, BODY_PREVIEW_LENGTH)}…` : text;
  return `body copy: ${countWords(text)} words, "${preview}" #${fingerprint}`;
}
