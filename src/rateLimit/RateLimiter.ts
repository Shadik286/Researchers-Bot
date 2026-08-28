import type { RateLimitConfig } from "../config/rateLimits.js";

/**
 * Per-source rate limiter: token bucket + concurrency semaphore + FIFO queue.
 *
 * Design notes
 * ------------
 * - The bucket refills continuously at `requestsPerSecond`. Its capacity is
 *   deliberately small (>= 1, and never more than one second of tokens) so a
 *   long idle period cannot be cashed in as a burst.
 * - An optional `requestsPerMinute` ceiling is enforced with a sliding window
 *   on top of the bucket, for providers that publish a per-minute quota.
 * - Waiters are served FIFO, so one hot query cannot starve another.
 * - Every wait is cancellable through an AbortSignal, which is what lets the
 *   orchestrator instantly drop queued main-paper work after an exact match.
 *
 * This limiter exists to keep the service INSIDE published limits. It is not a
 * mechanism for pushing against them.
 */

export class RateLimitAbortError extends Error {
  constructor(message = "Rate limiter wait aborted") {
    super(message);
    this.name = "RateLimitAbortError";
  }
}

/**
 * Thrown when admitting a request would mean waiting longer than the caller's
 * budget - typically because a provider answered 429 with a long Retry-After
 * (OpenAlex sends ~12.5h when a daily quota is exhausted).
 *
 * We still never send a request before the provider said we may. We simply
 * refuse to BLOCK on it: the caller fails fast, the source is reported as
 * rate-limited, and the rest of the search carries on.
 */
export class RateLimitExceededError extends Error {
  readonly source: string;
  readonly retryAfterMs: number;

  constructor(source: string, retryAfterMs: number) {
    super(
      `Source "${source}" is rate limited for another ${Math.ceil(retryAfterMs / 1000)}s; ` +
        "not waiting for it",
    );
    this.name = "RateLimitExceededError";
    this.source = source;
    this.retryAfterMs = retryAfterMs;
  }
}

interface Waiter {
  resolve: () => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
  enqueuedAt: number;
}

export interface RateLimiterOptions extends RateLimitConfig {
  name: string;
  /** Injectable clock + timer, so tests can run without real delays. */
  now?: () => number;
  setTimeoutFn?: (handler: () => void, ms: number) => NodeJS.Timeout | number;
  clearTimeoutFn?: (handle: NodeJS.Timeout | number) => void;
}

export interface RateLimiterStats {
  name: string;
  queued: number;
  inFlight: number;
  availableTokens: number;
  requestsPerSecond: number;
  maxConcurrency: number;
  totalAcquired: number;
  totalWaitMs: number;
  /** Set while a provider-instructed cooldown (HTTP 429) is in effect. */
  cooldownUntil?: number;
}

export class RateLimiter {
  readonly name: string;
  private readonly requestsPerSecond: number;
  private readonly requestsPerMinute?: number;
  private readonly maxConcurrency: number;
  private readonly capacity: number;

  private readonly now: () => number;
  private readonly setTimeoutFn: (handler: () => void, ms: number) => NodeJS.Timeout | number;
  private readonly clearTimeoutFn: (handle: NodeJS.Timeout | number) => void;

  private tokens: number;
  private lastRefill: number;
  private inFlight = 0;
  private readonly queue: Waiter[] = [];
  private readonly minuteWindow: number[] = [];
  private pumpHandle: NodeJS.Timeout | number | undefined;
  private cooldownUntil = 0;

  private totalAcquired = 0;
  private totalWaitMs = 0;

