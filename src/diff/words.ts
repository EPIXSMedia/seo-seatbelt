/*
 * How many words a rewrite added or removed: the word-level edit distance (insertions plus
 * deletions) between two texts. The shared start and end are trimmed first, so a typo fix
 * in a long paragraph costs two words, not the whole paragraph.
 */

import { wordsOf } from "../normalize.js";

/** Above this many cells the exact count is skipped and every differing word is counted. */
const MAX_COMPARISON_CELLS = 4_000_000;

export function wordsChanged(before: string, after: string): number {
  const left = wordsOf(before);
  const right = wordsOf(after);
  let start = 0;
  while (start < left.length && start < right.length && left[start] === right[start]) start += 1;
  let end = 0;
  while (end < left.length - start && end < right.length - start && left[left.length - 1 - end] === right[right.length - 1 - end]) end += 1;
  const leftMiddle = left.slice(start, left.length - end);
  const rightMiddle = right.slice(start, right.length - end);
  if (leftMiddle.length * rightMiddle.length > MAX_COMPARISON_CELLS) return leftMiddle.length + rightMiddle.length;
  return leftMiddle.length + rightMiddle.length - 2 * longestCommonSubsequence(leftMiddle, rightMiddle);
}

function longestCommonSubsequence(left: readonly string[], right: readonly string[]): number {
  let previous = new Uint32Array(right.length + 1);
  let current = new Uint32Array(right.length + 1);
  for (const word of left) {
    for (let index = 1; index <= right.length; index += 1) {
      current[index] = word === right[index - 1]
        ? (previous[index - 1] ?? 0) + 1
        : Math.max(previous[index] ?? 0, current[index - 1] ?? 0);
    }
    [previous, current] = [current, previous];
  }
  return previous[right.length] ?? 0;
}
