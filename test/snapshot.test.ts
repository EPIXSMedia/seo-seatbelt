import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
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
});

describe("live snapshots", () => {
  let server: Server;
  let host = "";
  const routes: Record<string, { status: number; body: string; headers?: Record<string, string> }> = {
    "/robots.txt": { status: 200, body: "User-agent: *\nAllow: /\nSitemap: https://example.com/sitemap.xml\n" },
    "/sitemap.xml": { status: 200, body: "<urlset><url><loc>https://example.com/</loc></url><url><loc>https://example.com/old</loc></url></urlset>" },
    "/": { status: 200, body: page() },
    "/old": { status: 301, body: "", headers: { location: "/" } },
    "/cut": { status: 200, body: page().replace("</html>", "") },
    "/busy": { status: 429, body: "slow down", headers: { "retry-after": "0" } },
  };

  beforeAll(async () => {
    server = createServer((request, response) => {
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
    expect(snapshot.pages["/cut"]).toHaveProperty("error");
  });
});
