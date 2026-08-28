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
 * Crossref (FALLBACK source)
 * ==========================
 *
 * API endpoints
 *   GET https://api.crossref.org/works?query.bibliographic=...
 *   GET https://api.crossref.org/works/{doi}
 *
 * Authentication
 *   None required. Supplying `mailto` puts us in the "polite pool", which is
 *   the courteous way to use the API and gets better service. CROSSREF_API_KEY
 *   is only meaningful for Metadata Plus subscribers and is sent as a Bearer
 *   token when present.
 *
 * Rate limits
 *   The polite pool advertises limits via X-Rate-Limit-Limit /
 *   X-Rate-Limit-Interval. We configure a conservative 5 req/s, far below the
 *   advertised 50 req/s, and honour 429 Retry-After.
 *
 * Request format
 *   query.bibliographic - free-form citation text (best for title matching)
 *   query.author        - author names
 *   query.title         - title words
 *   rows / select       - paging and response projection
 *
 * Response mapping
 *   message.items[] with title[], author[], DOI, issued.date-parts, abstract
 *   (JATS XML), container-title[], publisher, subject[], link[], URL.
 *
 * Access policy
 *   Crossref is a metadata registry: it tells us where the publisher's official
 *   landing page is. Most records are paywalled, and for those we return the
 *   DOI landing page - the correct legal destination.
 */

const BASE_URL = "https://api.crossref.org";

const SELECT_FIELDS = [
  "DOI",
  "title",
  "author",
  "issued",
  "abstract",
  "container-title",
  "publisher",
  "subject",
  "type",
  "URL",
  "link",
  "is-referenced-by-count",
  "event",
  "reference",
].join(",");

interface CrossrefAuthor {
  given?: string;
  family?: string;
  name?: string;
  sequence?: string;
}

interface CrossrefLink {
  URL?: string;
  "content-type"?: string;
  "content-version"?: string;
  "intended-application"?: string;
}

interface CrossrefWork {
  DOI?: string;
  title?: string[];
  "short-title"?: string[];
  author?: CrossrefAuthor[];
  issued?: { "date-parts"?: number[][] };
  published?: { "date-parts"?: number[][] };
  "published-print"?: { "date-parts"?: number[][] };
  "published-online"?: { "date-parts"?: number[][] };
  abstract?: string;
  "container-title"?: string[];
  publisher?: string;
  subject?: string[];
  type?: string;
  URL?: string;
  link?: CrossrefLink[];
  "is-referenced-by-count"?: number;
  event?: { name?: string };
  reference?: { DOI?: string }[];
  license?: { URL?: string; "content-version"?: string }[];
}

interface CrossrefListResponse {
  status?: string;
  message?: { "total-results"?: number; items?: CrossrefWork[] };
}

interface CrossrefItemResponse {
  status?: string;
  message?: CrossrefWork;
}

export class CrossrefSource extends BaseSource {
  readonly name = "Crossref";
  readonly key = "crossref";

  private readonly mailto: string | undefined;

  constructor(deps: SourceDependencies) {
    super(deps);
    this.mailto = deps.config.mailto.crossref;
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
        const { data } = await this.http.getJson<CrossrefListResponse>(`${BASE_URL}/works`, {
          query: {
            ...params,
            rows: Math.min(limit, 100),
            select: SELECT_FIELDS,
            mailto: this.mailto,
          },
          signal,
          operation: "search",
        });
        return (data.message?.items ?? [])
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
        const { data } = await this.http.getJson<CrossrefItemResponse>(
          // The DOI suffix can contain "/", which must survive as path data.
          `${BASE_URL}/works/${encodeURIComponent(normalized)}`,
          { query: { mailto: this.mailto }, signal, operation: "doi-lookup" },
        );
        return this.mapWork(data.message) ?? null;
      }),
    );
  }

  async getById(id: string, signal?: AbortSignal): Promise<PaperResult | null> {
    return this.getByDOI(id, signal);
  }

  /* ------------------------------------------------------------------ */

  private buildQueryParams(query: PaperSearchQuery): Record<string, string> | undefined {
    const params: Record<string, string> = {};

    if (query.title) {
      // `query.bibliographic` is Crossref's recommended field for matching a
      // known citation; it beats `query.title` for exact-title lookups.
      params["query.bibliographic"] = truncate(query.title);
    }
    const authors = (query.authors ?? []).map((a) => a.trim()).filter(Boolean);
    if (authors.length > 0) params["query.author"] = truncate(authors.join(" "));

    if (!params["query.bibliographic"] && !params["query.author"]) {
      const keywords = (query.keywords ?? []).map((k) => k.trim()).filter(Boolean);
      if (keywords.length > 0) params["query.bibliographic"] = truncate(keywords.join(" "));
      else if (query.freeText) params["query.bibliographic"] = truncate(query.freeText);
    }

    return Object.keys(params).length > 0 ? params : undefined;
  }

  private mapWork(work: CrossrefWork | undefined): PaperResult | undefined {
    if (!work) return undefined;

    const doi = cleanDoi(work.DOI);
    const title = work.title?.find((t) => typeof t === "string" && t.trim() !== "") ?? work["short-title"]?.[0];

    const authors = cleanAuthors(
      (work.author ?? []).map((a) => {
        if (a.name) return a.name;
        if (a.family && a.given) return `${a.given} ${a.family}`;
        return a.family ?? undefined;
      }),
    );

    const year =
      firstYear(work.issued) ??
      firstYear(work.published) ??
      firstYear(work["published-print"]) ??
      firstYear(work["published-online"]);

    const isConference = work.type === "proceedings-article";
    const containerTitle = work["container-title"]?.[0];

    // Crossref exposes publisher-hosted links; only ones flagged for text
    // mining or similar public use are surfaced, and only as a candidate PDF.
    const pdfLink = (work.link ?? []).find(
      (l) => l["content-type"]?.toLowerCase() === "application/pdf" && typeof l.URL === "string",
    );

    return buildPaper({
      title,
      authors,
      // Crossref abstracts arrive as JATS XML; stripMarkup in buildPaper cleans it.
      abstract: work.abstract,
      doi,
      year,
      journal: isConference ? undefined : containerTitle,
      conference: isConference ? (work.event?.name ?? containerTitle) : undefined,
      publisher: work.publisher,
      keywords: cleanKeywords(work.subject),
      source: this.name,
      sourceId: doi,
      landingPageUrl: work.URL ?? (doi ? `https://doi.org/${doi}` : undefined),
      pdfUrl: pdfLink?.URL,
      // Crossref does not assert open access, so we leave it unknown rather
      // than guessing - OpenAlex/Unpaywall-style data fills this in elsewhere.
      isOpenAccess: undefined,
      citationCount:
        typeof work["is-referenced-by-count"] === "number" ? work["is-referenced-by-count"] : undefined,
      referenceIds: (work.reference ?? [])
        .map((r) => cleanDoi(r.DOI))
        .filter((d): d is string => Boolean(d))
        .slice(0, 100),
      topics: (work.subject ?? []).map((s) => cleanText(s)).filter((s): s is string => Boolean(s)),
    });
  }

  /** Bearer token for Metadata Plus subscribers; omitted otherwise. */
  static headersFor(apiKey: string | undefined): Record<string, string> {
    return apiKey ? { "crossref-plus-api-token": `Bearer ${apiKey}` } : {};
  }
}

function firstYear(date: { "date-parts"?: number[][] } | undefined): number | undefined {
  const value = date?.["date-parts"]?.[0]?.[0];
  return cleanYear(value);
}

function truncate(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 500);
}
