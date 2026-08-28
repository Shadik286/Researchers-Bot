import { describe, expect, it } from "vitest";

import { MemoryCache } from "../src/cache/MemoryCache.js";
import { buildConfig, type AppConfig } from "../src/config/env.js";
import { HttpClient } from "../src/http/HttpClient.js";
import { Logger } from "../src/logging/Logger.js";
import type { PaperResult } from "../src/models/Paper.js";
import { CircuitBreaker } from "../src/rateLimit/CircuitBreaker.js";
import { RateLimiter } from "../src/rateLimit/RateLimiter.js";
import { RetryPolicy } from "../src/rateLimit/RetryPolicy.js";
import { UrlPolicy } from "../src/security/UrlPolicy.js";
import { buildPaper, deriveFullText, type SourceDependencies } from "../src/sources/BaseSource.js";
import { ArxivSource, normalizeArxivId } from "../src/sources/arxiv/ArxivSource.js";
import { CoreSource } from "../src/sources/core/CoreSource.js";
import { CrossrefSource } from "../src/sources/crossref/CrossrefSource.js";
import { DoajSource } from "../src/sources/doaj/DoajSource.js";
import { OpenAlexSource, normalizeOpenAlexId, reconstructAbstract } from "../src/sources/openalex/OpenAlexSource.js";
import { PubMedSource } from "../src/sources/pubmed/PubMedSource.js";
import { SemanticScholarSource } from "../src/sources/semanticScholar/SemanticScholarSource.js";
import { findAll, parseXml, textOf, textOfChild } from "../src/utils/xml.js";

/**
 * Adapter tests. Every upstream response here is a fixture served by a stub
 * `fetch`; no real academic API is contacted.
 */

const silentLogger = new Logger({ level: "error", sink: () => undefined });

interface StubbedSource<T> {
  source: T;
  urls: string[];
  headers: Record<string, string>[];
}

function makeDeps(
  key: string,
  responder: (url: string) => { status?: number; body: string; headers?: Record<string, string> },
  env: Record<string, string> = {},
): { deps: SourceDependencies; urls: string[]; headers: Record<string, string>[]; config: AppConfig } {
  const urls: string[] = [];
  const headers: Record<string, string>[] = [];
  const config = buildConfig({ NODE_ENV: "test", CACHE_TTL_SECONDS: "0", ...env });

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    urls.push(String(input));
    headers.push((init?.headers ?? {}) as Record<string, string>);
    const stub = responder(String(input));
    return new Response(stub.body, { status: stub.status ?? 200, headers: stub.headers });
  }) as typeof fetch;

  const httpClient = new HttpClient({
    source: key,
    rateLimiter: new RateLimiter({ name: key, requestsPerSecond: 1000, maxConcurrency: 4, maxRetries: 0 }),
    circuitBreaker: new CircuitBreaker({ name: key, failureThreshold: 5, cooldownMs: 1000, halfOpenSuccesses: 1 }),
    retryPolicy: new RetryPolicy({ maxRetries: 0, baseDelayMs: 10, maxDelayMs: 100, jitter: false }),
    urlPolicy: new UrlPolicy(),
    logger: silentLogger,
    userAgent: config.userAgent,
    defaultTimeoutMs: 5000,
    defaultHeaders:
      key === "core" && config.apiKeys.core ? { authorization: `Bearer ${config.apiKeys.core}` } : {},
    fetchImpl,
  });

  return {
    deps: {
      httpClient,
      cache: new MemoryCache({ defaultTtlSeconds: 0, maxEntries: 10 }),
      config,
      logger: silentLogger,
    },
    urls,
    headers,
    config,
  };
}

