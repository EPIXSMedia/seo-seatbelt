import { errorMessage } from "../errors.js";
import { VERSION } from "../version.js";

const MAX_REDIRECTS = 10;
const MAX_BODY_BYTES = 15 * 1024 * 1024;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
/** Busy or briefly failing servers get one polite retry. */
const RETRY_STATUSES = new Set([429, 502, 503, 504]);
const DEFAULT_RETRY_DELAY_MS = 2_000;
const MAX_RETRY_DELAY_MS = 10_000;
const MS_PER_SECOND = 1_000;
export const USER_AGENT = `seo-seatbelt/${VERSION} (+https://github.com/EPIXSMedia/seo-seatbelt)`;

export interface FetchedDocument {
  status: number;
  /** Every URL the request was redirected to, in order. */
  redirects: string[];
  finalUrl: string;
  xRobotsTag: string | null;
  contentType: string;
  body: string;
}

export class FetchError extends Error {
  override name = "FetchError";
}

/**
 * GET a URL following redirects by hand, so the redirect chain itself is recorded.
 * Never runs JavaScript, so no ads, analytics or trackers are ever triggered.
 */
export async function fetchDocument(url: string, timeoutMs: number): Promise<FetchedDocument> {
  const redirects: string[] = [];
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const response = await requestWithRetry(current, timeoutMs);
    const location = response.headers.get("location");
    if (REDIRECT_STATUSES.has(response.status) && location !== null) {
      await response.body?.cancel();
      current = new URL(location, current).href;
      redirects.push(current);
      continue;
    }
    return {
      status: response.status,
      redirects,
      finalUrl: current,
      xRobotsTag: response.headers.get("x-robots-tag"),
      contentType: response.headers.get("content-type") ?? "",
      body: await readBody(response, current),
    };
  }
  throw new FetchError(`${url} redirected more than ${MAX_REDIRECTS} times`);
}

async function requestWithRetry(url: string, timeoutMs: number): Promise<Response> {
  const first = await request(url, timeoutMs);
  if (!RETRY_STATUSES.has(first.status)) return first;
  await first.body?.cancel();
  await new Promise((resolve) => setTimeout(resolve, retryDelay(first.headers.get("retry-after"))));
  return request(url, timeoutMs);
}

function retryDelay(retryAfter: string | null): number {
  const seconds = Number(retryAfter);
  if (retryAfter === null || !Number.isFinite(seconds) || seconds < 0) return DEFAULT_RETRY_DELAY_MS;
  return Math.min(seconds * MS_PER_SECOND, MAX_RETRY_DELAY_MS);
}

async function request(url: string, timeoutMs: number): Promise<Response> {
  try {
    return await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        "user-agent": USER_AGENT,
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5",
        "cache-control": "no-cache",
        pragma: "no-cache",
      },
    });
  } catch (error) {
    throw new FetchError(`could not fetch ${url}: ${errorMessage(error)}`);
  }
}

async function readBody(response: Response, url: string): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) throw new FetchError(`${url} is larger than ${MAX_BODY_BYTES} bytes`);
  try {
    const body = await response.text();
    if (body.length > MAX_BODY_BYTES) throw new FetchError(`${url} is larger than ${MAX_BODY_BYTES} bytes`);
    return body;
  } catch (error) {
    if (error instanceof FetchError) throw error;
    throw new FetchError(`could not read ${url}: ${errorMessage(error)}`);
  }
}
