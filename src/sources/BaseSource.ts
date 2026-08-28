import type { Cache } from "../cache/Cache.js";
import { cacheKey } from "../cache/Cache.js";
import type { AppConfig } from "../config/env.js";
import type { HttpClient } from "../http/HttpClient.js";
import { HttpError } from "../http/HttpError.js";
import type { Logger } from "../logging/Logger.js";
import type { FullTextResult } from "../models/FullText.js";
import type { MatchType, PaperResult } from "../models/Paper.js";
import type { PaperSearchQuery } from "../models/Search.js";
import type { AcademicSource } from "../models/Source.js";
import { cleanAuthorDisplayName } from "../utils/normalizeAuthor.js";
import { normalizeDoi } from "../utils/normalizeDoi.js";
import { normalizeKeywords } from "../utils/normalizeKeywords.js";
import { stripMarkup } from "../utils/normalizeTitle.js";
import { sanitizeExternalLink } from "../security/UrlPolicy.js";

/** Everything an adapter is given. Nothing else is reachable from an adapter. */
export interface SourceDependencies {
  httpClient: HttpClient;
  cache: Cache;
  config: AppConfig;
  logger: Logger;
}

/**
 * Shared adapter behaviour: caching, 404-to-empty mapping, and the metadata
 * hygiene rules (no fabricated fields, links sanitised before they are echoed).
 *
 * Subclasses implement only what their API actually offers - which is what
 * keeps provider-specific behaviour out of the search engine.
 */
export abstract class BaseSource implements AcademicSource {
  abstract readonly name: string;
  abstract readonly key: string;

  protected readonly http: HttpClient;
  protected readonly cache: Cache;
  protected readonly config: AppConfig;
  protected readonly logger: Logger;

  constructor(deps: SourceDependencies) {
    this.http = deps.httpClient;
    this.cache = deps.cache;
    this.config = deps.config;
    this.logger = deps.logger.child({ source: this.constructor.name });
  }

  /** Overridden by adapters whose API key is mandatory. */
  isAvailable(): boolean {
    return true;
  }

  unavailableReason(): string | undefined {
    return undefined;
  }

  abstract search(query: PaperSearchQuery, signal?: AbortSignal): Promise<PaperResult[]>;

  /**
   * Default full-text resolution from already-fetched metadata. Adapters with a
   * dedicated availability endpoint (PMC, CORE, OpenAlex) override this.
   *
   * Never bypasses access control: it only reports links the source itself
   * published as reachable.
   */
  async getFullText(paper: PaperResult): Promise<FullTextResult | null> {
    return deriveFullText(paper);
  }

  /* ---------------------------------------------------------------- */
  /* Helpers for subclasses                                            */
  /* ---------------------------------------------------------------- */

  /** Read-through cache scoped to this source. */
  protected async withCache<T>(
    operation: string,
    parts: (string | number | undefined)[],
    loader: () => Promise<T>,
    ttlSeconds?: number,
  ): Promise<T> {
    const key = cacheKey(`${this.key}:${operation}`, ...parts);
    const hit = await this.cache.get<T>(key);
    if (hit !== undefined) {
      this.logger.debug("cache_hit", { operation, key });
      return hit;
    }
    const value = await loader();
    if (value !== undefined) {
      await this.cache.set(key, value, ttlSeconds ?? this.config.cache.ttlSeconds);
    }
    return value;
  }

  /**
   * Runs an upstream call and converts "not found" into an empty result.
   * Every other failure propagates so the orchestrator can report the source
   * status honestly.
   */
  protected async notFoundAsEmpty<T>(loader: () => Promise<T>, empty: T): Promise<T> {
    try {
      return await loader();
    } catch (error) {
      if (error instanceof HttpError && error.isNotFound) return empty;
      throw error;
    }
  }

  protected async notFoundAsNull<T>(loader: () => Promise<T | null>): Promise<T | null> {
    return this.notFoundAsEmpty<T | null>(loader, null);
  }

  protected resultLimit(query: PaperSearchQuery): number {
    const requested = query.limit ?? this.config.budget.maxResultsPerSource;
    return Math.max(1, Math.min(requested, this.config.budget.maxResultsPerSource));
  }
}

/* -------------------------------------------------------------------- */
/* Metadata hygiene helpers, shared by every adapter                     */
/* -------------------------------------------------------------------- */

/** Trims and strips markup; returns undefined rather than an empty string. */
export function cleanText(input: unknown): string | undefined {
  if (typeof input !== "string") return undefined;
  const value = stripMarkup(input);
  return value === "" ? undefined : value;
}

