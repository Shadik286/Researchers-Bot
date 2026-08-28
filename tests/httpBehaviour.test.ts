import http, { type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { HttpClient } from "../src/http/HttpClient.js";
import { HttpError } from "../src/http/HttpError.js";
import { Logger } from "../src/logging/Logger.js";
import { CircuitBreaker } from "../src/rateLimit/CircuitBreaker.js";
import { RateLimiter } from "../src/rateLimit/RateLimiter.js";
import { RetryPolicy } from "../src/rateLimit/RetryPolicy.js";
import { UrlPolicy } from "../src/security/UrlPolicy.js";

/**
 * HTTP-layer behaviour verified against a REAL local origin server, with real
 * sockets, real clocks and real timing - not a stubbed `fetch`.
 *
 * The unit tests in httpClient.test.ts cover the same rules with fake timers;
 * these prove the behaviour survives an actual network round trip.
 */

const silentLogger = new Logger({ level: "error", sink: () => undefined });

let server: Server;
let origin: string;

/** Per-path request counters, so retry counts can be asserted exactly. */
const hits = new Map<string, number>();
const bump = (path: string): number => {
  const n = (hits.get(path) ?? 0) + 1;
  hits.set(path, n);
  return n;
};
const arrivals = new Map<string, number[]>();
const recordArrival = (path: string): void => {
  const list = arrivals.get(path) ?? [];
  list.push(Date.now());
  arrivals.set(path, list);
};

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const n = bump(path);
    recordArrival(path);

    const json = (status: number, body: unknown, headers: Record<string, string> = {}): void => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(body));
    };

    switch (path) {
      case "/ok":
        return json(200, { ok: true, hit: n });

      // 429 with Retry-After: 1, then success.
      case "/429-retry-after":
        return n === 1 ? json(429, { error: "slow down" }, { "retry-after": "1" }) : json(200, { ok: true, hit: n });

      // 429 with no Retry-After -> exponential backoff.
      case "/429-no-header":
        return n === 1 ? json(429, { error: "slow down" }) : json(200, { ok: true, hit: n });

      // Always 429 - used to assert the retry count is bounded.
      case "/429-always":
        return json(429, { error: "slow down" }, { "retry-after": "0" });

      case "/500":
      case "/502":
      case "/503":
      case "/504":
        return json(Number(path.slice(1)), { error: "server" });

      case "/400":
      case "/401":
      case "/403":
      case "/404":
      case "/409":
        return json(Number(path.slice(1)), { error: "client" });

      // 5xx twice, then success.
      case "/flaky":
        return n <= 2 ? json(503, { error: "unavailable" }) : json(200, { ok: true, hit: n });

      // Never responds - exercises the client-side timeout.
      case "/hang":
        return; // deliberately no response, no end

      case "/not-json":
        res.writeHead(200, { "content-type": "application/json" });
        return res.end("<html>definitely not json</html>");

      default:
        return json(404, { error: "no route" });
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address() as AddressInfo;
  origin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
});

interface ClientBits {
  client: HttpClient;
  limiter: RateLimiter;
  breaker: CircuitBreaker;
}

function makeClient(options: {
  maxRetries?: number;
  timeoutMs?: number;
  requestsPerSecond?: number;
  maxConcurrency?: number;
  failureThreshold?: number;
  cooldownMs?: number;
  baseDelayMs?: number;
} = {}): ClientBits {
  const limiter = new RateLimiter({
    name: "local",
    requestsPerSecond: options.requestsPerSecond ?? 1000,
    maxConcurrency: options.maxConcurrency ?? 8,
    maxRetries: 0,
  });
  const breaker = new CircuitBreaker({
    name: "local",
    failureThreshold: options.failureThreshold ?? 100,
    cooldownMs: options.cooldownMs ?? 300,
    halfOpenSuccesses: 1,
  });
  const client = new HttpClient({
    source: "local",
    rateLimiter: limiter,
    circuitBreaker: breaker,
    retryPolicy: new RetryPolicy({
      maxRetries: options.maxRetries ?? 0,
      baseDelayMs: options.baseDelayMs ?? 60,
      maxDelayMs: 2000,
      jitter: false,
    }),
    // The local test origin is the only extra host permitted.
    urlPolicy: new UrlPolicy({ extraAllowedHosts: ["127.0.0.1"], allowInsecure: true }),
    logger: silentLogger,
    userAgent: "AcademicPaperFinder/1.0 (+qa@example.com)",
    defaultTimeoutMs: options.timeoutMs ?? 5000,
  });
  return { client, limiter, breaker };
}