describe("DoajSource", () => {
  const fixture = JSON.stringify({
    total: 1,
    results: [
      {
        id: "abcdef1234567890",
        bibjson: {
          title: "Deepfake Detection Using Audio and Video",
          abstract: "<p>A multimodal approach.</p>",
          year: "2024",
          author: [{ name: "Doe, John" }, { name: "Roe, Jane" }],
          identifier: [
            { type: "doi", id: "10.1234/example" },
            { type: "eissn", id: "1234-5678" },
          ],
          journal: { title: "Journal of Open Research", publisher: "Open Press" },
          keywords: ["deepfake", "audio"],
          subject: [{ term: "Computer Science" }],
          link: [
            { type: "fulltext", url: "https://journal.example.org/article/1" },
            { type: "fulltext", url: "https://journal.example.org/article/1.pdf", content_type: "PDF" },
          ],
        },
      },
    ],
  });

  it("maps a DOAJ article onto the canonical model", async () => {
    const { deps, urls } = makeDeps("doaj", () => ({ body: fixture }));
    const source = new DoajSource(deps);

    const results = await source.search({ title: "Deepfake Detection Using Audio and Video" });

    expect(urls[0]).toContain("https://doaj.org/api/search/articles/");
    expect(urls[0]).toContain("bibjson.title");

    const paper = results[0]!;
    expect(paper.title).toBe("Deepfake Detection Using Audio and Video");
    expect(paper.authors).toEqual(["John Doe", "Jane Roe"]);
    expect(paper.abstract).toBe("A multimodal approach.");
    expect(paper.doi).toBe("10.1234/example");
    expect(paper.year).toBe(2024);
    expect(paper.journal).toBe("Journal of Open Research");
    expect(paper.pdfUrl).toBe("https://journal.example.org/article/1.pdf");
    expect(paper.isOpenAccess).toBe(true);
    expect(paper.source).toBe("DOAJ");
  });

  it("only accepts a DOI lookup whose own DOI matches", async () => {
    const wrongDoi = JSON.stringify({
      results: [{ id: "x1", bibjson: { title: "Cites the DOI", identifier: [{ type: "doi", id: "10.9999/other" }] } }],
    });
    const { deps } = makeDeps("doaj", () => ({ body: wrongDoi }));
    expect(await new DoajSource(deps).getByDOI("10.1234/example")).toBeNull();
  });

  it("treats a 404 as no results rather than an error", async () => {
    const { deps } = makeDeps("doaj", () => ({ status: 404, body: "{}" }));
    await expect(new DoajSource(deps).search({ title: "x" })).resolves.toEqual([]);
  });

  it("needs no API key", () => {
    const { deps } = makeDeps("doaj", () => ({ body: "{}" }));
    expect(new DoajSource(deps).isAvailable()).toBe(true);
  });
});

