import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseConfig, type SeatbeltConfig } from "../src/config.js";

export function config(overrides: Record<string, unknown> = {}): SeatbeltConfig {
  return parseConfig({ baseUrl: "https://example.com", ...overrides }, "test config");
}

export function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "seo-seatbelt-"));
}

export function writeFiles(root: string, files: Record<string, string>): void {
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(root, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
}

interface PageParts {
  title?: string;
  description?: string;
  canonical?: string;
  robots?: string;
  h1?: string;
  body?: string;
  links?: string;
  jsonLd?: string;
}

export function page(parts: PageParts = {}): string {
  const {
    title = "Home Loan EMI Calculator",
    description = "Work out your monthly EMI in seconds.",
    canonical = "https://example.com/emi/",
    robots = "index, follow",
    h1 = "EMI Calculator",
    body = "Enter the loan amount, the interest rate and the tenure to see the EMI you will pay every month.",
    links = '<a href="https://example.com/about/">About us</a> <a href="/sip/">SIP calculator</a>',
    jsonLd = '{"@context":"https://schema.org","@type":"WebApplication","name":"EMI Calculator"}',
  } = parts;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${title}</title>
  <meta name="description" content="${description}">
  <meta name="robots" content="${robots}">
  <link rel="canonical" href="${canonical}">
  <script type="application/ld+json">${jsonLd}</script>
</head>
<body>
  <header><nav><a href="#main">Skip</a></nav></header>
  <main id="main">
    <h1>${h1}</h1>
    <p>${body}</p>
    <h2>How it works</h2>
    <div>${links}</div>
    <svg><title>icon</title></svg>
    <script>window.ad = "not counted";</script>
  </main>
</body>
</html>`;
}
