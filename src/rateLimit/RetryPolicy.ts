import type { RetryConfig } from "../config/rateLimits.js";
import { HttpError } from "../http/HttpError.js";

/**
 * Retry decisions, centralised so every adapter behaves identically.
 *
 * Status handling (see also docs/HTTP semantics in README):
 *
 *   400 Bad Request        never retried - the request itself is wrong
 *   401 Unauthorized       never retried - a credential problem, reported as
 *                          a source configuration issue
 *   403 Forbidden          never retried, never worked around
 *   404 Not Found          not an error - "no result" for this source
 *   408 Request Timeout    limited retry
 *   409 Conflict           never retried
 *   429 Too Many Requests  honour Retry-After; otherwise exponential backoff
 *   5xx                    limited exponential-backoff retry
 *   network/timeout        limited exponential-backoff retry
 */

export type RetryReason =
  | "rate-limited"
  | "server-error"
  | "timeout"
  | "network"
  | "none";

export interface RetryDecision {
  shouldRetry: boolean;
  delayMs: number;
  reason: RetryReason;
  /** True when the provider explicitly told us how long to wait. */
  providerDirected: boolean;
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export class RetryPolicy {
  constructor(
    private readonly config: RetryConfig,
    private readonly random: () => number = Math.random,
  ) {}

  get maxRetries(): number {
    return this.config.maxRetries;
  }

  decide(error: unknown, attempt: number): RetryDecision {
    const noRetry: RetryDecision = {
      shouldRetry: false,
      delayMs: 0,
      reason: "none",
      providerDirected: false,
    };

    if (attempt >= this.config.maxRetries) return noRetry;

    if (error instanceof HttpError) {
      if (error.kind === "timeout") {
        return { shouldRetry: true, delayMs: this.backoff(attempt), reason: "timeout", providerDirected: false };
      }
      if (error.kind === "network") {
        return { shouldRetry: true, delayMs: this.backoff(attempt), reason: "network", providerDirected: false };
      }
      if (error.kind === "aborted") return noRetry;

      const status = error.status;
      if (status === undefined || !RETRYABLE_STATUS.has(status)) return noRetry;

      if (status === 429) {
        // A 429 must NEVER be retried immediately. A Retry-After of 0 (or a
        // header that parses to 0) carries no useful guidance, so we fall back
        // to exponential backoff rather than hammering the provider.
        const retryAfterMs = positiveDelay(error.retryAfterMs);
        if (retryAfterMs !== undefined) {
          return {
            shouldRetry: true,
            delayMs: Math.min(retryAfterMs, this.config.maxDelayMs),
            reason: "rate-limited",
            providerDirected: true,
          };
        }
        return {
          shouldRetry: true,
          delayMs: this.backoff(attempt),
          reason: "rate-limited",
          providerDirected: false,
        };
      }

      if (status === 408 || status === 425) {
        return { shouldRetry: true, delayMs: this.backoff(attempt), reason: "timeout", providerDirected: false };
      }

      // 5xx - a Retry-After on 503 is also honoured.
      const retryAfterMs = positiveDelay(error.retryAfterMs);
      if (retryAfterMs !== undefined) {
        return {
          shouldRetry: true,
          delayMs: Math.min(retryAfterMs, this.config.maxDelayMs),
          reason: "server-error",
          providerDirected: true,
        };
      }
      return { shouldRetry: true, delayMs: this.backoff(attempt), reason: "server-error", providerDirected: false };
    }

    return noRetry;
  }

  /**
   * Exponential backoff: base * 2^attempt, clamped to maxDelayMs, with
   * "full jitter" (a uniform draw over [0, delay]) to avoid synchronised
   * retries across concurrent requests.
   */
  backoff(attempt: number): number {
    const exponential = this.config.baseDelayMs * Math.pow(2, Math.max(0, attempt));
    const capped = Math.min(exponential, this.config.maxDelayMs);
    if (!this.config.jitter) return Math.round(capped);
    // Keep a floor of half the delay so jitter cannot collapse the wait to ~0.
    const jittered = capped / 2 + this.random() * (capped / 2);
    return Math.round(jittered);
  }
}

/** Treats a non-positive delay as "no guidance given". */
export function positiveDelay(ms: number | undefined): number | undefined {
  return typeof ms === "number" && Number.isFinite(ms) && ms > 0 ? ms : undefined;
}

/** Parses a Retry-After header (delta-seconds or an HTTP date) into ms. */
export function parseRetryAfter(headerValue: string | null | undefined, now = Date.now()): number | undefined {
  if (!headerValue) return undefined;
  const trimmed = headerValue.trim();
  if (!trimmed) return undefined;

  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (!Number.isFinite(seconds) || seconds < 0) return undefined;
    return Math.min(seconds * 1000, 24 * 60 * 60 * 1000);
  }

  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, Math.min(date - now, 24 * 60 * 60 * 1000));
}

/** Cancellable sleep used between retry attempts. */
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new HttpError("Request aborted while backing off", { kind: "aborted" }));
      return;
    }
    // Not unref'd: this timer is the only thing that resolves the backoff
    // wait, so letting the process exit through it would strand the retry.
    const timer = setTimeout(() => {
      if (onAbort && signal) signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    const onAbort = signal
      ? () => {
          clearTimeout(timer);
          reject(new HttpError("Request aborted while backing off", { kind: "aborted" }));
        }
      : undefined;
    if (signal && onAbort) signal.addEventListener("abort", onAbort, { once: true });
  });
}
