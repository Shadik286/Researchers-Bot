import type { FullTextResult } from "../../models/FullText.js";
import type { PaperResult } from "../../models/Paper.js";
import type { PaperSearchQuery } from "../../models/Search.js";
import { normalizeDoi } from "../../utils/normalizeDoi.js";
import { childNamed, childrenNamed, findAll, parseXml, textOf, textOfChild, type XmlNode } from "../../utils/xml.js";
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
 * PubMed / PubMed Central (NCBI E-utilities)
 * ==========================================
 *
 * API endpoints
 *   GET .../esearch.fcgi?db=pubmed&term=...&retmode=json   - find PMIDs
 *   GET .../efetch.fcgi?db=pubmed&id=...&retmode=xml       - full records
 *   GET https://www.ncbi.nlm.nih.gov/pmc/utils/idconv/v1.0/ - PMID <-> PMCID
 *
 * Authentication
 *   Optional. NCBI_API_KEY is appended as `api_key` when configured; it raises
 *   the limit from 3 to 10 requests/second. Without it the adapter still works.
 *
 * Rate limits
 *   3 req/s unkeyed, 10 req/s keyed - enforced in config/rateLimits.ts. NCBI
 *   also asks that `tool` and `email` be sent, which we do.
 *
 * Request format
 *   PubMed query syntax with field tags: [Title], [Author], [DOI], [All Fields].
 *
 * Response mapping
 *   ArticleTitle -> title, Abstract/AbstractText -> abstract,
 *   AuthorList -> authors, ArticleId[IdType=doi|pmc] -> doi/pmcid,
 *   Journal/Title -> journal, PubDate/Year -> year, MeshHeading -> keywords.
 *
 * Full text
 *   A PMCID means a free full text exists in PMC, which is a legitimate open
 *   repository. We link to the official PMC article page. Where no PMCID
 *   exists we fall back to the PubMed abstract page or the DOI landing page -
 *   we never route around a publisher paywall.
 *
 * Error handling
 *   esearch returns an empty idlist rather than 404 for "no hits". NCBI
 *   answers 429 with Retry-After under load, which the shared client honours.
 */

const EUTILS = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";
const ID_CONVERTER = "https://www.ncbi.nlm.nih.gov/pmc/utils/idconv/v1.0/";
const TOOL_NAME = "AcademicPaperFinder";

interface ESearchResponse {
  esearchresult?: {
    count?: string;
    idlist?: string[];
    errorlist?: unknown;
    warninglist?: unknown;
    ERROR?: string;
  };
}

interface IdConverterRecord {
  pmid?: string;
  pmcid?: string;
  doi?: string;
  live?: boolean;
  status?: string;
}

interface IdConverterResponse {
  records?: IdConverterRecord[];
}

export class PubMedSource extends BaseSource {
  readonly name = "PubMed Central";
  readonly key = "pubmed";

  async search(query: PaperSearchQuery, signal?: AbortSignal): Promise<PaperResult[]> {
    const term = this.buildTerm(query);
    if (!term) return [];

    const limit = this.resultLimit(query);
    return this.withCache("search", [term, limit], async () => {
      const ids = await this.esearch(term, limit, signal);
      if (ids.length === 0) return [];
      return this.efetch(ids, signal);
    });
  }

  async getByDOI(doi: string, signal?: AbortSignal): Promise<PaperResult | null> {
    const normalized = normalizeDoi(doi);
    if (!normalized) return null;

    return this.withCache("doi", [normalized], async () => {
      const ids = await this.esearch(`${normalized}[DOI]`, 3, signal);
      if (ids.length === 0) return null;
      const papers = await this.efetch(ids, signal);
      return papers.find((p) => p.doi === normalized) ?? papers[0] ?? null;
    });
  }

  /** Accepts a bare PMID ("12345678") or a PMCID ("PMC1234567"). */
  async getById(id: string, signal?: AbortSignal): Promise<PaperResult | null> {
    const value = id.trim();
    if (/^\d{1,9}$/.test(value)) {
      const papers = await this.efetch([value], signal);
      return papers[0] ?? null;
    }
    if (/^pmc\d{1,9}$/i.test(value)) {
      const pmid = await this.pmcidToPmid(value.toUpperCase(), signal);
      if (!pmid) return null;
      const papers = await this.efetch([pmid], signal);
      return papers[0] ?? null;
    }
    return null;
  }

