import { normalizeText } from "../normalize.js";
import { isQuote, skipBalanced, skipComment, skipString, splitTopLevel, unquote } from "./lex.js";

/*
 * A forgiving reader for JavaScript, TypeScript and JSON settings. It turns every object
 * property it can see into a "leaf": the key path and the raw value, e.g.
 *   metadata.robots.index = false
 *   redirects[].destination = "/new"
 * It is not a parser: it never throws, and on odd input it simply sees less.
 */

export interface Leaf {
  path: readonly string[];
  value: string;
}

/** Calls whose argument object is page metadata, so their name belongs in the key path. */
const KEYED_CALLS = new Set(["useHead", "useSeoMeta", "useServerHead", "useServerSeoMeta", "definePageMeta", "generateMetadata"]);
const IDENTIFIER_START = /[A-Za-z_$@]/u;
const IDENTIFIER_PART = /[\w$@.]/u;
const WHITESPACE = /\s/u;
/** A value continues on the next line when its line ends with, or the next line starts with, an operator. */
const CONTINUES_AFTER = /[+\-*/%?:=,.(&|<>[{]$/u;
const CONTINUES_BEFORE = /^(?:[+\-*%?:.&|]|\/(?![/*]))/u;

export function scanLeaves(text: string): Leaf[] {
  const leaves: Leaf[] = [];
  scanStatements(text, 0, text.length, [], leaves);
  return leaves;
}

function skipSpace(text: string, start: number, end: number): number {
  let index = start;
  while (index < end) {
    const comment = skipComment(text, index);
    if (comment !== index) index = comment;
    else if (WHITESPACE.test(text[index] ?? "")) index += 1;
    else break;
  }
  return index;
}

function scanStatements(text: string, from: number, to: number, prefix: readonly string[], leaves: Leaf[]): void {
  let index = from;
  while (index < to) {
    index = skipSpace(text, index, to);
    const char = text[index] ?? "";
    if (index >= to) return;
    if (char === "{" || char === "(") {
      const end = Math.min(skipBalanced(text, index), to);
      scanStatements(text, index + 1, end - 1, prefix, leaves);
      index = end;
    } else if (char === "[") {
      const end = Math.min(skipBalanced(text, index), to);
      scanArray(text, index, end, prefix, leaves);
      index = end;
    } else if (isQuote(char)) {
      index = scanQuotedKey(text, index, to, prefix, leaves);
    } else if (IDENTIFIER_START.test(char)) {
      index = scanIdentifier(text, index, to, prefix, leaves);
    } else {
      index += 1;
    }
  }
}

function scanQuotedKey(text: string, start: number, to: number, prefix: readonly string[], leaves: Leaf[]): number {
  const end = Math.min(skipString(text, start), to);
  const after = skipSpace(text, end, to);
  if (text[after] !== ":" || text[after + 1] === ":") return end;
  return readValue(text, after + 1, to, [...prefix, unquote(text.slice(start, end))], leaves);
}

function readIdentifier(text: string, start: number, to: number): number {
  let index = start + 1;
  while (index < to && IDENTIFIER_PART.test(text[index] ?? "")) index += 1;
  return index;
}

function scanIdentifier(text: string, start: number, to: number, prefix: readonly string[], leaves: Leaf[]): number {
  const end = readIdentifier(text, start, to);
  const name = text.slice(start, end);
  const after = skipSpace(text, end, to);
  const next = text[after];
  const following = text[after + 1];
  if (next === ":" && following !== ":") return readValue(text, after + 1, to, [...prefix, name], leaves);
  if (next === "=" && following !== "=" && following !== ">") return readValue(text, after + 1, to, [...prefix, name], leaves);
  if (next === "(") return scanCall(text, name, after, to, prefix, leaves);
  if ((next === "," || after >= to) && prefix.length > 0) leaves.push({ path: [...prefix, name], value: name });
  return end;
}

/** `name(…)` is a call or, when a `{` body follows, a function or method named `name`. */
function scanCall(text: string, name: string, open: number, to: number, prefix: readonly string[], leaves: Leaf[]): number {
  const argumentsEnd = Math.min(skipBalanced(text, open), to);
  const keyed = KEYED_CALLS.has(name) ? [...prefix, name] : prefix;
  scanStatements(text, open + 1, argumentsEnd - 1, keyed, leaves);
  let bodyStart = skipSpace(text, argumentsEnd, to);
  if (text[bodyStart] === ":") bodyStart = skipReturnType(text, bodyStart, to);
  if (text[bodyStart] !== "{") return argumentsEnd;
  const bodyEnd = Math.min(skipBalanced(text, bodyStart), to);
  scanStatements(text, bodyStart + 1, bodyEnd - 1, [...prefix, name], leaves);
  return bodyEnd;
}

function skipReturnType(text: string, colon: number, to: number): number {
  let index = colon + 1;
  let angle = 0;
  while (index < to) {
    const char = text[index];
    if (char === "<") angle += 1;
    else if (char === ">") angle -= 1;
    else if (char === "{" && angle <= 0) return index;
    else if (char === ";" || char === "\n") return index;
    index += 1;
  }
  return index;
}

/** Elements of an array: objects and arrays are read inside, plain values become one leaf each. */
function scanArray(text: string, open: number, end: number, path: readonly string[], leaves: Leaf[]): void {
  const last = path[path.length - 1];
  const elementPath = last === undefined ? ["[]"] : [...path.slice(0, -1), `${last}[]`];
  for (const element of splitTopLevel(text.slice(open + 1, end - 1), ",")) {
    const trimmed = element.trim();
    if (trimmed === "") continue;
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) scanStatements(trimmed, 0, trimmed.length, elementPath, leaves);
    else leaves.push({ path: elementPath, value: normalizeText(trimmed) });
  }
}

/** Read the value of `path` starting at `start`; returns the index just after it. */
function readValue(text: string, start: number, to: number, path: readonly string[], leaves: Leaf[]): number {
  const index = skipSpace(text, start, to);
  const char = text[index];
  if (char === "{") {
    const end = Math.min(skipBalanced(text, index), to);
    scanStatements(text, index + 1, end - 1, path, leaves);
    return end;
  }
  if (char === "[") {
    const end = Math.min(skipBalanced(text, index), to);
    scanArray(text, index, end, path, leaves);
    return end;
  }
  const end = rawValueEnd(text, index, to);
  if (end.restartAt !== null) return readValue(text, end.restartAt, to, path, leaves);
  const nested: Leaf[] = [];
  scanStatements(text, index, end.index, path, nested);
  if (nested.length > 0) leaves.push(...nested);
  else leaves.push({ path, value: normalizeText(text.slice(index, end.index)) });
  return end.index;
}

/**
 * Where a plain value ends: at a top-level `,` `;` or closing bracket, or at a line break
 * that does not continue the expression. A lone `=` means what came before was a type
 * annotation (`metadata: Metadata = {…}`), so the value restarts after it.
 */
function rawValueEnd(text: string, start: number, to: number): { index: number; restartAt: number | null } {
  let index = start;
  while (index < to) {
    const char = text[index] ?? "";
    if (isQuote(char)) index = skipString(text, index);
    else if (char === "{" || char === "(" || char === "[") index = Math.min(skipBalanced(text, index), to);
    else if (char === "," || char === ";" || char === "}" || char === "]" || char === ")") break;
    else if (char === "=" && isLoneEquals(text, index)) return { index, restartAt: index + 1 };
    else if (char === "\n" && endsValue(text, start, index, to)) break;
    else index += 1;
  }
  return { index, restartAt: null };
}

function isLoneEquals(text: string, index: number): boolean {
  return !/[=!<>+\-*/%&|^?]/u.test(text[index - 1] ?? "") && !/[=>]/u.test(text[index + 1] ?? "");
}

function endsValue(text: string, start: number, newline: number, to: number): boolean {
  const soFar = text.slice(start, newline).trimEnd();
  if (soFar === "" || CONTINUES_AFTER.test(soFar)) return false;
  const nextStart = skipSpace(text, newline, to);
  return !CONTINUES_BEFORE.test(text.slice(nextStart, nextStart + 2));
}

/** The key path as one readable string. */
export function pathText(path: readonly string[]): string {
  return path.join(".");
}

/** A path segment in the form used for matching: lower case, without `[]`, `_` or `-`. */
export function segmentKey(segment: string): string {
  return segment.replace(/\[\]$/u, "").replace(/[_-]/gu, "").toLowerCase();
}
