import type { NormalizedAuthor } from "../models/Search.js";

/**
 * Author-name normalization.
 *
 * Supported input shapes:
 *   "John Doe"            -> { full: "john doe",     last: "doe", firstInitial: "j" }
 *   "Doe, John"           -> { full: "john doe",     last: "doe", firstInitial: "j" }
 *   "J. Doe"              -> { full: "j doe",        last: "doe", firstInitial: "j" }
 *   "Doe J"               -> { full: "j doe",        last: "doe", firstInitial: "j" }  (PubMed style)
 *   "van der Berg, Anne"  -> { full: "anne van der berg", last: "van der berg", ... }
 *   "Müller, K.-H."       -> { full: "k h muller", last: "muller", firstInitial: "k" }
 *
 * Matching between two authors is intentionally surname-anchored: surnames are
 * stable across sources, given names are not (full name vs. initials).
 */

/** Multi-word surname particles that belong to the LAST name, not the first. */
const SURNAME_PARTICLES = new Set([
  "van",
  "von",
  "der",
  "den",
  "de",
  "del",
  "della",
  "di",
  "da",
  "dos",
  "du",
  "la",
  "le",
  "el",
  "al",
  "bin",
  "ibn",
  "ter",
  "ten",
  "op",
  "mac",
  "mc",
  "st",
]);

/** Suffixes that are never part of the surname for matching purposes. */
const SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv", "phd", "md", "msc", "bsc", "dr", "prof"]);

function foldUnicode(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[‐-―−]/g, "-");
}

/** Lowercased, punctuation-free token list for one raw name string. */
function tokenize(raw: string): string[] {
  return foldUnicode(raw)
    .toLowerCase()
    .replace(/[^a-z\s'-]+/g, " ")
    .replace(/[-']/g, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0 && !SUFFIXES.has(t));
}

/** `true` for tokens that are really initials: "j", "jh", "j.h.". */
function isInitialToken(token: string): boolean {
  return token.length <= 2;
}

export function normalizeAuthor(input: string | undefined | null): NormalizedAuthor | undefined {
  if (typeof input !== "string") return undefined;
  const raw = input.trim();
  if (!raw) return undefined;

  let givenTokens: string[];
  let surnameTokens: string[];

  const commaIndex = raw.indexOf(",");
  if (commaIndex > 0) {
    // "Doe, John" / "van der Berg, Anne M."
    surnameTokens = tokenize(raw.slice(0, commaIndex));
    givenTokens = tokenize(raw.slice(commaIndex + 1));
  } else {
    const tokens = tokenize(raw);
    if (tokens.length === 0) return undefined;
    if (tokens.length === 1) {
      surnameTokens = tokens;
      givenTokens = [];
    } else {
      const last = tokens[tokens.length - 1]!;
      // PubMed style "Doe J" / "Doe JH": trailing token is an initial block.
      if (isInitialToken(last) && !isInitialToken(tokens[0]!)) {
        surnameTokens = tokens.slice(0, -1);
        givenTokens = [last];
      } else {
        // Western order: given names first, surname (+ particles) last.
        let splitAt = tokens.length - 1;
        while (splitAt > 0 && SURNAME_PARTICLES.has(tokens[splitAt - 1]!)) splitAt -= 1;
        surnameTokens = tokens.slice(splitAt);
        givenTokens = tokens.slice(0, splitAt);
      }
    }
  }

  if (surnameTokens.length === 0) {
    if (givenTokens.length === 0) return undefined;
    surnameTokens = [givenTokens[givenTokens.length - 1]!];
    givenTokens = givenTokens.slice(0, -1);
  }

  const last = surnameTokens.join(" ");
  const firstToken = givenTokens[0];
  const firstInitial = firstToken ? firstToken.charAt(0) : undefined;
  const full = [...givenTokens, ...surnameTokens].join(" ");

  return { full, last, firstInitial };
}

export function normalizeAuthors(input: readonly (string | undefined | null)[] | undefined): NormalizedAuthor[] {
  if (!Array.isArray(input)) return [];
  const out: NormalizedAuthor[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    const normalized = normalizeAuthor(raw);
    if (!normalized) continue;
    const key = `${normalized.last}|${normalized.firstInitial ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
}

/**
 * Similarity between two normalized authors in 0..1.
 *
 *   1.00 identical full names
 *   0.90 same surname + same first initial
 *   0.75 same surname, one side has no given name at all
 *   0.20 same surname, DIFFERENT first initial (probably a different person)
 *   0.00 different surname
 *
 * The surname-only case scores well because it is under-specified, not
 * contradicted: a user who types "Vaswani" has given us everything they know,
 * and the surname still matches. It stays below the surname+initial score so a
 * fuller corroboration always outranks it.
 */
export function authorSimilarity(a: NormalizedAuthor, b: NormalizedAuthor): number {
  if (a.last !== b.last) return 0;
  if (a.full === b.full) return 1;
  if (a.firstInitial && b.firstInitial) {
    return a.firstInitial === b.firstInitial ? 0.9 : 0.2;
  }
  return 0.75;
}

/**
 * Overlap between two author lists in 0..1, measured against the SHORTER list.
 * Sources routinely truncate long author lists ("et al"), so scoring against
 * the longer list would unfairly punish a correct match.
 */
export function authorOverlap(a: NormalizedAuthor[], b: NormalizedAuthor[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;

  let total = 0;
  const used = new Set<number>();
  for (const author of shorter) {
    let bestScore = 0;
    let bestIndex = -1;
    for (let i = 0; i < longer.length; i += 1) {
      if (used.has(i)) continue;
      const score = authorSimilarity(author, longer[i]!);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }
    if (bestIndex >= 0) used.add(bestIndex);
    total += bestScore;
  }
  return total / shorter.length;
}

/** Display form used in responses: "John Doe" style, whitespace-normalized. */
export function cleanAuthorDisplayName(input: string | undefined | null): string | undefined {
  if (typeof input !== "string") return undefined;
  const value = input.replace(/\s+/g, " ").trim();
  if (!value) return undefined;
  const commaIndex = value.indexOf(",");
  if (commaIndex > 0) {
    const family = value.slice(0, commaIndex).trim();
    const given = value.slice(commaIndex + 1).trim();
    if (family && given) return `${given} ${family}`;
  }
  return value;
}
