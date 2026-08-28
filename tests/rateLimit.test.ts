import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CircuitBreaker, CircuitOpenError } from "../src/rateLimit/CircuitBreaker.js";
import { RateLimitAbortError, RateLimiter } from "../src/rateLimit/RateLimiter.js";
import { RetryPolicy, delay, parseRetryAfter } from "../src/rateLimit/RetryPolicy.js";
import { HttpError } from "../src/http/HttpError.js";

/**
 * These tests use fake timers throughout, so they prove the pacing behaviour
 * without ever sleeping for real - and without touching a live API.
 */

describe("RateLimiter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("cannot send faster than the configured 1 request/second", async () => {
    const limiter = new RateLimiter({
      name: "test",
      requestsPerSecond: 1,
      maxConcurrency: 1,
      maxRetries: 0,
    });

    const completions: number[] = [];
    const start = Date.now();

    const tasks = [0, 1, 2].map(() =>
      limiter.schedule(async () => {
        completions.push(Date.now() - start);
      }),
    );

    // First request goes immediately (the bucket starts full with one token).
    await vi.advanceTimersByTimeAsync(0);
    expect(completions).toHaveLength(1);

    // Nothing more may leave before a full second has elapsed.
    await vi.advanceTimersByTimeAsync(900);
    expect(completions).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(150);
    expect(completions).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(1000);
    expect(completions).toHaveLength(3);

    await Promise.all(tasks);
    expect(completions[1]! - completions[0]!).toBeGreaterThanOrEqual(1000);
    expect(completions[2]! - completions[1]!).toBeGreaterThanOrEqual(950);
  });

  it("does not accumulate a burst while idle", async () => {
    const limiter = new RateLimiter({ name: "test", requestsPerSecond: 1, maxConcurrency: 1, maxRetries: 0 });

    await limiter.schedule(async () => undefined);
    // Sit idle for 10 seconds; the bucket must not hold 10 tokens.
    await vi.advanceTimersByTimeAsync(10_000);

    const done: number[] = [];
    const tasks = [0, 1, 2].map((i) => limiter.schedule(async () => void done.push(i)));

    await vi.advanceTimersByTimeAsync(0);
    expect(done).toHaveLength(1); // capacity is capped at one token

    await vi.advanceTimersByTimeAsync(1100);
    expect(done).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(1100);
    await Promise.all(tasks);
    expect(done).toHaveLength(3);
  });

  it("enforces max concurrency", async () => {
    const limiter = new RateLimiter({ name: "test", requestsPerSecond: 100, maxConcurrency: 2, maxRetries: 0 });

    let active = 0;
    let peak = 0;

    const tasks = Array.from({ length: 6 }, () =>
      limiter.schedule(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 50));
        active -= 1;
      }),
    );

    await vi.advanceTimersByTimeAsync(1000);
    await Promise.all(tasks);
    expect(peak).toBeLessThanOrEqual(2);
  });

  it("honours a per-minute ceiling on top of the per-second bucket", async () => {
    const limiter = new RateLimiter({
      name: "test",
      requestsPerSecond: 10,
      requestsPerMinute: 3,
      maxConcurrency: 1,
      maxRetries: 0,
    });

    const done: number[] = [];
    const tasks = Array.from({ length: 4 }, (_, i) => limiter.schedule(async () => void done.push(i)));

    await vi.advanceTimersByTimeAsync(5_000);
    expect(done).toHaveLength(3); // the fourth is held for the window to roll

    await vi.advanceTimersByTimeAsync(60_000);
    await Promise.all(tasks);
    expect(done).toHaveLength(4);
  });

  it("queues in FIFO order", async () => {
    const limiter = new RateLimiter({ name: "test", requestsPerSecond: 1, maxConcurrency: 1, maxRetries: 0 });
    const order: string[] = [];

    const tasks = ["a", "b", "c"].map((id) => limiter.schedule(async () => void order.push(id)));

    await vi.advanceTimersByTimeAsync(5000);
    await Promise.all(tasks);
    expect(order).toEqual(["a", "b", "c"]);
  });

  it("supports cancellation of a queued request", async () => {
    const limiter = new RateLimiter({ name: "test", requestsPerSecond: 1, maxConcurrency: 1, maxRetries: 0 });
    const controller = new AbortController();

    const first = limiter.schedule(async () => "first");
    const second = limiter.schedule(async () => "second", controller.signal);
    const rejection = expect(second).rejects.toBeInstanceOf(RateLimitAbortError);

    await vi.advanceTimersByTimeAsync(0);
    controller.abort();

    await rejection;
    await expect(first).resolves.toBe("first");
    expect(limiter.stats().queued).toBe(0);
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const limiter = new RateLimiter({ name: "test", requestsPerSecond: 1, maxConcurrency: 1, maxRetries: 0 });
    const controller = new AbortController();
    controller.abort();
    await expect(limiter.acquire(controller.signal)).rejects.toBeInstanceOf(RateLimitAbortError);
  });

  it("applies a provider-directed cooldown to the whole source", async () => {
    const limiter = new RateLimiter({ name: "test", requestsPerSecond: 100, maxConcurrency: 4, maxRetries: 0 });

    limiter.applyCooldown(2000);
    expect(limiter.cooldownRemainingMs).toBeGreaterThan(1900);

    let ran = false;
    const task = limiter.schedule(async () => void (ran = true));

    await vi.advanceTimersByTimeAsync(1500);
    expect(ran).toBe(false); // still cooling down

    await vi.advanceTimersByTimeAsync(1000);
    await task;
    expect(ran).toBe(true);
  });

  it("drains queued waiters on shutdown", async () => {
    const limiter = new RateLimiter({ name: "test", requestsPerSecond: 1, maxConcurrency: 1, maxRetries: 0 });
    const first = limiter.schedule(async () => "ok");
    const queued = limiter.schedule(async () => "never");
    const rejection = expect(queued).rejects.toBeInstanceOf(RateLimitAbortError);

    await vi.advanceTimersByTimeAsync(0);
    limiter.drain();

    await rejection;
    await expect(first).resolves.toBe("ok");
  });
});

