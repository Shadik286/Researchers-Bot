/**
 * Environment loading + validation.
 *
 * - Fails fast on structurally invalid configuration.
 * - Secrets are read here and NEVER re-exported through logs or API responses.
 *   `redactedConfigSnapshot()` is the only thing allowed near an HTTP response.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** Minimal .env loader (no dependency). Existing process.env always wins. */
export function loadDotEnv(file = ".env"): void {
  let text: string;
  try {
    text = readFileSync(resolve(process.cwd(), file), "utf8");
  } catch {
    return; // no .env file is fine - the service runs on public APIs
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    const quoted =
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"));
    if (quoted && value.length >= 2) value = value.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

type Env = NodeJS.ProcessEnv;

function str(env: Env, key: string, fallback: string): string {
  const v = env[key];
  return v === undefined || v.trim() === "" ? fallback : v.trim();
}

function optionalStr(env: Env, key: string): string | undefined {
  const v = env[key];
  return v === undefined || v.trim() === "" ? undefined : v.trim();
}

function num(env: Env, key: string, fallback: number, min: number, max: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new ConfigError(`${key} must be a number, received "${raw}"`);
  }
  if (parsed < min || parsed > max) {
    throw new ConfigError(`${key} must be between ${min} and ${max}, received ${parsed}`);
  }
  return parsed;
}

function bool(env: Env, key: string, fallback: boolean): boolean {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  const v = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  throw new ConfigError(`${key} must be a boolean, received "${raw}"`);
}

function list(env: Env, key: string, fallback: string[]): string[] {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Parses "100kb" / "1mb" / "2048" into bytes. */
export function parseByteSize(input: string, key = "MAX_BODY_SIZE"): number {
  const m = /^(\d+(?:\.\d+)?)\s*(b|kb|mb)?$/i.exec(input.trim());
  if (!m) throw new ConfigError(`${key} must look like "100kb", received "${input}"`);
  const value = Number(m[1]);
  const unit = (m[2] ?? "b").toLowerCase();
  const mult = unit === "mb" ? 1024 * 1024 : unit === "kb" ? 1024 : 1;
  const bytes = Math.floor(value * mult);
  if (bytes <= 0 || bytes > 10 * 1024 * 1024) {
    throw new ConfigError(`${key} must be > 0 and <= 10mb, received "${input}"`);
  }
  return bytes;
}

export interface AppConfig {
  nodeEnv: "development" | "production" | "test";
  isProduction: boolean;
  port: number;
  host: string;
  logLevel: "debug" | "info" | "warn" | "error";

  userAgent: string;
  contactEmail: string;

  apiKeys: {
    doaj?: string;
    ncbi?: string;
    core?: string;
    semanticScholar?: string;
    crossref?: string;
    openalex?: string;
  };
  mailto: {
    crossref?: string;
    openalex?: string;
  };

  defaults: {
    requestsPerSecond: number;
    maxConcurrency: number;
    maxRetries: number;
  };
  retry: {
    baseDelayMs: number;
    maxDelayMs: number;
    jitter: boolean;
  };
  requestTimeoutMs: number;

  circuit: {
    failureThreshold: number;
    cooldownMs: number;
    halfOpenSuccesses: number;
  };

  cache: {
    ttlSeconds: number;
    maxEntries: number;
  };

  budget: {
    maxPrimarySources: number;
    maxFallbackSources: number;
    maxExtendedSources: number;
    maxResultsPerSource: number;
    maxSimilarPapers: number;
    minSimilarPapers: number;
    maxSimilarCandidates: number;
    searchDeadlineMs: number;
  };

  matching: {
    exactThreshold: number;
    nearExactThreshold: number;
    titleExactThreshold: number;
  };

  /** Max score nudge applied to very recent papers (0 disables it). */
  recencyBoost: number;

  similarityWeights: {
    title: number;
    abstract: number;
    keywords: number;
    topics: number;
  };

  sourcePriority: string[];
  fallbackSourcePriority: string[];
  extendedSourcePriority: string[];
  similarSourcePriority: string[];

  server: {
    maxBodyBytes: number;
    requestTimeoutMs: number;
  };
  cors: {
    origins: string[];
    allowCredentials: boolean;
  };
}

export function buildConfig(env: Env = process.env): AppConfig {
  const nodeEnvRaw = str(env, "NODE_ENV", "development");
  if (!["development", "production", "test"].includes(nodeEnvRaw)) {
    throw new ConfigError(
      `NODE_ENV must be development|production|test, received "${nodeEnvRaw}"`,
    );
  }
  const nodeEnv = nodeEnvRaw as AppConfig["nodeEnv"];

  const logLevelRaw = str(env, "LOG_LEVEL", nodeEnv === "test" ? "error" : "info");
  if (!["debug", "info", "warn", "error"].includes(logLevelRaw)) {
    throw new ConfigError(`LOG_LEVEL must be debug|info|warn|error, received "${logLevelRaw}"`);
  }

  const contactEmail = str(env, "CONTACT_EMAIL", "contact@example.com");

  const weights = {
    title: num(env, "SIM_WEIGHT_TITLE", 0.4, 0, 1),
    abstract: num(env, "SIM_WEIGHT_ABSTRACT", 0.3, 0, 1),
    keywords: num(env, "SIM_WEIGHT_KEYWORDS", 0.2, 0, 1),
    topics: num(env, "SIM_WEIGHT_TOPICS", 0.1, 0, 1),
  };
  const weightSum = weights.title + weights.abstract + weights.keywords + weights.topics;
  if (Math.abs(weightSum - 1) > 0.001) {
    throw new ConfigError(`SIM_WEIGHT_* must sum to 1.0, received ${weightSum.toFixed(3)}`);
  }

  const minSimilar = num(env, "MIN_SIMILAR_PAPERS", 8, 0, 100);
  const maxSimilar = num(env, "MAX_SIMILAR_PAPERS", 10, 1, 100);
  if (minSimilar > maxSimilar) {
    throw new ConfigError("MIN_SIMILAR_PAPERS must be <= MAX_SIMILAR_PAPERS");
  }

  const corsOrigins = list(env, "CORS_ORIGINS", ["http://localhost:3000"]);
  if (nodeEnv === "production" && corsOrigins.includes("*") && env.CORS_ORIGINS?.trim() !== "*") {
    throw new ConfigError(
      "Wildcard CORS in production must be set explicitly via CORS_ORIGINS=*",
    );
  }

  return {
    nodeEnv,
    isProduction: nodeEnv === "production",
    port: num(env, "PORT", 3000, 0, 65535),
    host: str(env, "HOST", "0.0.0.0"),
    logLevel: logLevelRaw as AppConfig["logLevel"],

    userAgent: `AcademicPaperFinder/1.0 (+${contactEmail})`,
    contactEmail,

    apiKeys: {
      doaj: optionalStr(env, "DOAJ_API_KEY"),
      ncbi: optionalStr(env, "NCBI_API_KEY"),
      core: optionalStr(env, "CORE_API_KEY"),
      semanticScholar: optionalStr(env, "SEMANTIC_SCHOLAR_API_KEY"),
      crossref: optionalStr(env, "CROSSREF_API_KEY"),
      openalex: optionalStr(env, "OPENALEX_API_KEY"),
    },
    mailto: {
      crossref: optionalStr(env, "CROSSREF_MAILTO") ?? optionalStr(env, "CONTACT_EMAIL"),
      openalex: optionalStr(env, "OPENALEX_MAILTO") ?? optionalStr(env, "CONTACT_EMAIL"),
    },

    defaults: {
      requestsPerSecond: num(env, "DEFAULT_REQUESTS_PER_SECOND", 1, 0.01, 100),
      maxConcurrency: num(env, "DEFAULT_MAX_CONCURRENCY", 1, 1, 64),
      maxRetries: num(env, "DEFAULT_MAX_RETRIES", 2, 0, 10),
    },
    retry: {
      baseDelayMs: num(env, "RETRY_BASE_DELAY_MS", 1000, 10, 60_000),
      maxDelayMs: num(env, "RETRY_MAX_DELAY_MS", 30_000, 100, 300_000),
      jitter: bool(env, "RETRY_JITTER", true),
    },
    requestTimeoutMs: num(env, "REQUEST_TIMEOUT_MS", 15_000, 500, 120_000),

    circuit: {
      failureThreshold: num(env, "CIRCUIT_FAILURE_THRESHOLD", 5, 1, 100),
      cooldownMs: num(env, "CIRCUIT_COOLDOWN_MS", 30_000, 100, 600_000),
      halfOpenSuccesses: num(env, "CIRCUIT_HALF_OPEN_SUCCESSES", 2, 1, 20),
    },

    cache: {
      ttlSeconds: num(env, "CACHE_TTL_SECONDS", 3600, 0, 86_400),
      maxEntries: num(env, "CACHE_MAX_ENTRIES", 5000, 10, 1_000_000),
    },

    budget: {
      maxPrimarySources: num(env, "MAX_PRIMARY_SOURCES", 5, 1, 20),
      maxFallbackSources: num(env, "MAX_FALLBACK_SOURCES", 2, 0, 20),
      maxExtendedSources: num(env, "MAX_EXTENDED_SOURCES", 2, 0, 20),
      maxResultsPerSource: num(env, "MAX_RESULTS_PER_SOURCE", 20, 1, 100),
      maxSimilarPapers: maxSimilar,
      minSimilarPapers: minSimilar,
      maxSimilarCandidates: num(env, "MAX_SIMILAR_CANDIDATES", 50, 10, 500),
      searchDeadlineMs: num(env, "SEARCH_DEADLINE_MS", 45_000, 1000, 300_000),
    },

    matching: {
      exactThreshold: num(env, "EXACT_MATCH_THRESHOLD", 0.95, 0.5, 1),
      nearExactThreshold: num(env, "NEAR_EXACT_MATCH_THRESHOLD", 0.85, 0.3, 1),
      titleExactThreshold: num(env, "TITLE_EXACT_THRESHOLD", 0.97, 0.5, 1),
    },

    recencyBoost: num(env, "RECENCY_BOOST", 0.05, 0, 0.5),

    similarityWeights: weights,

    sourcePriority: list(env, "SOURCE_PRIORITY", [
      "doaj",
      "pubmed",
      "core",
      "arxiv",
      "semanticScholar",
    ]),
    fallbackSourcePriority: list(env, "FALLBACK_SOURCE_PRIORITY", ["crossref", "openalex"]),
    extendedSourcePriority: list(env, "EXTENDED_SOURCE_PRIORITY", ["europepmc", "datacite"]),
    // Europe PMC sits between the two big similarity APIs and the slow ones:
    // when Semantic Scholar is throttled and the OpenAlex daily quota is
    // spent, it is what keeps the similar-paper phase producing results.
    similarSourcePriority: list(env, "SIMILAR_SOURCE_PRIORITY", [
      "semanticScholar",
      "openalex",
      "europepmc",
      "arxiv",
      "core",
    ]),

    server: {
      maxBodyBytes: parseByteSize(str(env, "MAX_BODY_SIZE", "100kb")),
      requestTimeoutMs: num(env, "SERVER_REQUEST_TIMEOUT_MS", 60_000, 1000, 600_000),
    },
    cors: {
      origins: corsOrigins,
      allowCredentials: bool(env, "CORS_ALLOW_CREDENTIALS", false),
    },
  };
}

let cached: AppConfig | undefined;

export function getConfig(): AppConfig {
  if (!cached) cached = buildConfig(process.env);
  return cached;
}

/** Test helper - drops the memoized config so a new env can be applied. */
export function resetConfig(): void {
  cached = undefined;
}

/**
 * Safe to log / return: reports only whether a credential is configured,
 * never its value.
 */
export function redactedConfigSnapshot(config: AppConfig): Record<string, unknown> {
  return {
    nodeEnv: config.nodeEnv,
    port: config.port,
    userAgent: config.userAgent,
    // Booleans only - never a value: which sources have a key configured.
    // The field name deliberately avoids every word in the logger's credential
    // pattern (api_key / auth / token / secret / credential / bearer / ...),
    // which would otherwise redact this whole object and hide useful
    // operational information from the startup log.
    keyedSources: Object.fromEntries(
      Object.entries(config.apiKeys).map(([k, v]) => [k, Boolean(v)]),
    ),
    sourcePriority: config.sourcePriority,
    fallbackSourcePriority: config.fallbackSourcePriority,
    extendedSourcePriority: config.extendedSourcePriority,
    similarSourcePriority: config.similarSourcePriority,
    budget: config.budget,
    matching: config.matching,
    cacheTtlSeconds: config.cache.ttlSeconds,
    requestTimeoutMs: config.requestTimeoutMs,
  };
}
