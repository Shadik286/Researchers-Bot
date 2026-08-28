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
} from "../BaseSource.js";

/**
 * DOAJ - Directory of Open Access Journals
 * =======================================
 *
 * API endpoint
 *   GET https://doaj.org/api/search/articles/{search_query}
 *   GET https://doaj.org/api/articles/{id}
 *
 * Authentication
 *   None for search. DOAJ_API_KEY exists only for the write API, so this
 *   adapter runs fully on the public read API and never requires a key.
 *
 * Rate limits
 *   No hard published number for reads; DOAJ asks for reasonable use. We run
 *   at 2 req/s with concurrency 2 (see config/rateLimits.ts).
 *
 * Request format
 *   The search string is an Elasticsearch-style query embedded in the PATH, so
 *   it must be URL-encoded. Field-scoped terms:
 *     bibjson.title:"..."  bibjson.author.name:"..."  doi:"..."
 *   Paging via page / pageSize (pageSize max 100).
 *
 * Response mapping
 *   results[].bibjson.title            -> title
 *   results[].bibjson.author[].name    -> authors
 *   results[].bibjson.abstract         -> abstract
 *   results[].bibjson.identifier[]     -> doi / issn
 *   results[].bibjson.journal.title    -> journal
 *   results[].bibjson.link[]           -> landingPageUrl / pdfUrl
 *   results[].bibjson.keywords         -> keywords
 *   results[].bibjson.year             -> year
 *
 * Error handling
 *   404 -> no results. 400 -> malformed query, not retried. Everything else is
 *   handled by the shared HttpClient retry/circuit-breaker stack.
 *
 * Access policy
 *   Every DOAJ record is open access by definition, so links found here are
 *   safe to surface as open-access full text.
 */

const BASE_URL = "https://doaj.org/api";

interface DoajSearchResponse {
  total?: number;
  results?: DoajArticle[];
}

interface DoajArticle {
  id?: string;
  created_date?: string;
  last_updated?: string;
  bibjson?: {
    title?: string;
    abstract?: string;
    year?: string | number;
    month?: string;
    author?: { name?: string; affiliation?: string }[];
    identifier?: { type?: string; id?: string }[];
    journal?: {
      title?: string;
      publisher?: string;
      volume?: string;
      number?: string;
      country?: string;
      language?: string[];
    };
    keywords?: string[];
    subject?: { code?: string; scheme?: string; term?: string }[];
    link?: { type?: string; url?: string; content_type?: string }[];
  };
}

export class DoajSource extends BaseSource {
  readonly name = "DOAJ";
  readonly key = "doaj";

  async search(query: PaperSearchQuery, signal?: AbortSignal): Promise<PaperResult[]> {
    const searchExpression = this.buildQueryExpression(query);
    if (!searchExpression) return [];

    const limit = this.resultLimit(query);
    return this.withCache("search", [searchExpression, limit], async () =>
      this.notFoundAsEmpty(async () => {
        const url = `${BASE_URL}/search/articles/${encodeURIComponent(searchExpression)}`;
        const { data } = await this.http.getJson<DoajSearchResponse>(url, {
          query: { page: 1, pageSize: Math.min(limit, 100) },
          signal,
          operation: "search",
        });
        return (data.results ?? []).map((article) => this.mapArticle(article)).filter(isPaper).slice(0, limit);
      }, []),
    );
  }

  async getByDOI(doi: string, signal?: AbortSignal): Promise<PaperResult | null> {
    const normalized = normalizeDoi(doi);
    if (!normalized) return null;

    return this.withCache("doi", [normalized], async () =>
      this.notFoundAsNull(async () => {
        const expression = `doi:"${escapeQueryValue(normalized)}"`;
        const url = `${BASE_URL}/search/articles/${encodeURIComponent(expression)}`;
        const { data } = await this.http.getJson<DoajSearchResponse>(url, {
          query: { page: 1, pageSize: 5 },
          signal,
          operation: "doi-lookup",
        });
        for (const article of data.results ?? []) {
          const paper = this.mapArticle(article);
          // Only accept a record whose own DOI matches - DOAJ full-text search
          // can otherwise return articles that merely cite the DOI.
          if (paper && paper.doi === normalized) return paper;
        }
        return null;
      }),
    );
  }

  async getById(id: string, signal?: AbortSignal): Promise<PaperResult | null> {
    const articleId = id.trim();
    if (!/^[a-z0-9]{8,64}$/i.test(articleId)) return null;

    return this.withCache("id", [articleId], async () =>
      this.notFoundAsNull(async () => {
        const { data } = await this.http.getJson<DoajArticle>(`${BASE_URL}/articles/${encodeURIComponent(articleId)}`, {
          signal,
          operation: "id-lookup",
        });
        return this.mapArticle(data) ?? null;
      }),
    );
  }

  /* ------------------------------------------------------------------ */

  private buildQueryExpression(query: PaperSearchQuery): string | undefined {
    const clauses: string[] = [];

    const doi = normalizeDoi(query.doi);
    if (doi) clauses.push(`doi:"${escapeQueryValue(doi)}"`);

    if (query.title) {
      clauses.push(`bibjson.title:"${escapeQueryValue(query.title)}"`);
    }

    for (const author of query.authors ?? []) {
      const value = author.trim();
      if (value) clauses.push(`bibjson.author.name:"${escapeQueryValue(value)}"`);
    }

    if (clauses.length === 0) {
      const keywords = (query.keywords ?? []).map((k) => k.trim()).filter(Boolean);
      const free = query.freeText?.trim();
      if (keywords.length > 0) {
        return keywords.map((k) => `"${escapeQueryValue(k)}"`).join(" AND ");
      }
      if (free) return `"${escapeQueryValue(free)}"`;
      return undefined;
    }

    return clauses.join(" AND ");
  }

  private mapArticle(article: DoajArticle | undefined): PaperResult | undefined {
    const bibjson = article?.bibjson;
    if (!bibjson) return undefined;

    const identifiers = bibjson.identifier ?? [];
    const doi = cleanDoi(identifiers.find((i) => i.type?.toLowerCase() === "doi")?.id);

    const links = bibjson.link ?? [];
    const fullTextLink = links.find((l) => l.type?.toLowerCase() === "fulltext");
    const pdfLink = links.find(
      (l) =>
        l.content_type?.toLowerCase() === "pdf" ||
        (typeof l.url === "string" && /\.pdf($|\?)/i.test(l.url)),
    );

    const subjects = (bibjson.subject ?? [])
      .map((s) => cleanText(s.term))
      .filter((t): t is string => Boolean(t));

    return buildPaper({
      title: bibjson.title,
      authors: cleanAuthors((bibjson.author ?? []).map((a) => a.name)),
      abstract: bibjson.abstract,
      doi,
      year: cleanYear(bibjson.year),
      journal: bibjson.journal?.title,
      publisher: bibjson.journal?.publisher,
      keywords: cleanKeywords(bibjson.keywords),
      source: this.name,
      sourceId: article?.id,
      landingPageUrl: fullTextLink?.url ?? (doi ? `https://doi.org/${doi}` : undefined),
      pdfUrl: pdfLink?.url,
      // DOAJ only indexes open-access journals.
      isOpenAccess: true,
      topics: subjects.length > 0 ? subjects : undefined,
    });
  }
}

function isPaper(paper: PaperResult | undefined): paper is PaperResult {
  return paper !== undefined;
}

/** Escapes the characters that would otherwise break a quoted DOAJ term. */
function escapeQueryValue(value: string): string {
  return value.replace(/[\\"]/g, "\\$&").replace(/\s+/g, " ").trim().slice(0, 500);
}
