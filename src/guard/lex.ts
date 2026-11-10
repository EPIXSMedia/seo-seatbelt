/*
 * Small, forgiving readers for source text: quoted strings, template literals and balanced
 * brackets. They never throw: on broken input they stop at the end of the line or the file,
 * so one odd character cannot hide the rest of a file from the guard.
 */

const CLOSERS: Record<string, string> = { "{": "}", "[": "]", "(": ")" };

export function isQuote(char: string | undefined): boolean {
  return char === '"' || char === "'" || char === "`";
}

/** Index just after the string that starts at `start`. Plain strings end at a newline, like JavaScript's. */
export function skipString(text: string, start: number): number {
  const quote = text[start];
  let index = start + 1;
  while (index < text.length) {
    const char = text[index];
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === quote) return index + 1;
    if (char === "\n" && quote !== "`") return index;
    if (quote === "`" && char === "$" && text[index + 1] === "{") {
      index = skipBalanced(text, index + 1);
      continue;
    }
    index += 1;
  }
  return text.length;
}

/** Index just after the bracket that closes the one at `start` (`{`, `[` or `(`), skipping strings inside. */
export function skipBalanced(text: string, start: number): number {
  const stack: string[] = [];
  let index = start;
  while (index < text.length) {
    const char = text[index] ?? "";
    if (isQuote(char)) {
      index = skipString(text, index);
      continue;
    }
    const comment = skipComment(text, index);
    if (comment !== index) {
      index = comment;
      continue;
    }
    const closer = CLOSERS[char];
    if (closer !== undefined) stack.push(closer);
    else if (char === stack[stack.length - 1]) {
      stack.pop();
      if (stack.length === 0) return index + 1;
    }
    index += 1;
  }
  return text.length;
}

/** Strip one pair of matching quotes from a value written as a plain string literal. */
export function unquote(value: string): string {
  const first = value.charAt(0);
  if (value.length >= 2 && isQuote(first) && value.endsWith(first)) return value.slice(1, -1);
  return value;
}

/** Index just after a `//` or `/* *\/` comment starting at `start`, or `start` itself when there is none. */
export function skipComment(text: string, start: number): number {
  if (text[start] !== "/") return start;
  const next = text[start + 1];
  if (next === "/") {
    const end = text.indexOf("\n", start);
    return end === -1 ? text.length : end;
  }
  if (next === "*") {
    const end = text.indexOf("*/", start + 2);
    return end === -1 ? text.length : end + 2;
  }
  return start;
}

/** Split text on a separator that sits outside every string and bracket. */
export function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = [];
  let index = 0;
  let partStart = 0;
  while (index < text.length) {
    const char = text[index] ?? "";
    if (isQuote(char)) index = skipString(text, index);
    else if (CLOSERS[char] !== undefined) index = skipBalanced(text, index);
    else if (char === separator) {
      parts.push(text.slice(partStart, index));
      index += 1;
      partStart = index;
    } else index += 1;
  }
  parts.push(text.slice(partStart));
  return parts;
}

/** Remove every balanced `{…}` group from text. An unclosed `{` drops the rest. */
export function withoutBraceGroups(text: string): string {
  let result = "";
  let index = 0;
  while (index < text.length) {
    const open = text.indexOf("{", index);
    if (open === -1) return result + text.slice(index);
    result += `${text.slice(index, open)} `;
    index = skipBalanced(text, open);
  }
  return result;
}
