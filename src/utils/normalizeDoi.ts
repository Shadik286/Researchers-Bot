/**
 * DOI normalization.
 *
 * Accepted inputs are converted to the canonical bare, lowercase DOI:
 *
 *   10.1234/example
 *   doi:10.1234/example
 *   DOI: 10.1234/EXAMPLE
 *   https://doi.org/10.1234/example
 *   http://dx.doi.org/10.1234/example
 *   info:doi/10.1234/example
 *   urn:doi:10.1234/example
 *
 * DOIs are case-insensitive by specification, so the canonical form is
 * lowercased. Trailing punctuation picked up from prose ("...example.") is
 * stripped, but characters that are legally part of a DOI suffix are kept.
 */

/** Structural DOI test: a "10." prefix, a registrant, a "/", then a suffix. */
const DOI_PATTERN = /^10\.\d{4,9}\/[-._;()/:a-z0-9<>+\[\]]+$/i;

const RESOLVER_PREFIXES = [
  "https://doi.org/",
  "http://doi.org/",
  "https://dx.doi.org/",
  "http://dx.doi.org/",
  "https://www.doi.org/",
  "http://www.doi.org/",
  "doi.org/",
  "dx.doi.org/",
];

export function normalizeDoi(input: string | undefined | null): string | undefined {
  if (typeof input !== "string") return undefined;

  let value = input.trim();
  if (!value) return undefined;

  // Strip common wrappers before anything else: <10.x/y>, (10.x/y), "10.x/y".
  value = value
    .replace(/^[<([{"']+/, "")
    .replace(/>+$/, "")
    .trim();

  const lower = value.toLowerCase();

  for (const prefix of RESOLVER_PREFIXES) {
    if (lower.startsWith(prefix)) {
      value = value.slice(prefix.length);
      break;
    }
  }

  // Scheme-style prefixes: doi:, DOI :, info:doi/, urn:doi:
  value = value
    .replace(/^info:doi\//i, "")
    .replace(/^urn:doi:/i, "")
    .replace(/^doi\s*:\s*/i, "")
    .trim();

  // Percent-decode once - resolver URLs sometimes escape the suffix.
  if (value.includes("%")) {
    try {
      value = decodeURIComponent(value);
    } catch {
      /* keep the raw value if it is not valid percent-encoding */
    }
  }

  // Drop a query string / fragment that a resolver URL may carry.
  const cut = value.search(/[?#]/);
  if (cut !== -1) value = value.slice(0, cut);

  // Trailing sentence punctuation is never meaningful at the end of a DOI.
  value = value.replace(/[.,;:)\]}"']+$/g, "").trim();

  if (!value) return undefined;

  const canonical = value.toLowerCase();
  return DOI_PATTERN.test(canonical) ? canonical : undefined;
}

/** `true` when the string can be parsed as a syntactically valid DOI. */
export function isValidDoi(input: string | undefined | null): boolean {
  return normalizeDoi(input) !== undefined;
}

/** Compares two DOIs in canonical form. */
export function doiEquals(a: string | undefined, b: string | undefined): boolean {
  const na = normalizeDoi(a);
  const nb = normalizeDoi(b);
  return na !== undefined && nb !== undefined && na === nb;
}

/** Official resolver URL - the only DOI URL this service ever emits. */
export function doiToUrl(doi: string): string | undefined {
  const normalized = normalizeDoi(doi);
  return normalized ? `https://doi.org/${normalized}` : undefined;
}

/** Extracts the first DOI embedded in a longer string (e.g. a citation line). */
export function extractDoi(text: string | undefined | null): string | undefined {
  if (typeof text !== "string") return undefined;
  const match = /10\.\d{4,9}\/[-._;()/:a-z0-9<>+\[\]]+/i.exec(text);
  return match ? normalizeDoi(match[0]) : undefined;
}
