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

/** Config files where only redirect / URL / indexing settings matter (headers and the rest stay routine). */
export const DEFAULT_CONFIG_FILES = [
  "**/.htaccess",
  "**/vercel.json",
  "**/netlify.toml",
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

/** Written content: any change to the text is a change to body copy. */
export const DEFAULT_CONTENT_FILES = [
  "**/content/**/*.{md,mdx,markdoc}",
  "**/posts/**/*.{md,mdx,markdown}",
  "**/_posts/**/*.{md,mdx,markdown}",
  "**/blog/**/*.{md,mdx}",
  "**/pages/**/*.{md,mdx}",
  "**/app/**/*.{md,mdx}",
];

/** Files whose existence is a URL: adding, deleting or renaming one changes which pages exist. */
export const DEFAULT_ROUTE_FILES = [
  "**/app/**/page.{js,jsx,ts,tsx,md,mdx}",
  "**/pages/**/*.{js,jsx,ts,tsx,vue,astro,md,mdx}",
  "**/routes/**/+page.{svelte,ts,js}",
  "**/*.{html,htm}",
  ...DEFAULT_CONTENT_FILES,
];

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
  "**/pages/_app.*",
  "**/pages/_document.*",
  "**/.seo-seatbelt/**",
];

/** Extensions whose markup can carry titles, meta tags, headings, links or structured data. */
const MARKUP_EXTENSIONS = new Set([
  "html", "htm", "php", "phtml", "jsx", "tsx", "js", "ts", "mjs", "cjs", "vue", "svelte", "astro",
  "njk", "liquid", "hbs", "handlebars", "mustache", "ejs", "erb", "twig", "cshtml", "razor", "md", "mdx", "markdown",
]);

export type FileRole = "ignored" | "protected" | "config" | "markup" | "other";

export interface FileRules {
  roleOf(relativePath: string): FileRole;
  isRoute(relativePath: string): boolean;
  isContent(relativePath: string): boolean;
}

export function compileFileRules(guard: GuardConfig): FileRules {
  const options = { dot: true, nocase: true };
  const ignored = picomatch([...DEFAULT_IGNORED_FILES, ...guard.ignoreFiles], options);
  const protectedFile = picomatch([...DEFAULT_PROTECTED_FILES, ...guard.protectedFiles], options);
  const config = picomatch(DEFAULT_CONFIG_FILES, options);
  const route = picomatch([...DEFAULT_ROUTE_FILES, ...guard.routeFiles], options);
  const content = picomatch([...DEFAULT_CONTENT_FILES, ...guard.contentFiles], options);
  return {
    roleOf(relativePath) {
      if (ignored(relativePath)) return "ignored";
      if (protectedFile(relativePath)) return "protected";
      if (config(relativePath)) return "config";
      return MARKUP_EXTENSIONS.has(extensionOf(relativePath)) ? "markup" : "other";
    },
    isRoute: (relativePath) => !ignored(relativePath) && route(relativePath),
    isContent: (relativePath) => !ignored(relativePath) && content(relativePath),
  };
}

export function extensionOf(relativePath: string): string {
  const name = relativePath.slice(relativePath.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}
