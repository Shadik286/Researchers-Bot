import type { PaperResult } from "../../models/Paper.js";
import type { PaperSearchQuery } from "../../models/Search.js";
import { normalizeDoi } from "../../utils/normalizeDoi.js";
import { childNamed, childrenNamed, findAll, parseXml, textOf, textOfChild, type XmlNode } from "../../utils/xml.js";
import { BaseSource, buildPaper, cleanAuthors, cleanDoi, cleanText, cleanYear } from "../BaseSource.js";

/**
 * arXiv
 * =====
 *
 * API endpoint
 *   GET https://export.arxiv.org/api/query  (Atom 1.0 XML)
 *
 * Authentication
 *   None. arXiv's API is fully open; no key exists and none is needed.
 *
 * Rate limits
 *   arXiv asks for "no more than one request every three seconds" and a single
 *   connection at a time. Configured as requestsPerSecond = 1/3, concurrency 1.
 *   This is the slowest source by design and we do not push it.
 *
 * Request format
 *   search_query uses field prefixes: ti: (title), au: (author), abs:
 *   (abstract), cat: (category), all:. Phrases are quoted. `id_list` fetches
 *   specific arXiv ids. Paging via start / max_results.
 *
 * Response mapping
 *   feed/entry/title      -> title
 *   feed/entry/author/name-> authors
 *   feed/entry/summary    -> abstract
 *   feed/entry/id         -> arXiv id + landing page
 *   feed/entry/published  -> year
 *   link[@title="pdf"]    -> pdfUrl
 *   arxiv:doi             -> doi (present once published in a journal)
 *   category[@term]       -> topics
 *
 * Access policy
 *   arXiv is an open repository operated by Cornell; its PDFs are meant to be
 *   linked. We link to the official abs/pdf URLs and never mirror content.
 *
 * Error handling
 *   arXiv answers a bad query with HTTP 200 and an Atom feed containing a
 *   single error entry, so the mapper drops entries with no usable id.
 */

const API_URL = "https://export.arxiv.org/api/query";

/** 2101.00001 / 2101.00001v3 / hep-th/9901001 */
const ARXIV_ID_PATTERN = /^(\d{4}\.\d{4,5}(v\d+)?|[a-z-]+(\.[A-Z]{2})?\/\d{7}(v\d+)?)$/i;

export class ArxivSource extends BaseSource {
  readonly name = "arXiv";
  readonly key = "arxiv";

  async search(query: PaperSearchQuery, signal?: AbortSignal): Promise<PaperResult[]> {
    // arXiv has no DOI index of its own; a DOI-only query is best served by
    // other sources, so we skip rather than burn this source's slow budget.
    const searchQuery = this.buildSearchQuery(query);
    if (!searchQuery) return [];

    const limit = this.resultLimit(query);
    return this.withCache("search", [searchQuery, limit], async () =>
      this.notFoundAsEmpty(async () => {
        const { data } = await this.http.getText(API_URL, {
          query: {
            search_query: searchQuery,
            start: 0,
            max_results: Math.min(limit, 50),
            sortBy: "relevance",
            sortOrder: "descending",
          },
          accept: "application/atom+xml",
          signal,
          operation: "search",
        });
        return this.parseFeed(data).slice(0, limit);
      }, []),
    );
  }

  async getById(id: string, signal?: AbortSignal): Promise<PaperResult | null> {
    const arxivId = normalizeArxivId(id);
    if (!arxivId) return null;

    return this.withCache("id", [arxivId], async () =>
      this.notFoundAsNull(async () => {
        const { data } = await this.http.getText(API_URL, {
          query: { id_list: arxivId, max_results: 1 },
          accept: "application/atom+xml",
          signal,
          operation: "id-lookup",
        });
        return this.parseFeed(data)[0] ?? null;
      }),
    );
  }

  /**
   * arXiv cannot be queried by DOI directly. A DataCite-minted arXiv DOI
   * (10.48550/arXiv.XXXX.XXXXX) does encode the id, so that case is resolved;
   * a publisher DOI returns null and other sources handle it.
   */
  async getByDOI(doi: string, signal?: AbortSignal): Promise<PaperResult | null> {
    const normalized = normalizeDoi(doi);
    if (!normalized) return null;
    const match = /^10\.48550\/arxiv\.(.+)$/i.exec(normalized);
    if (!match) return null;
    return this.getById(match[1]!, signal);
  }