describe("PubMedSource", () => {
  const esearch = JSON.stringify({ esearchresult: { count: "1", idlist: ["12345678"] } });
  const efetch = `<?xml version="1.0"?>
<PubmedArticleSet>
  <PubmedArticle>
    <MedlineCitation>
      <PMID Version="1">12345678</PMID>
      <Article>
        <Journal>
          <JournalIssue><PubDate><Year>2023</Year></PubDate></JournalIssue>
          <Title>Journal of Medical Imaging</Title>
        </Journal>
        <ArticleTitle>Deep Learning for Medical Image Analysis</ArticleTitle>
        <Abstract>
          <AbstractText Label="BACKGROUND">Imaging is hard.</AbstractText>
          <AbstractText Label="RESULTS">Deep nets help.</AbstractText>
        </Abstract>
        <AuthorList>
          <Author><LastName>Doe</LastName><ForeName>John</ForeName></Author>
          <Author><CollectiveName>The Imaging Group</CollectiveName></Author>
        </AuthorList>
      </Article>
      <MeshHeadingList>
        <MeshHeading><DescriptorName>Deep Learning</DescriptorName></MeshHeading>
      </MeshHeadingList>
    </MedlineCitation>
    <PubmedData>
      <ArticleIdList>
        <ArticleId IdType="pubmed">12345678</ArticleId>
        <ArticleId IdType="doi">10.1234/pubmed-example</ArticleId>
        <ArticleId IdType="pmc">PMC7654321</ArticleId>
      </ArticleIdList>
    </PubmedData>
  </PubmedArticle>
</PubmedArticleSet>`;

  const responder = (url: string): { body: string } => {
    if (url.includes("esearch")) return { body: esearch };
    if (url.includes("efetch")) return { body: efetch };
    return { body: JSON.stringify({ records: [{ pmid: "12345678", pmcid: "PMC7654321" }] }) };
  };

  it("maps a PubMed record including PMC identifiers", async () => {
    const { deps } = makeDeps("pubmed", responder);
    const results = await new PubMedSource(deps).search({ title: "Deep Learning for Medical Image Analysis" });

    const paper = results[0]!;
    expect(paper.title).toBe("Deep Learning for Medical Image Analysis");
    expect(paper.authors).toEqual(["John Doe", "The Imaging Group"]);
    expect(paper.abstract).toContain("BACKGROUND: Imaging is hard.");
    expect(paper.doi).toBe("10.1234/pubmed-example");
    expect(paper.pmid).toBe("12345678");
    expect(paper.pmcid).toBe("PMC7654321");
    expect(paper.year).toBe(2023);
    expect(paper.keywords).toContain("deep learning");
    expect(paper.landingPageUrl).toBe("https://pmc.ncbi.nlm.nih.gov/articles/PMC7654321/");
    expect(paper.isOpenAccess).toBe(true);
  });

  it("sends tool and email, and the API key only when configured", async () => {
    const withoutKey = makeDeps("pubmed", responder);
    await new PubMedSource(withoutKey.deps).search({ title: "x" });
    expect(withoutKey.urls[0]).toContain("tool=AcademicPaperFinder");
    expect(withoutKey.urls[0]).not.toContain("api_key");

    const withKey = makeDeps("pubmed", responder, { NCBI_API_KEY: "secret-ncbi-key" });
    await new PubMedSource(withKey.deps).search({ title: "x" });
    expect(withKey.urls[0]).toContain("api_key=secret-ncbi-key");
  });

  it("resolves a PMC full text for a paper that has a PMCID", async () => {
    const { deps } = makeDeps("pubmed", responder);
    const paper = buildPaper({ title: "T", source: "PubMed Central", pmcid: "PMC7654321" })!;
    const fullText = await new PubMedSource(deps).getFullText(paper);
    expect(fullText).toMatchObject({ available: true, accessType: "repository" });
    expect(fullText!.url).toContain("pmc.ncbi.nlm.nih.gov/articles/PMC7654321");
  });

  it("returns an empty list when esearch finds nothing", async () => {
    const { deps } = makeDeps("pubmed", () => ({ body: JSON.stringify({ esearchresult: { idlist: [] } }) }));
    await expect(new PubMedSource(deps).search({ title: "nothing" })).resolves.toEqual([]);
  });
});

describe("CoreSource", () => {
  const fixture = JSON.stringify({
    totalHits: 1,
    results: [
      {
        id: 987654,
        title: "Open Repository Paper",
        abstract: "An abstract.",
        doi: "10.1234/core-example",
        yearPublished: 2022,
        authors: [{ name: "Jane Roe" }],
        publisher: "University Press",
        journals: [{ title: "Repository Journal" }],
        downloadUrl: "https://repository.example.org/download/987654.pdf",
        subjects: ["open science"],
        fieldsOfStudy: ["Computer Science"],
        citationCount: 12,
      },
    ],
  });

  it("is skipped gracefully when CORE_API_KEY is absent", async () => {
    const { deps, urls } = makeDeps("core", () => ({ body: fixture }));
    const source = new CoreSource(deps);

    expect(source.isAvailable()).toBe(false);
    expect(source.unavailableReason()).toContain("CORE_API_KEY");
    // Crucially, no request is attempted and no credential is invented.
    await expect(source.search({ title: "x" })).resolves.toEqual([]);
    expect(urls).toHaveLength(0);
  });

  it("searches and maps a work when the key is configured", async () => {
    const { deps, headers } = makeDeps("core", () => ({ body: fixture }), { CORE_API_KEY: "core-test-key" });
    const source = new CoreSource(deps);
    expect(source.isAvailable()).toBe(true);

    const paper = (await source.search({ title: "Open Repository Paper" }))[0]!;
    expect(paper.title).toBe("Open Repository Paper");
    expect(paper.doi).toBe("10.1234/core-example");
    expect(paper.pdfUrl).toBe("https://repository.example.org/download/987654.pdf");
    expect(paper.isOpenAccess).toBe(true);
    expect(paper.citationCount).toBe(12);
    expect(headers[0]!.authorization).toBe("Bearer core-test-key");
  });
});

