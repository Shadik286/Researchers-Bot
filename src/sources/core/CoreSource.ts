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
  type SourceDependencies,
} from "../BaseSource.js";

/**
 * CORE - aggregator of open-access repository content
 * ===================================================
 *
 * API endpoint
 *   GET https://api.core.ac.uk/v3/search/works?q=...&limit=...
 *   GET https://api.core.ac.uk/v3/works/{id}
 *
 * Authentication
 *   REQUIRED. `Authorization: Bearer <CORE_API_KEY>`, obtained free from
 *   https://core.ac.uk/services/api. When the key is absent the adapter
 *   reports itself unavailable and the orchestrator marks it "skipped" - the
 *   search continues on the remaining sources. We never guess or synthesise a
 *   key, and the key is never written to a log or a response.
 *
 * Rate limits
 *   The free tier is quota-based (roughly 10 requests/minute). We configure
 *   1 req/s AND a 10 req/min ceiling, which the token bucket enforces.
 *
 * Request format
 *   `q` accepts an Elasticsearch-style expression, e.g.
 *     title:"..." AND authors:"..."
 *     doi:"10.1234/example"
 *
 * Response mapping
 *   results[].title / authors[].name / abstract / doi / yearPublished /
 *   publisher / downloadUrl / sourceFulltextUrls / links[]
 *
 * Access policy
 *   CORE indexes open-access repository deposits, so `downloadUrl` is a legal
 *   repository PDF. We surface it as accessType "repository".
 *
 * Error handling
 *   401 -> configuration problem, reported as an auth issue, not retried.
 *   429 -> Retry-After honoured by the shared client.
 */

const BASE_URL = "https://api.core.ac.uk/v3";

interface CoreSearchResponse {
  totalHits?: number;
  results?: CoreWork[];
}

interface CoreWork {
  id?: number | string;
  title?: string;
  abstract?: string;
  doi?: string;
  yearPublished?: number | string;
  publishedDate?: string;
  authors?: { name?: string }[];
  publisher?: string;
  journals?: { title?: string }[];
  documentType?: string;
  downloadUrl?: string;
  sourceFulltextUrls?: string[];
  fullTextIdentifier?: string;
  links?: { type?: string; url?: string }[];
  subjects?: string[];
  fieldsOfStudy?: string[];
  language?: { name?: string };
  citationCount?: number;
}

export class CoreSource extends BaseSource {
  readonly name = "CORE";
  readonly key = "core";

  private readonly apiKey: string | undefined;

  constructor(deps: SourceDependencies) {
    super(deps);
    this.apiKey = deps.config.apiKeys.core;
  }

  override isAvailable(): boolean {
    return Boolean(this.apiKey);
  }

  override unavailableReason(): string | undefined {
    return this.apiKey ? undefined : "CORE_API_KEY is not configured";
  }

  async search(query: PaperSearchQuery, signal?: AbortSignal): Promise<PaperResult[]> {
    if (!this.isAvailable()) return [];
    const expression = this.buildExpression(query);
    if (!expression) return [];

    const limit = this.resultLimit(query);
    return this.withCache("search", [expression, limit], async () =>
      this.notFoundAsEmpty(async () => {
        const { data } = await this.http.getJson<CoreSearchResponse>(`${BASE_URL}/search/works`, {
          query: { q: expression, limit: Math.min(limit, 100), offset: 0 },
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
    if (!this.isAvailable()) return null;
    const normalized = normalizeDoi(doi);
    if (!normalized) return null;

    return this.withCache("doi", [normalized], async () =>
      this.notFoundAsNull(async () => {
        const { data } = await this.http.getJson<CoreSearchResponse>(`${BASE_URL}/search/works`, {
          query: { q: `doi:"${escapeExpression(normalized)}"`, limit: 5 },
          signal,
          operation: "doi-lookup",
        });
        for (const work of data.results ?? []) {
          const paper = this.mapWork(work);
          if (paper?.doi === normalized) return paper;
        }
        return null;
      }),
    );
  }

  async getById(id: string, signal?: AbortSignal): Promise<PaperResult | null> {
    if (!this.isAvailable()) return null;
    const workId = id.trim();
    if (!/^\d{1,12}$/.test(workId)) return null;

    return this.withCache("id", [workId], async () =>
      this.notFoundAsNull(async () => {
        const { data } = await this.http.getJson<CoreWork>(`${BASE_URL}/works/${encodeURIComponent(workId)}`, {
          signal,
          operation: "id-lookup",
        });
        return this.mapWork(data) ?? null;
      }),
    );
  }

  /* ------------------------------------------------------------------ */

  private buildExpression(query: PaperSearchQuery): string | undefined {
    const doi = normalizeDoi(query.doi);
    if (doi) return `doi:"${escapeExpression(doi)}"`;

    const clauses: string[] = [];
    if (query.title) clauses.push(`title:"${escapeExpression(query.title)}"`);
    for (const author of query.authors ?? []) {
      const value = author.trim();
      if (value) clauses.push(`authors:"${escapeExpression(value)}"`);
    }
    if (clauses.length > 0) return clauses.join(" AND ");

    const keywords = (query.keywords ?? []).map((k) => k.trim()).filter(Boolean);
    if (keywords.length > 0) return keywords.map((k) => `"${escapeExpression(k)}"`).join(" AND ");

    const free = query.freeText?.trim();
    return free ? `"${escapeExpression(free)}"` : undefined;
  }

  private mapWork(work: CoreWork | undefined): PaperResult | undefined {
    if (!work) return undefined;

    const doi = cleanDoi(work.doi);
    const pdfUrl =
      work.downloadUrl ??
      work.sourceFulltextUrls?.find((url) => typeof url === "string" && /\.pdf($|\?)/i.test(url)) ??
      work.sourceFulltextUrls?.[0];

    const landingPageUrl =
      work.links?.find((l) => l.type?.toLowerCase() === "display")?.url ??
      (doi ? `https://doi.org/${doi}` : undefined) ??
      (work.id !== undefined ? `https://core.ac.uk/works/${work.id}` : undefined);

    const topics = [...(work.fieldsOfStudy ?? []), ...(work.subjects ?? [])]
      .map((t) => cleanText(t))
      .filter((t): t is string => Boolean(t));

    return buildPaper({
      title: work.title,
      authors: cleanAuthors((work.authors ?? []).map((a) => a.name)),
      abstract: work.abstract,
      doi,
      year: cleanYear(work.yearPublished ?? work.publishedDate),
      journal: work.journals?.[0]?.title,
      publisher: work.publisher,
      keywords: cleanKeywords(work.subjects),
      source: this.name,
      sourceId: work.id !== undefined ? String(work.id) : undefined,
      landingPageUrl,
      pdfUrl,
      // CORE aggregates open-access deposits; a download URL means a legally
      // reachable repository copy.
      isOpenAccess: pdfUrl ? true : undefined,
      citationCount: typeof work.citationCount === "number" ? work.citationCount : undefined,
      topics: topics.length > 0 ? topics.slice(0, 20) : undefined,
    });
  }
}

function escapeExpression(value: string): string {
  return value.replace(/[\\"]/g, "\\$&").replace(/\s+/g, " ").trim().slice(0, 500);
}