describe("HTTP 429 handling (real server)", () => {
  it("waits for Retry-After instead of retrying immediately, then succeeds", async () => {
    const { client, limiter } = makeClient({ maxRetries: 2 });
    const startedAt = Date.now();

    const { data, meta } = await client.getJson<{ ok: boolean }>(`${origin}/429-retry-after`);
    const elapsed = Date.now() - startedAt;

    expect(data.ok).toBe(true);
    expect(meta.attempts).toBe(2);
    expect(hits.get("/429-retry-after")).toBe(2);
    // Retry-After: 1 -> the second attempt must not arrive before ~1s.
    expect(elapsed).toBeGreaterThanOrEqual(950);
    expect(elapsed).toBeLessThan(4000);

    const times = arrivals.get("/429-retry-after")!;
    expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(950);
    expect(limiter.stats().totalAcquired).toBe(2);
  });

  it("falls back to exponential backoff when no Retry-After is sent", async () => {
    const { client } = makeClient({ maxRetries: 2, baseDelayMs: 300 });
    const startedAt = Date.now();

    const { meta } = await client.getJson(`${origin}/429-no-header`);
    const elapsed = Date.now() - startedAt;

    expect(meta.attempts).toBe(2);
    // base * 2^0 = 300ms, no jitter.
    expect(elapsed).toBeGreaterThanOrEqual(280);
    expect(elapsed).toBeLessThan(3000);
  });

  it("gives up after the configured retry count rather than looping forever", async () => {
    const { client } = makeClient({ maxRetries: 2, baseDelayMs: 20 });
    await expect(client.getJson(`${origin}/429-always`)).rejects.toMatchObject({ status: 429 });
    // 1 initial attempt + 2 retries.
    expect(hits.get("/429-always")).toBe(3);
  });

  it("puts the whole source into cooldown after a 429", async () => {
    // `/429-always` is used because the single-shot 429 routes are consumed by
    // the tests above (the server counts hits per path).
    const { client, limiter } = makeClient({ maxRetries: 0, baseDelayMs: 500 });
    await expect(client.getJson(`${origin}/429-always`)).rejects.toMatchObject({ status: 429 });
    // Retry-After: 0 on that route, so the cooldown comes from the backoff.
    expect(limiter.stats().cooldownUntil).toBeDefined();
  });
});

describe("5xx retries (real server)", () => {
  it("retries a transient 503 a bounded number of times and then succeeds", async () => {
    const { client } = makeClient({ maxRetries: 3, baseDelayMs: 20 });
    const { data, meta } = await client.getJson<{ ok: boolean }>(`${origin}/flaky`);
    expect(data.ok).toBe(true);
    expect(meta.attempts).toBe(3);
    expect(hits.get("/flaky")).toBe(3);
  });

  it("retries each 5xx status and then fails gracefully", async () => {
    for (const status of [500, 502, 503, 504]) {
      hits.delete(`/${status}`);
      const { client } = makeClient({ maxRetries: 2, baseDelayMs: 10 });
      await expect(client.getJson(`${origin}/${status}`)).rejects.toMatchObject({ status, kind: "http" });
      expect(hits.get(`/${status}`), `status ${status}`).toBe(3); // 1 + 2 retries
    }
  });
});

describe("4xx behaviour (real server)", () => {
  it("never retries 400, 401, 403, 404 or 409", async () => {
    for (const status of [400, 401, 403, 404, 409]) {
      hits.delete(`/${status}`);
      const { client } = makeClient({ maxRetries: 3, baseDelayMs: 10 });
      await expect(client.getJson(`${origin}/${status}`)).rejects.toMatchObject({ status });
      expect(hits.get(`/${status}`), `status ${status}`).toBe(1); // exactly one attempt
    }
  });

  it("classifies 401 as auth, 403 as forbidden and 404 as not-found", async () => {
    const { client } = makeClient();
    const capture = async (status: number): Promise<HttpError> => {
      try {
        await client.getJson(`${origin}/${status}`);
        throw new Error("expected a rejection");
      } catch (error) {
        return error as HttpError;
      }
    };

    expect((await capture(401)).isAuthError).toBe(true);
    const forbidden = await capture(403);
    expect(forbidden.isForbidden).toBe(true);
    // A 403 must not be treated as a source-health problem, which would make
    // the breaker retry it - access denied is respected, never worked around.
    expect(forbidden.indicatesSourceUnhealthy).toBe(false);
    const notFound = await capture(404);
    expect(notFound.isNotFound).toBe(true);
    expect(notFound.indicatesSourceUnhealthy).toBe(false);
  });
});

