import { isIP } from "node:net";

/**
 * Outbound URL policy - the SSRF guard.
 *
 * The service only ever talks to a fixed, code-defined allowlist of scholarly
 * API hosts. A user cannot influence WHICH host is contacted: search input only
 * ever becomes a query-string value on an allowlisted endpoint.
 *
 * Also blocks, defensively:
 *   - any scheme other than https (plus http for arXiv's export host, which
 *     the arXiv adapter upgrades to https anyway)
 *   - credentials embedded in the URL (user:pass@host)
 *   - loopback, link-local, private, CGNAT, multicast and reserved IP literals
 *   - cloud instance-metadata addresses (169.254.169.254, fd00:ec2::254, ...)
 *   - non-standard ports
 */

export class BlockedUrlError extends Error {
  readonly url: string;
  readonly reason: string;

  constructor(url: string, reason: string) {
    super(`Refusing to fetch "${url}": ${reason}`);
    this.name = "BlockedUrlError";
    this.url = url;
    this.reason = reason;
  }
}

/** Hosts the service is allowed to call, grouped by the adapter that uses them. */
export const ALLOWED_API_HOSTS: ReadonlySet<string> = new Set([
  // DOAJ
  "doaj.org",
  "www.doaj.org",
  // NCBI / PubMed / PMC
  "eutils.ncbi.nlm.nih.gov",
  "www.ncbi.nlm.nih.gov",
  "pmc.ncbi.nlm.nih.gov",
  // CORE
  "api.core.ac.uk",
  "core.ac.uk",
  // arXiv
  "export.arxiv.org",
  "arxiv.org",
  // Semantic Scholar
  "api.semanticscholar.org",
  "www.semanticscholar.org",
  // Crossref
  "api.crossref.org",
  // OpenAlex
  "api.openalex.org",
  // Europe PMC (extended fallback)
  "www.ebi.ac.uk",
  "europepmc.org",
  // DataCite (extended fallback)
  "api.datacite.org",
  // Unpaywall (open-access location resolver)
  "api.unpaywall.org",
  // DOI resolver (used only to build canonical landing pages, never fetched
  // for content)
  "doi.org",
  "dx.doi.org",
]);

const ALLOWED_PORTS = new Set(["", "443", "80"]);

const METADATA_HOSTS = new Set([
  "169.254.169.254",
  "metadata.google.internal",
  "metadata.goog",
  "instance-data",
  "100.100.100.200",
]);

export interface UrlPolicyOptions {
  /**
   * Hosts trusted EXPLICITLY by the code that constructs the policy - in
   * practice only a local mock/test origin. There is no environment variable
   * for this: it cannot be set by configuration, let alone by a user.
   *
   * An explicitly trusted host also bypasses the loopback/private-address and
   * standard-port checks, since naming a host like `127.0.0.1` is the whole
   * point of the seam. Cloud metadata endpoints are NEVER bypassed.
   */
  extraAllowedHosts?: readonly string[];
  /** Allow http:// as well as https://. Default false. */
  allowInsecure?: boolean;
}

export class UrlPolicy {
  private readonly allowed: Set<string>;
  private readonly explicitlyTrusted: Set<string>;
  private readonly allowInsecure: boolean;

  constructor(options: UrlPolicyOptions = {}) {
    this.allowed = new Set(ALLOWED_API_HOSTS);
    this.explicitlyTrusted = new Set();
    for (const host of options.extraAllowedHosts ?? []) {
      const normalized = host.toLowerCase();
      this.allowed.add(normalized);
      this.explicitlyTrusted.add(normalized);
    }
    this.allowInsecure = options.allowInsecure ?? false;
  }

  /** Throws `BlockedUrlError` unless the URL is a permitted API endpoint. */
  assertAllowed(rawUrl: string): URL {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new BlockedUrlError(rawUrl, "not a valid absolute URL");
    }

    if (url.protocol !== "https:" && !(this.allowInsecure && url.protocol === "http:")) {
      throw new BlockedUrlError(rawUrl, `scheme "${url.protocol}" is not permitted`);
    }
    if (url.username || url.password) {
      throw new BlockedUrlError(rawUrl, "embedded credentials are not permitted");
    }

    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    const trusted = this.explicitlyTrusted.has(host);

    // Never bypassable, for any host.
    if (METADATA_HOSTS.has(host)) {
      throw new BlockedUrlError(rawUrl, "instance metadata endpoints are not permitted");
    }
    if (!ALLOWED_PORTS.has(url.port) && !trusted) {
      throw new BlockedUrlError(rawUrl, `port "${url.port}" is not permitted`);
    }
    if (isDisallowedAddress(host) && !trusted) {
      throw new BlockedUrlError(rawUrl, "private, loopback or reserved address");
    }
    if (!this.allowed.has(host)) {
      throw new BlockedUrlError(rawUrl, "host is not on the academic API allowlist");
    }

    return url;
  }

  isAllowed(rawUrl: string): boolean {
    try {
      this.assertAllowed(rawUrl);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Validates a link RETURNED BY a source before it is echoed to the client.
 *
 * This is a different (looser) check than `UrlPolicy`: publishers and
 * repositories live on thousands of hosts, so the host is not allowlisted.
 * What is enforced is that the link is a plain https/http web URL that does not
 * point into our own network - so a compromised or buggy upstream cannot turn a
 * response into an internal-network pointer, and never a `file:`/`javascript:`
 * or credential-bearing URL.
 *
 * Nothing at this URL is fetched by the backend; it is handed to the client.
 */
export function sanitizeExternalLink(rawUrl: string | undefined | null): string | undefined {
  if (typeof rawUrl !== "string") return undefined;
  const trimmed = rawUrl.trim();
  if (!trimmed) return undefined;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return undefined;
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  if (url.username || url.password) return undefined;

  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host) return undefined;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return undefined;
  if (METADATA_HOSTS.has(host)) return undefined;
  if (isDisallowedAddress(host)) return undefined;

  return url.toString();
}

/** True for loopback / private / link-local / reserved IP literals. */
export function isDisallowedAddress(host: string): boolean {
  if (host === "localhost") return true;

  const bracketless = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  const version = isIP(bracketless);

  if (version === 4) return isPrivateIPv4(bracketless);
  if (version === 6) return isPrivateIPv6(bracketless);

  // Not an IP literal: only obvious internal names are blocked here; the
  // allowlist does the real work for outbound API calls.
  return host.endsWith(".internal") || host.endsWith(".localhost");
}

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return true;
  const [a, b] = parts as [number, number, number, number];
  if (a === 0) return true; // "this" network
  if (a === 10) return true; // private
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local (incl. metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 192 && b === 0) return true; // IETF protocol assignments
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true; // multicast + reserved + broadcast
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::" || lower === "::1") return true;
  if (lower.startsWith("fe80")) return true; // link-local
  if (/^f[cd]/.test(lower)) return true; // unique local
  if (lower.startsWith("ff")) return true; // multicast
  // IPv4-mapped (::ffff:127.0.0.1) inherits the IPv4 rules.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped) return isPrivateIPv4(mapped[1]!);
  return false;
}
