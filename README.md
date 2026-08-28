# Academic Paper Finder

A backend service for **academic paper discovery and retrieval** over official, public scholarly APIs.

Submit any combination of **title**, **authors**, **keywords** and **DOI**; the service identifies the exact paper, returns its metadata and a **legal** full-text/PDF link where one exists, and then finds **8–10 genuinely related papers**.

- Node.js + TypeScript (strict), ESM
- Native `node:http` server — no Express, no framework
- **Zero runtime dependencies**
- REST API only; no frontend (a UI will be built separately against this API)

---

## Table of contents

1. [What it does](#what-it-does)
2. [Legal and access policy](#legal-and-access-policy)
3. [Architecture](#architecture)
4. [Installation](#installation)
5. [Configuration](#configuration)
6. [API keys](#api-keys)
7. [Supported sources](#supported-sources)
8. [How searching works](#how-searching-works)
9. [Immediate exact-match cancellation](#immediate-exact-match-cancellation)
10. [Similar-paper discovery](#similar-paper-discovery)
11. [Rate limiting, retries and circuit breaking](#rate-limiting-retries-and-circuit-breaking)
12. [Caching](#caching)
13. [API reference](#api-reference)
14. [Testing](#testing)
15. [Production deployment](#production-deployment)
16. [Adding a new source adapter](#adding-a-new-source-adapter)
17. [Project structure](#project-structure)

---

## What it does

Given a partial description of a paper, the service:

1. Normalizes the query (DOI forms, title Unicode/punctuation, author name orders).
2. Searches five primary academic sources, progressively, from most to least precise.
3. Verifies candidates with a match engine that combines deterministic rules and a weighted score.
4. **Stops the main-paper search the moment the paper is confidently identified**, cancelling everything still queued or in flight.
5. Falls back to Crossref and OpenAlex only if the primaries came up empty.
6. Resolves the best **legal** full-text link available.
7. Runs a **separate** similar-paper stage that is not affected by step 4's cancellation.
8. Deduplicates across sources, ranks, and returns a single JSON response with per-source status.

---

## Legal and access policy

This service is built for legitimate academic discovery. It is deliberately constrained:

**It does not, and cannot:**

- bypass paywalls, authentication, CAPTCHA, DRM, or access restrictions
- evade API rate limits, or use proxy/IP rotation or key rotation
- crawl the open internet, or scrape publisher/aggregator web pages
- use pirated or unauthorized copies of papers

**What it does instead:**

- **Official APIs only.** Every source adapter targets a documented public API endpoint. Two sources return XML (arXiv Atom, NCBI EFetch) because that is the official machine-readable format they publish; no HTML page is ever parsed.
- **A code-defined host allowlist.** `src/security/UrlPolicy.ts` permits outbound requests to a fixed set of scholarly API hosts and nothing else. User input never determines *which* host is contacted — only the value of a query parameter on an allowlisted endpoint. Loopback, private, link-local, CGNAT and cloud-metadata addresses are refused outright.
- **Honest identification.** A single, descriptive, contactable `User-Agent` (`AcademicPaperFinder/1.0 (+<CONTACT_EMAIL>)`). No browser or third-party service is impersonated. `mailto` is sent to the Crossref and OpenAlex *polite pools* only when you configure a real address.
- **Rate limits are treated as a ceiling, not a target.** See [Rate limiting](#rate-limiting-retries-and-circuit-breaking).
- **`403 Forbidden` ends the attempt.** It is reported as `status: "unavailable"` and never retried, re-routed, or worked around.
- **Paywalled papers resolve to the publisher's official landing page**, labelled `accessType: "landing-page"` with `available: false`. That is the correct legal destination; the service will not point anywhere else.

### Getting a PDF

An open-access PDF is looked up from **every** configured full-text source,
regardless of which source supplied the metadata - whether a free copy exists
has nothing to do with where the record was found. The chain
(`FULLTEXT_SOURCE_PRIORITY`) is:

| Source | Key needed | Covers |
|---|---|---|
| **Europe PMC** | none | PMC, PLOS, MDPI, BMC, biomedical + preprints |
| **Unpaywall** | none, but needs a **real** `CONTACT_EMAIL` | the canonical open-access index, all disciplines |
| OpenAlex | none | OA locations (free tier has a daily quota) |
| PubMed / CORE / Semantic Scholar | varies | repository copies |

The papers in the result list get the same treatment, under a bounded budget
(`FULLTEXT_ENRICH_MS`), so a slow index degrades the links rather than the
response.

> **Set `CONTACT_EMAIL` to a real address.** Unpaywall rejects placeholders, so
> leaving the default disables the single best source of PDF links.

If no free copy exists, the answer is the official landing page and
`available: false`. There is no configuration that makes the service retrieve a
paywalled PDF.

Full-text link priority:

| Priority | `accessType`   | Meaning |
|---------:|----------------|---------|
| 1 | `open-access`  | Publisher- or repository-hosted PDF the source itself verified as public |
| 2 | `repository`   | Institutional/subject repository copy (PMC, arXiv, CORE) |
| 3 | `publisher`    | Publisher-provided public PDF |
| 4 | `landing-page` | Official landing page — used for paywalled work |
| 5 | `unavailable`  | Nothing legal to link to; we say so rather than guessing |

Links returned *by* sources are sanitized before being echoed to the client (`sanitizeExternalLink`): `http`/`https` only, no embedded credentials, and never an address inside a private network. The backend does not fetch these links — it hands them to the client.

---

## Architecture

```
                          CLIENT
                            │ HTTP
                            ▼
                 Native node:http server            src/server.ts
                            │
                            ▼
       CORS · security headers · routing            src/api/, src/security/Cors.ts
                            │
                            ▼
             Input validation (no URLs in)          src/security/InputValidator.ts
                            │
                            ▼
                  Search Orchestrator                src/search/SearchOrchestrator.ts
                            │
        ┌───────────────────┼───────────────────┐
        ▼                   ▼                   ▼
    Primary             Fallback           Similarity
    sources             sources             sources                src/sources/*
        └───────────────────┼───────────────────┘
                            ▼
                       HttpClient                    src/http/HttpClient.ts
                            │
                     URL policy (SSRF)               src/security/UrlPolicy.ts
                            │
                     Circuit breaker                 src/rateLimit/CircuitBreaker.ts
                            │
                      Rate limiter                   src/rateLimit/RateLimiter.ts
                            │
                      Retry policy                   src/rateLimit/RetryPolicy.ts
                            │
                      Official APIs
                            │
                            ▼
     Normalize → Deduplicate → Match → Rank          src/search/*
                            │
                            ▼
                     Final JSON response
```

Key design rules:

- **Adapters are isolated.** A source adapter receives an `HttpClient`, a `Cache`, config and a logger through its constructor. It knows nothing about the HTTP server or the orchestrator.
- **No provider-specific behaviour in the engine.** The orchestrator only ever calls the `AcademicSource` interface. Source quirks live in the adapter.
- **One place for HTTP.** Timeouts, retries, `Retry-After`, the User-Agent, the SSRF guard and the breaker all live in `HttpClient`, so behaviour cannot drift between sources.

---

## Installation

Requires **Node.js 20+** (18 works; `fetch` and `AbortSignal` must be native).

```bash
npm install
cp .env.example .env        # then edit CONTACT_EMAIL, and any API keys you have

npm run dev                 # development, with reload (tsx)
# or
npm run build && npm start   # production
```

The service **runs out of the box with no API keys at all** — DOAJ, PubMed Central, arXiv, Semantic Scholar, Crossref and OpenAlex are all usable unauthenticated. Only CORE is skipped without a key.

Verify:

```bash
curl http://localhost:3000/health
curl http://localhost:3000/api/sources/status
```

Scripts:

| Script | Purpose |
|--------|---------|
| `npm run dev` | Development server with reload |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run the compiled server |
| `npm test` | Run the test suite once |
| `npm run test:watch` | Watch mode |
| `npm run test:coverage` | Coverage report |
| `npm run lint` / `npm run typecheck` | Strict type check, no emit |

---

## Configuration

All configuration is environment-based and validated at startup — **invalid configuration fails fast** with a clear message rather than misbehaving later. See `.env.example` for the annotated full list.

### Runtime

| Variable | Default | Notes |
|---|---|---|
| `NODE_ENV` | `development` | `development` \| `production` \| `test` |
| `PORT` | `3000` | |
| `HOST` | `0.0.0.0` | |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` |
| `CONTACT_EMAIL` | `contact@example.com` | **Set this.** Used in the User-Agent and the polite pools. The placeholder is never sent as a `mailto`. |

### Search budget

| Variable | Default | Notes |
|---|---|---|
| `MAX_PRIMARY_SOURCES` | `5` | |
| `MAX_FALLBACK_SOURCES` | `2` | |
| `MAX_RESULTS_PER_SOURCE` | `20` | |
| `MAX_SIMILAR_PAPERS` | `10` | Upper bound of the similar list |
| `MIN_SIMILAR_PAPERS` | `8` | Below this, the top-up keyword pass runs |
| `MAX_SIMILAR_CANDIDATES` | `50` | Hard cap on the candidate pool |
| `SEARCH_DEADLINE_MS` | `45000` | Wall-clock budget for main-paper discovery |

### Matching and similarity

| Variable | Default | Notes |
|---|---|---|
| `EXACT_MATCH_THRESHOLD` | `0.95` | |
| `NEAR_EXACT_MATCH_THRESHOLD` | `0.85` | |
| `TITLE_EXACT_THRESHOLD` | `0.97` | Mandatory title gate for an exact verdict |
| `SIM_WEIGHT_TITLE` | `0.4` | Must sum to exactly 1.0 |
| `SIM_WEIGHT_ABSTRACT` | `0.3` | |
| `SIM_WEIGHT_KEYWORDS` | `0.2` | |
| `SIM_WEIGHT_TOPICS` | `0.1` | |

### Source ordering

| Variable | Default |
|---|---|
| `SOURCE_PRIORITY` | `doaj,pubmed,core,arxiv,semanticScholar` |
| `FALLBACK_SOURCE_PRIORITY` | `crossref,openalex` |
| `EXTENDED_SOURCE_PRIORITY` | `europepmc,datacite` |
| `SIMILAR_SOURCE_PRIORITY` | `semanticScholar,openalex,arxiv,core` |

### Recency

| Variable | Default | Notes |
|---|---|---|
| `RECENCY_BOOST` | `0.05` | Small nudge so the more recent of two comparably relevant papers ranks first. `0` disables it. |

Per-request, `fromYear` / `toYear` filter the result list. A paper whose year is
unknown is excluded when a range is given - we cannot verify it, and inventing a
year to keep it would be fabricating metadata. The identified `exactPaper` is
never filtered out: if you asked for a specific title or DOI, you get it.

### Traffic, cache and server

| Variable | Default | Notes |
|---|---|---|
| `DEFAULT_REQUESTS_PER_SECOND` | `1` | Used when a source has no specific policy |
| `DEFAULT_MAX_CONCURRENCY` | `1` | |
| `DEFAULT_MAX_RETRIES` | `2` | |
| `RETRY_BASE_DELAY_MS` | `1000` | |
| `RETRY_MAX_DELAY_MS` | `30000` | |
| `RETRY_JITTER` | `true` | |
| `REQUEST_TIMEOUT_MS` | `15000` | Per outbound request |
| `CIRCUIT_FAILURE_THRESHOLD` | `5` | |
| `CIRCUIT_COOLDOWN_MS` | `30000` | |
| `CIRCUIT_HALF_OPEN_SUCCESSES` | `2` | |
| `CACHE_TTL_SECONDS` | `3600` | `0` disables caching |
| `CACHE_MAX_ENTRIES` | `5000` | LRU bound |
| `MAX_BODY_SIZE` | `100kb` | |
| `SERVER_REQUEST_TIMEOUT_MS` | `60000` | |
| `CORS_ORIGINS` | `http://localhost:3000` | Comma separated |
| `CORS_ALLOW_CREDENTIALS` | `false` | Ignored when origins is `*` |

---

## API keys

Rules enforced by the code:

- Keys are read **only** from environment variables. None are hard-coded.
- Keys are **never** logged. `Logger` redacts credential-shaped field names *and* scrubs registered secret values wherever they appear in a message.
- Keys are **never** returned in a response. `GET /api/sources/status` reports only `true`/`false` per credential.
- If a key is **optional**, the public API is used without it.
- If a key is **required** and absent, the source reports itself unavailable and the orchestrator marks it `skipped`. No request is attempted and no credential is invented or guessed.

| Variable | Required? | Effect |
|---|---|---|
| `CORE_API_KEY` | **Required for CORE** | Without it, CORE is skipped. Free at <https://core.ac.uk/services/api> |
| `NCBI_API_KEY` | Optional | Raises PubMed from 3 → 10 req/s |
| `SEMANTIC_SCHOLAR_API_KEY` | Optional | Leaves the shared public pool |
| `DOAJ_API_KEY` | Optional | Only needed for DOAJ's write API; search is public |
| `CROSSREF_API_KEY` | Optional | Metadata Plus subscribers only |
| `OPENALEX_API_KEY` | Optional | Premium accounts only |
| `CROSSREF_MAILTO`, `OPENALEX_MAILTO` | Optional | Default to `CONTACT_EMAIL` when it is set to a real address |

---

## Supported sources

### Primary (searched first, in order)

| # | Source | Auth | Configured limit | Endpoint |
|---|--------|------|------------------|----------|
| 1 | **DOAJ** | none | 2 req/s, conc. 2 | `doaj.org/api/search/articles/{query}` |
| 2 | **PubMed Central / NCBI** | optional key | 3 req/s (10 keyed), conc. 1 | E-utilities `esearch` + `efetch` + PMC ID converter |
|   | *Note: field-tagged terms are sent **unquoted**. PubMed answers a quoted `[Title]`/`[Author]` phrase that is not in its phrase index with zero results plus a `quotedphrasesnotfound` warning, even when the article is present.* | | | |
| 3 | **CORE** | **key required** | 1 req/s **and** 10 req/min | `api.core.ac.uk/v3/search/works` |
| 4 | **arXiv** | none | **1 req / 3 s**, conc. 1 | `export.arxiv.org/api/query` (Atom) |
| 5 | **Semantic Scholar** | optional key | 1 req/s | Graph API `/paper/search`, `/paper/{id}` |

### Tier 2 - fallback (only when the primaries found nothing)

| # | Source | Auth | Configured limit | Endpoint |
|---|--------|------|------------------|----------|
| 6 | **Crossref** | none (`mailto` polite pool) | 5 req/s | `api.crossref.org/works` |
| 7 | **OpenAlex** | none (`mailto` polite pool) | 5 req/s | `api.openalex.org/works` |

> **OpenAlex daily quota.** The free tier has a daily credit allowance. Once
> spent, OpenAlex replies `429` with `Retry-After` set to the next reset
> (~12 hours). The service records that cooldown, reports the source as
> `rate-limited` with a readable ETA, and **carries on with the other tiers** -
> it never blocks waiting for it.

### Tier 3 - extended, last resort (only when tiers 1 AND 2 found nothing)

These index the material the earlier tiers routinely miss: preprints, theses,
technical reports and repository deposits (Zenodo, OSF, figshare).

| # | Source | Auth | Configured limit | Endpoint |
|---|--------|------|------------------|----------|
| 8 | **Europe PMC** | none | 2 req/s | `ebi.ac.uk/europepmc/webservices/rest/search` |
| 9 | **DataCite** | none | 2 req/s | `api.datacite.org/dois` |

Configured with `EXTENDED_SOURCE_PRIORITY` / `MAX_EXTENDED_SOURCES`.

### Similarity sources

`semanticScholar` (official recommendations), `openalex` (`related_works` + concept search), `arxiv` (category-scoped), `core`.

Every adapter documents, in its own file header: endpoint, authentication, rate limits, request format, response mapping, error handling and access policy.

---

## How searching works

### Phases

| Phase | Step |
|------:|------|
| 1 | Input normalization |
| 2 | Strong-identifier (DOI) search |
| 3 | Primary directory search |
| 4 | Exact-match verification |
| 5 | **Immediate cancellation** |
| 6 | Fallback search — only if still unresolved |
| 7 | Main-paper normalization + legal full-text resolution |
| 8 | Similar-paper discovery |
| 9 | Deduplication |
| 10 | Ranking |
| 11 | Final response |

### Normalization

**DOI** — all of these become `10.1234/example`:

```
10.1234/example      doi:10.1234/example      DOI: 10.1234/EXAMPLE
https://doi.org/10.1234/example                http://dx.doi.org/10.1234/example
info:doi/10.1234/example                       urn:doi:10.1234/example
(10.1234/example).                             https://doi.org/10.1234%2Fexample
```

**Title** — lowercased, Unicode NFKD-folded (`Schrödinger` → `schrodinger`), typographic quotes/dashes normalized, punctuation dropped, whitespace collapsed. Scientific terminology is preserved: `COVID-19`, `H5N1`, `BERT-base` survive intact. Stop-word removal is opt-in and uses a deliberately small list — words like *state*, *network*, *control* are **not** stop words.

**Author** — `John Doe`, `Doe, John`, `J. Doe`, `Doe J` (PubMed style) and `van der Berg, Anne` all normalize to a surname-anchored form. Matching is surname-first because surnames are stable across sources while given names are not.

### Strategy by input

**Case A — DOI supplied.** The DOI is the strongest identifier, so the dedicated `getByDOI` endpoint is used (never a free-text search). A confirmed DOI match is an immediate `exact` verdict at confidence 0.99.

**Case B — title supplied.** Query variants run from most to least precise, stopping as soon as one confirms:

```
exact title  →  title + author  →  fuzzy/normalized title  →  keywords
```

**Case C — keywords and/or authors only (discovery).** These name no specific paper, so the service does not pretend to identify one: `exactPaper` is `null` and the ranked, deduplicated results are returned in `similarPapers`, with a note explaining why. A keyword or author hit can never be promoted to `exact` **or** `near-exact` - both are claims about identifying one particular paper.

### The match engine

Both deterministic rules and a numeric score must agree.

`exact` requires **one** of:

- normalized DOIs are equal, **or**
- the title gate (similarity ≥ `TITLE_EXACT_THRESHOLD`) **and** strong author overlap **and** no conflicting year, **or**
- an identical normalized title with no supplied authors, where the weighted score also clears `EXACT_MATCH_THRESHOLD`

The author bar is 0.8, relaxed to 0.7 when titles are byte-identical after normalization — a surname-only query like `["Vaswani"]` against *Attention Is All You Need* is a genuine identification. A **contradicted** given name (same surname, different initial) scores 0.2 and still blocks promotion.

Component weights when no DOI is given: title 0.55, author 0.25, year 0.08, venue 0.05, keywords 0.07.

Crucially these are a weighted mean over **applicable components only**. A component the query gave nothing to compare on (no authors supplied, no year hint, no keywords) is *excluded* and its weight redistributed - it is missing evidence, not contrary evidence. Scoring it as zero instead would cap a title-only query at ~0.62 however perfectly the title matched, making an exact verdict structurally unreachable.

`matchType` is one of `exact` · `near-exact` · `similar` · `keyword`, always returned with a `confidence` in 0–1. When nothing clears the bar, the closest candidate is returned **honestly labelled** (with a note explaining why), never dressed up as exact.

### Deduplication

The same paper legitimately appears on six sources at once. Identity keys, strongest first:

1. DOI → 2. PMCID → 3. PMID → 4. arXiv id → 5. source + source id → 6. normalized-title fingerprint + author overlap → 7. fuzzy title (≥ 0.93) with corroboration

Two records with **different** DOIs are never merged — a preprint and its published version are distinct works. Merging keeps the richest value per field (longest abstract, fullest author list) and preserves **every** source's links in `sourceLinks`, with the contributing sources listed in `sources`.

---

## Immediate exact-match cancellation

This is a core behaviour, and the distinction that makes it work is the **two independent cancellation scopes**:

```
MAIN-PAPER SEARCH                        SIMILAR-PAPER SEARCH
─────────────────                        ────────────────────
Source 1 → no match                      (not started yet)
Source 2 → no match
Source 3 → EXACT MATCH ──┐
                         │
   mainController.abort() ┘   ← cancels queued AND in-flight siblings
   Crossref/OpenAlex never queried for main-paper discovery
                         │
                         ▼
              Verify + resolve full text
                         │
                         ▼
                                         Semantic Scholar → recommendations
                                         OpenAlex → related_works
                                         … until 8–10 unique results
```

Mechanically:

- Each source is verified **the instant it resolves**, not after the whole batch settles. The first exact match calls `controller.abort()` immediately.
- The signal reaches all the way down: `HttpClient` passes it to `fetch`, **and** the `RateLimiter` drops queued waiters on abort. A request still sitting in a rate-limit queue is discarded rather than eventually sent.
- Cancelled sources are reported as `status: "skipped"`, `error: "cancelled"` — an expected outcome, not a failure.
- The similar-paper stage runs under a **separate** controller and is unaffected.
- `stoppedEarly: true` and a note in `notes[]` record that it happened.

Measured against the live APIs: a title+author query that previously scanned all seven sources for ~34s now completes main-paper discovery in **~180ms**.

---

## Similar-paper discovery

Runs only after a main paper is identified, as a distinct stage.

1. **Semantic Scholar `/recommendations/v1/papers/forpaper/{id}`** — the official recommendation endpoint, and the primary engine here. API-provided similarity; the Semantic Scholar website is never scraped.
2. **OpenAlex `related_works`** — fetched in a *single* batched request via the `openalex_id` filter, plus a bounded concept/topic search.
3. Any other configured source exposing `getRelated` (e.g. arXiv category-scoped).
4. A keyword/topic top-up pass, only if the related endpoints produced fewer than `MIN_SIMILAR_PAPERS`.

Scoring (weights configurable):

| Component | Weight | Measure |
|---|---|---|
| Title | 40% | Token Jaccard + character Dice + edit distance |
| Abstract | 30% | Bag-of-words cosine |
| Keywords | 20% | Jaccard over keyword tokens |
| Topics | 10% | Jaccard over topic/concept labels |

A component with **no data on either side is excluded** and its weight redistributed, so a paper is not penalized because one source omitted an abstract. A small capped bonus (≤ 0.1) rewards a real bibliographic relationship — direct citation, shared references, shared venue — which is what separates *genuinely related* from *shares one keyword*.

The main paper is excluded from its own list, results are deduplicated, and the output is additionally filtered to **visibly distinct titles** so a preprint/published pair never appears twice. Everything is bounded by `MAX_SIMILAR_CANDIDATES`; nothing recurses or crawls.

---

## Rate limiting, retries and circuit breaking

### Rate limiter (`src/rateLimit/RateLimiter.ts`)

Token bucket + concurrency semaphore + FIFO queue, one per source.

- Refills continuously at `requestsPerSecond`. Capacity is capped at **one second of tokens**, so a long idle period cannot be cashed in as a burst.
- Optional `requestsPerMinute` sliding-window ceiling on top (used for CORE).
- FIFO, so one hot query cannot starve another.
- Every wait is cancellable via `AbortSignal` — this is what makes exact-match cancellation instant.
- `applyCooldown(ms)` puts the **whole source** on hold after a 429, not just the request that hit it.

### Retry policy (`src/rateLimit/RetryPolicy.ts`)

| Status | Behaviour |
|---|---|
| `400` | Never retried — the request is wrong |
| `401` | Never retried — reported as a source auth/configuration issue |
| `403` | Never retried, **never worked around** — reported as `unavailable` |
| `404` / `410` | Normal "not found"; does not count against the circuit breaker |
| `408` / `425` | Limited retry |
| `409` | Never retried |
| `429` | **`Retry-After` is honoured** (delta-seconds or HTTP date). Without it - or when it is `0`, which carries no usable guidance - exponential backoff applies. A 429 is never retried immediately, and always costs a source-wide cooldown |
| `5xx` | Limited exponential-backoff retry; a `Retry-After` on 503 is honoured |
| timeout / network | Limited exponential-backoff retry |
| cancelled | Never retried |

Backoff is `base × 2^attempt`, clamped to `RETRY_MAX_DELAY_MS`, producing the **1s → 2s → 4s → 8s** ladder. Jitter (on by default) draws uniformly over the upper half of the delay, so concurrent retries desynchronize without collapsing to ~0.

### Circuit breaker (`src/rateLimit/CircuitBreaker.ts`)

`CLOSED → OPEN → HALF_OPEN → CLOSED`. After `CIRCUIT_FAILURE_THRESHOLD` consecutive health-indicating failures the source is skipped for `CIRCUIT_COOLDOWN_MS`; then a **single** probe is allowed, and `CIRCUIT_HALF_OPEN_SUCCESSES` successes close it. One failed probe re-opens it immediately.

Crucially, a 404 or a 400 does **not** trip the breaker — those say nothing about the provider's health. Live state is visible at `GET /api/sources/status`.

### Timeouts

Every outbound request has a deadline (`REQUEST_TIMEOUT_MS`, default 15s) enforced with `AbortController`. A slow source can never hang the whole search; `SEARCH_DEADLINE_MS` bounds main-paper discovery overall.

### Source failure is isolated

One failing source never fails the request:

```
DOAJ → success | PMC → success | CORE → skipped (no key)
arXiv → success | Semantic Scholar → rate-limited | …continue
```

Every source's outcome is reported in `sourcesChecked` with an honest status.

---

## Caching

`src/cache/Cache.ts` defines the interface; `MemoryCache` is the in-process TTL + LRU implementation.

Cached: DOI lookups, title/keyword searches, ID lookups, EFetch batches, ID conversions, and the **whole** related-paper lookup for every source that has one (including OpenAlex's batched `related_works` call and its concept top-up search, and arXiv's category search). Keys are namespaced per source and operation.

Measured effect: a repeated DOI search drops from ~7.3s to ~0.26s and issues **zero** additional upstream requests.

A **rejected loader is never cached**, so a transient upstream failure is not memoized.

The orchestrator and every adapter depend on the `Cache` interface only — dropping in Redis later means implementing `Cache` and passing it to `createApp({ cache })`. No engine code changes.

---

## API reference

### `GET /health`

```json
{
  "status": "ok",
  "service": "academic-paper-search",
  "version": "1.0.0",
  "timestamp": "2026-08-28T06:53:58.440Z",
  "uptimeSeconds": 4
}
```

### `POST /api/papers/search`

All fields optional, but **at least one is required**. Unknown fields are rejected — there is no field through which a caller can make the backend fetch an arbitrary URL.

```jsonc
{
  "title": "Deepfake Detection Using Audio and Video",  // string, ≤ 500 chars
  "authors": ["John Doe"],                               // string[], ≤ 20 × 200 chars
  "keywords": ["deepfake", "audio", "video"],            // string[], ≤ 20 × 100 chars
  "doi": "10.1234/example",                              // any recognised DOI form
  "fromYear": 2020,                                      // optional, inclusive
  "toYear": 2024                                         // optional, inclusive
}
```

**Example — DOI lookup**

```bash
curl -X POST http://localhost:3000/api/papers/search \
  -H 'content-type: application/json' \
  -d '{"doi":"10.1371/journal.pone.0266462"}'
```

**Example — title + author**

```bash
curl -X POST http://localhost:3000/api/papers/search \
  -H 'content-type: application/json' \
  -d '{"title":"Attention Is All You Need","authors":["Vaswani"]}'
```

**Example — keywords only**

```bash
curl -X POST http://localhost:3000/api/papers/search \
  -H 'content-type: application/json' \
  -d '{"keywords":["deepfake","audio","multimodal"]}'
```

**Response** (abridged, from a real run):

```json
{
  "success": true,
  "query": { "doi": "10.1371/journal.pone.0266462", "strategy": "doi" },

  "exactPaper": {
    "id": "doi:10.1371/journal.pone.0266462",
    "title": "Blockchain technology in healthcare: A systematic review.",
    "authors": ["Huma Saeed", "Hassaan Malik", "Umair Bashir"],
    "abstract": "…",
    "doi": "10.1371/journal.pone.0266462",
    "year": 2022,
    "journal": "PLOS ONE",
    "keywords": ["blockchain", "healthcare"],
    "source": "DOAJ",
    "sources": ["DOAJ"],
    "sourceLinks": [
      { "source": "DOAJ", "landingPageUrl": "https://journals.plos.org/…" }
    ],
    "landingPageUrl": "https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0266462",
    "pdfUrl": "https://journals.plos.org/plosone/article/file?id=10.1371/journal.pone.0266462&type=printable",
    "isOpenAccess": true,
    "matchType": "exact",
    "confidence": 0.99
  },

  "fullText": {
    "available": true,
    "url": "https://journals.plos.org/plosone/article/file?id=10.1371/journal.pone.0266462&type=printable",
    "type": "pdf",
    "accessType": "open-access",
    "source": "OpenAlex",
    "license": "cc-by"
  },

  "similarPapers": [
    {
      "id": "doi:10.1109/access.2019.2917555",
      "title": "Blockchain Technology in Healthcare: A Systematic Review",
      "authors": ["…"],
      "doi": "10.1109/access.2019.2917555",
      "year": 2019,
      "matchType": "similar",
      "similarityScore": 0.6238,
      "confidence": 0.6238
    }
  ],

  "sourcesChecked": [
    { "name": "CORE",             "status": "skipped", "resultCount": 0,  "durationMs": 0,    "error": "CORE_API_KEY is not configured" },
    { "name": "arXiv",            "status": "success", "resultCount": 0,  "durationMs": 3 },
    { "name": "DOAJ",             "status": "success", "resultCount": 1,  "durationMs": 414 },
    { "name": "PubMed Central",   "status": "skipped", "resultCount": 0,  "durationMs": 422,  "error": "cancelled" },
    { "name": "Semantic Scholar", "status": "success", "resultCount": 20, "durationMs": 1887 },
    { "name": "OpenAlex",         "status": "success", "resultCount": 49, "durationMs": 4373 }
  ],

  "searchCompleted": true,
  "stoppedEarly": true,
  "timings": { "totalMs": 7102, "mainPaperMs": 423, "similarPapersMs": 5915 },
  "notes": ["Exact match confirmed by DOAJ; remaining main-paper requests were cancelled."]
}
```

**Not found** — still `200`, with `success: true`:

```json
{
  "success": true,
  "exactPaper": null,
  "fullText": null,
  "similarPapers": [],
  "sourcesChecked": [ "…" ],
  "searchCompleted": true,
  "stoppedEarly": false,
  "notes": ["No confident match was found in the configured academic sources."]
}
```

`SourceStatus.status` is one of `success` · `failed` · `skipped` · `rate-limited` · `unavailable`.

### `GET /api/papers/:id`

`id` is `<scheme>:<value>`, URL-encoded. Supported schemes: `doi`, `pmid`, `pmcid`, `arxiv`, `s2`, `openalex`, `core`, `doaj`. Every value is format-validated, so this route cannot be used to reach an arbitrary address.

```bash
curl "http://localhost:3000/api/papers/doi%3A10.1371%2Fjournal.pone.0266462"
curl "http://localhost:3000/api/papers/arxiv%3A1706.03762"
```

```json
{ "success": true, "paper": { "…": "…" }, "fullText": { "…": "…" } }
```

### `GET /api/sources/status`

Per-source availability, capabilities, circuit state, rate-limiter state, cache stats and a **redacted** configuration snapshot (credentials appear only as booleans).

### Errors

```json
{
  "success": false,
  "error": {
    "code": "INVALID_REQUEST",
    "message": "At least one search field is required",
    "details": { "allowed": ["title", "authors", "keywords", "doi"] }
  }
}
```

| Status | Codes |
|---|---|
| `400` | `INVALID_REQUEST`, `INVALID_DOI`, `INVALID_PAPER_ID` |
| `403` | `ORIGIN_NOT_ALLOWED` |
| `404` | `NOT_FOUND`, `PAPER_NOT_FOUND` |
| `405` | `METHOD_NOT_ALLOWED` |
| `413` | `PAYLOAD_TOO_LARGE` |
| `415` | `UNSUPPORTED_MEDIA_TYPE` |
| `429` | `UPSTREAM_RATE_LIMITED` (with `Retry-After`) |
| `500` | `INTERNAL_ERROR` — generic message in production; **never** a stack trace |

### Server security

Request body cap (`MAX_BODY_SIZE`, enforced **while streaming**, not after buffering), JSON validation, request timeouts, `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Content-Security-Policy`, configurable CORS with `Vary: Origin`, and a client-supplied `x-request-id` that is echoed only when it matches a safe pattern.

---

## Testing

```bash
npm test              # 303 tests
npm run test:watch
npm run test:coverage
```

**No test contacts a real academic API.** External providers are mocked; where timing matters the suite either fakes the clock or runs against a local `node:http` origin it starts itself.

Layout:

| File | Covers |
|---|---|
| `normalization.test.ts` | DOI / title / author / keyword normalization |
| `matching.test.ts` | similarity primitives, match engine, dedup, ranking |
| `rateLimit.test.ts` | limiter, retry policy, circuit breaker (fake timers) |
| `httpClient.test.ts` | HTTP client rules with a stubbed `fetch` |
| `httpBehaviour.test.ts` | the same rules against a **real local origin server** - real sockets, real clocks |
| `sources.test.ts` | all seven adapters' request shape and response mapping |
| `orchestrator.test.ts` | the search pipeline, early stop, fallback, similar phase |
| `server.test.ts` | HTTP API end to end |
| `concurrency.test.ts` | per-request cancellation scoping, concurrent users |
| `security.test.ts` | SSRF guard, input validation, CORS, secret redaction |
| `cache.test.ts` | TTL, LRU, read-through |
| `cli.test.ts` | manual client input parsing and mode selection |
| `regressions.test.ts` | one block per bug found by QA against the live APIs |

### Manual search client

```bash
npm run dev        # terminal 1: the server
npm run search     # terminal 2: the client
```

It asks what you are searching by, so nothing is guessed from your text:

```
What are you searching by?
  1) Paper title             the full or partial title of one paper
  2) Author name             any format; use ";" between several authors
  3) Keywords / topic        comma separated
  4) DOI                     bare, doi: prefixed, or a doi.org URL
  5) Anything (auto-detect)  mixed input; prefixes like @Name and doi: still work
choice> 2
author(s)> Yoshua Bengio
```

`2 Yoshua Bengio` does both steps in one line. A year filter can be appended to
any value: `+ since: 2020`, `+ until: 2024`, `+ year: 2020-2024`. Commands:
`:help`, `:status`, `:json` (raw JSON), `:quit`.

One-shot: `npm run search -- --author "Bengio" --since 2020`.

Output shows the identified paper, its **PDF link** where one is openly
available, the ranked similar papers (each with its own PDF link when there is
one), and the per-source status table.

### Manual adapter probe

`npm test` is hermetic, so it cannot catch a provider changing its API. A separate, deliberately-run probe checks each adapter against the real endpoint with one small request per source:

```bash
npx tsx tests/manual/sourceProbe.ts              # all sources
npx tsx tests/manual/sourceProbe.ts doaj pubmed  # just these
```

It reports per-method success, latency, and any data-quality problem (malformed DOI/URL, undecoded entity, placeholder author). This is how the PubMed query-syntax bug was found.

Covered:

- DOI / title / author / keyword normalization; Unicode and scientific-terminology preservation
- Title, author, abstract similarity primitives
- Exact DOI match, exact title match, and the **false-positive guards** (similar title ≠ exact; contradicted author blocks promotion; keyword hits never reach exact)
- Deduplication across six sources, merge behaviour, different-DOI protection
- Similar-paper ranking, weight redistribution, citation bonus, distinct-title output
- Rate limiting: **1 req/s is provably not exceeded**, no idle burst accumulation, concurrency cap, per-minute ceiling, FIFO order, cancellation, drain
- 429 + `Retry-After` — proves the client **waits** rather than retrying immediately; exponential backoff ladder; jitter bounds
- Every documented HTTP status behaviour, including "403 is never retried"
- Circuit breaker state machine, including "404 does not trip it"
- Timeouts, `AbortController` cancellation, timeout-vs-cancellation distinction
- Per-request cancellation scoping: user A's exact match must not cancel user B's concurrent search
- **The integration test from the spec**: sources A and B return nothing, source C returns the exact paper — asserting that C identifies it, that the in-flight sibling is cancelled mid-request, that Crossref/OpenAlex are never called for main-paper discovery, and that the similar-paper phase still runs afterwards
- Fallback searching, missing API keys, source failure, partial results
- Legal access: paywalled → landing page; open-access → PDF; repository → repository URL; private-network URL → rejected
- SSRF guard, input validation, oversized body, CORS, secret redaction
- All seven adapters' response mapping, against fixture payloads

---

## Production deployment

```bash
npm ci --omit=dev && npm install --no-save typescript && npm run build
NODE_ENV=production node dist/server.js
```

Checklist:

- [ ] `NODE_ENV=production` — suppresses detailed error messages and stack traces
- [ ] `CONTACT_EMAIL` set to a real, monitored address (the server warns on startup if not)
- [ ] `CORS_ORIGINS` set to your frontend's origin — a wildcard in production must be set *explicitly* as `CORS_ORIGINS=*`, otherwise startup fails
- [ ] `CORE_API_KEY` set if you want CORE
- [ ] Secrets injected as environment variables, not committed (`.env` is git-ignored)
- [ ] Run behind a reverse proxy for TLS; add per-client rate limiting there — this service limits its **outbound** traffic, not inbound
- [ ] Ship the JSON logs to your aggregator; `event` is the stable field to index on
- [ ] Monitor `GET /api/sources/status` for `OPEN` circuits
- [ ] Consider Redis for the cache if you run multiple instances

`SIGINT`/`SIGTERM` drain rate-limiter queues and close the server gracefully, with a 10s hard cap.

---

## Adding a new source adapter

Three steps, no engine changes.

**1. Write the adapter** in `src/sources/<name>/<Name>Source.ts`, extending `BaseSource`:

```ts
import type { PaperResult } from "../../models/Paper.js";
import type { PaperSearchQuery } from "../../models/Search.js";
import { BaseSource, buildPaper, cleanAuthors, cleanDoi, cleanYear } from "../BaseSource.js";

/**
 * MySource
 * ========
 * API endpoint   : https://api.mysource.org/v1/search
 * Authentication : optional MYSOURCE_API_KEY (Bearer)
 * Rate limits    : 5 req/s documented -> we configure 2 req/s
 * Request format : ?q=<free text>&limit=<n>
 * Response map   : items[].name -> title, items[].creators[] -> authors, …
 * Error handling : 404 -> no results; 429 handled by the shared HttpClient
 * Access policy  : links only to publisher-hosted open-access PDFs
 */
export class MySource extends BaseSource {
  readonly name = "MySource";
  readonly key = "mysource";

  async search(query: PaperSearchQuery, signal?: AbortSignal): Promise<PaperResult[]> {
    const limit = this.resultLimit(query);
    const text = query.title ?? query.keywords?.join(" ") ?? query.freeText;
    if (!text) return [];

    return this.withCache("search", [text, limit], async () =>
      this.notFoundAsEmpty(async () => {
        const { data } = await this.http.getJson<MyResponse>("https://api.mysource.org/v1/search", {
          query: { q: text, limit },
          signal,
          operation: "search",
        });
        return (data.items ?? [])
          .map((item) => buildPaper({
            title: item.name,
            authors: cleanAuthors(item.creators),
            doi: cleanDoi(item.doi),
            year: cleanYear(item.published),
            source: this.name,
            landingPageUrl: item.url,
            pdfUrl: item.openAccessPdf,
          }))
          .filter((p): p is PaperResult => p !== undefined);
      }, []),
    );
  }

  // Optional, implement what the API actually supports:
  //   getByDOI(doi, signal)                 - dedicated identifier endpoint
  //   getById(id, signal)                   - native id lookup
  //   getFullText(paper, signal)            - when the API reports OA status
  //   getRelated(paper, limit, signal)      - official related/recommended endpoint
  //   isAvailable() / unavailableReason()   - when an API key is REQUIRED
}
```

**2. Allowlist its host** in `src/security/UrlPolicy.ts` (`ALLOWED_API_HOSTS`) — outbound requests to unlisted hosts are refused.

**3. Register it and set its traffic policy:**

```ts
// src/config/sources.ts
export const SOURCE_FACTORIES = {
  // …
  mysource: (deps) => new MySource(deps),
};

// authHeadersFor(), if it needs a credential:
case "mysource":
  return config.apiKeys.mysource ? { authorization: `Bearer ${config.apiKeys.mysource}` } : {};
```

```ts
// src/config/rateLimits.ts — at or BELOW the provider's published limit
const BASE_LIMITS = {
  // …
  mysource: { requestsPerSecond: 2, maxConcurrency: 1, maxRetries: 2 },
};
```

Then add the key to `SOURCE_PRIORITY`, `FALLBACK_SOURCE_PRIORITY` or `SIMILAR_SOURCE_PRIORITY` (and to `.env.example` if it takes a credential). The orchestrator, match engine, deduplicator and HTTP stack need no modification.

Before adding a source, confirm it offers an **official public API** and that your use complies with its terms.

---

## Project structure

```
src/
  server.ts                    native node:http server + composition root
  config/
    env.ts                     environment loading, validation, redaction
    sources.ts                 source registry / composition root for adapters
    rateLimits.ts              per-source traffic policies
  http/
    HttpClient.ts              the single place outbound HTTP happens
    HttpError.ts               typed transport errors
    RequestOptions.ts          request/response shapes
  models/
    Paper.ts  Search.ts  Source.ts  FullText.ts
  api/
    routes.ts                  router + JSON response helpers
    paperRoutes.ts             POST /api/papers/search, GET /api/papers/:id
    healthRoutes.ts            GET /health, GET /api/sources/status
    readBody.ts                streaming body reader with a byte cap
  search/
    SearchOrchestrator.ts      phases 1–11
    QueryBuilder.ts            normalization + progressive query variants
    MatchEngine.ts             exact-match verification
    RankingEngine.ts           similarity scoring + ranking
    SimilarPaperEngine.ts      similar-paper discovery stage
    Deduplicator.ts            cross-source merging
  sources/
    BaseSource.ts              shared adapter behaviour + metadata hygiene
    doaj/  pubmed/  core/  arxiv/  semanticScholar/  crossref/  openalex/
  rateLimit/
    RateLimiter.ts  RetryPolicy.ts  CircuitBreaker.ts
  cache/
    Cache.ts  MemoryCache.ts
  security/
    InputValidator.ts  Cors.ts  UrlPolicy.ts
  logging/
    Logger.ts                  structured JSON logs with secret redaction
  utils/
    normalizeDoi.ts  normalizeTitle.ts  normalizeAuthor.ts
    normalizeKeywords.ts  similarity.ts  xml.ts

tests/
  normalization.test.ts  matching.test.ts  rateLimit.test.ts
  httpClient.test.ts     security.test.ts  cache.test.ts
  sources.test.ts        orchestrator.test.ts  server.test.ts
  helpers/mockSource.ts

.env.example  .gitignore  package.json  tsconfig.json  vitest.config.ts
```

---

## License

MIT. You are responsible for complying with the terms of service of each academic API you enable.
