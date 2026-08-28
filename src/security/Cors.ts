import type { IncomingMessage, ServerResponse } from "node:http";
import type { AppConfig } from "../config/env.js";

/**
 * CORS handling, prepared for the separate frontend that will be built later.
 *
 * Rules:
 *  - only origins listed in CORS_ORIGINS are echoed back
 *  - "*" is honoured ONLY when it was configured explicitly (env.ts refuses a
 *    wildcard in production unless CORS_ORIGINS is literally "*")
 *  - credentials are never combined with a wildcard, which browsers reject and
 *    which would be unsafe anyway
 *  - `Vary: Origin` is always set so caches do not cross-serve responses
 */

export interface CorsOptions {
  origins: readonly string[];
  allowCredentials: boolean;
}

const ALLOWED_METHODS = "GET, POST, OPTIONS";
const ALLOWED_HEADERS = "content-type, accept, x-request-id";
const MAX_AGE_SECONDS = 600;

export class Cors {
  private readonly origins: Set<string>;
  private readonly allowAll: boolean;
  private readonly allowCredentials: boolean;

  constructor(options: CorsOptions) {
    this.origins = new Set(options.origins.map((o) => o.trim()).filter(Boolean));
    this.allowAll = this.origins.has("*");
    this.allowCredentials = options.allowCredentials && !this.allowAll;
  }

  static fromConfig(config: AppConfig): Cors {
    return new Cors({ origins: config.cors.origins, allowCredentials: config.cors.allowCredentials });
  }

  isAllowed(origin: string | undefined): boolean {
    if (!origin) return true; // same-origin / non-browser client
    return this.allowAll || this.origins.has(origin);
  }

  /** Applies the CORS response headers. Returns whether the origin passed. */
  apply(req: IncomingMessage, res: ServerResponse): boolean {
    res.setHeader("Vary", "Origin");

    const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
    if (!origin) return true;

    if (!this.isAllowed(origin)) return false;

    res.setHeader("Access-Control-Allow-Origin", this.allowAll ? "*" : origin);
    if (this.allowCredentials) res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Expose-Headers", "x-request-id");
    return true;
  }

  /** Answers a CORS preflight. Returns true when the request was handled. */
  handlePreflight(req: IncomingMessage, res: ServerResponse): boolean {
    if (req.method !== "OPTIONS") return false;

    const allowed = this.apply(req, res);
    if (!allowed) {
      res.statusCode = 403;
      res.end();
      return true;
    }

    res.setHeader("Access-Control-Allow-Methods", ALLOWED_METHODS);
    res.setHeader("Access-Control-Allow-Headers", ALLOWED_HEADERS);
    res.setHeader("Access-Control-Max-Age", String(MAX_AGE_SECONDS));
    res.statusCode = 204;
    res.end();
    return true;
  }
}

/** Security headers applied to every response. */
export function applySecurityHeaders(res: ServerResponse): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  // This is a JSON API: nothing should ever be rendered from it.
  res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
  res.setHeader("Cross-Origin-Resource-Policy", "same-site");
}
