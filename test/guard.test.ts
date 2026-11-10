import { describe, expect, it } from "vitest";
import { evaluateFileChange, type FileChange } from "../src/guard/evaluate.js";
import { compileFileRules } from "../src/guard/files.js";
import { config, page } from "./helpers.js";

const rules = compileFileRules(config().guard);

function check(change: FileChange): string[] {
  return evaluateFileChange(change, rules).map((finding) => finding.summary);
}

describe("evaluateFileChange", () => {
  it("negative control: a styling-only edit to a page is allowed", () => {
    const before = page();
    expect(check({ path: "index.html", before, after: before.replace('<main id="main">', '<main id="main" class="wide">') })).toEqual([]);
  });

  it("positive control: a title edit is caught", () => {
    expect(check({ path: "index.html", before: page(), after: page({ title: "New title" }) })).toEqual(["changes the page title"]);
  });

  it("catches meta description, H1 and anchor-text edits", () => {
    expect(check({ path: "src/Home.tsx", before: page(), after: page({ description: "Other" }) })).toEqual(["changes the meta description"]);
    expect(check({ path: "index.html", before: page(), after: page({ h1: "Other" }) })).toEqual(["changes the H1 heading"]);
    expect(check({ path: "index.html", before: page(), after: page({ links: '<a href="/sip/">SIP</a>' }) })).toEqual(["changes links or anchor text"]);
  });

  it("treats robots.txt and sitemaps as protected", () => {
    expect(check({ path: "public/robots.txt", before: "User-agent: *", after: "User-agent: *\nDisallow: /" })).toHaveLength(1);
    expect(check({ path: "public/sitemap.xml", before: null, after: "<urlset/>" })).toHaveLength(1);
  });

  it("only flags the redirect/URL parts of config files", () => {
    const before = '{ "headers": [{ "key": "X-Frame-Options" }] }';
    expect(check({ path: "vercel.json", before, after: before.replace("X-Frame-Options", "X-Content-Type-Options") })).toEqual([]);
    expect(check({ path: "vercel.json", before, after: `${before}\n"redirects": [{ "source": "/a", "destination": "/b" }]` }))
      .toEqual(["changes redirect / URL / indexing settings"]);
  });

  it("flags Next.js metadata and WordPress SEO code", () => {
    const next = 'export const metadata = {\n  title: "Home",\n};';
    expect(check({ path: "app/page.tsx", before: next, after: next.replace("Home", "Start") })).toEqual(["changes page metadata (title / description / robots)"]);
    const php = "<?php\nadd_filter('wpseo_title', 'x');";
    expect(check({ path: "wp-content/themes/t/functions.php", before: php, after: "<?php\n" })).toEqual(["changes WordPress SEO or redirect code"]);
  });

  it("flags body copy, slugs and new or renamed pages", () => {
    const post = "---\ntitle: Hello\nslug: hello\n---\nSome words here.\n";
    expect(check({ path: "content/blog/hello.md", before: post, after: post.replace("Some words", "Other words") })).toEqual(["changes the written content"]);
    expect(check({ path: "content/blog/hello.md", before: post, after: post.replace("slug: hello", "slug: hi") })).toEqual(["changes page settings (title, slug, date…)"]);
    expect(check({ path: "about.html", before: null, after: "<p>x</p>" })[0]).toContain("new page file");
    expect(check({ path: "about-us.html", before: "<p>x</p>", after: "<p>x</p>", renamedFrom: "about.html" })[0]).toContain("renames a page file");
  });

  it("ignores tests, build output and non-markup files", () => {
    expect(check({ path: "src/app.test.tsx", before: page(), after: page({ title: "x" }) })).toEqual([]);
    expect(check({ path: ".next/server/page.html", before: page(), after: page({ title: "x" }) })).toEqual([]);
    expect(check({ path: "src/styles.css", before: "a{}", after: "b{}" })).toEqual([]);
  });
});
