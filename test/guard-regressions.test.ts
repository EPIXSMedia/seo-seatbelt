import { describe, expect, it } from "vitest";
import { evaluateFileChange, type FileChange } from "../src/guard/evaluate.js";
import { compileFileRules } from "../src/guard/files.js";
import { config } from "./helpers.js";

/**
 * Edits that once slipped past the guard (each must be caught) and everyday edits
 * that must never interrupt an agent (each must pass). Found by review, kept as a
 * permanent record so none of them can come back.
 */

const rules = compileFileRules(config().guard);

type Case = [name: string, path: string, before: string | null, after: string | null, renamedFrom?: string];

function isFlagged([, path, before, after, renamedFrom]: Case): boolean {
  const change: FileChange = { path, before, after, renamedFrom };
  return evaluateFileChange(change, rules).length > 0;
}

const nextMetadata = (body: string): string => `export const metadata = {\n${body}\n};`;

const MUST_FLAG: Case[] = [
  ["html body copy rewrite", "index.html", "<html><body><main><h1>Hi</h1><p>We are the best invoicing tool for freelancers in India.</p></main></body></html>", "<html><body><main><h1>Hi</h1><p>Cheap stuff. Buy now. Totally different copy here today.</p></main></body></html>"],
  ["tsx body copy rewrite", "src/components/Hero.tsx", "export function Hero(){return <section><h1>Hi</h1><p>We are the best invoicing tool.</p></section>}", "export function Hero(){return <section><h1>Hi</h1><p>Totally different marketing copy.</p></section>}"],
  ["multi-line metadata robots", "app/page.tsx", nextMetadata('  title: "Home",\n  robots: {\n    index: true,\n    follow: true,\n  },'), nextMetadata('  title: "Home",\n  robots: {\n    index: false,\n    follow: false,\n  },')],
  ["metadata title.default and template", "app/layout.tsx", nextMetadata('  title: {\n    default: "Acme Invoicing",\n    template: "%s | Acme",\n  },'), nextMetadata('  title: {\n    default: "Acme",\n    template: "%s",\n  },')],
  ["prettier-wrapped description", "app/page.tsx", nextMetadata('  description:\n    "Old long description of the page that prettier wrapped onto the next line",'), nextMetadata('  description:\n    "New",')],
  ["multi-line alternates.languages", "app/page.tsx", nextMetadata('  alternates: {\n    languages: {\n      "en-US": "/en",\n      "de": "/de",\n    },\n  },'), nextMetadata('  alternates: {\n    languages: {\n      "en-US": "/en-us",\n    },\n  },')],
  ["JSX canonical in a template literal", "pages/about.tsx", 'import Head from "next/head";\nexport default function A(){return <Head><link rel="canonical" href={`${SITE}/about`} /></Head>}', 'import Head from "next/head";\nexport default function A(){return <Head><link rel="canonical" href={`${SITE}/about-us`} /></Head>}'],
  ["JSX meta description in a template literal", "pages/about.tsx", 'import Head from "next/head";\nexport default function A(){return <Head><meta name="description" content={`${brand} – the best invoicing tool`} /></Head>}', 'import Head from "next/head";\nexport default function A(){return <Head><meta name="description" content={`${brand} – cheap`} /></Head>}'],
  ["JSX anchor in a template literal", "src/Nav.tsx", "export const Nav=()=> <a href={`${SITE}/pricing`}>Pricing</a>", "export const Nav=()=> <a href={`${SITE}/plans`}>Pricing</a>"],
  ["uppercase <A HREF>", "index.html", '<html><body><A HREF="/pricing">Pricing</A></body></html>', '<html><body><A HREF="/plans">Plans</A></body></html>'],
  ["JSON-LD built in code", "app/product/page.tsx", 'const schema = { "@context": "https://schema.org", "@type": "Product", name: "Acme Pro", offers: { price: "99" } };\nexport default function P(){return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(schema) }} />}', 'const schema = { "@context": "https://schema.org", "@type": "Product", name: "Acme Lite", offers: { price: "9" } };\nexport default function P(){return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(schema) }} />}'],
  ["nginx return 301", "nginx.conf", "location /old { return 301 /new; }", "location /old { return 301 /somewhere-else; }"],
  ["multi-line astro redirects", "astro.config.mjs", "export default defineConfig({\n  redirects: {\n    '/old': '/new',\n  },\n});", "export default defineConfig({\n  redirects: {\n    '/old': '/elsewhere',\n  },\n});"],
  ["Markdoc content edit", "content/blog/post.markdoc", "---\ntitle: A\n---\n# Hello\nOriginal body copy here.", "---\ntitle: B\n---\n# Goodbye\nCompletely rewritten copy."],
  ["docs/ Markdown rewrite", "docs/intro.md", "# Intro\nOriginal paragraph explaining the product in detail.", "# Intro\nTotally different paragraph."],
  ["root Jekyll page rewrite", "about.md", "---\ntitle: About\n---\nOriginal paragraph about us.", "---\ntitle: About\n---\nTotally different paragraph."],
  ["front matter meta_description and seoTitle", "content/blog/post.md", "---\ntitle: A\nmeta_description: Old desc\nseoTitle: Old SEO title\n---\nbody", "---\ntitle: A\nmeta_description: New desc\nseoTitle: New SEO title\n---\nbody"],
  ["translation file title", "messages/en.json", '{"home":{"title":"Invoicing for freelancers","h1":"Get paid faster"}}', '{"home":{"title":"Invoices","h1":"Hello"}}'],
  ["firebase.json redirect", "firebase.json", '{"hosting":{"redirects":[{"source":"/old","destination":"/new","type":301}]}}', '{"hosting":{"redirects":[{"source":"/old","destination":"/x","type":301}]}}'],
  ["middleware redirect", "middleware.ts", 'import { NextResponse } from "next/server";\nexport function middleware(r){ if (r.nextUrl.pathname==="/old") return NextResponse.redirect(new URL("/new", r.url)); }', 'import { NextResponse } from "next/server";\nexport function middleware(r){ if (r.nextUrl.pathname==="/old") return NextResponse.redirect(new URL("/elsewhere", r.url)); }'],
  ["Remix route deleted", "app/routes/pricing.tsx", "export default function P(){return null}", null],
  ["Eleventy root page deleted", "about.njk", "<p>x</p>", null],
  ["seatbelt config loosened", "seo-seatbelt.config.json", '{"guard":{"decision":"deny"}}', '{"guard":{"decision":"ask","ignoreFiles":["**"]}}'],
  ["baseline edited", ".seo-seatbelt/baseline.json", '{"a":1}', '{"a":2}'],
  ["MUI Typography h1", "src/Hero.tsx", '<Typography variant="h1">Invoicing for freelancers</Typography>', "<Typography variant=\"h1\">Hello</Typography>"],
  ["motion.h1", "src/Hero.tsx", "<motion.h1>Invoicing for freelancers</motion.h1>", "<motion.h1>Hello</motion.h1>"],
  ["robots.txt renamed away", "public/robots.txt.bak", "User-agent: *\nDisallow: /admin", "User-agent: *\nDisallow: /admin", "public/robots.txt"],
  [".htaccess renamed away", ".htaccess.bak", "Redirect 301 /a /b", "Redirect 301 /a /b", ".htaccess"],
  ["unreadable (large or binary) sitemap", "public/sitemap.xml", null, null],
  ["_document.tsx adds noindex", "pages/_document.tsx", '<Html lang="en"><Head></Head><body/></Html>', '<Html lang="en"><Head><meta name="robots" content="noindex,nofollow" /></Head><body/></Html>'],
  ["_app.tsx DefaultSeo noindex", "pages/_app.tsx", '<DefaultSeo title="Acme" description="Best invoicing" />', '<DefaultSeo title="X" description="Y" noindex={true} />'],
  ["src/pages/_app.tsx title", "src/pages/_app.tsx", "<Head><title>Acme</title></Head>", "<Head><title>X</title></Head>"],
  ["package.json drops the seatbelt", "package.json", '{"scripts":{"prepare":"seo-seatbelt install"}}', '{"scripts":{}}'],
  ["Claude settings drop the hook", ".claude/settings.json", '{"hooks":{"PreToolUse":[{"matcher":"Edit|Write","hooks":[{"type":"command","command":"npx --no-install seo-seatbelt hook || exit 2"}]}]}}', '{"hooks":{}}'],
];

