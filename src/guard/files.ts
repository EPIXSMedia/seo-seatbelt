import picomatch from "picomatch";
import type { GuardConfig } from "../config.js";

/** Any change at all to these files changes what search engines crawl or index. */
export const DEFAULT_PROTECTED_FILES = [
  "**/robots.txt",
  "**/robots.{js,mjs,cjs,ts}",
  "**/sitemap*.xml",
  "**/sitemap.{js,mjs,cjs,ts}",
  "**/next-sitemap.config.{js,mjs,cjs,ts}",
  "**/_redirects",
];

/** SEO Seatbelt's own settings and approved baseline: changing them changes what is guarded. */
export const SEATBELT_FILES = ["**/seo-seatbelt.config.json", "**/.seo-seatbelt/**"];

/** Files that install or run the SEO Seatbelt hooks; only their seatbelt lines matter. */
export const SEATBELT_HOOK_FILES = [
  "**/.claude/settings*.json",
  "**/.codex/hooks.json",
  "**/.husky/**",
  "**/lefthook*.{yml,yaml,json,toml}",
  "**/.pre-commit-config.yaml",
  "package.json",
  ".git/hooks/**",
];

/** Config files where only redirect / URL / indexing settings matter (headers and the rest stay routine). */
export const DEFAULT_CONFIG_FILES = [
  "**/.htaccess",
  "**/vercel.json",
  "**/netlify.toml",
  "**/firebase.json",
  "**/next.config.{js,mjs,cjs,ts}",
  "**/nuxt.config.{js,mjs,ts}",
  "**/astro.config.{js,mjs,ts}",
  "**/svelte.config.{js,mjs}",
  "**/gatsby-config.{js,mjs,ts}",
  "**/docusaurus.config.{js,mjs,ts}",
  "**/_config.yml",
  "**/hugo.{toml,yaml,yml,json}",
  "**/nginx*.conf",
];

/** Translation files: their strings are the page text in each language. */
export const DEFAULT_MESSAGE_FILES = ["**/{messages,locales,locale,lang,i18n,translations}/**/*.{json,yaml,yml}"];

/** Written content: any change to the text is a change to body copy. */
export const DEFAULT_CONTENT_FILES = ["**/*.{md,mdx,markdown,markdoc}"];

/** Files whose existence is a URL: adding, deleting or renaming one changes which pages exist. */
export const DEFAULT_ROUTE_FILES = [
  "**/app/**/page.{js,jsx,ts,tsx,md,mdx}",
  "**/app/routes/**/*.{js,jsx,ts,tsx,md,mdx}",
  "**/pages/**/*.{js,jsx,ts,tsx,vue,astro,md,mdx}",
  "**/routes/**/+page.{svelte,ts,js}",
  "**/*.{html,htm}",
  "**/*.{njk,liquid,hbs,handlebars,ejs,pug,twig,erb,mustache}",
  ...DEFAULT_CONTENT_FILES,
];

/** Files that sit in page folders but are never pages themselves. */
const NOT_ROUTE_FILES = ["**/pages/_*.*", "**/{_includes,_layouts,_data,layouts,partials,components,includes}/**"];

export const DEFAULT_IGNORED_FILES = [
  "**/node_modules/**",
  "**/.git/**",
  "**/.next/**",
  "**/.nuxt/**",
  "**/.svelte-kit/**",
  "**/coverage/**",
  "**/__tests__/**",
  "**/*.{test,spec,stories}.*",
  "**/pages/api/**",
  "**/{README,CHANGELOG,CONTRIBUTING,LICENSE,CODE_OF_CONDUCT,SECURITY,AGENTS,CLAUDE}{,.md,.mdx,.markdown,.txt}",
  "**/.github/**",
  "**/.claude/**",
  "**/.changeset/**",
];

/** Extensions whose markup can carry titles, meta tags, headings, links or structured data. */
const MARKUP_EXTENSIONS = new Set([
  "html", "htm", "php", "phtml", "jsx", "tsx", "js", "ts", "mjs", "cjs", "vue", "svelte", "astro", "njk", "liquid",
  "hbs", "handlebars", "mustache", "ejs", "erb", "twig", "cshtml", "razor", "pug", "md", "mdx", "markdown", "markdoc",
]);

export type FileRole = "ignored" | "protected" | "seatbelt" | "seatbelt-hooks" | "config" | "messages" | "markup" | "other";

export interface FileRules {
  roleOf(relativePath: string): FileRole;
  isRoute(relativePath: string): boolean;
}

type Matcher = (relativePath: string) => boolean;

function matcher(patterns: readonly string[]): Matcher {
  if (patterns.length === 0) return () => false;
  return picomatch([...patterns], { dot: true, nocase: true });
}

/**
 * Patterns the owner lists in the config win over the defaults: an owner's `ignoreFiles`
 * is never inspected, and an owner's protected, content or route file is inspected even
 * where a default would skip it. SEO Seatbelt's own files are always inspected.
 */
export function compileFileRules(guard: GuardConfig): FileRules {
  const seatbelt = matcher(SEATBELT_FILES);
  const seatbeltHooks = matcher(SEATBELT_HOOK_FILES);
  const ownerIgnored = matcher(guard.ignoreFiles);
  const ownerProtected = matcher(guard.protectedFiles);
  const ownerContent = matcher(guard.contentFiles);
  const ownerRoute = matcher(guard.routeFiles);
  const defaultIgnored = matcher(DEFAULT_IGNORED_FILES);
  const protectedFile = matcher(DEFAULT_PROTECTED_FILES);
  const config = matcher(DEFAULT_CONFIG_FILES);
  const messages = matcher(DEFAULT_MESSAGE_FILES);
  const content = matcher(DEFAULT_CONTENT_FILES);
  const route = matcher(DEFAULT_ROUTE_FILES);
  const notRoute = matcher(NOT_ROUTE_FILES);
  const roleOf = (path: string): FileRole => {
    if (seatbelt(path)) return "seatbelt";
    if (seatbeltHooks(path)) return "seatbelt-hooks";
    if (ownerIgnored(path)) return "ignored";
    if (ownerProtected(path)) return "protected";
    if (ownerContent(path)) return "markup";
    if (defaultIgnored(path) && !ownerRoute(path)) return "ignored";
    if (protectedFile(path)) return "protected";
    if (config(path)) return "config";
    if (messages(path)) return "messages";
    if (content(path) || MARKUP_EXTENSIONS.has(extensionOf(path))) return "markup";
    return "other";
  };
  return {
    roleOf,
    isRoute(path) {
      if (ownerIgnored(path)) return false;
      if (ownerRoute(path)) return true;
      return !defaultIgnored(path) && route(path) && !notRoute(path);
    },
  };
}

export function extensionOf(relativePath: string): string {
  const name = relativePath.slice(relativePath.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}
