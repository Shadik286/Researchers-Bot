import type { IncomingMessage, ServerResponse } from "node:http";
import type { AppConfig } from "../config/env.js";
import type { SourceRegistry } from "../config/sources.js";
import type { Cache } from "../cache/Cache.js";
import type { Logger } from "../logging/Logger.js";
import type { ApiErrorBody } from "../models/Search.js";
import type { SearchOrchestrator } from "../search/SearchOrchestrator.js";
import { ValidationError } from "../security/InputValidator.js";

/**
 * Tiny routing layer over `node:http`.
 *
 * Routes are matched by method + a path pattern with a single `:param`
 * segment; that is all this API needs, and it avoids a framework dependency.
 */

export interface RequestContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: Record<string, string>;
  requestId: string;
  logger: Logger;
  /** Aborted when the client disconnects. */
  signal: AbortSignal;
  deps: RouteDependencies;
}

export interface RouteDependencies {
  config: AppConfig;
  registry: SourceRegistry;
  orchestrator: SearchOrchestrator;
  cache: Cache;
  logger: Logger;
  startedAt: number;
}

export type RouteHandler = (ctx: RequestContext) => Promise<void> | void;

interface Route {
  method: string;
  segments: string[];
  handler: RouteHandler;
}

export class Router {
  private readonly routes: Route[] = [];

  add(method: string, pattern: string, handler: RouteHandler): this {
    this.routes.push({
      method: method.toUpperCase(),
      segments: splitPath(pattern),
      handler,
    });
    return this;
  }

  get(pattern: string, handler: RouteHandler): this {
    return this.add("GET", pattern, handler);
  }

  post(pattern: string, handler: RouteHandler): this {
    return this.add("POST", pattern, handler);
  }

  /**
   * Finds a handler. `methodMismatch` distinguishes 404 from 405.
   *
   * A fully static path always wins over one with a `:param` segment, so
   * `GET /api/papers/search` reports 405 (the route exists, but only for POST)
   * instead of being swallowed by `GET /api/papers/:id` as an id of "search".
   */
  match(
    method: string,
    pathname: string,
  ): { handler: RouteHandler; params: Record<string, string> } | { methodMismatch: true } | undefined {
    const parts = splitPath(pathname);
    const wanted = method.toUpperCase();

    const candidates: { route: Route; params: Record<string, string>; specificity: number }[] = [];
    for (const route of this.routes) {
      const params = matchSegments(route.segments, parts);
      if (!params) continue;
      candidates.push({ route, params, specificity: Object.keys(params).length });
    }
    if (candidates.length === 0) return undefined;

    // Fewest path parameters first.
    candidates.sort((a, b) => a.specificity - b.specificity);
    const bestSpecificity = candidates[0]!.specificity;
    const mostSpecific = candidates.filter((c) => c.specificity === bestSpecificity);

    const exact = mostSpecific.find((c) => c.route.method === wanted);
    if (exact) return { handler: exact.route.handler, params: exact.params };

    // The most specific path matched but not for this method.
    if (mostSpecific.length > 0) return { methodMismatch: true };

    const fallback = candidates.find((c) => c.route.method === wanted);
    return fallback ? { handler: fallback.route.handler, params: fallback.params } : { methodMismatch: true };
  }
}

function splitPath(path: string): string[] {
  return path.split("/").filter((segment) => segment.length > 0);
}

function matchSegments(pattern: readonly string[], actual: readonly string[]): Record<string, string> | undefined {
  if (pattern.length !== actual.length) return undefined;
  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.length; i += 1) {
    const expected = pattern[i]!;
    const value = actual[i]!;
    if (expected.startsWith(":")) {
      params[expected.slice(1)] = value;
      continue;
    }
    if (expected !== value) return undefined;
  }
  return params;
}

/* -------------------------------------------------------------------- */
/* Response helpers                                                      */
/* -------------------------------------------------------------------- */

export function sendJson(res: ServerResponse, status: number, body: unknown, requestId?: string): void {
  if (res.writableEnded) return;
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Length", Buffer.byteLength(payload));
  if (requestId) res.setHeader("x-request-id", requestId);
  res.end(payload);
}

export interface ErrorOptions {
  status: number;
  code: string;
  message: string;
  details?: unknown;
  retryAfterSeconds?: number;
}

export function sendError(res: ServerResponse, options: ErrorOptions, requestId?: string): void {
  const body: ApiErrorBody = {
    success: false,
    error: {
      code: options.code,
      message: options.message,
      ...(options.details !== undefined ? { details: options.details } : {}),
    },
  };
  if (options.retryAfterSeconds !== undefined && !res.writableEnded) {
    res.setHeader("Retry-After", String(Math.ceil(options.retryAfterSeconds)));
  }
  sendJson(res, options.status, body, requestId);
}

/**
 * Maps a thrown error onto a client-safe response.
 *
 * In production the message of an unexpected error is replaced with a generic
 * one and no stack trace is ever serialized - the detail goes to the log only.
 */
export function sendUnexpectedError(
  res: ServerResponse,
  error: unknown,
  logger: Logger,
  isProduction: boolean,
  requestId: string,
): void {
  if (error instanceof ValidationError) {
    sendError(res, { status: 400, code: error.code, message: error.message, details: error.details }, requestId);
    return;
  }

  logger.error("request_failed", {
    requestId,
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error && !isProduction ? error.stack : undefined,
  });

  sendError(
    res,
    {
      status: 500,
      code: "INTERNAL_ERROR",
      message: isProduction
        ? "An unexpected error occurred."
        : error instanceof Error
          ? error.message
          : String(error),
    },
    requestId,
  );
}