describe("parseRetryAfter", () => {
  it("parses delta-seconds", () => {
    expect(parseRetryAfter("5")).toBe(5000);
    expect(parseRetryAfter(" 30 ")).toBe(30_000);
  });

  it("parses an HTTP date", () => {
    const now = Date.parse("2025-01-01T00:00:00Z");
    expect(parseRetryAfter("Wed, 01 Jan 2025 00:00:10 GMT", now)).toBe(10_000);
  });

  it("clamps a past date to zero and caps at 24h", () => {
    const now = Date.parse("2025-01-02T00:00:00Z");
    expect(parseRetryAfter("Wed, 01 Jan 2025 00:00:00 GMT", now)).toBe(0);
    expect(parseRetryAfter("999999999")).toBe(24 * 60 * 60 * 1000);
  });

  it("returns undefined for junk", () => {
    expect(parseRetryAfter(undefined)).toBeUndefined();
    expect(parseRetryAfter("")).toBeUndefined();
    expect(parseRetryAfter("soon")).toBeUndefined();
  });
});

describe("RetryPolicy", () => {
  const config = { maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 30_000, jitter: false };

  const httpError = (status: number, retryAfterMs?: number): HttpError =>
    new HttpError(`status ${status}`, { kind: "http", status, retryAfterMs });

  it("produces the documented 1s / 2s / 4s / 8s ladder without jitter", () => {
    const policy = new RetryPolicy(config);
    expect(policy.backoff(0)).toBe(1000);
    expect(policy.backoff(1)).toBe(2000);
    expect(policy.backoff(2)).toBe(4000);
    expect(policy.backoff(3)).toBe(8000);
  });

  it("clamps the backoff to maxDelayMs", () => {
    const policy = new RetryPolicy(config);
    expect(policy.backoff(20)).toBe(30_000);
  });

  it("applies bounded jitter when enabled", () => {
    const policy = new RetryPolicy({ ...config, jitter: true }, () => 0.5);
    // full jitter with a floor of half the delay: 1000/2 + 0.5*500 = 750
    expect(policy.backoff(0)).toBe(750);

    const low = new RetryPolicy({ ...config, jitter: true }, () => 0);
    const high = new RetryPolicy({ ...config, jitter: true }, () => 0.999);
    expect(low.backoff(1)).toBe(1000);
    expect(high.backoff(1)).toBeLessThanOrEqual(2000);
    expect(high.backoff(1)).toBeGreaterThan(1900);
  });

  it("waits for Retry-After on 429 rather than retrying immediately", () => {
    const policy = new RetryPolicy(config);
    const decision = policy.decide(httpError(429, 7000), 0);
    expect(decision).toMatchObject({ shouldRetry: true, delayMs: 7000, reason: "rate-limited", providerDirected: true });
  });

  it("falls back to exponential backoff on 429 with no Retry-After", () => {
    const policy = new RetryPolicy(config);
    const decision = policy.decide(httpError(429), 1);
    expect(decision.shouldRetry).toBe(true);
    expect(decision.providerDirected).toBe(false);
    expect(decision.delayMs).toBe(2000);
  });

  it("caps a provider-directed delay at maxDelayMs", () => {
    const policy = new RetryPolicy(config);
    expect(policy.decide(httpError(429, 120_000), 0).delayMs).toBe(30_000);
  });

  it("never retries 400, 401, 403, 404 or 409", () => {
    const policy = new RetryPolicy(config);
    for (const status of [400, 401, 403, 404, 409]) {
      expect(policy.decide(httpError(status), 0).shouldRetry, `status ${status}`).toBe(false);
    }
  });

  it("retries 408 and 5xx with backoff", () => {
    const policy = new RetryPolicy(config);
    for (const status of [408, 500, 502, 503, 504]) {
      const decision = policy.decide(httpError(status), 0);
      expect(decision.shouldRetry, `status ${status}`).toBe(true);
      expect(decision.delayMs).toBe(1000);
    }
  });

  it("retries timeouts and network errors but never a cancellation", () => {
    const policy = new RetryPolicy(config);
    expect(policy.decide(new HttpError("t", { kind: "timeout" }), 0).shouldRetry).toBe(true);
    expect(policy.decide(new HttpError("n", { kind: "network" }), 0).shouldRetry).toBe(true);
    expect(policy.decide(new HttpError("a", { kind: "aborted" }), 0).shouldRetry).toBe(false);
  });

  it("stops once maxRetries is reached", () => {
    const policy = new RetryPolicy({ ...config, maxRetries: 2 });
    expect(policy.decide(httpError(500), 1).shouldRetry).toBe(true);
    expect(policy.decide(httpError(500), 2).shouldRetry).toBe(false);
  });

  it("does not retry non-HTTP errors", () => {
    const policy = new RetryPolicy(config);
    expect(policy.decide(new Error("boom"), 0).shouldRetry).toBe(false);
  });
});

