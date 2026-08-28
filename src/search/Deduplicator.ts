import type { PaperResult, SourceLink } from "../models/Paper.js";
import { authorOverlap, normalizeAuthors } from "../utils/normalizeAuthor.js";
import { normalizeDoi } from "../utils/normalizeDoi.js";
import { titleFingerprint } from "../utils/normalizeTitle.js";
import { titleSimilarity } from "../utils/similarity.js";

/**
 * PHASE 9 - deduplication.
 *
 * The same paper legitimately appears on DOAJ, CORE, Semantic Scholar,
 * Crossref, OpenAlex and arXiv at once. The client must see ONE record with the
 * union of what every source knew.
 *
 * Identity keys, strongest first:
 *   1. DOI
 *   2. PMCID, then PMID
 *   3. arXiv id
 *   4. source + source id (same record from the same source)
 *   5. normalized-title fingerprint + author overlap
 *   6. fuzzy title similarity (last resort, requires corroboration)
 *
 * Merging keeps the richest value for each field and preserves every source's
 * links, so no useful route to the paper is lost.
 */

const FUZZY_TITLE_THRESHOLD = 0.93;
const FUZZY_AUTHOR_THRESHOLD = 0.5;

/** Source ranking used when two records disagree on a scalar field. */
const SOURCE_TRUST: Record<string, number> = {
  Crossref: 6, // authoritative for DOI-registered metadata
  "PubMed Central": 6, // authoritative for biomedical metadata
  OpenAlex: 5,
  "Semantic Scholar": 4,
  DOAJ: 4,
  arXiv: 3,
  CORE: 2,
};

export interface DeduplicationResult {
  papers: PaperResult[];
  /** How many input records were folded into an existing one. */
  mergedCount: number;
}

export class Deduplicator {
  /**
   * Collapses duplicates. Input order matters: earlier records are treated as
   * the "primary" record of their group, so callers should pass higher-quality
   * results first.
   */
  deduplicate(papers: readonly PaperResult[]): DeduplicationResult {
    const groups: PaperResult[] = [];
    const index = new Map<string, number>();
    let mergedCount = 0;

    for (const paper of papers) {
      const keys = identityKeys(paper);

      let target = -1;
      for (const key of keys) {
        const existing = index.get(key);
        if (existing !== undefined) {
          target = existing;
          break;
        }
      }

      // No strong identifier hit: try the fuzzy title + author route.
      if (target === -1) {
        target = this.findFuzzyMatch(groups, paper);
      }

      if (target === -1) {
        groups.push({ ...paper });
        const position = groups.length - 1;
        for (const key of keys) if (!index.has(key)) index.set(key, position);
        continue;
      }

      groups[target] = mergePapers(groups[target]!, paper);
      mergedCount += 1;
      // The merged record may now carry identifiers the group did not have.
      for (const key of identityKeys(groups[target]!)) {
        if (!index.has(key)) index.set(key, target);
      }
    }

    return { papers: groups, mergedCount };
  }

  private findFuzzyMatch(groups: readonly PaperResult[], paper: PaperResult): number {
    const fingerprint = titleFingerprint(paper.title);
    if (fingerprint.length < 12) return -1; // too short to be a safe key

    const paperAuthors = normalizeAuthors(paper.authors);

    for (let i = 0; i < groups.length; i += 1) {
      const group = groups[i]!;

      // Two records with DIFFERENT DOIs are different papers - never merge.
      if (paper.doi && group.doi && paper.doi !== group.doi) continue;

      const groupFingerprint = titleFingerprint(group.title);
      if (groupFingerprint === fingerprint) {
        if (this.corroborates(group, paper, paperAuthors)) return i;
        continue;
      }

      if (titleSimilarity(group.title, paper.title) >= FUZZY_TITLE_THRESHOLD) {
        if (this.corroborates(group, paper, paperAuthors)) return i;
      }
    }
    return -1;
  }

  /**
   * A title match alone is not enough. At least one of: matching year, author
   * overlap, or one side having no authors/year at all to contradict it.
   */
  private corroborates(
    group: PaperResult,
    paper: PaperResult,
    paperAuthors: ReturnType<typeof normalizeAuthors>,
  ): boolean {
    if (group.year !== undefined && paper.year !== undefined && Math.abs(group.year - paper.year) > 1) {
      return false;
    }
    const groupAuthors = normalizeAuthors(group.authors);
    if (groupAuthors.length === 0 || paperAuthors.length === 0) return true;
    return authorOverlap(groupAuthors, paperAuthors) >= FUZZY_AUTHOR_THRESHOLD;
  }
}

