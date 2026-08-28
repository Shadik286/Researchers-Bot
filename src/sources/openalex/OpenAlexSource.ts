import type { FullTextResult } from "../../models/FullText.js";
import type { PaperResult } from "../../models/Paper.js";
import type { PaperSearchQuery } from "../../models/Search.js";
import { normalizeDoi } from "../../utils/normalizeDoi.js";
import {
  BaseSource,
  buildPaper,
  cleanAuthors,
  cleanDoi,
  cleanKeywords,
  cleanText,
  cleanYear,
  deriveFullText,
  type SourceDependencies,
} from "../BaseSource.js";

/**
 * OpenAlex (FALLBACK + similarity source)
 * =======================================
 *
 * API endpoints
 *   GET https://api.openalex.org/works?search=...
 *   GET https://api.openalex.org/works?filter=doi:...
 *   GET https://api.openalex.org/works/{id}          (W-id, doi:, pmid:)
 *   GET https://api.openalex.org/works?filter=openalex_id:W1|W2|...
 *
 * Authentication
 *   None. Adding `mailto` joins the polite pool. OPENALEX_API_KEY exists only
 *   for premium accounts and is sent as `api_key` when configured.
 *
 * Rate limits
 *   100,000 calls/day and 10 req/s on the polite pool. We configure 5 req/s.
 *
 * Request format
 *   `search` for free text, `filter` for exact fields, `per-page` (max 200),
 *   `select` to trim the response.
 *
 * Response mapping
 *   title/display_name, authorships[].author.display_name, doi, publication_year,
 *   primary_location.source.display_name, best_oa_location / open_access,
 *   concepts[]/topics[], referenced_works[], related_works[].
 *
 * Similar papers
 *   `related_works` is OpenAlex's own relatedness signal and is used as the
 *   fallback/complement to Semantic Scholar recommendations. Concept-filtered
 *   search provides a second, bounded route. Requests stay page-limited - no
 *   unbounded crawling.
 *
 * Access policy
 *   `best_oa_location.pdf_url` is a verified open-access copy; when a work is
 *   closed we return `landing_page_url` / the DOI, never a workaround.
 */

const BASE_URL = "https://api.openalex.org";

const SELECT_FIELDS = [
  "id",
  "doi",
  "title",
  "display_name",
  "publication_year",
  "publication_date",
  "type",
  "authorships",
  "primary_location",
  "best_oa_location",
  "open_access",
  "abstract_inverted_index",
  "concepts",
  "topics",
  "keywords",
  "cited_by_count",
  "referenced_works",
  "related_works",
].join(",");

interface OpenAlexLocation {
  is_oa?: boolean;
  landing_page_url?: string | null;
  pdf_url?: string | null;
  license?: string | null;
  version?: string | null;
  source?: {
    id?: string;
    display_name?: string;
    type?: string;
    host_organization_name?: string | null;
  } | null;
}

interface OpenAlexWork {
  id?: string;
  doi?: string | null;
  title?: string | null;
  display_name?: string | null;
  publication_year?: number | null;
  publication_date?: string | null;
  type?: string | null;
  ids?: { openalex?: string; doi?: string; pmid?: string; pmcid?: string; mag?: string };
  authorships?: { author?: { display_name?: string } | null; raw_author_name?: string }[];
  primary_location?: OpenAlexLocation | null;
  best_oa_location?: OpenAlexLocation | null;
  open_access?: { is_oa?: boolean; oa_status?: string; oa_url?: string | null } | null;
  abstract_inverted_index?: Record<string, number[]> | null;
  concepts?: { display_name?: string; level?: number; score?: number }[];
  topics?: { display_name?: string; score?: number }[];
  keywords?: { display_name?: string; keyword?: string; score?: number }[];
  cited_by_count?: number;
  referenced_works?: string[];
  related_works?: string[];
}

interface OpenAlexListResponse {
  meta?: { count?: number; page?: number; per_page?: number };
  results?: OpenAlexWork[];
}

export class OpenAlexSource extends BaseSource {
  readonly name = "OpenAlex";
  readonly key = "openalex";

  private readonly mailto: string | undefined;
  private readonly apiKey: string | undefined;

  constructor(deps: SourceDependencies) {
    super(deps);
    this.mailto = deps.config.mailto.openalex;
    this.apiKey = deps.config.apiKeys.openalex;
  }

