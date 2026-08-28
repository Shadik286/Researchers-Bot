import type { Logger } from "../logging/Logger.js";
import type { CircuitBreaker } from "../rateLimit/CircuitBreaker.js";
import { CircuitOpenError } from "../rateLimit/CircuitBreaker.js";
import type { RateLimiter } from "../rateLimit/RateLimiter.js";
import { RateLimitAbortError, RateLimitExceededError } from "../rateLimit/RateLimiter.js";
import { RetryPolicy, delay, parseRetryAfter, positiveDelay } from "../rateLimit/RetryPolicy.js";
import { BlockedUrlError, UrlPolicy } from "../security/UrlPolicy.js";
import { HttpError, isAbortError } from "./HttpError.js";
import {
  buildQueryString,
  headersToObject,
  type HttpRequestOptions,
  type HttpResponse,
} from "./RequestOptions.js";

/**
 * The single place where outbound HTTP happens.
 *
 * Every request goes through, in order:
 *   URL policy (SSRF guard) -> circuit breaker -> rate limiter -> timeout ->
 *   fetch -> status mapping -> retry policy
 *
 * Adapters never call `fetch` directly, so behaviour such as Retry-After
 * handling or the honest User-Agent cannot drift between sources.
 */

export interface HttpClientOptions {
  /** Source key, used in logs and in the limiter/breaker registries. */
  source: string;
  rateLimiter: RateLimiter;
  circuitBreaker: CircuitBreaker;
  retryPolicy: RetryPolicy;
  urlPolicy: UrlPolicy;
  logger: Logger;
  userAgent: string;
  defaultTimeoutMs: number;
  /**
   * How long a request may sit in this source's rate-limit queue before we
   * give up on the source instead of blocking the search. Defaults to the
   * request timeout.
   */
  maxQueueWaitMs?: number;
  /** Headers added to every request (e.g. an API key). Never logged. */
  defaultHeaders?: Record<string, string>;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

const MAX_SNIPPET = 400;

export class HttpClient {
  readonly source: string;
  private readonly rateLimiter: RateLimiter;
  private readonly circuitBreaker: CircuitBreaker;
  private readonly retryPolicy: RetryPolicy;
  private readonly urlPolicy: UrlPolicy;
  private readonly logger: Logger;
  private readonly userAgent: string;
  private readonly defaultTimeoutMs: number;
  private readonly maxQueueWaitMs: number;
  private readonly defaultHeaders: Record<string, string>;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HttpClientOptions) {
    this.source = options.source;
    this.rateLimiter = options.rateLimiter;
    this.circuitBreaker = options.circuitBreaker;
    this.retryPolicy = options.retryPolicy;
    this.urlPolicy = options.urlPolicy;
    this.logger = options.logger.child({ source: options.source });
    this.userAgent = options.userAgent;
    this.defaultTimeoutMs = options.defaultTimeoutMs;
    this.maxQueueWaitMs = options.maxQueueWaitMs ?? options.defaultTimeoutMs;
    this.defaultHeaders = options.defaultHeaders ?? {};
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;

    if (typeof this.fetchImpl !== "function") {
      throw new Error("global fetch is unavailable; Node 18+ is required");
    }
  }

  async getJson<T>(url: string, options: HttpRequestOptions = {}): Promise<HttpResponse<T>> {
    const response = await this.request(url, { ...options, method: "GET", accept: options.accept ?? "application/json" });
    return { data: parseJson<T>(response.data, url, this.source), meta: response.meta };
  }

  async postJson<T>(url: string, body: unknown, options: HttpRequestOptions = {}): Promise<HttpResponse<T>> {
    const response = await this.request(url, {
      ...options,
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
      accept: options.accept ?? "application/json",
      headers: { "content-type": "application/json", ...(options.headers ?? {}) },
    });
    return { data: parseJson<T>(response.data, url, this.source), meta: response.meta };
  }

  async getText(url: string, options: HttpRequestOptions = {}): Promise<HttpResponse<string>> {
    return this.request(url, { ...options, method: "GET" });
  }

  /** Core request loop: rate limit, execute, classify, retry. */
  async request(url: string, options: HttpRequestOptions = {}): Promise<HttpResponse<string>> {
    const fullUrl = url + buildQueryString(options.query);
    const target = this.urlPolicy.assertAllowed(fullUrl); // throws BlockedUrlError
    const method = options.method ?? "GET";
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    const maxRetries = options.noRetry ? 0 : this.retryPolicy.maxRetries;
    const startedAt = Date.now();

    let attempt = 0;
    for (;;) {
      if (options.signal?.aborted) {
        throw new HttpError("Request aborted before dispatch", {
          kind: "aborted",
          url: target.toString(),
          method,
          source: this.source,
        });
      }

      try {
        const result = await this.executeOnce(target, method, options, timeoutMs, attempt);
        return {
          data: result.body,
          meta: {
            status: result.status,
            headers: result.headers,
            url: target.toString(),
            durationMs: Date.now() - startedAt,
            attempts: attempt + 1,
          },
        };
      } catch (error) {
        const httpError = this.toHttpError(error, target.toString(), method);

        // A 429 puts the whole source into cooldown, not just this request:
        // queued siblings must wait too.
        if (httpError.isRateLimited) {
          // A 429 always costs a real cooldown: a Retry-After of 0 gives no
          // usable guidance, so the backoff applies instead of nothing.
          const cooldown = positiveDelay(httpError.retryAfterMs) ?? this.retryPolicy.backoff(attempt);
          this.rateLimiter.applyCooldown(cooldown);
          this.logger.warn("source_rate_limited", {
            operation: options.operation,
            status: 429,
            cooldownMs: cooldown,
            providerDirected: httpError.retryAfterMs !== undefined,
            attempt: attempt + 1,
          });
        }

        if (attempt >= maxRetries) throw httpError;

        const decision = this.retryPolicy.decide(httpError, attempt);
        if (!decision.shouldRetry) throw httpError;

        this.logger.warn("request_retry_scheduled", {
          operation: options.operation,
          attempt: attempt + 1,
          maxRetries,
          delayMs: decision.delayMs,
          reason: decision.reason,
          providerDirected: decision.providerDirected,
          status: httpError.status,
        });

        await delay(decision.delayMs, options.signal);
        attempt += 1;
      }
    }
  }

