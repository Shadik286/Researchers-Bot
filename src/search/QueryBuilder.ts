import type { NormalizedQuery, PaperSearchQuery } from "../models/Search.js";
import { normalizeAuthors } from "../utils/normalizeAuthor.js";
import { normalizeDoi } from "../utils/normalizeDoi.js";
import { normalizeKeywords } from "../utils/normalizeKeywords.js";
import { normalizeTitle, titleTokens } from "../utils/normalizeTitle.js";

/**
 * PHASE 1 - input normalization, and the construction of the progressively
 * broader query variants used by the search strategy (section 7).
 */

export function normalizeQuery(raw: PaperSearchQuery): NormalizedQuery {
  const doi = normalizeDoi(raw.doi);
  const title = typeof raw.title === "string" ? raw.title.replace(/\s+/g, " ").trim() : undefined;
  const normalizedTitle = title ? normalizeTitle(title) : undefined;
  const authors = (raw.authors ?? []).map((a) => a.replace(/\s+/g, " ").trim()).filter(Boolean);
  const keywords = normalizeKeywords(raw.keywords);

  const strategy: NormalizedQuery["strategy"] = doi ? "doi" : title ? "title" : "keywords";

  return {
    raw,
    doi,
    fromYear: raw.fromYear,
    toYear: raw.toYear,
    title: title || undefined,
    normalizedTitle: normalizedTitle || undefined,
    titleTokens: title ? titleTokens(title) : [],
    authors,
    normalizedAuthors: normalizeAuthors(authors),
    keywords,
    strategy,
  };
}

/** One attempt against the sources, from most to least precise. */
export interface QueryVariant {
  /** Short label used in logs and in the response notes. */
  label: "doi" | "exact-title" | "title-author" | "fuzzy-title" | "keywords";
  query: PaperSearchQuery;
  /** Precision hint - drives how much confidence a hit here is worth. */
  precision: "identifier" | "high" | "medium" | "low";
}

/**
 * Builds the ordered variant list for the main-paper search.
 *
 *   CASE A (DOI)      -> [doi]  (plus a title fallback when a title is given)
 *   CASE B (title)    -> [exact-title, title+author, fuzzy-title, keywords?]
 *   CASE C (keywords) -> [keywords]
 *
 * The orchestrator walks this list and stops the moment an exact match is
 * confirmed, so the later, broader variants usually never run.
 */
export function buildQueryVariants(query: NormalizedQuery, resultLimit: number): QueryVariant[] {
  const variants: QueryVariant[] = [];

  if (query.doi) {
    variants.push({
      label: "doi",
      precision: "identifier",
      query: { doi: query.doi, limit: 5, intent: "main" },
    });
  }

  if (query.title) {
    const hasAuthors = query.authors.length > 0;

    variants.push({
      label: "exact-title",
      precision: "high",
      query: { title: query.title, limit: resultLimit, intent: "main" },
    });

    if (hasAuthors) {
      variants.push({
        label: "title-author",
        precision: "high",
        query: { title: query.title, authors: query.authors.slice(0, 3), limit: resultLimit, intent: "main" },
      });
    }

    // Fuzzy pass: normalized title, stop words dropped, as free text. Only
    // worth running when it actually differs from the exact pass.
    const fuzzy = query.titleTokens.join(" ");
    if (fuzzy && fuzzy !== normalizeTitle(query.title)) {
      variants.push({
        label: "fuzzy-title",
        precision: "medium",
        query: { freeText: fuzzy, limit: resultLimit, intent: "main" },
      });
    }
  }

  if (query.keywords.length > 0) {
    variants.push({
      label: "keywords",
      precision: query.title ? "low" : "medium",
      query: {
        keywords: query.keywords.slice(0, 8),
        authors: query.title ? undefined : query.authors.slice(0, 2),
        limit: resultLimit,
        intent: "main",
      },
    });
  }

  // Authors alone are a weak but legitimate query when nothing else was given.
  if (variants.length === 0 && query.authors.length > 0) {
    variants.push({
      label: "keywords",
      precision: "low",
      query: { authors: query.authors.slice(0, 3), limit: resultLimit, intent: "main" },
    });
  }

  return variants;
}

/** Free-text query describing a known paper, used for similarity searches. */
export function buildSimilarityQuery(
  title: string,
  keywords: readonly string[] | undefined,
  limit: number,
): PaperSearchQuery {
  const terms = [title, ...(keywords ?? []).slice(0, 4)].filter(Boolean).join(" ");
  return {
    freeText: terms.replace(/\s+/g, " ").trim().slice(0, 400),
    keywords: keywords ? [...keywords].slice(0, 6) : undefined,
    limit,
    intent: "similar",
  };
}