  override async getFullText(paper: PaperResult, signal?: AbortSignal): Promise<FullTextResult | null> {
    let pmcid = paper.pmcid;

    // A DOI or PMID with no known PMCID may still have a free PMC copy.
    if (!pmcid && (paper.doi || paper.pmid)) {
      pmcid = await this.lookupPmcid(paper.doi ?? paper.pmid!, signal);
    }

    if (pmcid) {
      return {
        available: true,
        url: `https://pmc.ncbi.nlm.nih.gov/articles/${encodeURIComponent(pmcid)}/`,
        type: "html",
        accessType: "repository",
        source: this.name,
      };
    }

    return deriveFullText(paper);
  }

  /* ------------------------------------------------------------------ */

  private commonParams(): Record<string, string> {
    const params: Record<string, string> = {
      tool: TOOL_NAME,
      email: this.config.contactEmail,
    };
    // The key is sent as a request parameter only; it is never logged and never
    // echoed in a response.
    if (this.config.apiKeys.ncbi) params.api_key = this.config.apiKeys.ncbi;
    return params;
  }

  private async esearch(term: string, limit: number, signal?: AbortSignal): Promise<string[]> {
    return this.notFoundAsEmpty(async () => {
      const { data } = await this.http.getJson<ESearchResponse>(`${EUTILS}/esearch.fcgi`, {
        query: {
          ...this.commonParams(),
          db: "pubmed",
          term,
          retmode: "json",
          retmax: Math.min(limit, 100),
          sort: "relevance",
        },
        signal,
        operation: "esearch",
      });
      const result = data.esearchresult;
      if (result?.ERROR) {
        this.logger.debug("esearch_reported_error", { detail: String(result.ERROR).slice(0, 200) });
        return [];
      }
      return (result?.idlist ?? []).filter((id) => /^\d+$/.test(id));
    }, []);
  }

  private async efetch(pmids: string[], signal?: AbortSignal): Promise<PaperResult[]> {
    if (pmids.length === 0) return [];
    return this.withCache("efetch", [pmids.join(",")], async () =>
      this.notFoundAsEmpty(async () => {
        const { data } = await this.http.getText(`${EUTILS}/efetch.fcgi`, {
          query: {
            ...this.commonParams(),
            db: "pubmed",
            id: pmids.join(","),
            retmode: "xml",
          },
          accept: "application/xml",
          signal,
          operation: "efetch",
        });
        const document = parseXml(data);
        return findAll(document, "PubmedArticle")
          .map((article) => this.mapArticle(article))
          .filter((p): p is PaperResult => p !== undefined);
      }, []),
    );
  }

  private async lookupPmcid(identifier: string, signal?: AbortSignal): Promise<string | undefined> {
    const record = await this.convertIds(identifier, signal);
    return record?.pmcid;
  }

  private async pmcidToPmid(pmcid: string, signal?: AbortSignal): Promise<string | undefined> {
    const record = await this.convertIds(pmcid, signal);
    return record?.pmid;
  }

  private async convertIds(identifier: string, signal?: AbortSignal): Promise<IdConverterRecord | undefined> {
    return this.withCache("idconv", [identifier], async () =>
      this.notFoundAsEmpty(async () => {
        const { data } = await this.http.getJson<IdConverterResponse>(ID_CONVERTER, {
          query: { ...this.commonParams(), ids: identifier, format: "json", versions: "no" },
          signal,
          operation: "id-converter",
        });
        const record = (data.records ?? []).find((r) => r.status !== "error");
        return record ?? undefined;
      }, undefined),
    );
  }

  /**
   * Builds a PubMed query.
   *
   * IMPORTANT: field-tagged terms are NOT quoted.
   *
   * PubMed treats a quoted string as an exact phrase-index lookup, and when the
   * phrase is not in that index it returns ZERO results plus a
   * `quotedphrasesnotfound` warning - even when the article is clearly present.
   * Verified against the live API:
   *
   *   "Blockchain technology in healthcare: A systematic review"[Title] -> 0
   *    Blockchain technology in healthcare A systematic review[Title]   -> 25
   *                                                (target at position 0)
   *   "Hassaan Malik"[Author] -> 0        Hassaan Malik[Author] -> 15
   *
   * Unquoted terms are ANDed by PubMed, which is the behaviour we want.
   */
  private buildTerm(query: PaperSearchQuery): string | undefined {
    const doi = normalizeDoi(query.doi);
    if (doi) return `${escapeTerm(doi)}[DOI]`;

    const clauses: string[] = [];

    const title = query.title ? escapeTerm(query.title) : "";
    if (title) clauses.push(`${title}[Title]`);

    for (const author of query.authors ?? []) {
      const value = escapeTerm(author);
      if (value) clauses.push(`${value}[Author]`);
    }

    if (clauses.length > 0) return clauses.join(" AND ");

    const keywords = (query.keywords ?? []).map((k) => escapeTerm(k)).filter(Boolean);
    if (keywords.length > 0) {
      return keywords.map((k) => `${k}[All Fields]`).join(" AND ");
    }
    const free = query.freeText ? escapeTerm(query.freeText) : "";
    return free ? `${free}[All Fields]` : undefined;
  }

