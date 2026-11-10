import { normalizeText } from "../normalize.js";
import { htaccessLines, nginxLines, tomlLeaves, yamlLeaves } from "./config-formats.js";
import { extensionOf, type FileRole } from "./files.js";
import { skipBalanced, skipComment, skipString, isQuote } from "./lex.js";
import { anchorSignal, bodyCopySignal, headingLevel, innerHtml, innerText, parseAttributes, scanTags, visibleCopy, type Tag } from "./markup.js";
import { pathText, scanLeaves, segmentKey, type Leaf } from "./scan.js";

/*
 * Reads ranking signals straight out of source files — templates, components, markdown,
 * WordPress PHP, translation files and site config — so an edit can be judged BEFORE it is
 * written or committed. Each signal is one readable line; an edit is risky when the set of
 * lines changes.
 */

const SEO_META_NAMES = new Set(["description", "robots", "googlebot", "bingbot"]);
const SEO_LINK_RELS = new Set(["canonical", "alternate", "next", "prev", "amphtml"]);
const HTML_ANCHORS = new Set(["a", "nuxtlink", "routerlink", "router-link", "nuxt-link"]);
const JSX_ANCHORS = new Set(["a", "Link", "NavLink", "NuxtLink", "RouterLink"]);
const SEO_COMPONENTS = new Set(["NextSeo", "DefaultSeo", "ArticleJsonLd", "Seo", "SEO", "Helmet", "Head"]);
const INDEXING_LINE = /noindex|nofollow|x-robots-tag|hreflang/iu;
const WORDPRESS_LINE = /wp_title|document_title|pre_get_document_title|wpseo_|rank_math|aioseo|seopress|wp_robots|rel_canonical|get_canonical_url|redirect_canonical|wp_sitemaps|wp_redirect|wp_safe_redirect|add_rewrite_rule|add_filter\s*\(\s*['"]the_(content|title|excerpt)/iu;
const ROUTING_CALL = /\b(?:NextResponse\.(?:redirect|rewrite)|Response\.redirect|permanentRedirect|redirect|navigateTo|notFound)\s*\(/gu;
const SCRIPT_BLOCK = /<script\b[^>]*>([\s\S]*?)<\/script\s*>/giu;
const LEADING_FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---/u;
const JSON_LD_KEY = /^["']@(?:context|type|graph)["']$/u;
const SEATBELT_NAME = "seo-seatbelt";
const COMMENT_LINE = /^\s*(#|\/\/)/u;
const SEO_FRONTMATTER_KEY = /title|description|seo|meta|canonical/iu;
const FRONTMATTER_KEYS = new Set([
  "slug", "permalink", "robots", "noindex", "draft", "published", "url", "aliases", "redirect_from", "redirect_to",
  "redirectfrom", "redirectto", "lang", "date", "lastmod", "updated", "expirydate", "publishdate", "hreflang",
]);

/** Settings keys that change URLs, redirects, languages or indexing. Compared without case, `_` or `-`. */
const CONFIG_SEO_KEYS = new Set([
  "redirects", "redirect", "rewrites", "rewrite", "trailingslash", "basepath", "i18n", "cleanurls", "site", "siteurl",
  "base", "baseurl", "url", "permalink", "permalinks", "sitemap", "robots", "canonical", "canonifyurls", "locales",
  "locale", "defaultlocale", "languages", "defaultcontentlanguage", "hreflang", "routerules", "routebasepath", "slug",
  "sitemetadata", "pathprefix", "format", "head", "headtags", "metadata", "title", "description", "tagline", "uglyurls",
  "disablekinds", "paths", "matcher", "redirectfrom", "redirectto", "noindex", "nofollow", "xrobotstag", "alternates",
]);
const CONFIG_SEO_VALUE = /x-robots-tag|noindex|nofollow/iu;
/** In code, page metadata lives under one of these names... */
const SCRIPT_SEO_ROOTS = new Set(["metadata", "generatemetadata", "usehead", "useseometa", "useserverhead", "useserverseometa", "definepagemeta", "head", "seo", "metainfo"]);
/** ...except these parts of it, which do not affect rankings (share cards, icons, theme). */
const SCRIPT_NON_SEO_KEYS = new Set(["opengraph", "twitter", "icons", "viewport", "themecolor", "colorscheme", "manifest", "applewebapp", "formatdetection", "verification", "generator", "referrer", "applinks", "link", "script", "style", "htmlattrs", "bodyattrs"]);
/** Names that are page metadata even when written alone (`export const metadata = build()`). */
const SCRIPT_SEO_SINGLE = new Set(["metadata", "generatemetadata", "seo"]);

const JSX_EXTENSIONS = new Set(["js", "jsx", "ts", "tsx", "mjs", "cjs"]);
const COMPONENT_EXTENSIONS = new Set(["vue", "svelte", "astro"]);
const MARKDOWN_EXTENSIONS = new Set(["md", "mdx", "markdown", "markdoc"]);
const PHP_EXTENSIONS = new Set(["php", "phtml"]);
const YAML_EXTENSIONS = new Set(["yml", "yaml"]);

export function sourceSignals(text: string, relativePath: string, role: FileRole): string[] {
  if (role === "config") return configSignals(text, relativePath);
  if (role === "messages") return leavesOf(text, relativePath).map((leaf) => `copy: ${pathText(leaf.path)} = ${leaf.value}`);
  if (role === "seatbelt-hooks") return seatbeltHookSignals(text, relativePath);
  if (role !== "markup") return [];
  const extension = extensionOf(relativePath);
  if (MARKDOWN_EXTENSIONS.has(extension)) return [...markdownSignals(text), ...(extension === "mdx" ? scriptSignals(text) : [])];
  const signals = [...markupSignals(text, JSX_EXTENSIONS.has(extension)), ...lineSignals(text, INDEXING_LINE, "indexing", /<(meta|link)\b/iu)];
  if (JSX_EXTENSIONS.has(extension)) signals.push(...scriptSignals(text));
  if (COMPONENT_EXTENSIONS.has(extension)) signals.push(...scriptSignals(componentScripts(text)));
  if (PHP_EXTENSIONS.has(extension)) signals.push(...lineSignals(text, WORDPRESS_LINE, "wordpress"));
  return signals;
}

/* ------------------------------------------------------------------ config */

function leavesOf(text: string, relativePath: string): Leaf[] {
  const extension = extensionOf(relativePath);
  if (YAML_EXTENSIONS.has(extension)) return yamlLeaves(text);
  if (extension === "toml") return tomlLeaves(text);
  return scanLeaves(text);
}

function configSignals(text: string, relativePath: string): string[] {
  const name = relativePath.slice(relativePath.lastIndexOf("/") + 1).toLowerCase();
  if (name === ".htaccess") return htaccessLines(text).map((line) => `config: ${line}`);
  if (name.startsWith("nginx") || extensionOf(name) === "conf") return nginxLines(text).map((line) => `config: ${line}`);
  return leavesOf(text, relativePath)
    .filter((leaf) => leaf.path.some((segment) => CONFIG_SEO_KEYS.has(segmentKey(segment))) || CONFIG_SEO_VALUE.test(leaf.value))
    .map((leaf) => `config: ${pathText(leaf.path)} = ${leaf.value}`);
}

/** The parts of a hook or package file that install or run SEO Seatbelt. */
function seatbeltHookSignals(text: string, relativePath: string): string[] {
  const mentions = (value: string): boolean => value.toLowerCase().includes(SEATBELT_NAME);
  if (extensionOf(relativePath) === "json") {
    return scanLeaves(text)
      .filter((leaf) => mentions(leaf.value) || leaf.path.some(mentions))
      .map((leaf) => `seatbelt: ${pathText(leaf.path)} = ${leaf.value}`);
  }
  return text.split(/\r?\n/u).filter(mentions).map((line) => `seatbelt: ${normalizeText(line)}`);
}

/* ------------------------------------------------------------------ code */

/** Metadata objects, JSON-LD objects and redirects written in JavaScript or TypeScript. */
function scriptSignals(code: string): string[] {
  const metadata = scanLeaves(code)
    .filter(isScriptSeoLeaf)
    .map((leaf) => `metadata: ${pathText(leaf.path)} = ${leaf.value}`);
  return [...metadata, ...jsonLdObjects(code), ...routingCalls(code)];
}

function isScriptSeoLeaf(leaf: Leaf): boolean {
  const keys = leaf.path.map(segmentKey);
  if (keys.some((key) => SCRIPT_NON_SEO_KEYS.has(key))) return false;
  if (keys.length === 1) return SCRIPT_SEO_SINGLE.has(keys[0] ?? "");
  return keys.some((key) => SCRIPT_SEO_ROOTS.has(key));
}

function routingCalls(code: string): string[] {
  const calls: string[] = [];
  for (const match of code.matchAll(ROUTING_CALL)) {
    const open = match.index + match[0].length - 1;
    calls.push(`routing: ${normalizeText(code.slice(match.index, skipBalanced(code, open)))}`);
  }
  return calls;
}

/** Object literals holding `"@context"`, `"@type"` or `"@graph"`: structured data built in code. */
function jsonLdObjects(code: string): string[] {
  const opens: number[] = [];
  const found: { start: number; end: number }[] = [];
  let index = 0;
  while (index < code.length) {
    const char = code[index] ?? "";
    const comment = skipComment(code, index);
    if (comment !== index) index = comment;
    else if (isQuote(char)) {
      const end = skipString(code, index);
      const owner = opens[opens.length - 1];
      if (owner !== undefined && JSON_LD_KEY.test(code.slice(index, end)) && /^\s*:/u.test(code.slice(end))) {
        found.push({ start: owner, end: skipBalanced(code, owner) });
      }
      index = end;
    } else {
      if (char === "{") opens.push(index);
      else if (char === "}") opens.pop();
      index += 1;
    }
  }
  const outermost = found.filter((inner) => !found.some((outer) => outer.start < inner.start && outer.end >= inner.end));
  return [...new Set(outermost.map(({ start, end }) => `structured data: ${normalizeText(code.slice(start, end))}`))];
}

/** The script blocks and Astro frontmatter of a Vue, Svelte or Astro component. */
function componentScripts(text: string): string {
  const parts = [...text.matchAll(SCRIPT_BLOCK)].map((match) => match[1] ?? "");
  const frontmatter = LEADING_FRONTMATTER.exec(text)?.[1];
  return [frontmatter ?? "", ...parts].join("\n;\n");
}

/* ------------------------------------------------------------------ markup */

function markupSignals(text: string, jsx: boolean): string[] {
  const tags = scanTags(text);
  const signals: string[] = [];
  tags.forEach((tag, index) => {
    if (!tag.closing) signals.push(...tagSignals(text, tags, index, tag, jsx));
  });
  const copy = visibleCopy(text, jsx);
  if (copy !== "") signals.push(bodyCopySignal(copy));
  return signals;
}

function tagSignals(text: string, tags: readonly Tag[], index: number, tag: Tag, jsx: boolean): string[] {
  const name = jsx ? tag.name : tag.name.toLowerCase();
  const inner = (): string | null => innerHtml(text, tags, index);
  if (name === "title") return [`title: ${innerText(inner())}`];
  if (name === "meta") return metaSignals(parseAttributes(tag.attributes));
  if (name === "link") return linkSignals(parseAttributes(tag.attributes));
  if (name === "script") return scriptTagSignals(tag, inner());
  const level = headingLevel(tag);
  if (level !== null) return [`h${String(level)}: ${innerText(inner())}`];
  if ((jsx ? JSX_ANCHORS : HTML_ANCHORS).has(name)) return [anchorSignal(tag, inner())];
  if (jsx && SEO_COMPONENTS.has(tag.name)) return componentProps(tag);
  return [];
}

function metaSignals(attributes: Record<string, string>): string[] {
  const name = (attributes.name ?? attributes.property ?? "").toLowerCase();
  const signals: string[] = [];
  if (SEO_META_NAMES.has(name)) signals.push(`meta ${name}: ${normalizeText(attributes.content ?? "")}`);
  if ((attributes["http-equiv"] ?? "").toLowerCase() === "refresh") signals.push(`meta refresh: ${attributes.content ?? ""}`);
  return signals;
}

function linkSignals(attributes: Record<string, string>): string[] {
  const rel = (attributes.rel ?? "").toLowerCase();
  if (!SEO_LINK_RELS.has(rel)) return [];
  const hreflang = attributes.hreflang;
  return [`link rel=${rel}: ${attributes.href ?? ""}${hreflang === undefined ? "" : ` (${hreflang})`}`];
}

function scriptTagSignals(tag: Tag, inner: string | null): string[] {
  const attributes = parseAttributes(tag.attributes);
  if (!(attributes.type ?? "").toLowerCase().includes("ld+json")) return [];
  const html = attributes.dangerouslysetinnerhtml;
  return [`structured data: ${normalizeText(html ?? inner ?? "")}`];
}

function componentProps(tag: Tag): string[] {
  return Object.entries(parseAttributes(tag.attributes))
    .filter(([key]) => key !== "children" && key !== "key")
    .map(([key, value]) => `metadata: ${tag.name} ${key}=${value}`);
}

function lineSignals(text: string, pattern: RegExp, label: string, skip?: RegExp): string[] {
  return text
    .split(/\r?\n/u)
    .filter((line) => !COMMENT_LINE.test(line) && pattern.test(line) && (skip === undefined || !skip.test(line)))
    .map((line) => `${label}: ${normalizeText(line)}`);
}

/* ------------------------------------------------------------------ markdown */

function markdownSignals(text: string): string[] {
  const { frontmatter, body } = splitFrontmatter(text);
  const signals = frontmatterSignals(frontmatter);
  let inFence = false;
  for (const line of body.split(/\r?\n/u)) {
    if (/^\s*(```|~~~)/u.test(line)) inFence = !inFence;
    if (inFence) continue;
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/u.exec(line);
    if (heading !== null) signals.push(`h${String(heading[1]?.length ?? 0)}: ${normalizeText(heading[2] ?? "")}`);
    for (const link of line.matchAll(/(?<!!)\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/gu)) {
      signals.push(`link: ${link[2] ?? ""} "${normalizeText(link[1] ?? "")}"`);
    }
  }
  signals.push(bodyCopySignal(body));
  return signals;
}

function splitFrontmatter(text: string): { frontmatter: string; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[^\S\r\n]*(?:\r?\n|$)/u.exec(text);
  if (match === null) return { frontmatter: "", body: text };
  return { frontmatter: match[1] ?? "", body: text.slice(match[0].length) };
}

function isFrontmatterSeoKey(key: string): boolean {
  return FRONTMATTER_KEYS.has(key.toLowerCase()) || SEO_FRONTMATTER_KEY.test(key);
}

function frontmatterSignals(frontmatter: string): string[] {
  const signals: string[] = [];
  let current = false;
  for (const line of frontmatter.split(/\r?\n/u)) {
    const key = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/u.exec(line);
    if (key !== null) {
      current = isFrontmatterSeoKey(key[1] ?? "");
      if (current) signals.push(`frontmatter ${key[1] ?? ""}: ${normalizeText(key[2] ?? "")}`);
    } else if (current && /^\s+\S/u.test(line)) {
      signals[signals.length - 1] = `${signals[signals.length - 1] ?? ""} ${normalizeText(line)}`;
    }
  }
  return signals;
}