const component = (body: string): string => `import { useState } from "react";
type Props<T extends object> = { items: Array<T>; onPick: (item: T) => void };
export function List<T extends object>({ items, onPick }: Props<T>) {
  const [open, setOpen] = useState<boolean>(false);
  ${body}
  return (
    <section className="list">
      <h2>Your items</h2>
      <p>Pick one of the items below to continue.</p>
      {items.length > 0 && <ul>{items.map((item, i) => <li key={i} onClick={() => onPick(item)}>{String(i)}</li>)}</ul>}
      <button onClick={() => setOpen(!open)}>Toggle</button>
    </section>
  );
}`;

const MUST_PASS: Case[] = [
  ["vercel.json security header", "vercel.json", '{\n  "headers": []\n}', '{\n  "headers": [\n    {\n      "source": "/(.*)",\n      "headers": [{ "key": "X-Frame-Options", "value": "DENY" }]\n    }\n  ]\n}'],
  ["CSS class change in HTML", "index.html", '<h1 class="a">Hi</h1><a class="x" href="/p">P</a>', '<h1 class="b">Hi</h1><a class="y" href="/p">P</a>'],
  ["component logic change", "src/List.tsx", component("const a = 1;"), component("const a = items.length > 3 ? 2 : 1; if (a < 2) { console.error(a); }")],
  ["component className change", "src/List.tsx", component(""), component("").replace('className="list"', 'className="list wide"')],
  ["component handler change", "src/List.tsx", component(""), component("").replace("setOpen(!open)", "setOpen((v) => !v)")],
  ["utility change", "src/lib/math.ts", "export function add(a: number, b: number): number { return a + b; }\nexport const head = (xs: number[]) => xs[0];", "export function add(a: number, b: number): number { return b + a; }\nexport const head = (xs: number[]) => xs.at(0);"],
  ["generic-heavy types", "src/lib/types.ts", "export type A<T> = Map<string, Array<T>>;\nconst x: Array<number> = [];", "export type A<T> = Map<string, ReadonlyArray<T>>;\nconst x: Array<number> = [1];"],
  ["next.config images", "next.config.mjs", "export default { images: { domains: ['a.com'] }, reactStrictMode: true };", "export default { images: { domains: ['a.com','b.com'] }, reactStrictMode: false };"],
  ["nuxt.config modules", "nuxt.config.ts", "export default defineNuxtConfig({ modules: ['@nuxt/ui'], app: { head: { title: 'Acme' } } })", "export default defineNuxtConfig({ modules: ['@nuxt/ui', '@pinia/nuxt'], app: { head: { title: 'Acme' } } })"],
  ["netlify build command", "netlify.toml", '[build]\ncommand = "npm run build"\npublish = "out"', '[build]\ncommand = "npm run build:prod"\npublish = "out"'],
  [".htaccess cache header", ".htaccess", 'Header set Cache-Control "max-age=3600"\nRedirect 301 /a /b', 'Header set Cache-Control "max-age=7200"\nRedirect 301 /a /b'],
  ["metadata openGraph image only", "app/page.tsx", 'export const metadata = { title: "Home", openGraph: { images: ["/a.png"] } };', 'export const metadata = { title: "Home", openGraph: { images: ["/b.png"] } };'],
  ["Vue script logic", "components/Card.vue", '<template><div class="c"><p>Hello there friend</p></div></template>\n<script setup>\nconst n = ref(1)\n</script>', '<template><div class="c"><p>Hello there friend</p></div></template>\n<script setup>\nconst n = ref(2)\n</script>'],
  ["PHP logic", "wp-content/themes/t/inc/x.php", "<?php\n$a = 1;\n?><p>Welcome to our store</p>", "<?php\n$a = 2;\n?><p>Welcome to our store</p>"],
  ["package.json dependency bump", "package.json", '{"dependencies":{"react":"19.0.0"},"scripts":{"prepare":"seo-seatbelt install"}}', '{"dependencies":{"react":"19.1.0"},"scripts":{"prepare":"seo-seatbelt install"}}'],
  ["README edit", "README.md", "# A\nold", "# B\nnew"],
];

describe("guard regressions", () => {
  it.each(MUST_FLAG)("catches: %s", (...testCase) => {
    expect(isFlagged(testCase)).toBe(true);
  });

  it.each(MUST_PASS)("lets through: %s", (...testCase) => {
    expect(isFlagged(testCase)).toBe(false);
  });
});
