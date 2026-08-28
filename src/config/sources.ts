import type { Cache } from "../cache/Cache.js";
import { HttpClient } from "../http/HttpClient.js";
import type { Logger } from "../logging/Logger.js";
import { registerSecret } from "../logging/Logger.js";
import type { AcademicSource } from "../models/Source.js";
import { CircuitBreaker, CircuitBreakerRegistry } from "../rateLimit/CircuitBreaker.js";
import { RateLimiter, RateLimiterRegistry } from "../rateLimit/RateLimiter.js";
import { RetryPolicy } from "../rateLimit/RetryPolicy.js";
import { UrlPolicy } from "../security/UrlPolicy.js";
import type { SourceDependencies } from "../sources/BaseSource.js";
import { ArxivSource } from "../sources/arxiv/ArxivSource.js";
import { CoreSource } from "../sources/core/CoreSource.js";
import { CrossrefSource } from "../sources/crossref/CrossrefSource.js";
import { DataCiteSource } from "../sources/datacite/DataCiteSource.js";
import { EuropePmcSource } from "../sources/europepmc/EuropePmcSource.js";
import { DoajSource } from "../sources/doaj/DoajSource.js";
import { OpenAlexSource } from "../sources/openalex/OpenAlexSource.js";
import { PubMedSource } from "../sources/pubmed/PubMedSource.js";
import { SemanticScholarSource } from "../sources/semanticScholar/SemanticScholarSource.js";
import type { AppConfig } from "./env.js";
import { trafficPolicyFor } from "./rateLimits.js";

/**
 * Composition root for sources.
 *
 * Adding a new academic source is a three-line change here plus one adapter
 * file - nothing in the orchestrator, the match engine or the HTTP layer needs
 * to know it exists.
 */

export type SourceFactory = (deps: SourceDependencies) => AcademicSource;

/** Machine key -> adapter constructor. The key is what SOURCE_PRIORITY uses. */
export const SOURCE_FACTORIES: Record<string, SourceFactory> = {
  doaj: (deps) => new DoajSource(deps),
  pubmed: (deps) => new PubMedSource(deps),
  core: (deps) => new CoreSource(deps),
  arxiv: (deps) => new ArxivSource(deps),
  semanticScholar: (deps) => new SemanticScholarSource(deps),
  crossref: (deps) => new CrossrefSource(deps),
  openalex: (deps) => new OpenAlexSource(deps),
  europepmc: (deps) => new EuropePmcSource(deps),
  datacite: (deps) => new DataCiteSource(deps),
};

/** Per-source auth headers. Values come from env and are never logged. */
function authHeadersFor(key: string, config: AppConfig): Record<string, string> {
  switch (key) {
    case "core":
      return config.apiKeys.core ? { authorization: `Bearer ${config.apiKeys.core}` } : {};
    case "semanticScholar":
      return SemanticScholarSource.headersFor(config.apiKeys.semanticScholar);
    case "crossref":
      return CrossrefSource.headersFor(config.apiKeys.crossref);
    case "doaj":
      return config.apiKeys.doaj ? { "api-key": config.apiKeys.doaj } : {};
    default:
      // pubmed and openalex pass their key as a request parameter instead.
      return {};
  }
}

export interface SourceRegistryOptions {
  config: AppConfig;
  cache: Cache;
  logger: Logger;
  /** Injected in tests to serve canned responses. */
  fetchImpl?: typeof fetch;
  /** Extra hosts the URL policy should permit (test servers only). */
  extraAllowedHosts?: readonly string[];
}

/**
 * Holds one adapter per configured source, each with its own rate limiter,
 * circuit breaker and HTTP client.
 */
export class SourceRegistry {
  readonly rateLimiters: RateLimiterRegistry;
  readonly circuitBreakers: CircuitBreakerRegistry;

  private readonly sources = new Map<string, AcademicSource>();
  private readonly config: AppConfig;

  constructor(options: SourceRegistryOptions) {
    const { config, cache, logger, fetchImpl, extraAllowedHosts } = options;
    this.config = config;

    // Register every configured secret so the logger scrubs it on sight.
    for (const secret of Object.values(config.apiKeys)) registerSecret(secret);

    const urlPolicy = new UrlPolicy({
      extraAllowedHosts,
      // Only relaxed when a test injects a local mock host.
      allowInsecure: (extraAllowedHosts?.length ?? 0) > 0,
    });

    this.rateLimiters = new RateLimiterRegistry((key) => {
      const policy = trafficPolicyFor(key, config);
      return new RateLimiter({ name: key, ...policy.rateLimit });
    });

    this.circuitBreakers = new CircuitBreakerRegistry((key) => {
      const policy = trafficPolicyFor(key, config);
      return new CircuitBreaker({ name: key, ...policy.circuit });
    });

    const allKeys = new Set<string>([
      ...config.sourcePriority,
      ...config.fallbackSourcePriority,
      ...config.extendedSourcePriority,
      ...config.similarSourcePriority,
    ]);

    for (const key of allKeys) {
      const factory = SOURCE_FACTORIES[key];
      if (!factory) {
        logger.warn("unknown_source_key_ignored", { key });
        continue;
      }
      const policy = trafficPolicyFor(key, config);
      const httpClient = new HttpClient({
        source: key,
        rateLimiter: this.rateLimiters.get(key),
        circuitBreaker: this.circuitBreakers.get(key),
        retryPolicy: new RetryPolicy(policy.retry),
        urlPolicy,
        logger,
        userAgent: config.userAgent,
        defaultTimeoutMs: policy.timeoutMs,
        defaultHeaders: authHeadersFor(key, config),
        fetchImpl,
      });

      const source = factory({ httpClient, cache, config, logger });
      this.sources.set(key, source);

      logger.debug("source_registered", {
        key,
        name: source.name,
        available: source.isAvailable(),
        requestsPerSecond: policy.rateLimit.requestsPerSecond,
        maxConcurrency: policy.rateLimit.maxConcurrency,
      });
    }
  }

  get(key: string): AcademicSource | undefined {
    return this.sources.get(key);
  }

  /** Sources for the primary (PHASE 3) pass, in configured order. */
  primarySources(): AcademicSource[] {
    return this.resolve(this.config.sourcePriority).slice(0, this.config.budget.maxPrimarySources);
  }

  /** Sources for the fallback (PHASE 6) pass, in configured order. */
  fallbackSources(): AcademicSource[] {
    return this.resolve(this.config.fallbackSourcePriority).slice(0, this.config.budget.maxFallbackSources);
  }

  /**
   * Last-resort sources (PHASE 6b), tried only when the primaries AND the
   * fallbacks all came up empty.
   */
  extendedSources(): AcademicSource[] {
    return this.resolve(this.config.extendedSourcePriority).slice(0, this.config.budget.maxExtendedSources);
  }

  /** Sources used to build the similar-paper candidate pool (PHASE 8). */
  similarSources(): AcademicSource[] {
    return this.resolve(this.config.similarSourcePriority);
  }

  all(): AcademicSource[] {
    return [...this.sources.values()];
  }

  keys(): string[] {
    return [...this.sources.keys()];
  }

  /** Test/maintenance seam: register a source not built from configuration. */
  register(key: string, source: AcademicSource): void {
    this.sources.set(key, source);
  }

  private resolve(keys: readonly string[]): AcademicSource[] {
    const out: AcademicSource[] = [];
    for (const key of keys) {
      const source = this.sources.get(key);
      if (source) out.push(source);
    }
    return out;
  }
}
