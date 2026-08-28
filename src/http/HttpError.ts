/**
 * Typed transport error. Every failure that leaves `HttpClient` is one of
 * these, so callers never have to sniff arbitrary error shapes.
 */

export type HttpErrorKind =
  | "http" // an HTTP response with a non-2xx status
  | "timeout" // our own deadline elapsed
  | "aborted" // caller cancelled (e.g. exact match found elsewhere)
  | "network" // DNS/TCP/TLS failure, connection reset
  | "parse" // 2xx body that could not be decoded
  | "blocked" // request refused locally by the URL policy (SSRF guard)
  | "circuit-open" // source is in breaker cooldown; no request was sent
  | "cooldown"; // source is in a provider-directed 429 cooldown; nothing sent

export interface HttpErrorOptions {
  kind: HttpErrorKind;
  status?: number;
  statusText?: string;
  url?: string;
  method?: string;
  source?: string;
  retryAfterMs?: number;
  /** Truncated response body, for diagnostics. Never contains our credentials. */
  responseSnippet?: string;
  cause?: unknown;
}

export class HttpError extends Error {
  readonly kind: HttpErrorKind;
  readonly status?: number;
  readonly statusText?: string;
  readonly url?: string;
  readonly method?: string;
  readonly source?: string;
  readonly retryAfterMs?: number;
  readonly responseSnippet?: string;

  constructor(message: string, options: HttpErrorOptions) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "HttpError";
    this.kind = options.kind;
    this.status = options.status;
    this.statusText = options.statusText;
    this.url = options.url;
    this.method = options.method;
    this.source = options.source;
    this.retryAfterMs = options.retryAfterMs;
    this.responseSnippet = options.responseSnippet;
  }

  /** 404 means "this source does not have it", not "this source is broken". */
  get isNotFound(): boolean {
    return this.status === 404 || this.status === 410;
  }

  /** A missing/invalid credential - a configuration problem on our side. */
  get isAuthError(): boolean {
    return this.status === 401;
  }

  /**
   * Access is denied by the provider. We surface this and stop; we never try
   * another route, another identity, or another network path around it.
   */
  get isForbidden(): boolean {
    return this.status === 403;
  }

  get isRateLimited(): boolean {
    return this.status === 429;
  }

  get isServerError(): boolean {
    return this.status !== undefined && this.status >= 500 && this.status <= 599;
  }

  /**
   * Whether this failure says something about the SOURCE's health, and so
   * should count toward opening its circuit breaker.
   */
  get indicatesSourceUnhealthy(): boolean {
    if (this.kind === "aborted") return false;
    if (this.kind === "blocked") return false;
    // The breaker is already open; re-counting it would extend its own cooldown.
    if (this.kind === "circuit-open") return false;
    // A provider quota is not a health problem; it must not trip the breaker.
    if (this.kind === "cooldown") return false;
    if (this.isNotFound) return false;
    if (this.status !== undefined && this.status >= 400 && this.status < 500 && !this.isRateLimited) {
      // 400/401/403/409: our request or our configuration, not their uptime.
      return false;
    }
    return true;
  }

  /** Structured, log-safe representation. */
  toLogFields(): Record<string, unknown> {
    return {
      errorKind: this.kind,
      status: this.status,
      statusText: this.statusText,
      url: this.url,
      method: this.method,
      source: this.source,
      retryAfterMs: this.retryAfterMs,
      message: this.message,
    };
  }
}

export function isHttpError(error: unknown): error is HttpError {
  return error instanceof HttpError;
}

/** True for the abort shapes Node/undici can throw. */
export function isAbortError(error: unknown): boolean {
  if (error instanceof HttpError) return error.kind === "aborted";
  if (typeof error === "object" && error !== null) {
    const name = (error as { name?: unknown }).name;
    if (name === "AbortError" || name === "TimeoutError") return true;
  }
  return false;
}