  async search(query: PaperSearchQuery, signal?: AbortSignal): Promise<PaperResult[]> {
    const doi = normalizeDoi(query.doi);
    if (doi) {
      const paper = await this.getByDOI(doi, signal);
      return paper ? [paper] : [];
    }

    const params = this.buildQueryParams(query);
    if (!params) return [];
    const limit = this.resultLimit(query);

    return this.withCache("search", [JSON.stringify(params), limit], async () =>
      this.notFoundAsEmpty(async () => {
        const { data } = await this.http.getJson<OpenAlexListResponse>(`${BASE_URL}/works`, {
          query: { ...params, ...this.commonParams(), "per-page": Math.min(limit, 200), select: SELECT_FIELDS },
          signal,
          operation: "search",
        });
        return (data.results ?? [])
          .map((work) => this.mapWork(work))
          .filter((p): p is PaperResult => p !== undefined)
          .slice(0, limit);
      }, []),
    );
  }

  async getByDOI(doi: string, signal?: AbortSignal): Promise<PaperResult | null> {
    const normalized = normalizeDoi(doi);
    if (!normalized) return null;

    return this.withCache("doi", [normalized], async () =>
      this.notFoundAsNull(async () => {
        const { data } = await this.http.getJson<OpenAlexListResponse>(`${BASE_URL}/works`, {
          query: {
            filter: `doi:https://doi.org/${normalized}`,
            ...this.commonParams(),
            "per-page": 1,
            select: SELECT_FIELDS,
          },
          signal,
          operation: "doi-lookup",
        });
        const work = data.results?.[0];
        return work ? (this.mapWork(work) ?? null) : null;
      }),
    );
  }

  /** Accepts "W2741809807", a full OpenAlex URL, or "pmid:123". */
  async getById(id: string, signal?: AbortSignal): Promise<PaperResult | null> {
    const workId = normalizeOpenAlexId(id);
    if (!workId) return null;

    return this.withCache("id", [workId], async () =>
      this.notFoundAsNull(async () => {
        const { data } = await this.http.getJson<OpenAlexWork>(`${BASE_URL}/works/${encodeURIComponent(workId)}`, {
          query: { ...this.commonParams(), select: SELECT_FIELDS },
          signal,
          operation: "id-lookup",
        });
        return this.mapWork(data) ?? null;
      }),
    );
  }

  /**
   * OpenAlex relatedness, in two bounded steps:
   *   1. `related_works` - OpenAlex's own related-work ids, fetched in ONE
   *      batched request via the openalex_id filter.
   *   2. a concept-filtered relevance search, when step 1 is thin.
   * Both are page-limited; nothing recurses or crawls.
   */
  async getRelated(paper: PaperResult, limit: number, signal?: AbortSignal): Promise<PaperResult[]> {
    // Cached as a whole: the batched related_works lookup and the concept
    // top-up search below are upstream requests too, and re-issuing them on
    // every repeat search defeats the point of the cache.
    return this.withCache("related", [relatedCacheKey(paper), limit], async () =>
      this.fetchRelated(paper, limit, signal),
    );
  }

  private async fetchRelated(paper: PaperResult, limit: number, signal?: AbortSignal): Promise<PaperResult[]> {
    const results: PaperResult[] = [];

    const source = await this.fetchWorkForRelated(paper, signal);
    const relatedIds = (source?.related_works ?? [])
      .map((id) => normalizeOpenAlexId(id))
      .filter((id): id is string => Boolean(id))
      .slice(0, Math.min(limit, 50));

    if (relatedIds.length > 0) {
      const batch = await this.notFoundAsEmpty(async () => {
        const { data } = await this.http.getJson<OpenAlexListResponse>(`${BASE_URL}/works`, {
          query: {
            filter: `openalex_id:${relatedIds.join("|")}`,
            ...this.commonParams(),
            "per-page": relatedIds.length,
            select: SELECT_FIELDS,
          },
          signal,
          operation: "related-works",
        });
        return data.results ?? [];
      }, []);
      for (const work of batch) {
        const mapped = this.mapWork(work, "similar");
        if (mapped) results.push(mapped);
      }
    }

    if (results.length < limit) {
      const topics = (paper.topics ?? paper.keywords ?? []).slice(0, 3);
      const searchText = [paper.title, ...topics].filter(Boolean).join(" ").slice(0, 350);
      if (searchText) {
        const extra = await this.notFoundAsEmpty(async () => {
          const { data } = await this.http.getJson<OpenAlexListResponse>(`${BASE_URL}/works`, {
            query: {
              search: searchText,
              ...this.commonParams(),
              "per-page": Math.min(limit * 2, 50),
              select: SELECT_FIELDS,
            },
            signal,
            operation: "related-search",
          });
          return data.results ?? [];
        }, []);
        for (const work of extra) {
          const mapped = this.mapWork(work, "similar");
          if (mapped) results.push(mapped);
        }
      }
    }

    return results;
  }

