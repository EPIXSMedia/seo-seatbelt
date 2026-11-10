import { symlinkSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compareSnapshots } from "../src/diff/compare.js";
import { takeSnapshot } from "../src/snapshot.js";
import { config, page, tempDir, writeFiles } from "./helpers.js";

const compare = { wordCount: { percent: 5, words: 25 }, ignoreSignals: new Set<never>() };

describe("build-folder snapshots", () => {
  it("compares a build folder with a baseline and finds a changed title and a new page", async () => {
    const before = tempDir();
    writeFiles(before, { "index.html": page(), "emi/index.html": page(), "robots.txt": "User-agent: *\nAllow: /\n" });
    const baseline = await takeSnapshot({ config: config(), root: before, dir: "." });
    expect(Object.keys(baseline.pages)).toEqual(["/", "/emi/"]);

    const after = tempDir();
    writeFiles(after, { "index.html": page(), "emi/index.html": page({ title: "Changed" }), "new.html": page(), "robots.txt": "User-agent: *\nAllow: /\n" });
    const current = await takeSnapshot({ config: config(), root: after, dir: ".", pagePaths: Object.keys(baseline.pages) });
    const signals = compareSnapshots(baseline, current, compare).changes.map((change) => `${change.page ?? ""} ${change.signal}`);
    expect(signals).toEqual(["/emi/ title", "/new.html page"]);
  });

  it("follows robots.txt and sitemap indexes to child sitemaps inside the build folder", async () => {
    const dir = tempDir();
    writeFiles(dir, {
      "index.html": page(),
      "robots.txt": "User-agent: *\nSitemap: https://example.com/sitemap_index.xml\n",
      "sitemap_index.xml": "<sitemapindex><sitemap><loc>https://example.com/post-sitemap.xml</loc></sitemap></sitemapindex>",
      "post-sitemap.xml": "<urlset><url><loc>https://example.com/blog/a/</loc></url></urlset>",
    });
    const snapshot = await takeSnapshot({ config: config(), root: dir, dir: "." });
    expect(snapshot.site.sitemapUrls).toEqual(["/blog/a/"]);
  });

  it("finds sitemap_index.xml when robots.txt lists no sitemap, and never reads outside the folder", async () => {
    const dir = tempDir();
    writeFiles(dir, {
      "index.html": page(),
      "sitemap_index.xml": "<sitemapindex><sitemap><loc>https://example.com/../../etc/passwd</loc></sitemap><sitemap><loc>/pages.xml</loc></sitemap></sitemapindex>",
      "pages.xml": "<urlset><url><loc>https://example.com/</loc></url></urlset>",
    });
    const snapshot = await takeSnapshot({ config: config(), root: dir, dir: "." });
    expect(snapshot.site.sitemapUrls).toEqual(["/"]);
  });

  // Creating a symlink on Windows needs administrator rights, which CI runners do not have.
  it.skipIf(process.platform === "win32")("reads pages that the build links in rather than copies", async () => {
    const dir = tempDir();
    writeFiles(dir, { "index.html": page(), "shared/about.html": page({ title: "About" }) });
    symlinkSync(path.join(dir, "shared/about.html"), path.join(dir, "about.html"));
    const snapshot = await takeSnapshot({ config: config(), root: dir, dir: "." });
    expect(snapshot.pages["/about.html"]).toMatchObject({ title: "About" });
  });
});

describe("live snapshots", () => {
  let server: Server;
  let host = "";
  let cutReads = 0;
  const routes: Record<string, { status: number; body: string; headers?: Record<string, string> }> = {
    "/robots.txt": { status: 200, body: "User-agent: *\nAllow: /\nSitemap: https://example.com/sitemap.xml\n" },
    "/sitemap.xml": { status: 200, body: "<urlset><url><loc>https://example.com/</loc></url><url><loc>https://example.com/old</loc></url></urlset>" },
    "/": { status: 200, body: page() },
    "/old": { status: 301, body: "", headers: { location: "/" } },
    "/minified": { status: 200, body: page().replace("</body>\n</html>", "") },
    "/linked": { status: 200, body: page().replace(/<link rel="canonical"[^>]*>/u, ""), headers: { link: '<https://example.com/emi/>; rel="canonical", <https://example.com/de/>; rel=alternate; hreflang=de' } },
    "/busy": { status: 429, body: "slow down", headers: { "retry-after": "0" } },
  };

  beforeAll(async () => {
    server = createServer((request, response) => {
      if (request.url === "/cut") {
        cutReads += 1;
        response.writeHead(200, { "content-type": "text/html" });
        const html = page();
        response.end(html.slice(0, html.indexOf("<p>") + cutReads * 12));
        return;
      }
      const route = routes[request.url ?? ""] ?? { status: 404, body: "not found" };
      response.writeHead(route.status, { "content-type": "text/html", ...route.headers });
      response.end(route.body);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    host = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => { resolve(); }));
  });

  it("reads robots.txt, follows the sitemap onto the host being checked, and records redirects", async () => {
    const snapshot = await takeSnapshot({ config: config({ discoverFromSitemap: true }), root: tempDir(), target: host });
    expect(snapshot.site.sitemapUrls).toEqual(["/", "/old"]);
    expect(snapshot.pages["/old"]).toMatchObject({ status: 200, redirects: ["/"] });
    expect(snapshot.pages["/"]).toMatchObject({ title: "Home Loan EMI Calculator", canonical: "/emi/" });
  });

  it("treats a busy server (HTTP 429) as unreadable after one retry, not as a lost page", async () => {
    const snapshot = await takeSnapshot({ config: config({ pages: ["/busy"] }), root: tempDir(), target: host });
    const busy = snapshot.pages["/busy"];
    expect(busy !== undefined && "error" in busy ? busy.error : "").toContain("HTTP 429");
  });

  it("treats a cut-off page as unreadable, never as a pass", async () => {
    const snapshot = await takeSnapshot({ config: config({ pages: ["/cut"] }), root: tempDir(), target: host });
    expect(snapshot.pages["/cut"]).toEqual({ error: expect.stringContaining("cut off") as unknown });
  });

  it("accepts a page whose minifier drops </html> when a second read agrees", async () => {
    const snapshot = await takeSnapshot({ config: config({ pages: ["/minified"] }), root: tempDir(), target: host });
    expect(snapshot.pages["/minified"]).toMatchObject({ title: "Home Loan EMI Calculator" });
  });

  it("reads a canonical sent in the HTTP Link header, and full URLs in \"pages\"", async () => {
    const snapshot = await takeSnapshot({ config: config({ pages: ["https://example.com/linked", "linked"] }), root: tempDir(), target: host });
    expect(Object.keys(snapshot.pages)).toEqual(["/linked"]);
    expect(snapshot.pages["/linked"]).toMatchObject({ canonical: "/emi/" });
  });

  it("refuses a \"pages\" entry on another site", async () => {
    await expect(takeSnapshot({ config: config({ pages: ["https://other.example/x"] }), root: tempDir(), target: host })).rejects.toThrow(/not a page of this site/u);
  });
});
