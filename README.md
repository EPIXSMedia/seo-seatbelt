# SEO Seatbelt

**Stops AI coding agents, and people, from changing a website's Google ranking signals without the site owner's approval.**

AI coding agents such as Claude Code, Codex, Cursor and Copilot are good at "tidying up". They shorten a title, reword an H1, "fix" a canonical, add `noindex` to a staging page that ships to production, rename a slug or rewrite three paragraphs of copy. Each change looks harmless in a diff. But a lost ranking can take weeks to show up and months to win back, and by then nobody remembers which commit caused it.

SEO Seatbelt puts a check in front of those changes:

| Layer | When it runs | What it does |
| --- | --- | --- |
| **Agent hook** | Before Claude Code or Codex writes a file | Pauses the agent and shows the owner exactly which ranking signals would change, or refuses the edit outright |
| **Git pre-commit hook** | Before any commit, from a person or any tool | Blocks a staged change to ranking signals until the owner allows it |
| **Served-page check** | In CI, after a deploy, or on a schedule | Compares the real HTML a site serves (or a build folder) with an approved baseline |

Changes that cannot move rankings, such as CSS, classes, scripts, images and security headers, pass straight through.

## What counts as a ranking signal

Page title · meta description · robots meta and `X-Robots-Tag` · canonical · `hreflang` · pagination links · H1–H6 · internal and outbound links, including anchor text and `nofollow` / `sponsored` / `ugc` · body copy and word count · JSON-LD structured data · HTTP status and redirect chains · `robots.txt` · sitemap URLs · which page URLs exist (added, deleted or renamed page files).

In source files it reads plain HTML and templates (PHP, Twig, Liquid, Handlebars, EJS and others), JSX/TSX, Vue, Svelte and Astro components, Next.js `metadata`, Nuxt `useHead` / `useSeoMeta`, `next-seo`, React Helmet, WordPress SEO hooks (Yoast, Rank Math, AIOSEO, SEOPress, core canonical and redirects), Markdown/MDX frontmatter, headings, links and body copy, and the redirect and URL settings in `.htaccess`, `vercel.json`, `netlify.toml`, `next.config.*` and similar files.

## Install

Requires Node.js 20.18.1 or later.

```sh
echo "allow-git=root" >> .npmrc          # npm 12+ only installs from GitHub when the project opts in
npm install --save-dev github:EPIXSMedia/seo-seatbelt
npx seo-seatbelt init --url https://your-site.com --git --claude
npx seo-seatbelt baseline
git add .npmrc seo-seatbelt.config.json .seo-seatbelt/baseline.json .claude/settings.json
```

The `.npmrc` line lets npm 12 and later install a package straight from GitHub, here and in CI (`npm ci`). Older npm versions do not need it. npm may warn that the package's `prepare` script was skipped. That is harmless: npm has already built the package while fetching it from GitHub.

`init` writes `seo-seatbelt.config.json`. `--git` installs the pre-commit hook and `--claude` adds the Claude Code hook to `.claude/settings.json`; existing settings are kept. `baseline` records the approved state of the site. Commit the baseline so every later check compares against it.

### Codex

Add the hook to your Codex `hooks.json`. Codex then asks you to trust the new hook:

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "npx --no-install seo-seatbelt hook" }] }
    ]
  }
}
```

The hook reads Codex `apply_patch` edits as well as Claude Code `Edit`, `Write` and `MultiEdit` calls. Every other tool call passes through untouched.

### Cursor, Copilot and everything else

Any tool that commits through git is covered by the pre-commit hook. Anything that reaches production is covered by the served-page check in CI.

## Approving a change

The hook and the commit check never decide on the owner's behalf. They describe the change, for example:

```
SEO Seatbelt: this change can move the site's Google rankings, so it needs the site owner's approval.

  src/app/pricing/page.tsx — changes page metadata (title / description / robots)
      - metadata: title: "Pricing — Acme Invoicing for Freelancers",
      + metadata: title: "Pricing",
