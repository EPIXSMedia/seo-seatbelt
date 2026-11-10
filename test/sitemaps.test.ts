import { describe, expect, it } from "vitest";
import { collectSitemapUrls, MAX_SITEMAP_FILES, type SitemapSource } from "../src/sources/sitemaps.js";

function source(files: Record<string, string>): SitemapSource & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    locate: (url) => new URL(url, "https://example.com").pathname,
    read: async (url) => {
      reads.push(url);
      return Promise.resolve(files[url] ?? null);
    },
  };
}

describe("collectSitemapUrls", () => {
  it("returns null when the site has no sitemap", async () => {
    expect(await collectSitemapUrls([], ["/sitemap.xml", "/sitemap_index.xml"], source({}))).toBeNull();
  });

  it("reads each sitemap once, even when an index lists the default location again", async () => {
    const files = source({
      "/sitemap.xml": "<sitemapindex><sitemap><loc>/sitemap.xml</loc></sitemap><sitemap><loc>/a.xml</loc></sitemap></sitemapindex>",
      "/a.xml": "<urlset><url><loc>https://example.com/a</loc></url></urlset>",
    });
    expect(await collectSitemapUrls([], ["/sitemap.xml"], files)).toEqual(["https://example.com/a"]);
    expect(files.reads).toEqual(["/sitemap.xml", "/a.xml"]);
  });

  it("refuses a site with more sitemap files than it can read, rather than reading part of it", async () => {
    const children = Array.from({ length: MAX_SITEMAP_FILES + 1 }, (_, index) => `<sitemap><loc>/s${index}.xml</loc></sitemap>`).join("");
    const files: Record<string, string> = { "/sitemap.xml": `<sitemapindex>${children}</sitemapindex>` };
    for (let index = 0; index <= MAX_SITEMAP_FILES; index += 1) files[`/s${index}.xml`] = "<urlset></urlset>";
    await expect(collectSitemapUrls([], ["/sitemap.xml"], source(files))).rejects.toThrow(/more than 500 sitemap files/u);
  });
});