  private mapArticle(node: XmlNode): PaperResult | undefined {
    const citation = childNamed(node, "MedlineCitation");
    const article = citation ? childNamed(citation, "Article") : undefined;
    if (!article) return undefined;

    const pmid = textOfChild(citation, "PMID");

    const ids = new Map<string, string>();
    const pubmedData = childNamed(node, "PubmedData");
    const idList = pubmedData ? childNamed(pubmedData, "ArticleIdList") : undefined;
    for (const idNode of idList ? childrenNamed(idList, "ArticleId") : []) {
      const type = idNode.attributes.IdType?.toLowerCase();
      const value = textOf(idNode);
      if (type && value) ids.set(type, value);
    }

    const journalNode = childNamed(article, "Journal");
    const journalTitle = textOfChild(journalNode, "Title") ?? textOfChild(journalNode, "ISOAbbreviation");

    const year = this.extractYear(journalNode, article);
    const abstract = this.extractAbstract(article);
    const authors = this.extractAuthors(article);
    const keywords = this.extractKeywords(citation);

    const doi = cleanDoi(ids.get("doi"));
    const pmcid = ids.get("pmc");

    const landingPageUrl = pmcid
      ? `https://pmc.ncbi.nlm.nih.gov/articles/${pmcid}/`
      : pmid
        ? `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`
        : doi
          ? `https://doi.org/${doi}`
          : undefined;

    return buildPaper({
      title: textOfChild(article, "ArticleTitle"),
      authors,
      abstract,
      doi,
      year,
      journal: journalTitle,
      keywords,
      source: this.name,
      sourceId: pmid,
      pmid,
      pmcid,
      landingPageUrl,
      // A PMC record is free full text; a PubMed-only record may not be, and we
      // do not guess.
      isOpenAccess: pmcid ? true : undefined,
    });
  }

  private extractYear(journalNode: XmlNode | undefined, article: XmlNode): number | undefined {
    const issue = journalNode ? childNamed(journalNode, "JournalIssue") : undefined;
    const pubDate = issue ? childNamed(issue, "PubDate") : undefined;
    const year = cleanYear(textOfChild(pubDate, "Year")) ?? cleanYear(textOfChild(pubDate, "MedlineDate"));
    if (year) return year;
    const articleDate = childNamed(article, "ArticleDate");
    return cleanYear(textOfChild(articleDate, "Year"));
  }

  private extractAbstract(article: XmlNode): string | undefined {
    const abstractNode = childNamed(article, "Abstract");
    if (!abstractNode) return undefined;
    const parts: string[] = [];
    for (const text of childrenNamed(abstractNode, "AbstractText")) {
      const label = text.attributes.Label;
      const body = textOf(text);
      if (!body) continue;
      parts.push(label ? `${label}: ${body}` : body);
    }
    return cleanText(parts.join(" "));
  }

  private extractAuthors(article: XmlNode): string[] {
    const list = childNamed(article, "AuthorList");
    if (!list) return [];
    const names: string[] = [];
    for (const author of childrenNamed(list, "Author")) {
      const collective = textOfChild(author, "CollectiveName");
      if (collective) {
        names.push(collective);
        continue;
      }
      const lastName = textOfChild(author, "LastName");
      if (!lastName) continue;
      const foreName = textOfChild(author, "ForeName") ?? textOfChild(author, "Initials");
      names.push(foreName ? `${foreName} ${lastName}` : lastName);
    }
    return cleanAuthors(names);
  }

  private extractKeywords(citation: XmlNode | undefined): string[] | undefined {
    if (!citation) return undefined;
    const terms: string[] = [];

    const meshList = childNamed(citation, "MeshHeadingList");
    for (const heading of meshList ? childrenNamed(meshList, "MeshHeading") : []) {
      const descriptor = textOfChild(heading, "DescriptorName");
      if (descriptor) terms.push(descriptor);
    }
    for (const keywordList of childrenNamed(citation, "KeywordList")) {
      for (const keyword of childrenNamed(keywordList, "Keyword")) {
        const value = textOf(keyword);
        if (value) terms.push(value);
      }
    }
    return cleanKeywords(terms);
  }
}

/**
 * PubMed terms are sent as a query parameter. Strip every character that is
 * part of PubMed's own query grammar so user text cannot alter the query
 * structure: quotes, the [field] brackets, grouping parens, the `:` range
 * separator and the `*` truncation wildcard.
 */
function escapeTerm(value: string): string {
  return value
    .replace(/["\[\]():*~]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 400);
}
