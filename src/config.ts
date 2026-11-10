import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { errorMessage } from "./errors.js";

export const CONFIG_FILE_NAME = "seo-seatbelt.config.json";

const DEFAULT_MAX_PAGES = 200;
const PAGE_CAP = 5000;
const DEFAULT_CONCURRENCY = 4;
const MAX_CONCURRENCY = 16;
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_WORD_PERCENT = 5;
const DEFAULT_WORD_COUNT = 25;

const signalNames = z.enum([
  "status", "redirects", "xRobotsTag", "lang", "title", "metaDescription", "metaRobots",
  "canonical", "hreflang", "pagination", "headings", "links", "wordCount", "structuredData",
  "robotsTxt", "sitemapUrls",
]);

const guardSchema = z.object({
  /** "ask" pauses the agent for the owner's yes/no; "deny" refuses outright (use for unattended agents). */
  decision: z.enum(["ask", "deny"]).default("ask"),
  protectedFiles: z.array(z.string()).default([]),
  contentFiles: z.array(z.string()).default([]),
  routeFiles: z.array(z.string()).default([]),
  ignoreFiles: z.array(z.string()).default([]),
}).strict();

export const configSchema = z.object({
  $schema: z.string().optional(),
  /** The live site's address. Same-site links are stored as paths, so any host can be checked against it. */
  baseUrl: z.url({ protocol: /^https?$/ }).optional(),
  pages: z.array(z.string().min(1)).default(["/"]),
  discoverFromSitemap: z.boolean().default(false),
  /** Read built HTML files from this folder instead of fetching pages over the network. */
  dir: z.string().optional(),
  cleanUrls: z.boolean().default(false),
  baseline: z.string().default(".seo-seatbelt/baseline.json"),
  maxPages: z.number().int().positive().max(PAGE_CAP).default(DEFAULT_MAX_PAGES),
  concurrency: z.number().int().min(1).max(MAX_CONCURRENCY).default(DEFAULT_CONCURRENCY),
  timeoutMs: z.number().int().positive().default(DEFAULT_TIMEOUT_MS),
  ignoreSelectors: z.array(z.string()).default([]),
  ignoreJsonLdKeys: z.array(z.string()).default([]),
  ignoreSignals: z.array(signalNames).default([]),
  wordCount: z.object({
    percent: z.number().min(0).default(DEFAULT_WORD_PERCENT),
    words: z.number().int().min(0).default(DEFAULT_WORD_COUNT),
  }).strict().prefault({}),
  guard: guardSchema.prefault({}),
}).strict();

export type SeatbeltConfig = z.infer<typeof configSchema>;
export type GuardConfig = SeatbeltConfig["guard"];

export interface LoadedConfig {
  config: SeatbeltConfig;
  /** Folder holding the config file (or the starting folder when there is none). */
  root: string;
  file: string | null;
}

export class ConfigError extends Error {
  override name = "ConfigError";
}

export function findConfigFile(startDir: string): string | null {
  let current = path.resolve(startDir);
  for (;;) {
    const candidate = path.join(current, CONFIG_FILE_NAME);
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function parseConfig(raw: unknown, source: string): SeatbeltConfig {
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigError(`${source} is not valid:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

export function loadConfig(startDir: string): LoadedConfig {
  const file = findConfigFile(startDir);
  if (file === null) {
    return { config: parseConfig({}, "default config"), root: path.resolve(startDir), file: null };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new ConfigError(`${file} could not be read as JSON: ${errorMessage(error)}`);
  }
  return { config: parseConfig(raw, file), root: path.dirname(file), file };
}
