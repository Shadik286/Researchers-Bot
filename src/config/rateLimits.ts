import type { AppConfig } from "./env.js";

/**
 * Per-source traffic policy.
 *
 * These numbers are deliberately at or BELOW each provider's published limit.
 * They exist to keep us a well-behaved API client - never to probe how fast a
 * provider can be pushed, and never to work around a limit we have hit.
 */
export interface RateLimitConfig {
  requestsPerSecond: number;
  requestsPerMinute?: number;
  maxConcurrency: number;
  maxRetries: number;
}

export interface RetryConfig {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitter: boolean;
}

export interface CircuitBreakerConfig {
  failureThreshold: number;
  cooldownMs: number;
  halfOpenSuccesses: number;
}

export interface SourceTrafficPolicy {
  rateLimit: RateLimitConfig;
  retry: RetryConfig;
  circuit: CircuitBreakerConfig;
  timeoutMs: number;
}

/**
 * Documented provider limits (checked against public docs):
 *
 *  doaj             2 req/s is the documented soft cap for the public API.
 *  pubmed (NCBI)    3 req/s without an API key, 10 req/s with one.
 *  core             ~10 req/min on the free tier -> we stay well under.
 *  arxiv            "no more than one request every three seconds".
 *  semanticScholar  1 req/s on the shared unauthenticated pool.
 *  crossref         50 req/s on the polite pool; we stay far below.
 *  openalex         10 req/s / 100k per day on the polite pool. Note the free
 *                   tier also has a DAILY credit quota; when it is exhausted
 *                   OpenAlex answers 429 with Retry-After set to the next
 *                   reset (~12h), which the limiter reports rather than
 *                   blocking on.
 *  europepmc        no published number; considerate use requested.
 *  datacite         no published number; considerate use requested.
 */
const BASE_LIMITS: Record<string, RateLimitConfig> = {
  doaj: { requestsPerSecond: 2, maxConcurrency: 2, maxRetries: 2 },
  pubmed: { requestsPerSecond: 3, maxConcurrency: 1, maxRetries: 2 },
  core: { requestsPerSecond: 1, requestsPerMinute: 10, maxConcurrency: 1, maxRetries: 2 },
  arxiv: { requestsPerSecond: 1 / 3, maxConcurrency: 1, maxRetries: 2 },
  semanticScholar: { requestsPerSecond: 1, maxConcurrency: 1, maxRetries: 3 },
  crossref: { requestsPerSecond: 5, maxConcurrency: 2, maxRetries: 2 },
  openalex: { requestsPerSecond: 5, maxConcurrency: 2, maxRetries: 2 },
  // Neither publishes a hard numeric limit; both ask for considerate use.
  europepmc: { requestsPerSecond: 2, maxConcurrency: 1, maxRetries: 2 },
  datacite: { requestsPerSecond: 2, maxConcurrency: 1, maxRetries: 2 },
};

/** Bonus limits unlocked by a configured API key (per provider documentation). */
const KEYED_LIMITS: Record<string, RateLimitConfig> = {
  pubmed: { requestsPerSecond: 10, maxConcurrency: 3, maxRetries: 2 },
  semanticScholar: { requestsPerSecond: 1, maxConcurrency: 2, maxRetries: 3 },
  core: { requestsPerSecond: 1, requestsPerMinute: 60, maxConcurrency: 2, maxRetries: 2 },
};

export function trafficPolicyFor(sourceKey: string, config: AppConfig): SourceTrafficPolicy {
  const hasKey = sourceHasKey(sourceKey, config);
  const base =
    (hasKey ? KEYED_LIMITS[sourceKey] : undefined) ??
    BASE_LIMITS[sourceKey] ?? {
      requestsPerSecond: config.defaults.requestsPerSecond,
      maxConcurrency: config.defaults.maxConcurrency,
      maxRetries: config.defaults.maxRetries,
    };

  return {
    rateLimit: {
      requestsPerSecond: base.requestsPerSecond,
      requestsPerMinute: base.requestsPerMinute,
      maxConcurrency: base.maxConcurrency,
      maxRetries: base.maxRetries,
    },
    retry: {
      maxRetries: base.maxRetries,
      baseDelayMs: config.retry.baseDelayMs,
      maxDelayMs: config.retry.maxDelayMs,
      jitter: config.retry.jitter,
    },
    circuit: { ...config.circuit },
    timeoutMs: config.requestTimeoutMs,
  };
}

function sourceHasKey(sourceKey: string, config: AppConfig): boolean {
  switch (sourceKey) {
    case "pubmed":
      return Boolean(config.apiKeys.ncbi);
    case "core":
      return Boolean(config.apiKeys.core);
    case "semanticScholar":
      return Boolean(config.apiKeys.semanticScholar);
    case "doaj":
      return Boolean(config.apiKeys.doaj);
    case "crossref":
      return Boolean(config.apiKeys.crossref);
    case "openalex":
      return Boolean(config.apiKeys.openalex);
    default:
      return false;
  }
}