  /** OpenAlex knows the OA status, so it can upgrade a link to open-access. */
  override async getFullText(paper: PaperResult, signal?: AbortSignal): Promise<FullTextResult | null> {
    const work = await this.fetchWorkForRelated(paper, signal);
    if (!work) return deriveFullText(paper);

    const best = work.best_oa_location;
    const isRepository = best?.source?.type === "repository";

    // Only `best_oa_location.pdf_url` is guaranteed to BE a PDF. `oa_url` is
    // "the best open link", which for many records (e.g. SSRN) is a doi.org
    // resolver or a landing page - calling that `type: "pdf"` would be wrong.
    const truePdfUrl = looksLikePdf(best?.pdf_url) ? best!.pdf_url! : undefined;
    if (truePdfUrl) {
      return {
        available: true,
        url: truePdfUrl,
        type: "pdf",
        accessType: isRepository ? "repository" : "open-access",
        source: this.name,
        license: best?.license ?? undefined,
      };
    }

    const oaUrl = work.open_access?.oa_url ?? undefined;
    if (oaUrl && work.open_access?.is_oa === true) {
      return {
        available: true,
        url: oaUrl,
        type: looksLikePdf(oaUrl) ? "pdf" : "html",
        accessType: isRepository ? "repository" : "open-access",
        source: this.name,
        license: best?.license ?? undefined,
      };
    }

    const landing = best?.landing_page_url ?? work.primary_location?.landing_page_url ?? undefined;
    if (landing) {
      const isOa = work.open_access?.is_oa === true;
      return {
        available: isOa,
        url: landing,
        type: "html",
        // Closed access resolves to the publisher's own landing page.
        accessType: isOa ? "open-access" : "landing-page",
        source: this.name,
      };
    }

    return deriveFullText(paper);
  }

  /* ------------------------------------------------------------------ */

  private commonParams(): Record<string, string | undefined> {
    const params: Record<string, string | undefined> = { mailto: this.mailto };
    if (this.apiKey) params.api_key = this.apiKey;
    return params;
  }

  private async fetchWorkForRelated(paper: PaperResult, signal?: AbortSignal): Promise<OpenAlexWork | undefined> {
    const identifier =
      paper.source === this.name && paper.sourceId
        ? normalizeOpenAlexId(paper.sourceId)
        : paper.doi
          ? `https://doi.org/${paper.doi}`
          : paper.pmid
            ? `pmid:${paper.pmid}`
            : undefined;
    if (!identifier) return undefined;

    return this.withCache("work", [identifier], async () =>
      this.notFoundAsEmpty(async () => {
        const { data } = await this.http.getJson<OpenAlexWork>(`${BASE_URL}/works/${encodeURIComponent(identifier)}`, {
          query: { ...this.commonParams(), select: SELECT_FIELDS },
          signal,
          operation: "work-lookup",
        });
        return data;
      }, undefined),
    );
  }

  private buildQueryParams(query: PaperSearchQuery): Record<string, string> | undefined {
    const filters: string[] = [];
    const params: Record<string, string> = {};

    if (query.title) {
      // title.search is far more precise than the global `search` parameter.
      filters.push(`title.search:${sanitizeFilterValue(query.title)}`);
    }
    const authors = (query.authors ?? []).map((a) => a.trim()).filter(Boolean);
    if (authors.length > 0 && filters.length > 0) {
      filters.push(`raw_author_name.search:${sanitizeFilterValue(authors[0]!)}`);
    }

    if (filters.length > 0) {
      params.filter = filters.join(",");
      return params;
    }

    const keywords = (query.keywords ?? []).map((k) => k.trim()).filter(Boolean);
    const text = keywords.length > 0 ? keywords.join(" ") : (query.freeText ?? authors.join(" "));
    if (!text.trim()) return undefined;
    params.search = text.replace(/\s+/g, " ").trim().slice(0, 350);
    return params;
  }