  constructor(options: RateLimiterOptions) {
    this.name = options.name;
    this.requestsPerSecond = Math.max(options.requestsPerSecond, 0.001);
    this.requestsPerMinute = options.requestsPerMinute;
    this.maxConcurrency = Math.max(1, Math.floor(options.maxConcurrency));
    // At most one second of tokens, and never less than one, so a single
    // request can always proceed but a burst cannot accumulate.
    this.capacity = Math.max(1, Math.min(this.requestsPerSecond, this.maxConcurrency));

    this.now = options.now ?? (() => Date.now());
    this.setTimeoutFn = options.setTimeoutFn ?? ((h, ms) => setTimeout(h, ms));
    this.clearTimeoutFn = options.clearTimeoutFn ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));

    this.tokens = this.capacity;
    this.lastRefill = this.now();
  }

  /**
   * Waits until a slot is available. The caller MUST call `release()` when the
   * request finishes - use `schedule()` unless you need manual control.
   */
  async acquire(signal?: AbortSignal, maxWaitMs?: number): Promise<void> {
    if (signal?.aborted) throw new RateLimitAbortError();

    // Refuse to queue behind a wait longer than the caller can afford. Without
    // this a single provider-directed cooldown stalls every later request on
    // that source indefinitely, which stalls the whole search.
    if (maxWaitMs !== undefined) {
      const projected = this.projectedWaitMs();
      if (projected > maxWaitMs) throw new RateLimitExceededError(this.name, projected);
    }

    const enqueuedAt = this.now();
    if (this.queue.length === 0 && this.tryTake()) {
      this.totalAcquired += 1;
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, signal, enqueuedAt };
      if (signal) {
        waiter.onAbort = () => {
          const index = this.queue.indexOf(waiter);
          if (index !== -1) this.queue.splice(index, 1);
          reject(new RateLimitAbortError());
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.queue.push(waiter);
      this.schedulePump();
    });

    this.totalAcquired += 1;
    this.totalWaitMs += this.now() - enqueuedAt;
  }

  /** Frees the concurrency slot taken by `acquire()`. */
  release(): void {
    if (this.inFlight > 0) this.inFlight -= 1;
    this.schedulePump();
  }

  /** Runs `task` under the limiter and always releases the slot. */
  async schedule<T>(task: () => Promise<T>, signal?: AbortSignal, maxWaitMs?: number): Promise<T> {
    await this.acquire(signal, maxWaitMs);
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  /**
   * Applies a provider-instructed cooldown (an HTTP 429 Retry-After).
   * Nothing leaves the limiter until the cooldown expires.
   */
  applyCooldown(ms: number): void {
    if (!Number.isFinite(ms) || ms <= 0) return;
    const until = this.now() + ms;
    if (until > this.cooldownUntil) this.cooldownUntil = until;
    // Spending the bucket keeps a queued request from firing the moment the
    // cooldown lifts.
    this.tokens = 0;
    this.schedulePump();
  }

  get cooldownRemainingMs(): number {
    return Math.max(0, this.cooldownUntil - this.now());
  }

  stats(): RateLimiterStats {
    this.refill();
    return {
      name: this.name,
      queued: this.queue.length,
      inFlight: this.inFlight,
      availableTokens: Math.floor(this.tokens * 100) / 100,
      requestsPerSecond: this.requestsPerSecond,
      maxConcurrency: this.maxConcurrency,
      totalAcquired: this.totalAcquired,
      totalWaitMs: Math.round(this.totalWaitMs),
      cooldownUntil: this.cooldownUntil > this.now() ? this.cooldownUntil : undefined,
    };
  }

  /** Rejects every queued waiter. Used on shutdown. */
  drain(reason = "Rate limiter drained"): void {
    if (this.pumpHandle !== undefined) {
      this.clearTimeoutFn(this.pumpHandle);
      this.pumpHandle = undefined;
    }
    while (this.queue.length > 0) {
      const waiter = this.queue.shift()!;
      if (waiter.signal && waiter.onAbort) {
        waiter.signal.removeEventListener("abort", waiter.onAbort);
      }
      waiter.reject(new RateLimitAbortError(reason));
    }
  }

  /* ---------------------------------------------------------------- */

  private refill(): void {
    const now = this.now();
    const elapsed = now - this.lastRefill;
    if (elapsed <= 0) return;
    this.lastRefill = now;
    this.tokens = Math.min(this.capacity, this.tokens + (elapsed / 1000) * this.requestsPerSecond);
  }

  private minuteQuotaExceeded(): boolean {
    if (this.requestsPerMinute === undefined) return false;
    const cutoff = this.now() - 60_000;
    while (this.minuteWindow.length > 0 && this.minuteWindow[0]! <= cutoff) {
      this.minuteWindow.shift();
    }
    return this.minuteWindow.length >= this.requestsPerMinute;
  }

  /** Takes a token + a concurrency slot when both are available. */
  private tryTake(): boolean {
    if (this.cooldownRemainingMs > 0) return false;
    if (this.inFlight >= this.maxConcurrency) return false;
    if (this.minuteQuotaExceeded()) return false;
    this.refill();
    if (this.tokens < 1) return false;

    this.tokens -= 1;
    this.inFlight += 1;
    if (this.requestsPerMinute !== undefined) this.minuteWindow.push(this.now());
    return true;
  }

  private schedulePump(): void {
    if (this.pumpHandle !== undefined) return;
    if (this.queue.length === 0) return;
    const delay = this.nextDelayMs();
    this.pumpHandle = this.setTimeoutFn(() => {
      this.pumpHandle = undefined;
      this.pump();
    }, delay);
    // The pump timer is deliberately NOT unref'd. It is only ever scheduled
    // while the queue is non-empty, and it is the only thing that will resolve
    // those waiters - unref'ing it lets Node exit with their promises still
    // pending, which silently hangs any caller outside a long-lived server
    // (a CLI, a worker, a script). `drain()` clears it on shutdown.
  }

  private pump(): void {
    while (this.queue.length > 0) {
      if (!this.tryTake()) break;
      const waiter = this.queue.shift()!;
      if (waiter.signal && waiter.onAbort) {
        waiter.signal.removeEventListener("abort", waiter.onAbort);
      }
      if (waiter.signal?.aborted) {
        // Aborted while queued: hand the slot to the next waiter instead.
        this.inFlight -= 1;
        this.tokens = Math.min(this.capacity, this.tokens + 1);
        waiter.reject(new RateLimitAbortError());
        continue;
      }
      waiter.resolve();
    }
    if (this.queue.length > 0) this.schedulePump();
  }

  /**
   * Best estimate of how long a request arriving NOW would wait before being
   * admitted: the provider cooldown, the tokens needed to clear the queue
   * ahead of it, and any per-minute quota window.
   */
  projectedWaitMs(): number {
    const cooldown = this.cooldownRemainingMs;
    this.refill();

    const ahead = this.queue.length;
    const tokensNeeded = ahead + 1 - this.tokens;
    const tokenWait = tokensNeeded <= 0 ? 0 : (tokensNeeded / this.requestsPerSecond) * 1000;

    let minuteWait = 0;
    if (this.requestsPerMinute !== undefined && this.minuteWindow.length >= this.requestsPerMinute) {
      const oldest = this.minuteWindow[this.minuteWindow.length - this.requestsPerMinute];
      if (oldest !== undefined) minuteWait = Math.max(0, oldest + 60_000 - this.now());
    }

    return Math.max(cooldown, tokenWait, minuteWait);
  }

  /** How long until the next request could possibly be admitted. */
  private nextDelayMs(): number {
    const cooldown = this.cooldownRemainingMs;
    if (cooldown > 0) return Math.min(cooldown + 5, 60_000);
    if (this.inFlight >= this.maxConcurrency) return 25;
    this.refill();
    if (this.tokens >= 1) return 0;
    const needed = 1 - this.tokens;
    return Math.max(5, Math.ceil((needed / this.requestsPerSecond) * 1000));
  }
}

/** Registry of one limiter per source, created lazily. */
export class RateLimiterRegistry {
  private readonly limiters = new Map<string, RateLimiter>();

  constructor(private readonly factory: (key: string) => RateLimiter) {}

  get(key: string): RateLimiter {
    let limiter = this.limiters.get(key);
    if (!limiter) {
      limiter = this.factory(key);
      this.limiters.set(key, limiter);
    }
    return limiter;
  }

  all(): RateLimiter[] {
    return [...this.limiters.values()];
  }

  drainAll(): void {
    for (const limiter of this.limiters.values()) limiter.drain();
  }
}
