/**
 * Legal full-text access description.
 *
 * The service only ever surfaces links that the publisher, repository or
 * aggregator itself advertises as publicly reachable. Paywalled content
 * resolves to `accessType: "landing-page"` - the paywall is never circumvented.
 */
export interface FullTextResult {
  available: boolean;
  url?: string;
  type?: "pdf" | "html";
  accessType:
    | "open-access"
    | "publisher"
    | "repository"
    | "landing-page"
    | "unavailable";
  /** Which adapter supplied the link. */
  source?: string;
  /** Licence string when the source publishes one (e.g. "cc-by"). */
  license?: string;
}

export const UNAVAILABLE_FULL_TEXT: FullTextResult = Object.freeze({
  available: false,
  accessType: "unavailable",
});
