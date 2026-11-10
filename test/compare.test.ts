import { describe, expect, it } from "vitest";
import { compareSnapshots } from "../src/diff/compare.js";
import { formatCheckReport } from "../src/diff/report.js";
import { extractPageSignals } from "../src/extract/page.js";
import type { PageResult, Snapshot } from "../src/types.js";
import { page } from "./helpers.js";

const options = { wordCount: { percent: 5, words: 25 }, ignoreSignals: new Set<never>() };
const extract = { pageUrl: "https://example.com/emi/", siteOrigins: ["https://example.com"], ignoreSelectors: [], ignoreJsonLdKeys: new Set<string>() };

function snapshot(pages: Record<string, PageResult>, robotsTxt: string[] | null = ["user-agent: *", "allow: /"]): Snapshot {
  return {
    tool: "seo-seatbelt", schemaVersion: 1, toolVersion: "1.0.0", createdAt: "2026-11-10T00:00:00.000Z", source: "https://example.com",
    site: { robotsTxt, sitemapUrls: ["/", "/emi/"] }, pages,
  };
}

function read(html: string): PageResult {
  return extractPageSignals(html, { status: 200, redirects: [], xRobotsTag: null }, extract);
}

describe("compareSnapshots", () => {
  const baseline = snapshot({ "/emi/": read(page()) });

  it("negative control: an identical site reports nothing", () => {
    expect(compareSnapshots(baseline, snapshot({ "/emi/": read(page()) }), options)).toEqual({ changes: [], errors: [] });
  });

  it("positive control: a changed title is flagged with the before and after", () => {
    const { changes } = compareSnapshots(baseline, snapshot({ "/emi/": read(page({ title: "EMI Calculator 2026" })) }), options);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ page: "/emi/", signal: "title", severity: "high", removed: ["Home Loan EMI Calculator"], added: ["EMI Calculator 2026"] });
  });

  it("flags indexing changes as critical", () => {
    const current = snapshot({ "/emi/": read(page({ robots: "noindex", canonical: "/" })) }, ["user-agent: *", "disallow: /"]);
    const signals = compareSnapshots(baseline, current, options).changes.map((change) => `${change.signal}:${change.severity}`);
    expect(signals).toEqual(expect.arrayContaining(["robotsTxt:critical", "metaRobots:critical", "canonical:critical"]));
  });

  it("flags H1, link and anchor-text changes", () => {
    const current = snapshot({ "/emi/": read(page({ h1: "Loan EMI", links: '<a href="/sip/">SIP tool</a>' })) });
    const changes = compareSnapshots(baseline, current, options).changes;
    expect(changes.find((change) => change.signal === "headings")?.severity).toBe("high");
    expect(changes.find((change) => change.signal === "links")?.removed).toEqual(['/about/ "About us"', '/sip/ "SIP calculator"']);
  });

  it("allows small copy edits but flags big ones (both limits must be passed)", () => {
    const small = snapshot({ "/emi/": read(page({ body: `${"word ".repeat(19)}extra` })) });
    expect(compareSnapshots(baseline, small, options).changes.map((change) => change.signal)).toEqual([]);
    const big = snapshot({ "/emi/": read(page({ body: "word ".repeat(120) })) });
    expect(compareSnapshots(baseline, big, options).changes.map((change) => change.signal)).toEqual(["wordCount"]);
  });

  it("never treats an unreadable page as a pass", () => {
    const result = compareSnapshots(baseline, snapshot({ "/emi/": { error: "timed out" } }), options);
    expect(result.errors).toEqual([{ page: "/emi/", error: "timed out" }]);
  });

  it("reports new pages and respects ignored signals", () => {
    const current = snapshot({ "/emi/": read(page({ title: "Changed" })), "/new/": read(page()) });
    const result = compareSnapshots(baseline, current, { ...options, ignoreSignals: new Set(["title"] as const) });
    expect(result.changes.map((change) => change.signal)).toEqual(["page"]);
  });
});

describe("formatCheckReport", () => {
  it("warns when the baseline came from a different version", () => {
    const baseline = snapshot({ "/emi/": read(page()) });
    const current = { ...snapshot({ "/emi/": read(page({ title: "New" })) }), toolVersion: "1.1.0" };
    const report = formatCheckReport(compareSnapshots(baseline, current, options), baseline, current);
    expect(report).toContain("recorded by SEO Seatbelt 1.0.0 and this check ran on 1.1.0");
  });
});