describe("ArxivSource", () => {
  const atom = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
  <entry>
    <id>http://arxiv.org/abs/2101.00001v2</id>
    <published>2021-01-01T00:00:00Z</published>
    <title>Attention Mechanisms for Audio-Visual Deepfake Detection</title>
    <summary>We present a transformer that fuses audio and video streams.</summary>
    <author><name>John Doe</name></author>
    <author><name>Jane Roe</name></author>
    <arxiv:doi>10.1234/arxiv-example</arxiv:doi>
    <arxiv:journal_ref>Proc. of ICML 2021</arxiv:journal_ref>
    <link href="http://arxiv.org/abs/2101.00001v2" rel="alternate" type="text/html"/>
    <link title="pdf" href="http://arxiv.org/pdf/2101.00001v2" rel="related" type="application/pdf"/>
    <category term="cs.CV" scheme="http://arxiv.org/schemas/atom"/>
  </entry>
</feed>`;

  it("parses the Atom feed into the canonical model", async () => {
    const { deps, urls } = makeDeps("arxiv", () => ({ body: atom }));
    const paper = (await new ArxivSource(deps).search({ title: "Attention Mechanisms" }))[0]!;

    expect(urls[0]).toContain("https://export.arxiv.org/api/query");
    expect(urls[0]).toContain("search_query=ti");
    expect(paper.title).toBe("Attention Mechanisms for Audio-Visual Deepfake Detection");
    expect(paper.authors).toEqual(["John Doe", "Jane Roe"]);
    expect(paper.arxivId).toBe("2101.00001v2");
    expect(paper.doi).toBe("10.1234/arxiv-example");
    expect(paper.year).toBe(2021);
    expect(paper.pdfUrl).toBe("http://arxiv.org/pdf/2101.00001v2");
    expect(paper.topics).toEqual(["cs.CV"]);
    expect(paper.isOpenAccess).toBe(true);
  });

  it("resolves a DataCite arXiv DOI back to the arXiv id", async () => {
    const { deps, urls } = makeDeps("arxiv", () => ({ body: atom }));
    const paper = await new ArxivSource(deps).getByDOI("10.48550/arXiv.2101.00001");
    expect(paper?.arxivId).toBe("2101.00001v2");
    expect(urls[0]).toContain("id_list=2101.00001");
  });

  it("returns null for a publisher DOI it cannot resolve", async () => {
    const { deps, urls } = makeDeps("arxiv", () => ({ body: atom }));
    expect(await new ArxivSource(deps).getByDOI("10.1109/some.publisher.doi")).toBeNull();
    expect(urls).toHaveLength(0);
  });

  it("normalizes arXiv identifiers", () => {
    expect(normalizeArxivId("arXiv:2101.00001")).toBe("2101.00001");
    expect(normalizeArxivId("https://arxiv.org/abs/2101.00001v3")).toBe("2101.00001v3");
    expect(normalizeArxivId("hep-th/9901001")).toBe("hep-th/9901001");
    expect(normalizeArxivId("not-an-id")).toBeUndefined();
  });
});

describe("SemanticScholarSource", () => {
  const paperJson = {
    paperId: "a".repeat(40),
    externalIds: { DOI: "10.1234/s2-example", ArXiv: "2101.00001", PubMed: "12345678" },
    title: "Multimodal Deepfake Detection",
    abstract: "We study multimodal detection.",
    year: 2023,
    venue: "NeurIPS",
    publicationVenue: { name: "NeurIPS", type: "conference" },
    authors: [{ name: "John Doe" }],
    fieldsOfStudy: ["Computer Science"],
    openAccessPdf: { url: "https://proceedings.example.org/paper.pdf", status: "GOLD" },
    isOpenAccess: true,
    citationCount: 42,
    url: "https://www.semanticscholar.org/paper/aaa",
  };

  it("maps a paper, classifying a conference venue correctly", async () => {
    const { deps } = makeDeps("semanticScholar", () => ({ body: JSON.stringify({ data: [paperJson] }) }));
    const paper = (await new SemanticScholarSource(deps).search({ title: "Multimodal Deepfake Detection" }))[0]!;

    expect(paper.doi).toBe("10.1234/s2-example");
    expect(paper.conference).toBe("NeurIPS");
    expect(paper.journal).toBeUndefined();
    expect(paper.arxivId).toBe("2101.00001");
    expect(paper.pmid).toBe("12345678");
    expect(paper.pdfUrl).toBe("https://proceedings.example.org/paper.pdf");
    expect(paper.citationCount).toBe(42);
  });

  it("uses the official recommendations endpoint for related papers", async () => {
    const { deps, urls } = makeDeps("semanticScholar", () => ({
      body: JSON.stringify({ recommendedPapers: [paperJson] }),
    }));
    const main = buildPaper({ title: "Main", source: "Semantic Scholar", doi: "10.1234/main" })!;
    const related = await new SemanticScholarSource(deps).getRelated(main, 10);

    expect(urls[0]).toContain("/recommendations/v1/papers/forpaper/DOI%3A10.1234%2Fmain");
    expect(related[0]!.matchType).toBe("similar");
  });

  it("works without an API key and sends the header only when configured", async () => {
    const noKey = makeDeps("semanticScholar", () => ({ body: JSON.stringify({ data: [] }) }));
    expect(new SemanticScholarSource(noKey.deps).isAvailable()).toBe(true);
    expect(SemanticScholarSource.headersFor(undefined)).toEqual({});
    expect(SemanticScholarSource.headersFor("s2-key")).toEqual({ "x-api-key": "s2-key" });
  });
});

describe("CrossrefSource", () => {
  const work = {
    DOI: "10.1234/crossref-example",
    title: ["A Paywalled Journal Article"],
    author: [{ given: "John", family: "Doe" }, { name: "The Consortium" }],
    issued: { "date-parts": [[2020, 5, 1]] },
    abstract: "<jats:p>An abstract in JATS.</jats:p>",
    "container-title": ["Journal of Closed Access"],
    publisher: "Big Publisher",
    subject: ["Machine Learning"],
    type: "journal-article",
    URL: "https://doi.org/10.1234/crossref-example",
    "is-referenced-by-count": 7,
    reference: [{ DOI: "10.1234/cited-work" }],
  };

  it("maps a Crossref work and strips JATS markup from the abstract", async () => {
    const { deps, urls } = makeDeps("crossref", () => ({ body: JSON.stringify({ message: work }) }), {
      CONTACT_EMAIL: "ops@university.example",
    });
    const paper = await new CrossrefSource(deps).getByDOI("10.1234/crossref-example");

    expect(urls[0]).toContain("api.crossref.org/works/10.1234%2Fcrossref-example");
    expect(urls[0]).toContain("mailto=");
    expect(paper!.title).toBe("A Paywalled Journal Article");
    expect(paper!.authors).toEqual(["John Doe", "The Consortium"]);
    expect(paper!.abstract).toBe("An abstract in JATS.");
    expect(paper!.year).toBe(2020);
    expect(paper!.journal).toBe("Journal of Closed Access");
    expect(paper!.referenceIds).toEqual(["10.1234/cited-work"]);
    // Crossref does not assert open access, so it must stay unknown.
    expect(paper!.isOpenAccess).toBeUndefined();
  });

  it("uses query.bibliographic for a title search", async () => {
    const { deps, urls } = makeDeps("crossref", () => ({ body: JSON.stringify({ message: { items: [work] } }) }));
    await new CrossrefSource(deps).search({ title: "A Paywalled Journal Article", authors: ["John Doe"] });
    expect(urls[0]).toContain("query.bibliographic=");
    expect(urls[0]).toContain("query.author=");
  });
});

describe("OpenAlexSource", () => {
  const work = {
    id: "https://openalex.org/W2741809807",
    doi: "https://doi.org/10.1234/openalex-example",
    title: "An Open Access Work",
    publication_year: 2021,
    type: "journal-article",
    authorships: [{ author: { display_name: "Jane Roe" } }],
    primary_location: { landing_page_url: "https://publisher.example/article", source: { display_name: "PLOS ONE", type: "journal" } },
    best_oa_location: { pdf_url: "https://repo.example.org/oa.pdf", source: { type: "repository" }, license: "cc-by" },
    open_access: { is_oa: true, oa_status: "gold", oa_url: "https://repo.example.org/oa.pdf" },
    abstract_inverted_index: { We: [0], present: [1], a: [2], method: [3] },
    concepts: [{ display_name: "Machine learning", score: 0.9 }],
    topics: [{ display_name: "Deepfake detection", score: 0.8 }],
    cited_by_count: 55,
    referenced_works: ["https://openalex.org/W111111111"],
    related_works: ["https://openalex.org/W222222222"],
  };

  it("maps a work and reconstructs the inverted-index abstract", async () => {
    const { deps, urls } = makeDeps("openalex", () => ({ body: JSON.stringify({ results: [work] }) }));
    const paper = await new OpenAlexSource(deps).getByDOI("10.1234/openalex-example");

    expect(urls[0]).toContain("filter=doi%3Ahttps%3A%2F%2Fdoi.org%2F10.1234%2Fopenalex-example");
    expect(paper!.title).toBe("An Open Access Work");
    expect(paper!.abstract).toBe("We present a method");
    expect(paper!.journal).toBe("PLOS ONE");
    expect(paper!.pdfUrl).toBe("https://repo.example.org/oa.pdf");
    expect(paper!.isOpenAccess).toBe(true);
    expect(paper!.citationCount).toBe(55);
    expect(paper!.sourceId).toBe("W2741809807");
  });

  it("reports an open-access repository PDF as legally reachable full text", async () => {
    const { deps } = makeDeps("openalex", () => ({ body: JSON.stringify(work) }));
    const paper = buildPaper({ title: "T", source: "OpenAlex", doi: "10.1234/openalex-example" })!;
    const fullText = await new OpenAlexSource(deps).getFullText(paper);
    expect(fullText).toMatchObject({ available: true, type: "pdf", accessType: "repository", license: "cc-by" });
  });

  it("returns the official landing page for a closed-access work", async () => {
    const closed = {
      ...work,
      best_oa_location: null,
      open_access: { is_oa: false },
    };
    const { deps } = makeDeps("openalex", () => ({ body: JSON.stringify(closed) }));
    const paper = buildPaper({ title: "T", source: "OpenAlex", doi: "10.1234/openalex-example" })!;
    const fullText = await new OpenAlexSource(deps).getFullText(paper);

    expect(fullText).toMatchObject({ available: false, accessType: "landing-page" });
    expect(fullText!.url).toBe("https://publisher.example/article");
  });

  it("batches related_works into a single bounded request", async () => {
    const { deps, urls } = makeDeps("openalex", (url) =>
      url.includes("openalex_id")
        ? { body: JSON.stringify({ results: [work] }) }
        : { body: JSON.stringify(work) },
    );
    const main = buildPaper({ title: "Main", source: "OpenAlex", doi: "10.1234/openalex-example" })!;
    const related = await new OpenAlexSource(deps).getRelated(main, 10);

    expect(urls.some((u) => u.includes("filter=openalex_id%3AW222222222"))).toBe(true);
    expect(related[0]!.matchType).toBe("similar");
  });

  it("reconstructs and normalizes helper values", () => {
    expect(reconstructAbstract({ Hello: [0], world: [1] })).toBe("Hello world");
    expect(reconstructAbstract(null)).toBeUndefined();
    expect(reconstructAbstract({})).toBeUndefined();
    expect(normalizeOpenAlexId("https://openalex.org/W123456")).toBe("W123456");
    expect(normalizeOpenAlexId("nonsense")).toBeUndefined();
  });
});

describe("buildPaper / deriveFullText (metadata and access policy)", () => {
  it("never fabricates a missing field", () => {
    const paper = buildPaper({ title: "Only a title", source: "Test" })!;
    expect(paper.abstract).toBeUndefined();
    expect(paper.doi).toBeUndefined();
    expect(paper.year).toBeUndefined();
    expect(paper.journal).toBeUndefined();
    expect(paper.authors).toEqual([]);
  });

  it("refuses a record with no usable title", () => {
    expect(buildPaper({ title: undefined, source: "Test" })).toBeUndefined();
    expect(buildPaper({ title: "   ", source: "Test" })).toBeUndefined();
  });

  it("drops links that point into a private network", () => {
    const paper = buildPaper({
      title: "T",
      source: "Test",
      pdfUrl: "http://192.168.0.5/paper.pdf",
      landingPageUrl: "https://publisher.example/article",
    })!;
    expect(paper.pdfUrl).toBeUndefined();
    expect(paper.landingPageUrl).toBe("https://publisher.example/article");
  });

  it("returns an open-access PDF when one exists", () => {
    const paper = buildPaper({
      title: "T",
      source: "DOAJ",
      pdfUrl: "https://journal.example.org/a.pdf",
      isOpenAccess: true,
    })!;
    expect(deriveFullText(paper)).toMatchObject({ available: true, type: "pdf", accessType: "open-access" });
  });

  it("returns a repository PDF for an arXiv/PMC record", () => {
    const paper = buildPaper({
      title: "T",
      source: "arXiv",
      arxivId: "2101.00001",
      pdfUrl: "https://arxiv.org/pdf/2101.00001",
    })!;
    expect(deriveFullText(paper).accessType).toBe("repository");
  });

  it("returns the landing page - never a workaround - for a paywalled paper", () => {
    const paper = buildPaper({
      title: "Paywalled",
      source: "Crossref",
      doi: "10.1234/paywalled",
      landingPageUrl: "https://publisher.example/article",
      isOpenAccess: false,
    })!;
    const fullText = deriveFullText(paper);
    expect(fullText).toMatchObject({ available: false, accessType: "landing-page" });
    expect(fullText.url).toBe("https://publisher.example/article");
  });

  it("falls back to the DOI resolver when there is no other link", () => {
    const paper = buildPaper({ title: "T", source: "Crossref", doi: "10.1234/x" })!;
    expect(deriveFullText(paper).url).toBe("https://doi.org/10.1234/x");
  });

  it("reports unavailable when there is nothing legal to link to", () => {
    const paper = buildPaper({ title: "T", source: "Test" })!;
    expect(deriveFullText(paper)).toMatchObject({ available: false, accessType: "unavailable" });
  });
});

describe("xml parser", () => {
  it("parses elements, attributes, namespaces and CDATA", () => {
    const doc = parseXml(`<root xmlns:x="urn:x"><x:item id="1"><![CDATA[raw <text>]]></x:item></root>`);
    const item = findAll(doc, "item")[0]!;
    expect(item.attributes.id).toBe("1");
    expect(textOf(item)).toBe("raw <text>");
  });

  it("decodes entities and skips comments and declarations", () => {
    const doc = parseXml(`<!DOCTYPE r><!-- hi --><r><a>A &amp; B &#65;</a></r>`);
    expect(textOfChild(findAll(doc, "r")[0], "a")).toBe("A & B A");
  });

  it("does not expand a DOCTYPE internal subset (no XXE / billion laughs)", () => {
    const hostile = `<!DOCTYPE lolz [<!ENTITY lol "LOLLOLLOL"><!ENTITY lol2 "&lol;&lol;&lol;">]><r><a>&lol2;</a></r>`;
    const doc = parseXml(hostile);
    // The entity is left untouched rather than being expanded.
    expect(textOfChild(findAll(doc, "r")[0], "a")).toBe("&lol2;");
  });

  it("handles self-closing tags and stray close tags", () => {
    const doc = parseXml(`<r><a/><b>x</b></close></r>`);
    expect(findAll(doc, "a")).toHaveLength(1);
    expect(textOfChild(findAll(doc, "r")[0], "b")).toBe("x");
  });

  it("throws on an empty document", () => {
    expect(() => parseXml("")).toThrow();
  });
});