```

- **Agent hook, `"decision": "ask"` (the default):** the agent pauses and the owner answers yes or no in the agent's own permission prompt.
- **Agent hook, `"decision": "deny"`:** the edit is refused. Use this for unattended or background agents. To let an approved change through, the owner starts that session with `SEO_SEATBELT_ALLOW=1`.
- **Commits:** `SEO_SEATBELT_ALLOW=1 git commit …` once the owner has approved.
- **Baseline:** after an approved change is live, run `npx seo-seatbelt baseline` and commit the new baseline.

## Checking the served site

```sh
npx seo-seatbelt check                                  # the live site in "baseUrl"
npx seo-seatbelt check --url https://preview.example.app # a preview deployment
npx seo-seatbelt check --url http://localhost:3000       # a local dev server
npx seo-seatbelt check --dir out                         # a static build folder
npx seo-seatbelt check --json                            # machine-readable output
```

Same-site links, canonicals and redirects are stored as paths, so a baseline taken from production can be compared with localhost, a preview URL or a build folder.

| Exit code | Meaning |
| --- | --- |
| `0` | No ranking signal changed |
| `1` | Changes need the owner's approval (listed with before and after) |
| `2` | The check could not be completed: a page timed out, was cut off, or the server answered 429/5xx. **This is never a pass.** Re-run it. |

The checker fetches HTML only and never runs JavaScript, so it does not trigger ads, analytics or tracking scripts on the site. Busy servers get one polite retry that honours `Retry-After`.

### GitHub Actions

```yaml
name: SEO Seatbelt
on: [pull_request]
jobs:
  seo:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm ci
      - run: npm run build          # your site's build
      - run: npx seo-seatbelt check --dir out
```

## Configuration

`seo-seatbelt.config.json` (all fields optional):

```json
{
  "baseUrl": "https://your-site.com",
  "pages": ["/", "/pricing/", "/blog/"],
  "discoverFromSitemap": true,
  "maxPages": 200,
  "dir": "out",
  "cleanUrls": false,
  "baseline": ".seo-seatbelt/baseline.json",
  "concurrency": 4,
  "timeoutMs": 20000,
  "ignoreSelectors": [".cookie-banner", "[data-ad]"],
  "ignoreJsonLdKeys": ["dateModified"],
  "ignoreSignals": [],
  "wordCount": { "percent": 5, "words": 25 },
  "guard": {
    "decision": "ask",
    "protectedFiles": [],
    "contentFiles": [],
    "routeFiles": [],
    "ignoreFiles": []
  }
}
```

- `pages` / `discoverFromSitemap` / `maxPages`: which pages are read. Sitemap URLs are added up to the limit.
- `dir` / `cleanUrls`: read a build folder instead of fetching. With `cleanUrls`, `about.html` is served as `/about`.
- `ignoreSelectors`: page parts left out before reading, such as rotating banners, dates and live widgets.
- `ignoreJsonLdKeys`: structured-data keys that change on every build.
- `wordCount`: copy changes are flagged only when **both** limits are passed, so a typo fix does not raise an alarm.
- `guard.protectedFiles`: extra files where any change needs approval. `robots.txt`, sitemaps and `_redirects` are always protected.
- `guard.contentFiles`: extra Markdown folders whose body copy counts as content.
- `guard.routeFiles`: extra files whose existence is a URL.
- `guard.ignoreFiles`: files the guard should never inspect.

## Library use

```ts
import { compareSnapshots, loadConfig, takeSnapshot } from "seo-seatbelt";

const { config, root } = loadConfig(process.cwd());
const current = await takeSnapshot({ config, root });
```

## Limits

- The source-file guard reads files with fast pattern matching, not a full compiler. A title assembled at runtime from a database or API cannot be seen until it is served. The served-page check is the backstop for that.
- The served-page check reads HTML as served, without running JavaScript. Ranking signals that only exist after client-side rendering are not seen.
- A hook can be removed by whoever controls the machine. SEO Seatbelt stops accidents and over-eager agents; it is not access control.

## Contributing

Issues and pull requests are welcome. `npm test` runs the suite. `npm run lint` and `npm run typecheck` must stay clean.

## Licence

MIT © EPIXS Media
