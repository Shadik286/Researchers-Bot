import type { PaperResult } from "../../models/Paper.js";
import type { PaperSearchQuery } from "../../models/Search.js";
import { normalizeDoi } from "../../utils/normalizeDoi.js";
import { BaseSource, buildPaper, cleanAuthors, cleanDoi, cleanKeywords, cleanText, cleanYear } from "../BaseSource.js";

/**
 * DataCite (EXTENDED fallback source, last resort)
 * ================================================
 *
 * The final tier. DataCite registers DOIs for the material the other sources
 * usually miss: preprints, theses, technical reports, conference material and
 * repository deposits (Zenodo, figshare, OSF, institutional repositories).
 *
 * API endpoint
 *   GET https://api.datacite.org/dois
 *
 * Authentication
 *   None for reads.
 *
 * Rate limits
 *   DataCite asks for considerate use of the public API; configured at
 *   2 req/s, concurrency 1.
 *
 * Request format
 *   `query` (Elasticsearch-style), `page[size]` (<= 1000).
 *
 * Response mapping
 *   data[].attributes -> doi, titles[].title, creators[].name,
 *   publicationYear, publisher, types.resourceTypeGeneral, url, descriptions[],
 *   subjects[].subject.
 *
 * Filtering
 *   DataCite indexes datasets, software and pre-registrations as well as
 *   papers. Non-textual resource types are dropped so the result list stays a
 *   list of *papers*.
 *
 * Access policy
 *   `attributes.url` is the depositor's own landing page. It is surfaced as a
 *   landing page; a PDF is only claimed when the URL plainly is one.
 */

const BASE_URL = "https://api.datacite.org/dois";

/** Resource types that represent a readable scholarly text. */
const TEXTUAL_TYPES = new Set([
  "text",
  "preprint",
  "journalarticle",
  "conferencepaper",
  "report",
  "dissertation",
  "book",
  "bookchapter",
]);

interface DataCiteCreator {
  name?: string;
  givenName?: string;
  familyName?: string;
  nameType?: string;
}

interface DataCiteAttributes {
  doi?: string;
  titles?: { title?: string }[];
  creators?: DataCiteCreator[];
  publisher?: string | { name?: string };
  publicationYear?: number;
  descriptions?: { description?: string; descriptionType?: string }[];
  subjects?: { subject?: string }[];
  types?: { resourceTypeGeneral?: string; resourceType?: string; citeproc?: string };
  url?: string;
  contentUrl?: string[] | null;
  citationCount?: number;
}

interface DataCiteResponse {
  data?: { id?: string; attributes?: DataCiteAttributes }[];
  meta?: { total?: number };
}

export class DataCiteSource extends BaseSource {
  readonly name = "DataCite";
  readonly key = "datacite";

  async search(query: PaperSearchQuery, signal?: AbortSignal): Promise<PaperResult[]> {
    const expression = this.buildExpression(query);
    if (!expression) return [];

    const limit = this.resultLimit(query);
    return this.withCache("search", [expression, limit], async () =>
      this.notFoundAsEmpty(async () => {
        const { data } = await this.http.getJson<DataCiteResponse>(BASE_URL, {
          query: { query: expression, "page[size]": Math.min(limit, 50) },
          signal,
          operation: "search",
        });
        return (data.data ?? [])
          .map((entry) => this.mapWork(entry.attributes))
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
        const { data } = await this.http.getJson<{ data?: { attributes?: DataCiteAttributes } }>(
          `${BASE_URL}/${encodeURIComponent(normalized)}`,
          { signal, operation: "doi-lookup" },
        );
        return this.mapWork(data.data?.attributes) ?? null;
      }),
    );
  }

  async getById(id: string, signal?: AbortSignal): Promise<PaperResult | null> {
    return this.getByDOI(id, signal);
  }

  /* ------------------------------------------------------------------ */

  private buildExpression(query: PaperSearchQuery): string | undefined {
    const doi = normalizeDoi(query.doi);
    if (doi) return `doi:"${escapeValue(doi)}"`;

    const clauses: string[] = [];
    if (query.title) clauses.push(`titles.title:"${escapeValue(query.title)}"`);
    for (const author of query.authors ?? []) {
      const value = escapeValue(author);
      if (value) clauses.push(`creators.name:"${value}"`);
    }
    if (clauses.length > 0) return clauses.join(" AND ");

    const keywords = (query.keywords ?? []).map((k) => escapeValue(k)).filter(Boolean);
    if (keywords.length > 0) return keywords.map((k) => `"${k}"`).join(" AND ");

    const free = query.freeText ? escapeValue(query.freeText) : "";
    return free ? `"${free}"` : undefined;
  }

  private mapWork(attributes: DataCiteAttributes | undefined): PaperResult | undefined {
    if (!attributes) return undefined;

    // Keep papers; drop datasets, software, images and similar.
    const general = attributes.types?.resourceTypeGeneral?.toLowerCase().replace(/\s+/g, "");
    const specific = attributes.types?.resourceType?.toLowerCase().replace(/\s+/g, "");
    const looksTextual =
      (general !== undefined && TEXTUAL_TYPES.has(general)) ||
      (specific !== undefined && TEXTUAL_TYPES.has(specific)) ||
      attributes.types?.citeproc === "article-journal";
    if (!looksTextual) return undefined;

    const title = attributes.titles?.find((t) => typeof t.title === "string" && t.title.trim())?.title;
    const abstract = attributes.descriptions?.find(
      (d) => (d.descriptionType ?? "").toLowerCase() === "abstract",
    )?.description;

    const publisher =
      typeof attributes.publisher === "string" ? attributes.publisher : attributes.publisher?.name;

    const url = attributes.url;
    const pdfFromContent = (attributes.contentUrl ?? [])?.find((u) => typeof u === "string" && /\.pdf($|\?)/i.test(u));

    return buildPaper({
      title,
      authors: cleanAuthors(
        (attributes.creators ?? []).map((c) =>
          c.name ?? [c.givenName, c.familyName].filter(Boolean).join(" ") ?? undefined,
        ),
      ),
      abstract,
      doi: cleanDoi(attributes.doi),
      year: cleanYear(attributes.publicationYear),
      publisher: cleanText(publisher),
      keywords: cleanKeywords((attributes.subjects ?? []).map((s) => s.subject)),
      source: this.name,
      sourceId: cleanDoi(attributes.doi),
      landingPageUrl: url,
      // Only claim a PDF when the deposit actually advertises one.
      pdfUrl: pdfFromContent ?? (typeof url === "string" && /\.pdf($|\?)/i.test(url) ? url : undefined),
      // DataCite records the DOI, not the access status; do not guess.
      isOpenAccess: undefined,
    });
  }
}

function escapeValue(value: string): string {
  return value
    .replace(/[\\"~^]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 400);
}
