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
} from "../BaseSource.js";

/**
 * Europe PMC (EXTENDED fallback source)
 * =====================================
 *
 * Queried only when the five primary sources AND Crossref/OpenAlex have failed
 * to identify the paper. Europe PMC aggregates PubMed, PMC, Agricola, preprint
 * servers, patents and theses, so it frequently has records the earlier tiers
 * miss - which is exactly what a last-resort tier is for.
 *
 * API endpoint
 *   GET https://www.ebi.ac.uk/europepmc/webservices/rest/search
 *
 * Authentication
 *   None. No key exists and none is needed.
 *
 * Rate limits
 *   No hard published number; EBI asks for considerate use. Configured
 *   conservatively at 2 req/s, concurrency 1.
 *
 * Request format
 *   `query` uses a field grammar: TITLE:"...", AUTH:"...", DOI:"...",
 *   KW:"...", plus bare free text. `resultType=core` returns abstracts,
 *   author lists and full-text links; `format=json`; `pageSize` <= 1000.
 *
 * Response mapping
 *   resultList.result[] -> title, authorString/authorList, doi, pmid, pmcid,
 *   journalInfo.journal.title, pubYear, abstractText, citedByCount,
 *   isOpenAccess ("Y"/"N"), fullTextUrlList.fullTextUrl[].
 *
 * Access policy
 *   Only links Europe PMC itself marks `availability: "Open access"` are
 *   surfaced as full text. A "Subscription required" entry is treated as a
 *   landing page, never as an open copy.
 */

const BASE_URL = "https://www.ebi.ac.uk/europepmc/webservices/rest/search";

interface EpmcFullTextUrl {
  availability?: string;
  availabilityCode?: string;
  documentStyle?: string;
  site?: string;
  url?: string;
}

interface EpmcResult {
  id?: string;
  source?: string;
  pmid?: string;
  pmcid?: string;
  doi?: string;
  title?: string;
  authorString?: string;
  authorList?: { author?: { fullName?: string; firstName?: string; lastName?: string }[] };
  journalInfo?: { journal?: { title?: string }; yearOfPublication?: number };
  pubYear?: string;
  abstractText?: string;
  keywordList?: { keyword?: string[] };
  citedByCount?: number;
  isOpenAccess?: string;
  inEPMC?: string;
  hasPDF?: string;
  license?: string;
  fullTextUrlList?: { fullTextUrl?: EpmcFullTextUrl[] };
  pubTypeList?: { pubType?: string[] };
}

interface EpmcResponse {
  hitCount?: number;
  resultList?: { result?: EpmcResult[] };
}

export class EuropePmcSource extends BaseSource {
  readonly name = "Europe PMC";
  readonly key = "europepmc";

  async search(query: PaperSearchQuery, signal?: AbortSignal): Promise<PaperResult[]> {
    const expression = this.buildExpression(query);
    if (!expression) return [];

    const limit = this.resultLimit(query);
    return this.withCache("search", [expression, limit], async () =>
      this.notFoundAsEmpty(async () => {
        const { data } = await this.http.getJson<EpmcResponse>(BASE_URL, {
          query: {
            query: expression,
            format: "json",
            resultType: "core",
            pageSize: Math.min(limit, 100),
          },
          signal,
          operation: "search",
        });
        return (data.resultList?.result ?? [])
          .map((item) => this.mapResult(item))
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
        const { data } = await this.http.getJson<EpmcResponse>(BASE_URL, {
          query: {
            query: `DOI:"${escapeValue(normalized)}"`,
            format: "json",
            resultType: "core",
            pageSize: 5,
          },
          signal,
          operation: "doi-lookup",
        });
        for (const item of data.resultList?.result ?? []) {
          const paper = this.mapResult(item);
          if (paper?.doi === normalized) return paper;
        }
        return null;
      }),
    );
  }

