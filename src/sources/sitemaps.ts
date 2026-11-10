import { parseSitemap } from "../extract/site.js";

/** A site with more sitemap files than this is refused rather than read in part. */
export const MAX_SITEMAP_FILES = 500;

/** Where sitemaps usually live when robots.txt does not list any. */
export const DEFAULT_SITEMAP_PATHS = ["/sitemap.xml", "/sitemap-index.xml", "/sitemap_index.xml"];

export interface SitemapSource {
  /** The sitemap's text, or null when it does not exist. Throws when it exists but cannot be read. */
  read(url: string): Promise<string | null>;
  /** Where a sitemap URL is read from (e.g. the host being checked, or a file in the build folder). */
  locate(url: string): string;
}

export class SitemapLimitError extends Error {
  override name = "SitemapLimitError";
}

/**
 * Every page URL in the site's sitemaps, following sitemap indexes to their children.
 * Starts from the sitemaps robots.txt lists or, when it lists none, the first default
 * location that exists. Returns null when the site has no sitemap at all.
 */
export async function collectSitemapUrls(listed: readonly string[], defaults: readonly string[], source: SitemapSource): Promise<string[] | null> {
  const read = memoized(source);
  const queue = listed.length > 0 ? listed.map((url) => source.locate(url)) : await firstExisting(defaults, (url) => source.locate(url), read);
  const seen = new Set<string>();
  const urls: string[] = [];
  let found = false;
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    if (seen.has(next)) continue;
    if (seen.size >= MAX_SITEMAP_FILES) {
      throw new SitemapLimitError(`the site lists more than ${MAX_SITEMAP_FILES} sitemap files, so its sitemap URLs cannot all be read`);
    }
    seen.add(next);
    const body = await read(next);
    if (body === null) continue;
    found = true;
    const parsed = parseSitemap(body);
    urls.push(...parsed.urls);
    queue.push(...parsed.childSitemaps.map((url) => source.locate(url)));
  }
  return found ? urls : null;
}

type Read = (url: string) => Promise<string | null>;

/** Each sitemap is read once, even when it is both a default location and listed again later. */
function memoized(source: SitemapSource): Read {
  const cache = new Map<string, Promise<string | null>>();
  return async (url) => {
    const cached = cache.get(url) ?? source.read(url);
    cache.set(url, cached);
    return cached;
  };
}

async function firstExisting(defaults: readonly string[], locate: SitemapSource["locate"], read: Read): Promise<string[]> {
  for (const url of defaults) {
    const located = locate(url);
    if ((await read(located)) !== null) return [located];
  }
  return [];
}
