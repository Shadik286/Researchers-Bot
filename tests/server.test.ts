import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MemoryCache } from "../src/cache/MemoryCache.js";
import { buildConfig } from "../src/config/env.js";
import { Logger } from "../src/logging/Logger.js";
import { createApp, type App } from "../src/server.js";
import { MockSource, makePaper } from "./helpers/mockSource.js";

/**
 * End-to-end HTTP tests against the real `node:http` server.
 *
 * The server is bound to an ephemeral loopback port and every academic source
 * is a mock, so nothing leaves the machine.
 */

const silentLogger = new Logger({ level: "error", sink: () => undefined });

let app: App;
let baseUrl: string;

const target = makePaper({
  source: "Mock Primary",
  doi: "10.1234/example",
  pdfUrl: "https://repo.example.org/paper.pdf",
  isOpenAccess: true,
});

const similar = Array.from({ length: 12 }, (_, i) =>
  makePaper({
    source: "Mock Similar",
    doi: `10.1234/similar-${i}`,
    title: `Multimodal Deepfake Detection Variant ${i}`,
  }),
);

beforeAll(async () => {
  const config = buildConfig({
    NODE_ENV: "test",
    SOURCE_PRIORITY: "doaj",
    FALLBACK_SOURCE_PRIORITY: "crossref",
    SIMILAR_SOURCE_PRIORITY: "semanticScholar",
    CORS_ORIGINS: "http://localhost:3000",
    MAX_BODY_SIZE: "1kb",
    CACHE_TTL_SECONDS: "0",
  });

  app = createApp({
    config,
    logger: silentLogger,
    cache: new MemoryCache({ defaultTtlSeconds: 0, maxEntries: 10 }),
    fetchImpl: (async () => {
      throw new Error("A test attempted a real network request");
    }) as typeof fetch,
  });

  app.registry.register(
    "doaj",
    new MockSource({
      name: "Mock Primary",
      key: "doaj",
      results: [target],
      byDoi: { "10.1234/example": target },
    }),
  );
  app.registry.register("crossref", new MockSource({ name: "Mock Fallback", key: "crossref", results: [] }));
  app.registry.register("semanticScholar", new MockSource({ name: "Mock Similar", key: "semanticScholar", related: similar }));

  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", () => resolve()));
  const address = app.server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await app.close();
});

async function post(path: string, body: unknown, init: RequestInit = {}): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...((init.headers as Record<string, string>) ?? {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
    ...init,
  });
}

describe("GET /health", () => {
  it("reports service health", async () => {
    const response = await fetch(`${baseUrl}/health`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");

    const body = await response.json();
    expect(body).toMatchObject({ status: "ok", service: "academic-paper-search" });
    expect(typeof body.timestamp).toBe("string");
  });

  it("sets the hardening headers", async () => {
    const response = await fetch(`${baseUrl}/health`);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });
});

describe("GET /api/sources/status", () => {
  it("lists sources without ever exposing a credential", async () => {
    const response = await fetch(`${baseUrl}/api/sources/status`);
    expect(response.status).toBe(200);

    const body = await response.json();
    const raw = JSON.stringify(body);

    expect(body.success).toBe(true);
    expect(Array.isArray(body.sources)).toBe(true);
    expect(body.sources[0]).toHaveProperty("circuit");
    expect(body.sources[0]).toHaveProperty("rateLimit");
    // Only booleans are reported for credentials.
    expect(body.configuration.keyedSources).toBeTruthy();
    expect(raw).not.toMatch(/"api_?key"\s*:\s*"[^"]+"/i);
    expect(raw).not.toContain("Bearer ");
  });
});

describe("POST /api/papers/search", () => {
  it("returns the exact paper, full text and 8-10 similar papers", async () => {
    const response = await post("/api/papers/search", {
      title: "Deepfake Detection Using Audio and Video",
      authors: ["John Doe"],
    });

    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body.success).toBe(true);
    expect(body.exactPaper).not.toBeNull();
    expect(body.exactPaper.matchType).toBe("exact");
    expect(body.exactPaper.id).toBe("doi:10.1234/example");
    expect(body.fullText).toMatchObject({ available: true, type: "pdf" });
    expect(body.similarPapers.length).toBeGreaterThanOrEqual(8);
    expect(body.similarPapers.length).toBeLessThanOrEqual(10);
    expect(body.similarPapers[0]).toHaveProperty("similarityScore");
    expect(body.searchCompleted).toBe(true);
    expect(Array.isArray(body.sourcesChecked)).toBe(true);
  });

  it("accepts a DOI-only request", async () => {
    const response = await post("/api/papers/search", { doi: "https://doi.org/10.1234/example" });
    const body = await response.json();
    expect(body.exactPaper.doi).toBe("10.1234/example");
    expect(body.query.strategy).toBe("doi");
  });

  it("returns exactPaper: null with a 200 when nothing is found", async () => {
    const response = await post("/api/papers/search", { title: "A Title Nothing Will Ever Match Xyzzy" });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(true);
    expect(body.exactPaper).toBeNull();
    expect(body.similarPapers).toEqual([]);
    expect(body.searchCompleted).toBe(true);
  });

  it("rejects an empty request with 400 and a structured error", async () => {
    const response = await post("/api/papers/search", {});
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body).toMatchObject({
      success: false,
      error: { code: "INVALID_REQUEST", message: expect.stringContaining("At least one search field") },
    });
  });

  it("rejects a malformed DOI with 400", async () => {
    const response = await post("/api/papers/search", { doi: "definitely-not-a-doi" });
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("INVALID_DOI");
  });

  it("rejects malformed JSON with 400", async () => {
    const response = await post("/api/papers/search", "{not json");
    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toMatch(/not valid JSON/);
  });

  it("rejects a request that tries to smuggle in a URL", async () => {
    const response = await post("/api/papers/search", { title: "x", url: "http://169.254.169.254/" });
    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toMatch(/Unsupported field/);
  });

  it("rejects an oversized body with 413", async () => {
    const huge = { title: "x".repeat(5000) };
    const response = await post("/api/papers/search", huge);
    expect(response.status).toBe(413);
    expect((await response.json()).error.code).toBe("PAYLOAD_TOO_LARGE");
  });

  it("rejects a non-JSON content type with 415", async () => {
    const response = await fetch(`${baseUrl}/api/papers/search`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "title=x",
    });
    expect(response.status).toBe(415);
  });

  it("never returns a stack trace", async () => {
    const response = await post("/api/papers/search", {});
    const raw = await response.text();
    expect(raw).not.toMatch(/at .*\(.*:\d+:\d+\)/);
  });
});