  private mapWork(work: OpenAlexWork | undefined, matchType: "keyword" | "similar" = "keyword"): PaperResult | undefined {
    if (!work) return undefined;

    const doi = cleanDoi(work.doi ?? work.ids?.doi);
    const best = work.best_oa_location;
    const primary = work.primary_location;

    const venueName = cleanText(primary?.source?.display_name ?? undefined);
    const isConference = work.type === "proceedings-article" || primary?.source?.type === "conference";

    const topics = [
      ...(work.topics ?? []).map((t) => t.display_name),
      ...(work.concepts ?? []).filter((c) => (c.score ?? 0) >= 0.3).map((c) => c.display_name),
    ]
      .map((t) => cleanText(t))
      .filter((t): t is string => Boolean(t));

    const keywordTerms = (work.keywords ?? [])
      .map((k) => cleanText(k.display_name ?? k.keyword))
      .filter((k): k is string => Boolean(k));

    const pmid = work.ids?.pmid ? extractTrailingId(work.ids.pmid) : undefined;
    const pmcid = work.ids?.pmcid ? extractTrailingId(work.ids.pmcid) : undefined;

    return buildPaper({
      title: work.title ?? work.display_name ?? undefined,
      authors: cleanAuthors(
        (work.authorships ?? []).map((a) => a.author?.display_name ?? a.raw_author_name),
      ),
      abstract: reconstructAbstract(work.abstract_inverted_index),
      doi,
      year: cleanYear(work.publication_year ?? work.publication_date),
      journal: isConference ? undefined : venueName,
      conference: isConference ? venueName : undefined,
      publisher: cleanText(primary?.source?.host_organization_name ?? undefined),
      keywords: cleanKeywords(keywordTerms.length > 0 ? keywordTerms : topics),
      source: this.name,
      sourceId: normalizeOpenAlexId(work.id),
      pmid,
      pmcid: pmcid ? (pmcid.toUpperCase().startsWith("PMC") ? pmcid.toUpperCase() : `PMC${pmcid}`) : undefined,
      landingPageUrl:
        best?.landing_page_url ??
        primary?.landing_page_url ??
        // An oa_url that is not a PDF is still a perfectly good landing page.
        (looksLikePdf(work.open_access?.oa_url) ? undefined : (work.open_access?.oa_url ?? undefined)) ??
        (doi ? `https://doi.org/${doi}` : undefined),
      // Only advertise a pdfUrl when the link really is a PDF.
      pdfUrl: looksLikePdf(best?.pdf_url)
        ? (best?.pdf_url ?? undefined)
        : looksLikePdf(work.open_access?.oa_url)
          ? (work.open_access?.oa_url ?? undefined)
          : undefined,
      isOpenAccess: work.open_access?.is_oa ?? undefined,
      citationCount: typeof work.cited_by_count === "number" ? work.cited_by_count : undefined,
      topics: topics.length > 0 ? [...new Set(topics)].slice(0, 20) : undefined,
      referenceIds: (work.referenced_works ?? [])
        .map((id) => normalizeOpenAlexId(id))
        .filter((id): id is string => Boolean(id))
        .slice(0, 100),
      matchType,
    });
  }
}

/**
 * OpenAlex stores abstracts as an inverted index (word -> positions) for
 * licensing reasons. Rebuilding it is the documented, intended usage.
 */
export function reconstructAbstract(index: Record<string, number[]> | null | undefined): string | undefined {
  if (!index || typeof index !== "object") return undefined;
  const positions: string[] = [];
  let maxPosition = -1;

  for (const [word, spots] of Object.entries(index)) {
    if (!Array.isArray(spots)) continue;
    for (const spot of spots) {
      if (!Number.isInteger(spot) || spot < 0 || spot > 20_000) continue;
      positions[spot] = word;
      if (spot > maxPosition) maxPosition = spot;
    }
  }
  if (maxPosition < 0) return undefined;

  const text = positions.slice(0, maxPosition + 1).filter(Boolean).join(" ").trim();
  return text === "" ? undefined : text;
}

/** "https://openalex.org/W2741809807" -> "W2741809807" */
export function normalizeOpenAlexId(input: string | undefined | null): string | undefined {
  if (typeof input !== "string") return undefined;
  const value = input.trim();
  if (/^W\d{4,12}$/i.test(value)) return value.toUpperCase();
  const match = /openalex\.org\/(W\d{4,12})/i.exec(value);
  if (match) return match[1]!.toUpperCase();
  if (/^(pmid|pmcid|doi|mag):/i.test(value)) return value;
  return undefined;
}

function extractTrailingId(url: string): string | undefined {
  const match = /\/([^/]+)\/?$/.exec(url.trim());
  return match ? match[1] : undefined;
}

/** Commas and colons are the filter grammar's separators. */
function sanitizeFilterValue(value: string): string {
  return value
    .replace(/[,:|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 350);
}

/**
 * A link is only treated as a PDF when it plausibly is one. A DOI resolver
 * (`https://doi.org/10.x/y`) is a landing page no matter which field of the
 * upstream payload it arrived in.
 */
function looksLikePdf(url: string | null | undefined): boolean {
  if (typeof url !== "string" || url.trim() === "") return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  if (host === "doi.org" || host === "dx.doi.org" || host === "www.doi.org") return false;
  const path = parsed.pathname.toLowerCase();
  if (path.endsWith(".pdf")) return true;
  // Common publisher patterns that serve a PDF without a .pdf suffix.
  return /\/pdf(\/|$)|[?&](type=printable|format=pdf|download=pdf)/i.test(url);
}

/** Stable cache key for a paper's related-works lookup. */
function relatedCacheKey(paper: PaperResult): string {
  return paper.doi ?? paper.sourceId ?? paper.pmid ?? paper.arxivId ?? paper.title.toLowerCase().slice(0, 120);
}