/** Every strong identity key a record carries. */
export function identityKeys(paper: PaperResult): string[] {
  const keys: string[] = [];
  const doi = normalizeDoi(paper.doi);
  if (doi) keys.push(`doi:${doi}`);
  if (paper.pmcid) keys.push(`pmcid:${paper.pmcid.toUpperCase()}`);
  if (paper.pmid) keys.push(`pmid:${paper.pmid}`);
  if (paper.arxivId) keys.push(`arxiv:${stripArxivVersion(paper.arxivId)}`);
  if (paper.sourceId) keys.push(`src:${paper.source}:${paper.sourceId}`);
  return keys;
}

function stripArxivVersion(id: string): string {
  return id.replace(/v\d+$/i, "").toLowerCase();
}

/**
 * Merges `incoming` into `primary`.
 *
 * Scalars: keep the primary's value unless it is missing, or unless the
 * incoming record comes from a more trusted source AND the primary's value is
 * clearly poorer (shorter abstract, truncated author list).
 */
export function mergePapers(primary: PaperResult, incoming: PaperResult): PaperResult {
  const merged: PaperResult = { ...primary };

  const primaryTrust = SOURCE_TRUST[primary.source] ?? 1;
  const incomingTrust = SOURCE_TRUST[incoming.source] ?? 1;

  merged.doi ??= incoming.doi;
  merged.pmid ??= incoming.pmid;
  merged.pmcid ??= incoming.pmcid;
  merged.arxivId ??= incoming.arxivId;
  merged.year ??= incoming.year;
  merged.journal ??= incoming.journal;
  merged.conference ??= incoming.conference;
  merged.publisher ??= incoming.publisher;
  merged.sourceId ??= primary.source === incoming.source ? incoming.sourceId : merged.sourceId;

  // Longer abstract wins - sources routinely truncate.
  if (incoming.abstract && (!merged.abstract || incoming.abstract.length > merged.abstract.length * 1.2)) {
    merged.abstract = incoming.abstract;
  }

  // Fuller author list wins; a tie goes to the more trusted source.
  if (
    incoming.authors.length > merged.authors.length ||
    (incoming.authors.length === merged.authors.length && incomingTrust > primaryTrust && incoming.authors.length > 0)
  ) {
    merged.authors = incoming.authors;
  }

  // A longer, more specific title from a trusted source replaces a truncated one.
  if (
    incoming.title.length > merged.title.length * 1.15 &&
    incomingTrust >= primaryTrust &&
    titleSimilarity(incoming.title, merged.title) >= FUZZY_TITLE_THRESHOLD
  ) {
    merged.title = incoming.title;
  }

  merged.keywords = mergeStringLists(merged.keywords, incoming.keywords, 30);
  merged.topics = mergeStringLists(merged.topics, incoming.topics, 30);
  merged.referenceIds = mergeStringLists(merged.referenceIds, incoming.referenceIds, 200);

  // Access links: a real PDF beats none; an open-access flag from any source
  // that asserts `true` is kept (no source asserts OA it has not verified).
  if (!merged.pdfUrl && incoming.pdfUrl) merged.pdfUrl = incoming.pdfUrl;
  if (!merged.landingPageUrl && incoming.landingPageUrl) merged.landingPageUrl = incoming.landingPageUrl;
  if (merged.isOpenAccess !== true && incoming.isOpenAccess !== undefined) {
    merged.isOpenAccess = merged.isOpenAccess === undefined ? incoming.isOpenAccess : merged.isOpenAccess || incoming.isOpenAccess;
  }

  if (typeof incoming.citationCount === "number") {
    merged.citationCount = Math.max(merged.citationCount ?? 0, incoming.citationCount);
  }

  // Keep the strongest match verdict across the group.
  if (incoming.confidence > merged.confidence) {
    merged.confidence = incoming.confidence;
    merged.matchType = incoming.matchType;
  }
  if (incoming.similarityScore !== undefined) {
    merged.similarityScore = Math.max(merged.similarityScore ?? 0, incoming.similarityScore);
  }

  merged.sources = unique([...(merged.sources ?? [merged.source]), ...(incoming.sources ?? [incoming.source])]);
  merged.sourceLinks = mergeSourceLinks(merged.sourceLinks, incoming.sourceLinks);

  return merged;
}

function mergeSourceLinks(a: SourceLink[] | undefined, b: SourceLink[] | undefined): SourceLink[] {
  const out: SourceLink[] = [];
  const seen = new Set<string>();
  for (const link of [...(a ?? []), ...(b ?? [])]) {
    const key = `${link.source}|${link.pdfUrl ?? ""}|${link.landingPageUrl ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(link);
  }
  return out;
}

function mergeStringLists(
  a: string[] | undefined,
  b: string[] | undefined,
  limit: number,
): string[] | undefined {
  if (!a && !b) return undefined;
  const merged = unique([...(a ?? []), ...(b ?? [])]).slice(0, limit);
  return merged.length > 0 ? merged : undefined;
}

function unique(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}