describe("delay", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("resolves after the requested time", async () => {
    let done = false;
    const promise = delay(500).then(() => void (done = true));
    await vi.advanceTimersByTimeAsync(499);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    await promise;
    expect(done).toBe(true);
  });

  it("rejects when aborted mid-wait", async () => {
    const controller = new AbortController();
    const promise = delay(5000, controller.signal);
    const rejection = expect(promise).rejects.toMatchObject({ kind: "aborted" });
    await vi.advanceTimersByTimeAsync(10);
    controller.abort();
    await rejection;
  });
});

describe("CircuitBreaker", () => {
  const options = { name: "test", failureThreshold: 3, cooldownMs: 5000, halfOpenSuccesses: 2 };

  it("starts CLOSED and opens after the failure threshold", () => {
    const breaker = new CircuitBreaker(options);
    expect(breaker.currentState).toBe("CLOSED");

    breaker.onFailure();
    breaker.onFailure();
    expect(breaker.currentState).toBe("CLOSED");

    breaker.onFailure();
    expect(breaker.currentState).toBe("OPEN");
    expect(() => breaker.ensureAllowed()).toThrow(CircuitOpenError);
    expect(breaker.canRequest()).toBe(false);
  });

  it("resets the failure count on success", () => {
    const breaker = new CircuitBreaker(options);
    breaker.onFailure();
    breaker.onFailure();
    breaker.onSuccess();
    breaker.onFailure();
    breaker.onFailure();
    expect(breaker.currentState).toBe("CLOSED");
  });

  it("moves to HALF_OPEN after the cooldown and closes on enough successes", () => {
    let now = 1000;
    const breaker = new CircuitBreaker({ ...options, now: () => now });

    breaker.onFailure();
    breaker.onFailure();
    breaker.onFailure();
    expect(breaker.currentState).toBe("OPEN");

    now += 5001;
    expect(breaker.currentState).toBe("HALF_OPEN");

    expect(() => breaker.ensureAllowed()).not.toThrow();
    // Only one probe is allowed at a time while half open.
    expect(() => breaker.ensureAllowed()).toThrow(CircuitOpenError);

    breaker.onSuccess();
    breaker.ensureAllowed();
    breaker.onSuccess();
    expect(breaker.currentState).toBe("CLOSED");
  });

  it("re-opens immediately when a half-open probe fails", () => {
    let now = 1000;
    const breaker = new CircuitBreaker({ ...options, now: () => now });
    breaker.onFailure();
    breaker.onFailure();
    breaker.onFailure();

    now += 6000;
    expect(breaker.currentState).toBe("HALF_OPEN");
    breaker.ensureAllowed();
    breaker.onFailure();
    expect(breaker.currentState).toBe("OPEN");
    expect(breaker.snapshot().totalTrips).toBe(2);
  });

  it("execute() ignores failures that do not indicate poor source health", async () => {
    const breaker = new CircuitBreaker(options);
    const notFound = new HttpError("missing", { kind: "http", status: 404 });

    for (let i = 0; i < 5; i += 1) {
      await expect(
        breaker.execute(
          async () => {
            throw notFound;
          },
          (error) => error instanceof HttpError && error.indicatesSourceUnhealthy,
        ),
      ).rejects.toBe(notFound);
    }
    expect(breaker.currentState).toBe("CLOSED");
  });

  it("execute() counts 5xx failures and trips", async () => {
    const breaker = new CircuitBreaker(options);
    const serverError = new HttpError("boom", { kind: "http", status: 503 });

    for (let i = 0; i < 3; i += 1) {
      await expect(
        breaker.execute(
          async () => {
            throw serverError;
          },
          (error) => error instanceof HttpError && error.indicatesSourceUnhealthy,
        ),
      ).rejects.toBe(serverError);
    }
    expect(breaker.currentState).toBe("OPEN");
  });

  it("reset() returns the breaker to a clean CLOSED state", () => {
    const breaker = new CircuitBreaker(options);
    breaker.onFailure();
    breaker.onFailure();
    breaker.onFailure();
    breaker.reset();
    expect(breaker.currentState).toBe("CLOSED");
    expect(breaker.snapshot().totalTrips).toBe(0);
  });
});
