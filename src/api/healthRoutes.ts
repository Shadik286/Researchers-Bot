import { redactedConfigSnapshot } from "../config/env.js";
import type { RequestContext, Router } from "./routes.js";
import { sendJson } from "./routes.js";

/**
 * Operational endpoints.
 *
 *   GET /health              liveness
 *   GET /api/sources/status  per-source availability, circuit + limiter state
 *
 * Neither endpoint exposes a credential: only whether one is configured.
 */

export function registerHealthRoutes(router: Router): void {
  router.get("/health", handleHealth);
  router.get("/api/sources/status", handleSourceStatus);
}

function handleHealth(ctx: RequestContext): void {
  sendJson(
    ctx.res,
    200,
    {
      status: "ok",
      service: "academic-paper-search",
      version: "1.0.0",
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.round((Date.now() - ctx.deps.startedAt) / 1000),
    },
    ctx.requestId,
  );
}

function handleSourceStatus(ctx: RequestContext): void {
  const { registry, config, cache } = ctx.deps;

  const breakers = new Map(registry.circuitBreakers.all().map((b) => [b.name, b.snapshot()]));
  const limiters = new Map(registry.rateLimiters.all().map((l) => [l.name, l.stats()]));

  const sources = registry.keys().map((key) => {
    const source = registry.get(key)!;
    const breaker = breakers.get(key);
    const limiter = limiters.get(key);

    const available = source.isAvailable();
    const circuitState = breaker?.state ?? "CLOSED";

    return {
      key,
      name: source.name,
      role: roleOf(key, config),
      available,
      reason: available ? undefined : source.unavailableReason?.(),
      requiresApiKey: !available,
      circuit: {
        state: circuitState,
        consecutiveFailures: breaker?.consecutiveFailures ?? 0,
        cooldownRemainingMs: breaker?.cooldownRemainingMs ?? 0,
        totalTrips: breaker?.totalTrips ?? 0,
      },
      rateLimit: limiter
        ? {
            requestsPerSecond: limiter.requestsPerSecond,
            maxConcurrency: limiter.maxConcurrency,
            queued: limiter.queued,
            inFlight: limiter.inFlight,
            cooldownRemainingMs: limiter.cooldownUntil ? Math.max(0, limiter.cooldownUntil - Date.now()) : 0,
            totalRequests: limiter.totalAcquired,
          }
        : undefined,
      capabilities: {
        search: true,
        getByDOI: typeof source.getByDOI === "function",
        getById: typeof source.getById === "function",
        getFullText: typeof source.getFullText === "function",
        getRelated: typeof source.getRelated === "function",
      },
    };
  });

  sendJson(
    ctx.res,
    200,
    {
      success: true,
      timestamp: new Date().toISOString(),
      sources,
      cache: cache.stats(),
      configuration: redactedConfigSnapshot(config),
    },
    ctx.requestId,
  );
}

function roleOf(key: string, config: RequestContext["deps"]["config"]): string[] {
  const roles: string[] = [];
  if (config.sourcePriority.includes(key)) roles.push("primary");
  if (config.fallbackSourcePriority.includes(key)) roles.push("fallback");
  if (config.extendedSourcePriority.includes(key)) roles.push("extended");
  if (config.similarSourcePriority.includes(key)) roles.push("similar");
  return roles;
}