  /** arXiv's own related-paper route: same primary category, recent first. */
  async getRelated(paper: PaperResult, limit: number, signal?: AbortSignal): Promise<PaperResult[]> {
    const category = paper.topics?.find((t) => /^[a-z-]+(\.[A-Za-z-]+)?$/.test(t));
    const titleTerms = paper.title.split(/\s+/).slice(0, 8).join(" ");
    if (!category && !titleTerms) return [];

    const clauses: string[] = [];
    if (titleTerms) clauses.push(`all:"${escapeAtomQuery(titleTerms)}"`);
    if (category) clauses.push(`cat:${escapeAtomQuery(category)}`);

    // Cached: arXiv is the slowest source (1 req / 3s), so repeating this on
    // every search would dominate the similar-paper phase.
    return this.withCache("related", [clauses.join(" AND "), limit], async () =>
      this.notFoundAsEmpty(async () => {
        const { data } = await this.http.getText(API_URL, {
          query: {
            search_query: clauses.join(" AND "),
            start: 0,
            max_results: Math.min(limit, 50),
            sortBy: "relevance",
            sortOrder: "descending",
          },
          accept: "application/atom+xml",
          signal,
          operation: "related",
        });
        return this.parseFeed(data);
      }, []),
    );
  }

  /* ------------------------------------------------------------------ */

  private buildSearchQuery(query: PaperSearchQuery): string | undefined {
    const clauses: string[] = [];

    if (query.title) clauses.push(`ti:"${escapeAtomQuery(query.title)}"`);
    for (const author of query.authors ?? []) {
      const value = author.trim();
      if (value) clauses.push(`au:"${escapeAtomQuery(value)}"`);
    }
    if (clauses.length > 0) return clauses.join(" AND ");

    const keywords = (query.keywords ?? []).map((k) => k.trim()).filter(Boolean);
    if (keywords.length > 0) {
      return keywords.map((k) => `all:"${escapeAtomQuery(k)}"`).join(" AND ");
    }
    const free = query.freeText?.trim();
    return free ? `all:"${escapeAtomQuery(free)}"` : undefined;
  }

  private parseFeed(xml: string): PaperResult[] {
    let document: XmlNode;
    try {
      document = parseXml(xml);
    } catch (error) {
      this.logger.warn("atom_parse_failed", { error: error instanceof Error ? error.message : String(error) });
      return [];
    }
    return findAll(document, "entry")
      .map((entry) => this.mapEntry(entry))
      .filter((p): p is PaperResult => p !== undefined);
  }

  private mapEntry(entry: XmlNode): PaperResult | undefined {
    const rawId = textOfChild(entry, "id");
    const arxivId = rawId ? normalizeArxivId(extractIdFromUrl(rawId)) : undefined;
    if (!arxivId) return undefined; // error entries carry no usable id

    const authors = cleanAuthors(
      childrenNamed(entry, "author")
        .map((author) => textOfChild(author, "name"))
        .filter((n): n is string => Boolean(n)),
    );

    let pdfUrl: string | undefined;
    let landingPageUrl: string | undefined;
    for (const link of childrenNamed(entry, "link")) {
      const href = link.attributes.href;
      if (!href) continue;
      const title = link.attributes.title?.toLowerCase();
      const type = link.attributes.type?.toLowerCase();
      if (title === "pdf" || type === "application/pdf") pdfUrl = href;
      else if (link.attributes.rel === "alternate") landingPageUrl = href;
    }

    const categories = childrenNamed(entry, "category")
      .map((c) => c.attributes.term)
      .filter((t): t is string => Boolean(t));

    const journalRef = textOfChild(entry, "journal_ref");
    const comment = textOfChild(entry, "comment");
    const conference = comment && /conference|proceedings|workshop|symposium/i.test(comment) ? comment : undefined;

    return buildPaper({
      title: textOfChild(entry, "title"),
      authors,
      abstract: textOfChild(entry, "summary"),
      doi: cleanDoi(textOfChild(entry, "doi")),
      year: cleanYear(textOfChild(entry, "published")),
      journal: cleanText(journalRef),
      conference,
      publisher: "arXiv",
      source: this.name,
      sourceId: arxivId,
      arxivId,
      landingPageUrl: landingPageUrl ?? `https://arxiv.org/abs/${arxivId}`,
      pdfUrl: pdfUrl ?? `https://arxiv.org/pdf/${arxivId}`,
      // arXiv preprints are freely readable by design.
      isOpenAccess: true,
      topics: categories.length > 0 ? categories : undefined,
    });
  }
}

/** "http://arxiv.org/abs/2101.00001v2" -> "2101.00001v2" */
function extractIdFromUrl(value: string): string {
  const match = /arxiv\.org\/abs\/(.+)$/i.exec(value.trim());
  return match ? match[1]!.trim() : value.trim();
}

export function normalizeArxivId(input: string | undefined): string | undefined {
  if (!input) return undefined;
  let value = input.trim();
  value = value.replace(/^arxiv:/i, "").trim();
  if (value.includes("arxiv.org/")) value = extractIdFromUrl(value);
  value = value.replace(/\.pdf$/i, "");
  return ARXIV_ID_PATTERN.test(value) ? value : undefined;
}

/** Strips characters that would break the Atom query grammar. */
function escapeAtomQuery(value: string): string {
  return value
    .replace(/["()]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 400);
}