describe("timeouts (real server)", () => {
  it("times out a request that never responds, without hanging the process", async () => {
    const { client } = makeClient({ timeoutMs: 400, maxRetries: 0 });
    const startedAt = Date.now();
    await expect(client.getJson(`${origin}/hang`)).rejects.toMatchObject({ kind: "timeout" });
    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeGreaterThanOrEqual(350);
    expect(elapsed).toBeLessThan(3000);
  });

  it("stays responsive to other requests while one is hanging", async () => {
    const { client } = makeClient({ timeoutMs: 600, maxRetries: 0, maxConcurrency: 4 });
    const hanging = client.getJson(`${origin}/hang`).catch((e) => e);
    const healthy = await client.getJson<{ ok: boolean }>(`${origin}/ok`);
    expect(healthy.data.ok).toBe(true); // completed while the other was stuck
    await expect(hanging).resolves.toMatchObject({ kind: "timeout" });
  });
});

describe("rate limiting (real server, real clock)", () => {
  it("spaces requests according to requestsPerSecond", async () => {
    const { client } = makeClient({ requestsPerSecond: 4, maxConcurrency: 1 });
    const startedAt = Date.now();

    const stamps: number[] = [];
    await Promise.all(
      [0, 1, 2].map(async () => {
        await client.getJson(`${origin}/ok`);
        stamps.push(Date.now() - startedAt);
      }),
    );
    stamps.sort((a, b) => a - b);

    // 4 req/s -> ~250ms apart. Allow slack for real scheduling.
    expect(stamps[1]! - stamps[0]!).toBeGreaterThanOrEqual(200);
    expect(stamps[2]! - stamps[1]!).toBeGreaterThanOrEqual(200);
    expect(stamps[2]!).toBeLessThan(3000);
  });
});

describe("circuit breaker (real server)", () => {
  it("opens after repeated failures, blocks requests, then recovers via HALF_OPEN", async () => {
    hits.delete("/503");
    const { client, breaker } = makeClient({
      maxRetries: 0,
      failureThreshold: 3,
      cooldownMs: 400,
    });

    expect(breaker.currentState).toBe("CLOSED");
    for (let i = 0; i < 3; i += 1) {
      await expect(client.getJson(`${origin}/503`)).rejects.toMatchObject({ status: 503 });
    }
    expect(breaker.currentState).toBe("OPEN");

    // While OPEN no request reaches the server at all.
    const before = hits.get("/503")!;
    await expect(client.getJson(`${origin}/503`)).rejects.toMatchObject({ kind: "circuit-open" });
    expect(hits.get("/503")).toBe(before);

    // After the cooldown a single probe is allowed; a success closes it.
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(breaker.currentState).toBe("HALF_OPEN");
    await client.getJson(`${origin}/ok`);
    expect(breaker.currentState).toBe("CLOSED");
  });

  it("does not trip on 404s, which say nothing about source health", async () => {
    const { client, breaker } = makeClient({ maxRetries: 0, failureThreshold: 3 });
    for (let i = 0; i < 6; i += 1) {
      await expect(client.getJson(`${origin}/404`)).rejects.toMatchObject({ status: 404 });
    }
    expect(breaker.currentState).toBe("CLOSED");
  });
});

describe("response validation (real server)", () => {
  it("reports a non-JSON body as a parse error rather than crashing", async () => {
    const { client } = makeClient();
    await expect(client.getJson(`${origin}/not-json`)).rejects.toMatchObject({ kind: "parse" });
  });

  it("sends the honest User-Agent over the wire", async () => {
    let seen: string | undefined;
    const probe = http.createServer((req, res) => {
      seen = req.headers["user-agent"];
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", () => resolve()));
    const port = (probe.address() as AddressInfo).port;

    const { client } = makeClient();
    await client.getJson(`http://127.0.0.1:${port}/ok`);
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    expect(seen).toBe("AcademicPaperFinder/1.0 (+qa@example.com)");
    expect(seen).not.toMatch(/mozilla|chrome|safari/i);
  });
});
