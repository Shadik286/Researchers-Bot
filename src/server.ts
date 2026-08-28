import http, { type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

import { registerHealthRoutes } from "./api/healthRoutes.js";
import { registerPaperRoutes } from "./api/paperRoutes.js";
import { Router, sendError, sendUnexpectedError, type RequestContext, type RouteDependencies } from "./api/routes.js";
import { MemoryCache } from "./cache/MemoryCache.js";
import type { Cache } from "./cache/Cache.js";
import { ConfigError, buildConfig, loadDotEnv, redactedConfigSnapshot, type AppConfig } from "./config/env.js";
import { SourceRegistry } from "./config/sources.js";
import { Logger, registerSecret, setRootLogger } from "./logging/Logger.js";
import { SearchOrchestrator } from "./search/SearchOrchestrator.js";
import { Cors, applySecurityHeaders } from "./security/Cors.js";
import { PayloadTooLargeError } from "./api/readBody.js";
import { ValidationError } from "./security/InputValidator.js";

/**
 * Native `node:http` server. No Express, no framework.
 *
 * Pipeline per request:
 *   security headers -> CORS -> routing -> validation -> orchestrator -> JSON
 *
 * Every request gets an AbortSignal wired to the client connection, so a
 * disconnect propagates all the way down into the rate limiter queues.
 */

export interface CreateAppOptions {
  config?: AppConfig;
  cache?: Cache;
  logger?: Logger;
  /** Injected by tests to serve canned upstream responses. */
  fetchImpl?: typeof fetch;
  extraAllowedHosts?: readonly string[];
}

export interface App {
  server: Server;
  config: AppConfig;
  registry: SourceRegistry;
  orchestrator: SearchOrchestrator;
  cache: Cache;
  logger: Logger;
  close: () => Promise<void>;
}

export function createApp(options: CreateAppOptions = {}): App {
  const config = options.config ?? buildConfig(process.env);
  const logger = options.logger ?? new Logger({ level: config.logLevel, base: { service: "academic-paper-search" } });

  for (const secret of Object.values(config.apiKeys)) registerSecret(secret);

  const cache = options.cache ?? new MemoryCache({
    defaultTtlSeconds: config.cache.ttlSeconds,
    maxEntries: config.cache.maxEntries,
  });

  const registry = new SourceRegistry({
    config,
    cache,
    logger,
    fetchImpl: options.fetchImpl,
    extraAllowedHosts: options.extraAllowedHosts,
  });

  const orchestrator = new SearchOrchestrator({ registry, config, logger });
  const cors = Cors.fromConfig(config);

  const router = new Router();
  registerHealthRoutes(router);
  registerPaperRoutes(router);

  const deps: RouteDependencies = {
    config,
    registry,
    orchestrator,
    cache,
    logger,
    startedAt: Date.now(),
  };

  const server = http.createServer((req, res) => {
    void handleRequest(req, res, { router, cors, deps, config, logger });
  });

  server.requestTimeout = config.server.requestTimeoutMs;
  server.headersTimeout = Math.min(config.server.requestTimeoutMs, 30_000);
  server.keepAliveTimeout = 5_000;
  // Bound the header size a client can force us to buffer.
  server.maxHeadersCount = 100;

  const close = async (): Promise<void> => {
    registry.rateLimiters.drainAll();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeIdleConnections?.();
    });
  };

  return { server, config, registry, orchestrator, cache, logger, close };
}

