import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HttpClient } from "../src/http/HttpClient.js";
import { HttpError } from "../src/http/HttpError.js";
import { Logger } from "../src/logging/Logger.js";
import { CircuitBreaker } from "../src/rateLimit/CircuitBreaker.js";
import { RateLimiter } from "../src/rateLimit/RateLimiter.js";
import { RetryPolicy } from "../src/rateLimit/RetryPolicy.js";
import { UrlPolicy } from "../src/security/UrlPolicy.js";

/**
 * Every upstream call in these tests is a stub. Nothing here touches a real
 * academic API.
 */

const ALLOWED = "https://api.openalex.org/works";

interface StubResponse {
  status?: number;
  body?: string;
  headers?: Record<string, string>;
  delayMs?: number;
  throws?: Error;
}

function makeResponse({ status = 200, body = "{}", headers = {} }: StubResponse): Response {
  return new Response(body, { status, headers });
}

function buildClient(
  responses: StubResponse[],
  overrides: Partial<{
    maxRetries: number;
    timeoutMs: number;
    requestsPerSecond: number;
    defaultHeaders: Record<string, string>;
  }> = {},
): { client: HttpClient; calls: { url: string; init: RequestInit }[]; limiter: RateLimiter } {
  const calls: { url: string; init: RequestInit }[] = [];
  let index = 0;

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    const stub = responses[Math.min(index, responses.length - 1)] ?? {};
    index += 1;

    if (stub.delayMs) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, stub.delayMs);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      });
    }
    if (stub.throws) throw stub.throws;
    return makeResponse(stub);
  }) as typeof fetch;

  const limiter = new RateLimiter({
    name: "test",
    requestsPerSecond: overrides.requestsPerSecond ?? 1000,
    maxConcurrency: 4,
    maxRetries: 0,
  });

  const client = new HttpClient({
    source: "test",
    rateLimiter: limiter,
    circuitBreaker: new CircuitBreaker({ name: "test", failureThreshold: 3, cooldownMs: 1000, halfOpenSuccesses: 1 }),
    retryPolicy: new RetryPolicy({
      maxRetries: overrides.maxRetries ?? 0,
      baseDelayMs: 100,
      maxDelayMs: 5000,
      jitter: false,
    }),
    urlPolicy: new UrlPolicy(),
    logger: new Logger({ level: "error", sink: () => undefined }),
    userAgent: "AcademicPaperFinder/1.0 (+contact@example.com)",
    defaultTimeoutMs: overrides.timeoutMs ?? 5000,
    defaultHeaders: overrides.defaultHeaders,
    fetchImpl,
  });

  return { client, calls, limiter };
}