  /** Accepts a PMID, a PMCID, or a Europe PMC `SOURCE:ID` pair. */
  async getById(id: string, signal?: AbortSignal): Promise<PaperResult | null> {
    const value = id.trim();
    let expression: string | undefined;
    if (/^\d{1,9}$/.test(value)) expression = `EXT_ID:${value}`;
    else if (/^pmc\d{1,9}$/i.test(value)) expression = `PMCID:${value.toUpperCase()}`;
    if (!expression) return null;

    return this.withCache("id", [expression], async () =>
      this.notFoundAsNull(async () => {
        const { data } = await this.http.getJson<EpmcResponse>(BASE_URL, {
          query: { query: expression, format: "json", resultType: "core", pageSize: 1 },
          signal,
          operation: "id-lookup",
        });
        const first = data.resultList?.result?.[0];
        return first ? (this.mapResult(first) ?? null) : null;
      }),
    );
  }

  override async getFullText(paper: PaperResult, signal?: AbortSignal): Promise<FullTextResult | null> {
    if (!paper.doi) return deriveFullText(paper);
    const found = await this.getByDOI(paper.doi, signal);
    if (!found) return deriveFullText(paper);
    return deriveFullText(found);
  }

  /* ------------------------------------------------------------------ */

  private buildExpression(query: PaperSearchQuery): string | undefined {
    const doi = normalizeDoi(query.doi);
    if (doi) return `DOI:"${escapeValue(doi)}"`;

    const clauses: string[] = [];
    if (query.title) clauses.push(`TITLE:"${escapeValue(query.title)}"`);
    for (const author of query.authors ?? []) {
      const value = escapeValue(author);
      if (value) clauses.push(`AUTH:"${value}"`);
    }
    if (clauses.length > 0) return clauses.join(" AND ");

    const keywords = (query.keywords ?? []).map((k) => escapeValue(k)).filter(Boolean);
    if (keywords.length > 0) return keywords.map((k) => `"${k}"`).join(" AND ");

    const free = query.freeText ? escapeValue(query.freeText) : "";
    return free ? `"${free}"` : undefined;
  }

  private mapResult(item: EpmcResult | undefined): PaperResult | undefined {
    if (!item) return undefined;

    const doi = cleanDoi(item.doi);
    const pmcid = item.pmcid ? item.pmcid.toUpperCase() : undefined;

    const authors = item.authorList?.author?.length
      ? cleanAuthors(
          item.authorList.author.map((a) =>
            a.fullName ?? [a.firstName, a.lastName].filter(Boolean).join(" ") ?? undefined,
          ),
        )
      : cleanAuthors((item.authorString ?? "").split(",").map((n) => n.trim()));

    const links = item.fullTextUrlList?.fullTextUrl ?? [];
    const openLinks = links.filter((l) => l.availabilityCode === "OA" || /open access/i.test(l.availability ?? ""));
    const pdfUrl = openLinks.find((l) => l.documentStyle?.toLowerCase() === "pdf")?.url;
    const htmlUrl = openLinks.find((l) => l.documentStyle?.toLowerCase() === "html")?.url;
    const doiLink = links.find((l) => l.documentStyle?.toLowerCase() === "doi")?.url;

    const isOpenAccess = item.isOpenAccess === "Y" ? true : item.isOpenAccess === "N" ? false : undefined;

    const isPreprint = (item.pubTypeList?.pubType ?? []).some((t) => /preprint/i.test(t));

    return buildPaper({
      title: item.title,
      authors,
      abstract: item.abstractText,
      doi,
      year: cleanYear(item.pubYear ?? item.journalInfo?.yearOfPublication),
      journal: item.journalInfo?.journal?.title,
      publisher: isPreprint ? "Preprint" : undefined,
      keywords: cleanKeywords(item.keywordList?.keyword),
      source: this.name,
      sourceId: item.id,
      pmid: cleanText(item.pmid),
      pmcid,
      landingPageUrl:
        htmlUrl ??
        doiLink ??
        (pmcid ? `https://europepmc.org/article/PMC/${pmcid}` : undefined) ??
        (doi ? `https://doi.org/${doi}` : undefined),
      pdfUrl,
      isOpenAccess,
      citationCount: typeof item.citedByCount === "number" ? item.citedByCount : undefined,
    });
  }
}

/** Strips the characters that would otherwise break the query grammar. */
function escapeValue(value: string): string {
  return value
    .replace(/["():]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 400);
}
