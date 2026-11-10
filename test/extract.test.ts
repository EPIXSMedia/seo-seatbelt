import { describe, expect, it } from "vitest";
import { extractPageSignals } from "../src/extract/page.js";
import { page } from "./helpers.js";

const http = { status: 200, redirects: [], xRobotsTag: null };
const options = {
  pageUrl: "https://example.com/emi/",
  siteOrigins: ["https://example.com"],
  ignoreSelectors: [],
  ignoreJsonLdKeys: new Set<string>(),
};

describe("extractPageSignals", () => {
  const signals = extractPageSignals(page(), http, options);

  it("reads the head signals", () => {
    expect(signals.title).toBe("Home Loan EMI Calculator");
    expect(signals.metaDescription).toBe("Work out your monthly EMI in seconds.");
    expect(signals.metaRobots).toEqual(["robots: index, follow"]);
    expect(signals.lang).toBe("en");
  });

  it("stores same-site URLs as paths so any host can be compared with the live site", () => {
    expect(signals.canonical).toBe("/emi/");
    expect(signals.links).toEqual(['/about/ "About us"', '/sip/ "SIP calculator"']);
  });

  it("ignores in-page anchors and SVG titles", () => {
    expect(signals.links.some((link) => link.includes("#main"))).toBe(false);
    expect(signals.title).not.toBe("icon");
  });

  it("reads headings in order and counts only visible words in <main>", () => {
    expect(signals.headings).toEqual(["h1: EMI Calculator", "h2: How it works"]);
    expect(signals.wordCount).toBe(28);
  });

  it("records link rel values that pass or withhold ranking credit", () => {
    const html = page({ links: '<a href="https://partner.example.org/" rel="Sponsored noopener">Partner</a>' });
    expect(extractPageSignals(html, http, options).links).toEqual(['https://partner.example.org/ "Partner" [rel=sponsored]']);
  });

  it("keeps a space between the parts of a card link", () => {
    const html = page({ links: '<a href="/sip/"><h3>SIP Calculator</h3><p>Plan your monthly SIP.</p></a>' });
    expect(extractPageSignals(html, http, options).links).toEqual(['/sip/ "SIP Calculator Plan your monthly SIP."']);
  });

  it("gives the same structured data whatever the key order", () => {
    const reordered = page({ jsonLd: '{"name":"EMI Calculator","@type":"WebApplication","@context":"https://schema.org"}' });
    expect(extractPageSignals(reordered, http, options).structuredData).toEqual(signals.structuredData);
  });
});
