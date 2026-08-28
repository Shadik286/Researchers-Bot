import { SAFE_STOP_WORDS, normalizeTitle, stripMarkup } from "./normalizeTitle.js";

/**
 * Keyword normalization.
 *
 * Keywords arrive as free text from users and as controlled vocabulary from
 * sources (MeSH terms, DOAJ subjects, OpenAlex concepts, arXiv categories).
 * They are folded to a common lowercase form, de-duplicated, and split on the
 * separators sources actually use (comma, semicolon, pipe).
 */

const MAX_KEYWORD_LENGTH = 120;

export function normalizeKeyword(input: string | undefined | null): string | undefined {
  if (typeof input !== "string") return undefined;
  const normalized = normalizeTitle(input, { removeStopWords: false, keepHyphens: true });
  if (!normalized) return undefined;
  if (normalized.length > MAX_KEYWORD_LENGTH) return normalized.slice(0, MAX_KEYWORD_LENGTH).trim();
  // A keyword that is nothing but a stop word carries no signal.
  if (SAFE_STOP_WORDS.has(normalized)) return undefined;
  return normalized;
}

export function normalizeKeywords(
  input: readonly (string | undefined | null)[] | string | undefined | null,
): string[] {
  const raw: (string | undefined | null)[] = Array.isArray(input)
    ? [...input]
    : typeof input === "string"
      ? [input]
      : [];

  const out: string[] = [];
  const seen = new Set<string>();

  for (const item of raw) {
    if (typeof item !== "string") continue;
    for (const part of stripMarkup(item).split(/[;,|]/)) {
      const normalized = normalizeKeyword(part);
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      out.push(normalized);
    }
  }
  return out;
}

/** Content tokens of a keyword list, used for set-based similarity. */
export function keywordTokens(keywords: readonly string[] | undefined): Set<string> {
  const tokens = new Set<string>();
  for (const keyword of keywords ?? []) {
    for (const token of keyword.split(/\s+/)) {
      if (token && !SAFE_STOP_WORDS.has(token)) tokens.add(token);
    }
  }
  return tokens;
}