interface HandlerContext {
  router: Router;
  cors: Cors;
  deps: RouteDependencies;
  config: AppConfig;
  logger: Logger;
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  { router, cors, deps, config, logger }: HandlerContext,
): Promise<void> {
  const requestId = readRequestId(req) ?? randomUUID();
  const startedAt = Date.now();
  const requestLogger = logger.child({ requestId });

  applySecurityHeaders(res);

  // A client disconnect aborts the whole downstream pipeline.
  const controller = new AbortController();
  const onClose = (): void => {
    if (!res.writableEnded) controller.abort();
  };
  req.on("aborted", onClose);
  res.on("close", onClose);

  try {
    if (cors.handlePreflight(req, res)) return;

    if (!cors.apply(req, res)) {
      sendError(res, { status: 403, code: "ORIGIN_NOT_ALLOWED", message: "Origin is not allowed by CORS policy." }, requestId);
      return;
    }

    let url: URL;
    try {
      url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    } catch {
      sendError(res, { status: 400, code: "INVALID_REQUEST", message: "Malformed request URL." }, requestId);
      return;
    }

    const matched = router.match(req.method ?? "GET", url.pathname);

    if (!matched) {
      sendError(res, { status: 404, code: "NOT_FOUND", message: `No route for ${req.method} ${url.pathname}` }, requestId);
      return;
    }
    if ("methodMismatch" in matched) {
      sendError(res, { status: 405, code: "METHOD_NOT_ALLOWED", message: `${req.method} is not supported on this route.` }, requestId);
      return;
    }

    const ctx: RequestContext = {
      req,
      res,
      url,
      params: matched.params,
      requestId,
      logger: requestLogger,
      signal: controller.signal,
      deps,
    };

    await matched.handler(ctx);
  } catch (error) {
    handleRouteError(error, res, requestLogger, config, requestId);
  } finally {
    req.removeListener("aborted", onClose);
    res.removeListener("close", onClose);
    requestLogger.info("request_completed", {
      method: req.method,
      path: safePath(req.url),
      status: res.statusCode,
      durationMs: Date.now() - startedAt,
    });
  }
}

function handleRouteError(
  error: unknown,
  res: ServerResponse,
  logger: Logger,
  config: AppConfig,
  requestId: string,
): void {
  if (res.writableEnded) return;

  if (error instanceof PayloadTooLargeError) {
    sendError(res, { status: 413, code: error.code, message: error.message }, requestId);
    return;
  }
  if (error instanceof ValidationError) {
    const status = error.code === "UNSUPPORTED_MEDIA_TYPE" ? 415 : error.code === "CLIENT_ABORTED" ? 400 : 400;
    sendError(res, { status, code: error.code, message: error.message, details: error.details }, requestId);
    return;
  }
  sendUnexpectedError(res, error, logger, config.isProduction, requestId);
}

function readRequestId(req: IncomingMessage): string | undefined {
  const header = req.headers["x-request-id"];
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== "string") return undefined;
  // Only accept a sane, log-safe id from the client.
  return /^[A-Za-z0-9._-]{1,64}$/.test(value) ? value : undefined;
}

function safePath(url: string | undefined): string {
  if (!url) return "/";
  const cut = url.indexOf("?");
  return (cut === -1 ? url : url.slice(0, cut)).slice(0, 200);
}

/* -------------------------------------------------------------------- */
/* Entrypoint                                                            */
/* -------------------------------------------------------------------- */

export async function main(): Promise<void> {
  loadDotEnv();

  let config: AppConfig;
  try {
    config = buildConfig(process.env);
  } catch (error) {
    // Fail fast and loudly on bad configuration.
    const message = error instanceof ConfigError ? error.message : String(error);
    process.stderr.write(`${JSON.stringify({ level: "error", event: "invalid_configuration", message })}\n`);
    process.exitCode = 1;
    return;
  }

  const logger = new Logger({ level: config.logLevel, base: { service: "academic-paper-search" } });
  setRootLogger(logger);

  const app = createApp({ config, logger });

  await new Promise<void>((resolve) => {
    app.server.listen(config.port, config.host, () => resolve());
  });

  logger.info("server_started", {
    host: config.host,
    port: config.port,
    ...redactedConfigSnapshot(config),
  });

  // Crossref and OpenAlex give better service to clients that identify
  // themselves. We refuse to send the placeholder address, so an operator who
  // never set CONTACT_EMAIL silently loses the polite pool - say so once.
  if (!process.env.CONTACT_EMAIL) {
    logger.warn("contact_email_not_configured", {
      detail:
        "CONTACT_EMAIL is unset, so the User-Agent carries a placeholder and no mailto is sent to " +
        "the Crossref/OpenAlex polite pools. Set CONTACT_EMAIL to a real address you monitor.",
    });
  }

  const shutdown = (signal: string): void => {
    logger.info("server_shutting_down", { signal });
    void app.close().then(() => {
      logger.info("server_stopped", {});
      process.exit(0);
    });
    // Do not wait forever for lingering connections.
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("unhandledRejection", (reason) => {
    logger.error("unhandled_rejection", { error: reason instanceof Error ? reason.message : String(reason) });
  });
  process.on("uncaughtException", (error) => {
    logger.error("uncaught_exception", { error: error.message });
    void app.close().finally(() => process.exit(1));
  });
}

// Run only when executed directly, not when imported by a test.
// `pathToFileURL` handles Windows drive letters and spaces in the path.
const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  void main();
}
