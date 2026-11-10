import { createHash } from "node:crypto";
import { countWords, normalizeText, rankingRelTokens } from "../normalize.js";
import { skipBalanced, skipString, withoutBraceGroups } from "./lex.js";

/*
 * Reads tags out of HTML, templates and JSX without a full parser. A tag ends at the first
 * `>` that is outside quotes and `{…}`, so `content={`${a} > ${b}`}` stays one attribute.
 */

export interface Tag {
  name: string;
  closing: boolean;
  selfClosing: boolean;
  attributes: string;
  start: number;
  end: number;
}

const TAG_START = /<(\/?)([A-Za-z][\w:.-]*)/uy;
const RAW_TEXT_ELEMENTS = new Set(["script", "style", "textarea"]);
const ATTRIBUTE_NAME = /[^\s=>/"'{}]+/uy;
const HEADING_NAME = /^(?:(?:motion|m|animated|styled)\.)?h([1-6])$/iu;
const HEADING_COMPONENTS = new Set(["Heading", "Title"]);
const HEADING_VALUE = /^h([1-6])$/iu;
const LEVEL_VALUE = /^[1-6]$/u;
const ANY_TAG = /<[^>]*>/gu;
const BODY_PREVIEW_LENGTH = 60;
const FINGERPRINT_LENGTH = 10;

export function scanTags(text: string): Tag[] {
  const tags: Tag[] = [];
  let index = text.indexOf("<");
  while (index !== -1) {
    if (text.startsWith("<!--", index)) {
      const close = text.indexOf("-->", index + 4);
      index = close === -1 ? -1 : text.indexOf("<", close + 3);
      continue;
    }
    TAG_START.lastIndex = index;
    const match = TAG_START.exec(text);
    if (match === null) {
      index = text.indexOf("<", index + 1);
      continue;
    }
    const tag = readTag(text, index, TAG_START.lastIndex, match[2] ?? "", match[1] === "/");
    tags.push(tag);
    index = text.indexOf("<", rawTextEnd(text, tag));
  }
  return tags;
}

function readTag(text: string, start: number, nameEnd: number, name: string, closing: boolean): Tag {
  const end = tagEnd(text, nameEnd);
  const attributes = text.slice(nameEnd, text[end - 1] === ">" ? end - 1 : end);
  return { name, closing, selfClosing: attributes.trimEnd().endsWith("/"), attributes, start, end };
}

/** Script and style bodies are not markup: jump to their closing tag. */
function rawTextEnd(text: string, tag: Tag): number {
  if (tag.closing || tag.selfClosing || !RAW_TEXT_ELEMENTS.has(tag.name.toLowerCase())) return tag.end;
  const close = text.toLowerCase().indexOf(`</${tag.name.toLowerCase()}`, tag.end);
  return close === -1 ? text.length : close;
}

function tagEnd(text: string, from: number): number {
  let index = from;
  while (index < text.length) {
    const char = text[index];
    if (char === '"' || char === "'") {
      const close = text.indexOf(char, index + 1);
      index = close === -1 ? index + 1 : close + 1;
    } else if (char === "`") index = skipString(text, index);
    else if (char === "{") index = skipBalanced(text, index);
    else if (char === ">") return index + 1;
    else if (char === "<") return index;
    else index += 1;
  }
  return text.length;
}

/** Attribute names (lower case) to raw values; `{…}` values keep their inner expression. */
export function parseAttributes(attributes: string): Record<string, string> {
  const result: Record<string, string> = {};
  let index = 0;
  while (index < attributes.length) {
    const char = attributes[index] ?? "";
    if (char === "{") {
      index = skipBalanced(attributes, index);
      continue;
    }
    ATTRIBUTE_NAME.lastIndex = index;
    const name = ATTRIBUTE_NAME.exec(attributes)?.[0];
    if (name === undefined) {
      index += 1;
      continue;
    }
    const value = readAttributeValue(attributes, ATTRIBUTE_NAME.lastIndex);
    result[name.toLowerCase()] = value.value;
    index = value.end;
  }
  return result;
}

function readAttributeValue(attributes: string, from: number): { value: string; end: number } {
  let index = from;
  while (/\s/u.test(attributes[index] ?? "")) index += 1;
  if (attributes[index] !== "=") return { value: "", end: from };
  index += 1;
  while (/\s/u.test(attributes[index] ?? "")) index += 1;
  const char = attributes[index] ?? "";
  if (char === '"' || char === "'") {
    const close = attributes.indexOf(char, index + 1);
    const end = close === -1 ? attributes.length : close;
    return { value: attributes.slice(index + 1, end), end: end + 1 };
  }
  if (char === "{") {
    const end = skipBalanced(attributes, index);
    return { value: normalizeText(attributes.slice(index + 1, end - 1)), end };
  }
  const end = attributes.slice(index).search(/[\s>]|$/u) + index;
  return { value: attributes.slice(index, end), end };
}

/** Text between an opening tag and its matching closing tag, or null when it is never closed. */
export function innerHtml(text: string, tags: readonly Tag[], openIndex: number): string | null {
  const open = tags[openIndex];
  if (open === undefined || open.selfClosing) return null;
  let depth = 0;
  for (let index = openIndex + 1; index < tags.length; index += 1) {
    const tag = tags[index];
    if (tag === undefined || tag.selfClosing || tag.name.toLowerCase() !== open.name.toLowerCase()) continue;
    if (!tag.closing) depth += 1;
    else if (depth === 0) return text.slice(open.end, tag.start);
    else depth -= 1;
  }
  return null;
}

export function innerText(html: string | null): string {
  return normalizeText((html ?? "").replace(ANY_TAG, " "));
}

/** The heading level a tag renders, from `<h2>`, `<motion.h1>`, `as="h1"`, `variant="h1"` or `level={2}`. */
export function headingLevel(tag: Tag): number | null {
  const direct = HEADING_NAME.exec(tag.name);
  if (direct !== null) return Number(direct[1]);
  const attributes = parseAttributes(tag.attributes);
  for (const key of ["as", "variant", "component"]) {
    const level = HEADING_VALUE.exec(attributes[key] ?? "");
    if (level !== null) return Number(level[1]);
  }
  if (!HEADING_COMPONENTS.has(tag.name)) return null;
  const level = attributes.level ?? attributes.order ?? attributes.size;
  return level !== undefined && LEVEL_VALUE.test(level.replace(/["'`]/gu, "")) ? Number(level.replace(/["'`]/gu, "")) : null;
}

export function anchorSignal(tag: Tag, inner: string | null): string {
  const attributes = parseAttributes(tag.attributes);
  const href = attributes.href ?? attributes[":href"] ?? attributes["v-bind:href"] ?? attributes.to ?? attributes[":to"] ?? attributes["v-bind:to"] ?? "";
  const rel = rankingRelTokens(attributes.rel);
  return `link: ${normalizeText(href)} "${innerText(inner)}"${rel.length > 0 ? ` [rel=${rel.join(" ")}]` : ""}`;
}

export function bodyCopySignal(text: string): string {
  const normalized = normalizeText(text);
  const fingerprint = createHash("sha256").update(normalized).digest("hex").slice(0, FINGERPRINT_LENGTH);
  const preview = normalized.length > BODY_PREVIEW_LENGTH ? `${normalized.slice(0, BODY_PREVIEW_LENGTH)}…` : normalized;
  return `body copy: ${countWords(normalized)} words, "${preview}" #${fingerprint}`;
}

/** Parts of a page whose text is already its own signal, or is not visible copy. */
const NOT_BODY_COPY = new Set(["head", "title", "script", "style", "svg", "noscript", "template-literal", "a", "link", "navlink", "nuxtlink", "routerlink", "router-link", "nuxt-link", "textarea"]);
const TEMPLATE_CODE = /<\?(?:php|=)?[\s\S]*?(?:\?>|$)|<%[\s\S]*?(?:%>|$)|\{\{[\s\S]*?\}\}|\{%[\s\S]*?%\}|\{#[\s\S]*?#\}/gu;
const CODE_FRAGMENT = /=>|&&|\|\||[;{}]/u;

/**
 * Visible copy of a page or component, outside headings, links and scripts. In JSX only
 * text inside elements that are closed later counts, so TypeScript generics are not copy.
 */
export function visibleCopy(text: string, jsx: boolean): string {
  const source = jsx ? text : text.replace(TEMPLATE_CODE, " ");
  const tags = scanTags(source);
  const closedNames = new Set(tags.filter((tag) => tag.closing).map((tag) => tag.name));
  const parts: string[] = [];
  let skipped = 0;
  let open = 0;
  tags.forEach((tag, index) => {
    const ignoredElement = NOT_BODY_COPY.has(tag.name.toLowerCase()) || headingLevel(tag) !== null;
    if (!tag.selfClosing && (ignoredElement || (jsx && closedNames.has(tag.name)))) {
      const step = tag.closing ? -1 : 1;
      if (ignoredElement) skipped = Math.max(0, skipped + step);
      else open = Math.max(0, open + step);
    }
    const next = tags[index + 1]?.start ?? source.length;
    if (skipped > 0 || (jsx && open === 0)) return;
    const segment = withoutBraceGroups(source.slice(tag.end, next));
    if (!jsx || !CODE_FRAGMENT.test(segment)) parts.push(segment);
  });
  return normalizeText(parts.join(" "));
}