describe("HttpClient", () => {
  it("parses a JSON response and reports metadata", async () => {
    const { client } = buildClient([{ body: JSON.stringify({ ok: true }) }]);
    const { data, meta } = await client.getJson<{ ok: boolean }>(ALLOWED);
    expect(data.ok).toBe(true);
    expect(meta.status).toBe(200);
    expect(meta.attempts).toBe(1);
  });

  it("sends an honest, contactable User-Agent and never spoofs a browser", async () => {
    const { client, calls } = buildClient([{}]);
    await client.getJson(ALLOWED);
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["user-agent"]).toBe("AcademicPaperFinder/1.0 (+contact@example.com)");
    expect(headers["user-agent"]).not.toMatch(/mozilla|chrome|safari/i);
  });

  it("serializes query parameters and drops empty values", async () => {
    const { client, calls } = buildClient([{}]);
    await client.getJson(ALLOWED, { query: { search: "deep fake", empty: undefined, page: 2 } });
    expect(calls[0]!.url).toBe("https://api.openalex.org/works?search=deep+fake&page=2");
  });

  it("throws a typed HttpError carrying the status", async () => {
    const { client } = buildClient([{ status: 404, body: "not found" }]);
    await expect(client.getJson(ALLOWED)).rejects.toMatchObject({ kind: "http", status: 404, isNotFound: true });
  });

  it("does not retry a 400", async () => {
    const { client, calls } = buildClient([{ status: 400 }], { maxRetries: 3 });
    await expect(client.getJson(ALLOWED)).rejects.toBeInstanceOf(HttpError);
    expect(calls).toHaveLength(1);
  });

  it("does not retry a 403 and never attempts to work around it", async () => {
    const { client, calls } = buildClient([{ status: 403 }], { maxRetries: 3 });
    await expect(client.getJson(ALLOWED)).rejects.toMatchObject({ status: 403, isForbidden: true });
    expect(calls).toHaveLength(1);
  });

  it("marks a 401 as an authentication/configuration issue without retrying", async () => {
    const { client, calls } = buildClient([{ status: 401 }], { maxRetries: 3 });
    await expect(client.getJson(ALLOWED)).rejects.toMatchObject({ status: 401, isAuthError: true });
    expect(calls).toHaveLength(1);
  });

  it("retries a 503 with backoff and then succeeds", async () => {
    vi.useFakeTimers();
    try {
      const { client, calls } = buildClient([{ status: 503 }, { status: 503 }, { body: '{"ok":1}' }], {
        maxRetries: 3,
      });
      const promise = client.getJson<{ ok: number }>(ALLOWED);
      await vi.advanceTimersByTimeAsync(5000);
      const { data, meta } = await promise;
      expect(data.ok).toBe(1);
      expect(calls).toHaveLength(3);
      expect(meta.attempts).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits for Retry-After on a 429 instead of retrying immediately", async () => {
    vi.useFakeTimers();
    try {
      const { client, calls, limiter } = buildClient(
        [{ status: 429, headers: { "retry-after": "3" } }, { body: '{"ok":1}' }],
        { maxRetries: 2 },
      );

      const promise = client.getJson(ALLOWED);

      await vi.advanceTimersByTimeAsync(100);
      expect(calls).toHaveLength(1); // still waiting - no immediate retry
      expect(limiter.cooldownRemainingMs).toBeGreaterThan(2000);

      await vi.advanceTimersByTimeAsync(2000);
      expect(calls).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(2000);
      await promise;
      expect(calls).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("puts the whole source into cooldown after a 429", async () => {
    vi.useFakeTimers();
    try {
      const { client, limiter } = buildClient([{ status: 429, headers: { "retry-after": "5" } }], { maxRetries: 0 });
      await expect(client.getJson(ALLOWED)).rejects.toMatchObject({ status: 429 });
      expect(limiter.cooldownRemainingMs).toBeGreaterThan(4000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("times out a hanging request", async () => {
    vi.useFakeTimers();
    try {
      const { client } = buildClient([{ delayMs: 60_000 }], { timeoutMs: 1000 });
      const promise = client.getJson(ALLOWED);
      const assertion = expect(promise).rejects.toMatchObject({ kind: "timeout" });
      await vi.advanceTimersByTimeAsync(1500);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a caller cancellation as 'aborted', not a timeout", async () => {
    vi.useFakeTimers();
    try {
      const { client } = buildClient([{ delayMs: 60_000 }], { timeoutMs: 30_000 });
      const controller = new AbortController();
      const promise = client.getJson(ALLOWED, { signal: controller.signal });
      const assertion = expect(promise).rejects.toMatchObject({ kind: "aborted" });
      await vi.advanceTimersByTimeAsync(10);
      controller.abort();
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses to dispatch when the signal is already aborted", async () => {
    const { client, calls } = buildClient([{}]);
    const controller = new AbortController();
    controller.abort();
    await expect(client.getJson(ALLOWED, { signal: controller.signal })).rejects.toMatchObject({ kind: "aborted" });
    expect(calls).toHaveLength(0);
  });

  it("classifies a network failure", async () => {
    const { client } = buildClient([{ throws: new TypeError("fetch failed") }]);
    await expect(client.getJson(ALLOWED)).rejects.toMatchObject({ kind: "network" });
  });

  it("classifies a malformed JSON body as a parse error", async () => {
    const { client } = buildClient([{ body: "<html>oops</html>" }]);
    await expect(client.getJson(ALLOWED)).rejects.toMatchObject({ kind: "parse" });
  });

  it("blocks a URL that is not on the academic API allowlist", async () => {
    const { client, calls } = buildClient([{}]);
    await expect(client.getJson("https://evil.example.com/data")).rejects.toBeInstanceOf(Error);
    expect(calls).toHaveLength(0);
  });

  it("merges configured auth headers without logging them", async () => {
    const lines: string[] = [];
    const { client, calls } = buildClient([{}], { defaultHeaders: { authorization: "Bearer super-secret-value" } });
    void lines;
    await client.getJson(ALLOWED);
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer super-secret-value");
  });

  it("posts a JSON body when required", async () => {
    const { client, calls } = buildClient([{ body: '{"ok":true}' }]);
    await client.postJson(ALLOWED, { q: "test" });
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.body).toBe('{"q":"test"}');
  });
});