/** Cleans an author list; unusable entries are dropped, never invented. */
export function cleanAuthors(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of input) {
    const name = cleanAuthorDisplayName(typeof entry === "string" ? entry : undefined);
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

/** Parses a publication year from the many shapes sources use. */
export function cleanYear(input: unknown): number | undefined {
  if (typeof input === "number" && Number.isInteger(input)) {
    return isPlausibleYear(input) ? input : undefined;
  }
  if (typeof input === "string") {
    const match = /(1[5-9]\d{2}|20\d{2}|21\d{2})/.exec(input);
    if (match) {
      const year = Number(match[1]);
      return isPlausibleYear(year) ? year : undefined;
    }
  }
  return undefined;
}

function isPlausibleYear(year: number): boolean {
  return year >= 1500 && year <= new Date().getFullYear() + 2;
}

export function cleanKeywords(input: unknown): string[] | undefined {
  const keywords = normalizeKeywords(
    Array.isArray(input) ? input.filter((k): k is string => typeof k === "string") : undefined,
  );
  return keywords.length > 0 ? keywords : undefined;
}

export function cleanDoi(input: unknown): string | undefined {
  return typeof input === "string" ? normalizeDoi(input) : undefined;
}

/** Only http(s) links that do not point into our own network survive. */
export function cleanUrl(input: unknown): string | undefined {
  return typeof input === "string" ? sanitizeExternalLink(input) : undefined;
}

export interface BuildPaperInput {
  title: string | undefined;
  authors?: string[];
  abstract?: string;
  doi?: string;
  year?: number;
  journal?: string;
  conference?: string;
  publisher?: string;
  keywords?: string[];
  source: string;
  sourceId?: string;
  pmid?: string;
  pmcid?: string;
  arxivId?: string;
  landingPageUrl?: string;
  pdfUrl?: string;
  isOpenAccess?: boolean;
  citationCount?: number;
  topics?: string[];
  referenceIds?: string[];
  matchType?: MatchType;
  confidence?: number;
}

/**
 * Assembles a `PaperResult`, dropping every empty field so that "unknown" is
 * represented as `undefined` rather than as a fabricated value.
 *
 * Returns `undefined` when the record has no usable title, since an untitled
 * record cannot be matched, ranked or displayed.
 */
export function buildPaper(input: BuildPaperInput): PaperResult | undefined {
  const title = cleanText(input.title);
  if (!title) return undefined;

  const paper: PaperResult = {
    title,
    authors: input.authors ?? [],
    source: input.source,
    matchType: input.matchType ?? "keyword",
    confidence: input.confidence ?? 0,
  };

  const abstract = cleanText(input.abstract);
  if (abstract) paper.abstract = abstract;
  if (input.doi) paper.doi = input.doi;
  if (input.year !== undefined) paper.year = input.year;
  const journal = cleanText(input.journal);
  if (journal) paper.journal = journal;
  const conference = cleanText(input.conference);
  if (conference) paper.conference = conference;
  const publisher = cleanText(input.publisher);
  if (publisher) paper.publisher = publisher;
  if (input.keywords && input.keywords.length > 0) paper.keywords = input.keywords;
  if (input.sourceId) paper.sourceId = input.sourceId;
  if (input.pmid) paper.pmid = input.pmid;
  if (input.pmcid) paper.pmcid = input.pmcid;
  if (input.arxivId) paper.arxivId = input.arxivId;

  const landing = cleanUrl(input.landingPageUrl);
  if (landing) paper.landingPageUrl = landing;
  const pdf = cleanUrl(input.pdfUrl);
  if (pdf) paper.pdfUrl = pdf;

  if (input.isOpenAccess !== undefined) paper.isOpenAccess = input.isOpenAccess;
  if (typeof input.citationCount === "number" && input.citationCount >= 0) {
    paper.citationCount = input.citationCount;
  }
  if (input.topics && input.topics.length > 0) paper.topics = input.topics;
  if (input.referenceIds && input.referenceIds.length > 0) paper.referenceIds = input.referenceIds;

  paper.sources = [input.source];
  paper.sourceLinks = [
    {
      source: input.source,
      landingPageUrl: paper.landingPageUrl,
      pdfUrl: paper.pdfUrl,
      sourceId: paper.sourceId,
    },
  ];

  return paper;
}

/**
 * Derives a `FullTextResult` from a paper's existing links.
 *
 * Priority (per the access policy):
 *   1. open-access PDF
 *   2. repository / publisher PDF
 *   3. official HTML full text or landing page
 *   4. nothing - and we say so, rather than pointing anywhere unofficial
 */
export function deriveFullText(paper: PaperResult): FullTextResult {
  const pdfUrl = paper.pdfUrl;
  if (pdfUrl) {
    return {
      available: true,
      url: pdfUrl,
      type: "pdf",
      accessType: paper.isOpenAccess === false ? "publisher" : inferPdfAccessType(paper),
      source: paper.source,
    };
  }

  if (paper.landingPageUrl) {
    return {
      available: paper.isOpenAccess === true,
      url: paper.landingPageUrl,
      type: "html",
      // A paywalled paper resolves here: the official landing page, never a
      // circumvented copy.
      accessType: paper.isOpenAccess === true ? "open-access" : "landing-page",
      source: paper.source,
    };
  }

  if (paper.doi) {
    return {
      available: false,
      url: `https://doi.org/${paper.doi}`,
      type: "html",
      accessType: "landing-page",
      source: paper.source,
    };
  }

  return { available: false, accessType: "unavailable", source: paper.source };
}

function inferPdfAccessType(paper: PaperResult): FullTextResult["accessType"] {
  if (paper.isOpenAccess === true) return "open-access";
  if (paper.pmcid || paper.arxivId) return "repository";
  if (paper.source === "CORE" || paper.source === "DOAJ") return "repository";
  return "publisher";
}
