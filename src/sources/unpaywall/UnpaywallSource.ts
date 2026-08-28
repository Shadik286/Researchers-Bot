import type { FullTextResult } from "../../models/FullText.js";
import type { PaperResult } from "../../models/Paper.js";
import type { PaperSearchQuery } from "../../models/Search.js";
import { normalizeDoi } from "../../utils/normalizeDoi.js";
import { BaseSource, cleanUrl, type SourceDependencies } from "../BaseSource.js";

/**
 * Unpaywall - open-access location service (FULL-TEXT RESOLVER ONLY)
 * ==================================================================
 *
 * Not a search index: it answers one question, "is there a legal free copy of
 * this DOI, and where?". It is the canonical answer to that question, built
 * from publisher feeds and repository harvesting, and is what powers the OA
 * indicators in Web of Science, Scopus and OpenAlex.
 *
 * API endpoint
 *   GET https://api.unpaywall.org/v2/{doi}?email=<contact>
 *
 * Authentication
 *   No key. It requires a REAL contact email for identification, exactly like
 *   the Crossref/OpenAlex polite pools. Placeholder addresses are rejected
 *   with `{"error": true}`, so this adapter reports itself unavailable unless
 *   CONTACT_EMAIL is set to a genuine address.
 *
 * Rate limits
 *   100,000 calls/day. Configured conservatively at 5 req/s.
 *
 * Response mapping
 *   is_oa, oa_status, best_oa_location{url_for_pdf, url_for_landing_page,
 *   host_type, license, version}, oa_locations[].
 *
 * Access policy
 *   Unpaywall only ever reports copies the publisher or a repository has made
 *   publicly available - that is the entire premise of the service. A closed
 *   paper returns `is_oa: false` and we fall back to the landing page. Nothing
 *   here circumvents anything.
 */

const BASE_URL = "https://api.unpaywall.org/v2";

/** Addresses Unpaywall rejects, and which we must not send. */
const PLACEHOLDER_EMAIL = /@(example|test|localhost|invalid|sample)\.|^(you|your|me|test|qa|noreply)@/i;

interface UnpaywallLocation {
  url?: string | null;
  url_for_pdf?: string | null;
  url_for_landing_page?: string | null;
  host_type?: string | null;
  version?: string | null;
  license?: string | null;
  is_best?: boolean;
}

interface UnpaywallResponse {
  doi?: string;
  is_oa?: boolean;
  oa_status?: string;
  title?: string;
  best_oa_location?: UnpaywallLocation | null;
  oa_locations?: UnpaywallLocation[];
  error?: boolean;
  message?: string;
}

export class UnpaywallSource extends BaseSource {
  readonly name = "Unpaywall";
  readonly key = "unpaywall";

  private readonly email: string | undefined;

  constructor(deps: SourceDependencies) {
    super(deps);
    const contact = deps.config.contactEmail?.trim();
    this.email = contact && !PLACEHOLDER_EMAIL.test(contact) ? contact : undefined;
  }

  override isAvailable(): boolean {
    return Boolean(this.email);
  }

  override unavailableReason(): string | undefined {
    return this.isAvailable()
      ? undefined
      : "CONTACT_EMAIL must be a real address for Unpaywall (it rejects placeholders)";
  }

  /** Unpaywall is a DOI resolver, not a search index. */
  async search(_query: PaperSearchQuery): Promise<PaperResult[]> {
    return [];
  }

  override async getFullText(paper: PaperResult, signal?: AbortSignal): Promise<FullTextResult | null> {
    const doi = normalizeDoi(paper.doi);
    if (!doi || !this.email) return null;

    return this.withCache("fulltext", [doi], async () =>
      this.notFoundAsNull(async () => {
        const { data } = await this.http.getJson<UnpaywallResponse>(
          `${BASE_URL}/${encodeURIComponent(doi)}`,
          { query: { email: this.email }, signal, operation: "oa-lookup" },
        );

        if (data.error || data.is_oa !== true) return null;

        // Prefer the flagged best location, then any location with a real PDF.
        const candidates = [data.best_oa_location, ...(data.oa_locations ?? [])].filter(
          (l): l is UnpaywallLocation => Boolean(l),
        );

        const pdfLocation = candidates.find((l) => cleanUrl(l.url_for_pdf));
        if (pdfLocation) {
          return {
            available: true,
            url: cleanUrl(pdfLocation.url_for_pdf)!,
            type: "pdf" as const,
            accessType: pdfLocation.host_type === "repository" ? ("repository" as const) : ("open-access" as const),
            source: this.name,
            license: pdfLocation.license ?? undefined,
          };
        }

        // Open access, but only an HTML full text is published.
        const htmlLocation = candidates.find((l) => cleanUrl(l.url_for_landing_page) ?? cleanUrl(l.url));
        if (htmlLocation) {
          return {
            available: true,
            url: (cleanUrl(htmlLocation.url_for_landing_page) ?? cleanUrl(htmlLocation.url))!,
            type: "html" as const,
            accessType: htmlLocation.host_type === "repository" ? ("repository" as const) : ("open-access" as const),
            source: this.name,
            license: htmlLocation.license ?? undefined,
          };
        }

        return null;
      }),
    );
  }
}
