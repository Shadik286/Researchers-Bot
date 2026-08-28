import type { CircuitBreakerConfig } from "../config/rateLimits.js";

/**
 * Source-level circuit breaker.
 *
 *   CLOSED     normal operation; consecutive failures are counted
 *   OPEN       the source is skipped outright until the cooldown expires
 *   HALF_OPEN  a limited number of probe requests are allowed through;
 *              enough successes close the circuit, one failure re-opens it
 *
 * This protects both us (no waiting on a dead provider) and the provider
 * (no hammering while it is struggling).
 */

export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

export class CircuitOpenError extends Error {
  readonly retryAfterMs: number;
  readonly source: string;

  constructor(source: string, retryAfterMs: number) {
    super(`Circuit for source "${source}" is open; retry in ${Math.ceil(retryAfterMs / 1000)}s`);
    this.name = "CircuitOpenError";
    this.source = source;
    this.retryAfterMs = retryAfterMs;
  }
}

export interface CircuitSnapshot {
  name: string;
  state: CircuitState;
  consecutiveFailures: number;
  openedAt?: number;
  cooldownRemainingMs: number;
  totalTrips: number;
}

export interface CircuitBreakerOptions extends CircuitBreakerConfig {
  name: string;
  now?: () => number;
}

export class CircuitBreaker {
  readonly name: string;
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly halfOpenSuccesses: number;
  private readonly now: () => number;

  private state: CircuitState = "CLOSED";
  private consecutiveFailures = 0;
  private halfOpenSuccessCount = 0;
  private halfOpenProbesInFlight = 0;
  private openedAt: number | undefined;
  private totalTrips = 0;

  constructor(options: CircuitBreakerOptions) {
    this.name = options.name;
    this.failureThreshold = options.failureThreshold;
    this.cooldownMs = options.cooldownMs;
    this.halfOpenSuccesses = options.halfOpenSuccesses;
    this.now = options.now ?? (() => Date.now());
  }

  get currentState(): CircuitState {
    this.refreshState();
    return this.state;
  }

  /** Throws `CircuitOpenError` when the source must not be contacted. */
  ensureAllowed(): void {
    this.refreshState();
    if (this.state === "OPEN") {
      throw new CircuitOpenError(this.name, this.cooldownRemainingMs());
    }
    if (this.state === "HALF_OPEN") {
      // Exactly one probe at a time while half open.
      if (this.halfOpenProbesInFlight >= 1) {
        throw new CircuitOpenError(this.name, Math.max(250, this.cooldownRemainingMs()));
      }
      this.halfOpenProbesInFlight += 1;
    }
  }

  /** True when a call is currently permitted (non-throwing check). */
  canRequest(): boolean {
    this.refreshState();
    if (this.state === "OPEN") return false;
    if (this.state === "HALF_OPEN") return this.halfOpenProbesInFlight < 1;
    return true;
  }

  onSuccess(): void {
    if (this.state === "HALF_OPEN") {
      this.halfOpenProbesInFlight = Math.max(0, this.halfOpenProbesInFlight - 1);
      this.halfOpenSuccessCount += 1;
      if (this.halfOpenSuccessCount >= this.halfOpenSuccesses) this.close();
      return;
    }
    this.consecutiveFailures = 0;
  }

  /**
   * Records a failure. Only failures that say something about the SOURCE's
   * health should be reported here - a 404 (paper simply not in this source)
   * must not trip the breaker.
   */
  onFailure(): void {
    if (this.state === "HALF_OPEN") {
      this.halfOpenProbesInFlight = Math.max(0, this.halfOpenProbesInFlight - 1);
      this.trip();
      return;
    }
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.failureThreshold) this.trip();
  }

  /** Wraps a call, recording the outcome. `isSourceFailure` filters noise. */
  async execute<T>(task: () => Promise<T>, isSourceFailure: (error: unknown) => boolean = () => true): Promise<T> {
    this.ensureAllowed();
    try {
      const result = await task();
      this.onSuccess();
      return result;
    } catch (error) {
      if (isSourceFailure(error)) {
        this.onFailure();
      } else if (this.state === "HALF_OPEN") {
        // A non-health failure during a probe just returns the probe slot.
        this.halfOpenProbesInFlight = Math.max(0, this.halfOpenProbesInFlight - 1);
      }
      throw error;
    }
  }

  snapshot(): CircuitSnapshot {
    this.refreshState();
    return {
      name: this.name,
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      openedAt: this.openedAt,
      cooldownRemainingMs: this.cooldownRemainingMs(),
      totalTrips: this.totalTrips,
    };
  }

  reset(): void {
    this.close();
    this.totalTrips = 0;
  }

  /* ---------------------------------------------------------------- */

  private cooldownRemainingMs(): number {
    if (this.openedAt === undefined) return 0;
    return Math.max(0, this.openedAt + this.cooldownMs - this.now());
  }

  private refreshState(): void {
    if (this.state === "OPEN" && this.cooldownRemainingMs() === 0) {
      this.state = "HALF_OPEN";
      this.halfOpenSuccessCount = 0;
      this.halfOpenProbesInFlight = 0;
    }
  }

  private trip(): void {
    this.state = "OPEN";
    this.openedAt = this.now();
    this.halfOpenSuccessCount = 0;
    this.halfOpenProbesInFlight = 0;
    this.totalTrips += 1;
  }

  private close(): void {
    this.state = "CLOSED";
    this.consecutiveFailures = 0;
    this.halfOpenSuccessCount = 0;
    this.halfOpenProbesInFlight = 0;
    this.openedAt = undefined;
  }
}

/** One breaker per source, created lazily. */
export class CircuitBreakerRegistry {
  private readonly breakers = new Map<string, CircuitBreaker>();

  constructor(private readonly factory: (key: string) => CircuitBreaker) {}

  get(key: string): CircuitBreaker {
    let breaker = this.breakers.get(key);
    if (!breaker) {
      breaker = this.factory(key);
      this.breakers.set(key, breaker);
    }
    return breaker;
  }

  all(): CircuitBreaker[] {
    return [...this.breakers.values()];
  }
}
