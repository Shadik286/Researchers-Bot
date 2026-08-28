import { SAFE_STOP_WORDS, normalizeTitle } from "./normalizeTitle.js";

/**
 * String / set similarity primitives shared by the match and similarity
 * engines. Everything here is pure and synchronous so it is cheap to unit test.
 */

/** Levenshtein edit distance with an early-exit band. */
export function levenshtein(a: string, b: string, maxDistance = Infinity): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  if (Math.abs(a.length - b.length) > maxDistance) return maxDistance + 1;

  // Keep the shorter string on the row axis to bound memory.
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];

  let previous = new Array<number>(short.length + 1);
  let current = new Array<number>(short.length + 1);
  for (let i = 0; i <= short.length; i += 1) previous[i] = i;

  for (let j = 1; j <= long.length; j += 1) {
    current[0] = j;
    let rowMin = current[0]!;
    const longChar = long.charCodeAt(j - 1);
    for (let i = 1; i <= short.length; i += 1) {
      const cost = short.charCodeAt(i - 1) === longChar ? 0 : 1;
      const value = Math.min(
        current[i - 1]! + 1, // insertion
        previous[i]! + 1, // deletion
        previous[i - 1]! + cost, // substitution
      );
      current[i] = value;
      if (value < rowMin) rowMin = value;
    }
    if (rowMin > maxDistance) return maxDistance + 1;
    const swap = previous;
    previous = current;
    current = swap;
  }
  return previous[short.length]!;
}

/** Normalized edit-distance similarity in 0..1. */
export function levenshteinSimilarity(a: string, b: string): number {
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  if (a === b) return 1;
  const maxLen = Math.max(a.length, b.length);
  const distance = levenshtein(a, b);
  return Math.max(0, 1 - distance / maxLen);
}

export function jaccard<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): number {
  if (a.size === 0 && b.size === 0) return 0;
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const item of small) if (large.has(item)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** Overlap coefficient - tolerant of very different set sizes. */
export function overlapCoefficient<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const item of small) if (large.has(item)) intersection += 1;
  return intersection / small.size;
}

/** Character bigrams, used for order-sensitive fuzzy title comparison. */
export function bigrams(input: string): Set<string> {
  const set = new Set<string>();
  const cleaned = input.replace(/\s+/g, " ").trim();
  for (let i = 0; i < cleaned.length - 1; i += 1) set.add(cleaned.slice(i, i + 2));
  return set;
}

/** Sorensen-Dice coefficient over character bigrams. */
export function diceCoefficient(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const A = bigrams(a);
  const B = bigrams(b);
  if (A.size === 0 || B.size === 0) return 0;
  let intersection = 0;
  for (const gram of A) if (B.has(gram)) intersection += 1;
  return (2 * intersection) / (A.size + B.size);
}

/**
 * Title similarity in 0..1.
 *
 * Combines three views so that no single quirk dominates:
 *   - token Jaccard   : robust against word order and subtitle differences
 *   - character Dice  : robust against small spelling/hyphenation differences
 *   - edit distance   : penalizes genuinely different strings
 *
 * A shared prefix bonus handles the common "Title: subtitle" truncation that
 * several sources apply.
 */
export function titleSimilarity(a: string | undefined, b: string | undefined): number {
  const na = normalizeTitle(a, { removeStopWords: false });
  const nb = normalizeTitle(b, { removeStopWords: false });
  if (!na || !nb) return 0;
  if (na === nb) return 1;

  const tokensA = new Set(na.split(" ").filter((t) => t && !SAFE_STOP_WORDS.has(t)));
  const tokensB = new Set(nb.split(" ").filter((t) => t && !SAFE_STOP_WORDS.has(t)));

  const tokenScore = jaccard(tokensA, tokensB);
  const diceScore = diceCoefficient(na, nb);
  const editScore = levenshteinSimilarity(na, nb);

  let score = 0.45 * tokenScore + 0.35 * diceScore + 0.2 * editScore;

  // One title being a clean prefix of the other (dropped subtitle) is a strong
  // signal, but never enough on its own to reach "exact".
  const shorter = na.length <= nb.length ? na : nb;
  const longer = na.length <= nb.length ? nb : na;
  if (shorter.length >= 20 && longer.startsWith(shorter)) {
    score = Math.max(score, 0.9);
  }

  return clamp01(score);
}

/** Bag-of-words cosine similarity, used for abstract comparison. */
export function cosineSimilarity(a: string | undefined, b: string | undefined): number {
  const va = termFrequency(a);
  const vb = termFrequency(b);
  if (va.size === 0 || vb.size === 0) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (const [term, count] of va) {
    normA += count * count;
    const other = vb.get(term);
    if (other) dot += count * other;
  }
  for (const count of vb.values()) normB += count * count;
  if (normA === 0 || normB === 0) return 0;
  return clamp01(dot / (Math.sqrt(normA) * Math.sqrt(normB)));
}

function termFrequency(text: string | undefined): Map<string, number> {
  const map = new Map<string, number>();
  if (!text) return map;
  const normalized = normalizeTitle(text, { removeStopWords: false });
  for (const token of normalized.split(" ")) {
    if (!token || token.length < 3 || SAFE_STOP_WORDS.has(token)) continue;
    map.set(token, (map.get(token) ?? 0) + 1);
  }
  return map;
}

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/** Rounds to 4 decimals so scores serialize cleanly. */
export function roundScore(value: number): number {
  return Math.round(clamp01(value) * 10_000) / 10_000;
}