describe("GET /api/papers/:id", () => {
  it("resolves a known DOI", async () => {
    const response = await fetch(`${baseUrl}/api/papers/${encodeURIComponent("doi:10.1234/example")}`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(true);
    expect(body.paper.doi).toBe("10.1234/example");
    expect(body.fullText).toHaveProperty("accessType");
  });

  it("returns 404 for an unknown paper", async () => {
    const response = await fetch(`${baseUrl}/api/papers/${encodeURIComponent("doi:10.9999/unknown")}`);
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("PAPER_NOT_FOUND");
  });

  it("returns 400 for a malformed id", async () => {
    const response = await fetch(`${baseUrl}/api/papers/${encodeURIComponent("doi:nonsense")}`);
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("INVALID_PAPER_ID");
  });

  it("rejects an unsupported id scheme rather than fetching it", async () => {
    const response = await fetch(`${baseUrl}/api/papers/${encodeURIComponent("http://169.254.169.254/latest")}`);
    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toMatch(/Unsupported id scheme/);
  });
});

describe("routing and CORS", () => {
  it("returns 404 for an unknown route", async () => {
    const response = await fetch(`${baseUrl}/nope`);
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("NOT_FOUND");
  });

  it("returns 405 for the wrong method on a known route", async () => {
    const response = await fetch(`${baseUrl}/api/papers/search`);
    expect(response.status).toBe(405);
    expect((await response.json()).error.code).toBe("METHOD_NOT_ALLOWED");
  });

  it("answers a preflight for an allowed origin", async () => {
    const response = await fetch(`${baseUrl}/api/papers/search`, {
      method: "OPTIONS",
      headers: { origin: "http://localhost:3000", "access-control-request-method": "POST" },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
    expect(response.headers.get("access-control-allow-methods")).toContain("POST");
    expect(response.headers.get("vary")).toBe("Origin");
  });

  it("rejects a preflight from a disallowed origin", async () => {
    const response = await fetch(`${baseUrl}/api/papers/search`, {
      method: "OPTIONS",
      headers: { origin: "https://evil.example.com", "access-control-request-method": "POST" },
    });
    expect(response.status).toBe(403);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("rejects an actual request from a disallowed origin", async () => {
    const response = await post("/api/papers/search", { title: "x" }, { headers: { origin: "https://evil.example.com" } });
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("ORIGIN_NOT_ALLOWED");
  });

  it("echoes back a client-supplied request id", async () => {
    const response = await fetch(`${baseUrl}/health`, { headers: { "x-request-id": "test-request-1" } });
    expect(response.headers.get("x-request-id")).toBe("test-request-1");
  });

  it("ignores a malformed client request id", async () => {
    const response = await fetch(`${baseUrl}/health`, { headers: { "x-request-id": "bad id with spaces" } });
    expect(response.headers.get("x-request-id")).not.toBe("bad id with spaces");
  });
});