  /** One attempt: breaker gate, limiter wait, fetch with a timeout. */
  private async executeOnce(
    target: URL,
    method: string,
    options: HttpRequestOptions,
    timeoutMs: number,
    attempt: number,
  ): Promise<{ status: number; headers: Record<string, string>; body: string }> {
    return this.circuitBreaker.execute(
      async () =>
        this.rateLimiter.schedule(async () => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
          const timerHandle = timer as unknown as { unref?: () => void };
          timerHandle.unref?.();

          const onCallerAbort = (): void => controller.abort(new Error("caller-abort"));
          options.signal?.addEventListener("abort", onCallerAbort, { once: true });

          const startedAt = Date.now();
          try {
            const response = await this.fetchImpl(target.toString(), {
              method,
              headers: this.buildHeaders(options),
              body: method === "POST" ? options.body : undefined,
              signal: controller.signal,
              redirect: "follow",
            });

            const headers = headersToObject(response.headers);
            const body = await response.text();
            const durationMs = Date.now() - startedAt;

            if (!response.ok) {
              throw new HttpError(
                `${this.source} responded ${response.status} ${response.statusText}`.trim(),
                {
                  kind: "http",
                  status: response.status,
                  statusText: response.statusText,
                  url: target.toString(),
                  method,
                  source: this.source,
                  retryAfterMs: parseRetryAfter(headers["retry-after"]),
                  responseSnippet: snippet(body),
                },
              );
            }

            this.logger.debug("request_completed", {
              operation: options.operation,
              status: response.status,
              durationMs,
              attempt: attempt + 1,
              bytes: body.length,
            });

            return { status: response.status, headers, body };
          } catch (error) {
            if (error instanceof HttpError) throw error;
            // Distinguish our timeout from a caller-initiated cancellation.
            if (isAbortError(error) || controller.signal.aborted) {
              const causedByCaller = options.signal?.aborted === true;
              throw new HttpError(
                causedByCaller
                  ? `${this.source} request cancelled`
                  : `${this.source} request timed out after ${timeoutMs}ms`,
                {
                  kind: causedByCaller ? "aborted" : "timeout",
                  url: target.toString(),
                  method,
                  source: this.source,
                  cause: error,
                },
              );
            }
            throw new HttpError(`${this.source} request failed: ${describeError(error)}`, {
              kind: "network",
              url: target.toString(),
              method,
              source: this.source,
              cause: error,
            });
          } finally {
            clearTimeout(timer);
            options.signal?.removeEventListener("abort", onCallerAbort);
          }
        }, options.signal, this.maxQueueWaitMs),
      (error) => error instanceof HttpError && error.indicatesSourceUnhealthy,
    );
  }

  private buildHeaders(options: HttpRequestOptions): Record<string, string> {
    return {
      // An honest, contactable identity. We never impersonate a browser or
      // another service.
      "user-agent": this.userAgent,
      accept: options.accept ?? "application/json",
      "accept-encoding": "gzip, deflate",
      ...this.defaultHeaders,
      ...(options.headers ?? {}),
    };
  }

  private toHttpError(error: unknown, url: string, method: string): HttpError {
    if (error instanceof HttpError) return error;
    if (error instanceof CircuitOpenError) {
      return new HttpError(error.message, {
        kind: "circuit-open",
        url,
        method,
        source: this.source,
        retryAfterMs: error.retryAfterMs,
        cause: error,
      });
    }
    if (error instanceof RateLimitExceededError) {
      return new HttpError(error.message, {
        kind: "cooldown",
        url,
        method,
        source: this.source,
        retryAfterMs: error.retryAfterMs,
        cause: error,
      });
    }
    if (error instanceof RateLimitAbortError) {
      return new HttpError(error.message, { kind: "aborted", url, method, source: this.source, cause: error });
    }
    if (error instanceof BlockedUrlError) {
      return new HttpError(error.message, { kind: "blocked", url, method, source: this.source, cause: error });
    }
    if (isAbortError(error)) {
      return new HttpError("Request aborted", { kind: "aborted", url, method, source: this.source, cause: error });
    }
    return new HttpError(`${this.source} request failed: ${describeError(error)}`, {
      kind: "network",
      url,
      method,
      source: this.source,
      cause: error,
    });
  }
}

function parseJson<T>(body: string, url: string, source: string): T {
  if (body.trim() === "") {
    throw new HttpError(`${source} returned an empty JSON body`, { kind: "parse", url, source });
  }
  try {
    return JSON.parse(body) as T;
  } catch (error) {
    throw new HttpError(`${source} returned a body that is not valid JSON`, {
      kind: "parse",
      url,
      source,
      responseSnippet: snippet(body),
      cause: error,
    });
  }
}

function snippet(body: string): string {
  return body.length > MAX_SNIPPET ? `${body.slice(0, MAX_SNIPPET)}...` : body;
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as { cause?: unknown }).cause;
    const causeCode =
      cause && typeof cause === "object" && "code" in cause ? String((cause as { code: unknown }).code) : undefined;
    return causeCode ? `${error.message} (${causeCode})` : error.message;
  }
  return String(error);
}
