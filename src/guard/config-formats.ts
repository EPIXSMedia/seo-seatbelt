import { normalizeText } from "../normalize.js";
import { skipBalanced, unquote } from "./lex.js";
import type { Leaf } from "./scan.js";

/*
 * Leaf readers for the plain-text settings formats sites use: YAML, TOML, Apache
 * `.htaccess` and nginx. Each returns readable lines; nothing here ever throws.
 */

const YAML_KEY = /^(["']?)([^"'#:][^"'#:]*?)\1\s*:(?:\s+(.*?))?\s*$/u;
const YAML_BLOCK_SCALAR = /^[|>][+-]?$/u;
const TOML_TABLE = /^\[\[?\s*([^\]]+?)\s*\]\]?\s*(?:#.*)?$/u;
const TOML_KEY = /^((?:"[^"]*"|'[^']*'|[\w.-]+)(?:\s*\.\s*(?:"[^"]*"|'[^']*'|[\w-]+))*)\s*=\s*(.*)$/u;
const HTACCESS_DIRECTIVES = new Set([
  "redirect", "redirectmatch", "redirectpermanent", "redirecttemp", "rewriterule", "rewritecond", "rewriteengine",
  "rewritebase", "rewritemap", "errordocument", "directoryindex", "options", "directoryslash", "fallbackresource",
]);
const NGINX_DIRECTIVES = new Set(["return", "rewrite", "error_page", "try_files", "index", "server_name", "root", "alias", "absolute_redirect"]);
const HEADER_SIGNAL = /x-robots-tag|\blink\b/iu;

interface YamlFrame {
  indent: number;
  key: string;
}

export function yamlLeaves(text: string): Leaf[] {
  const leaves: Leaf[] = [];
  const stack: YamlFrame[] = [];
  let blockScalar: { indent: number; leaf: Leaf } | null = null;
  for (const rawLine of text.split(/\r?\n/u)) {
    const indent = rawLine.length - rawLine.trimStart().length;
    const content = rawLine.trim();
    if (blockScalar !== null && (content === "" || indent > blockScalar.indent)) {
      blockScalar.leaf.value = normalizeText(`${blockScalar.leaf.value} ${content}`);
      continue;
    }
    blockScalar = null;
    if (content === "" || content.startsWith("#") || content === "---") continue;
    const opened = yamlLine(content, indent, stack, leaves);
    if (opened !== null) blockScalar = { indent, leaf: opened };
  }
  return leaves;
}

/** Read one YAML line; returns the leaf when it opens a block scalar (`|` or `>`). */
function yamlLine(content: string, indent: number, stack: YamlFrame[], leaves: Leaf[]): Leaf | null {
  while (stack.length > 0 && (stack[stack.length - 1]?.indent ?? 0) >= indent) stack.pop();
  let rest = content;
  let restIndent = indent;
  if (rest === "-" || rest.startsWith("- ")) {
    stack.push({ indent, key: "[]" });
    rest = rest.slice(1).trimStart();
    restIndent = indent + (content.length - rest.length);
    if (rest === "") return null;
  }
  const path = stack.map((frame) => frame.key);
  const key = YAML_KEY.exec(rest);
  if (key === null) {
    leaves.push({ path, value: normalizeText(rest) });
    return null;
  }
  const name = key[2] ?? "";
  const value = key[3] ?? "";
  if (value === "" || value.startsWith("#")) {
    stack.push({ indent: restIndent, key: name });
    return null;
  }
  const leaf = { path: [...path, name], value: YAML_BLOCK_SCALAR.test(value) ? "" : normalizeText(value) };
  leaves.push(leaf);
  return YAML_BLOCK_SCALAR.test(value) ? leaf : null;
}

export function tomlLeaves(text: string): Leaf[] {
  const leaves: Leaf[] = [];
  let table: string[] = [];
  let index = 0;
  while (index < text.length) {
    const lineEnd = endOfLine(text, index);
    const line = text.slice(index, lineEnd).trim();
    const header = TOML_TABLE.exec(line);
    const pair = header === null ? TOML_KEY.exec(line) : null;
    if (header !== null) {
      table = dottedKey(header[1] ?? "");
      if (line.startsWith("[[")) table = [...table.slice(0, -1), `${table[table.length - 1] ?? ""}[]`];
    } else if (pair !== null && !line.startsWith("#")) {
      const valueStart = index + text.slice(index, lineEnd).indexOf("=") + 1;
      const valueEnd = tomlValueEnd(text, valueStart, lineEnd);
      leaves.push({ path: [...table, ...dottedKey(pair[1] ?? "")], value: normalizeText(text.slice(valueStart, valueEnd)) });
      index = Math.max(valueEnd, lineEnd);
      continue;
    }
    index = lineEnd + 1;
  }
  return leaves;
}

function endOfLine(text: string, start: number): number {
  const end = text.indexOf("\n", start);
  return end === -1 ? text.length : end;
}

/** A TOML array or inline table may run over several lines; follow it to its closing bracket. */
function tomlValueEnd(text: string, start: number, lineEnd: number): number {
  const first = text.slice(start, lineEnd).search(/\S/u);
  const open = first === -1 ? -1 : start + first;
  if (open !== -1 && (text[open] === "[" || text[open] === "{")) return Math.max(skipBalanced(text, open), lineEnd);
  return lineEnd;
}

function dottedKey(key: string): string[] {
  return (key.match(/"[^"]*"|'[^']*'|[^.\s]+/gu) ?? []).map(unquote);
}

/** Apache: every redirect, rewrite, error-page and index directive, plus robots / Link headers. */
export function htaccessLines(text: string): string[] {
  return text.split(/\r?\n/u).map((line) => line.trim()).filter((line) => {
    if (line === "" || line.startsWith("#")) return false;
    const directive = (/^<?\/?([A-Za-z]+)/u.exec(line)?.[1] ?? "").toLowerCase();
    if (HTACCESS_DIRECTIVES.has(directive)) return true;
    return directive === "header" ? HEADER_SIGNAL.test(line) : /noindex|nofollow|x-robots-tag/iu.test(line);
  }).map(normalizeText);
}

/** nginx: routing statements with the `server` / `location` blocks they sit in. */
export function nginxLines(text: string): string[] {
  const lines: string[] = [];
  const context: string[] = [];
  let statement = "";
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.replace(/(^|\s)#.*$/u, "");
    for (const char of line) {
      if (char === "{") context.push(normalizeText(statement));
      else if (char === "}") context.pop();
      else if (char === ";") lines.push(...nginxStatement(normalizeText(statement), context));
      if (char === "{" || char === "}" || char === ";") statement = "";
      else statement += char;
    }
    statement += " ";
  }
  return lines;
}

function nginxStatement(statement: string, context: readonly string[]): string[] {
  const directive = statement.split(" ")[0]?.toLowerCase() ?? "";
  const relevant = NGINX_DIRECTIVES.has(directive) || (directive === "add_header" && HEADER_SIGNAL.test(statement));
  if (!relevant) return [];
  return [[...context, statement].join(" > ")];
}
