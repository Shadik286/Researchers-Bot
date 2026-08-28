import type { FullTextResult } from "../../src/models/FullText.js";
import type { PaperResult } from "../../src/models/Paper.js";
import type { PaperSearchQuery } from "../../src/models/Search.js";
import type { AcademicSource } from "../../src/models/Source.js";

/**
 * A fully controllable in-memory source, used to prove orchestration behaviour
 * without contacting any real academic API.
 */

export interface MockSourceOptions {
  name: string;
  key: string;
  /** Results returned by `search`. */
  results?: PaperResult[];
  /** Result returned by `getByDOI`, keyed by normalized DOI. */
  byDoi?: Record<string, PaperResult>;
  /** Papers returned by `getRelated`. */
  related?: PaperResult[];
  /** Simulated latency, so cancellation can be observed mid-flight. */
  latencyMs?: number;
  /** When set, every call rejects with this error. */
  failWith?: Error;
  available?: boolean;
  unavailableMessage?: string;
  fullText?: FullTextResult | null;
}

export interface MockCall {
  method: "search" | "getByDOI" | "getById" | "getRelated" | "getFullText";
  query?: PaperSearchQuery;
  doi?: string;
  aborted: boolean;
}

export class MockSource implements AcademicSource {
  readonly name: string;
  readonly key: string;
  readonly calls: MockCall[] = [];
  /** Calls that were cut short because the caller aborted. */
  readonly cancelledCalls: MockCall[] = [];

  constructor(private readonly options: MockSourceOptions) {
    this.name = options.name;
    this.key = options.key;
  }

  isAvailable(): boolean {
    return this.options.available !== false;
  }

  unavailableReason(): string | undefined {
    return this.isAvailable() ? undefined : (this.options.unavailableMessage ?? "mock source unavailable");
  }

  get searchCallCount(): number {
    return this.calls.filter((c) => c.method === "search" || c.method === "getByDOI").length;
  }

  async search(query: PaperSearchQuery, signal?: AbortSignal): Promise<PaperResult[]> {
    const call: MockCall = { method: "search", query, aborted: false };
    this.calls.push(call);
    await this.simulate(call, signal);
    return clone(this.options.results ?? []);
  }

  async getByDOI(doi: string, signal?: AbortSignal): Promise<PaperResult | null> {
    const call: MockCall = { method: "getByDOI", doi, aborted: false };
    this.calls.push(call);
    await this.simulate(call, signal);
    return clone(this.options.byDoi?.[doi] ?? null);
  }

  async getById(id: string, signal?: AbortSignal): Promise<PaperResult | null> {
    const call: MockCall = { method: "getById", doi: id, aborted: false };
    this.calls.push(call);
    await this.simulate(call, signal);
    return clone(this.options.byDoi?.[id] ?? null);
  }

  async getRelated(_paper: PaperResult, limit: number, signal?: AbortSignal): Promise<PaperResult[]> {
    const call: MockCall = { method: "getRelated", aborted: false };
    this.calls.push(call);
    await this.simulate(call, signal);
    return clone((this.options.related ?? []).slice(0, limit));
  }

  async getFullText(paper: PaperResult, signal?: AbortSignal): Promise<FullTextResult | null> {
    const call: MockCall = { method: "getFullText", aborted: false };
    this.calls.push(call);
    await this.simulate(call, signal);
    if (this.options.fullText !== undefined) return this.options.fullText;
    return paper.pdfUrl
      ? { available: true, url: paper.pdfUrl, type: "pdf", accessType: "open-access", source: this.name }
      : null;
  }

  private async simulate(call: MockCall, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      call.aborted = true;
      this.cancelledCalls.push(call);
      throw abortError();
    }

    const latency = this.options.latencyMs ?? 0;
    if (latency > 0) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, latency);
        const onAbort = (): void => {
          clearTimeout(timer);
          call.aborted = true;
          this.cancelledCalls.push(call);
          reject(abortError());
        };
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    }

    if (this.options.failWith) throw this.options.failWith;
  }
}

function abortError(): Error {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

function clone<T>(value: T): T {
  return value === null || value === undefined ? value : (structuredClone(value) as T);
}

/**
 * Convenience factory for a well-formed paper fixture.
 *
 * Mirrors what `buildPaper` produces in a real adapter - including `sources`
 * and `sourceLinks` - so mock-based tests exercise the shape the API actually
 * returns rather than a thinner one.
 */
export function makePaper(overrides: Partial<PaperResult> = {}): PaperResult {
  const base: PaperResult = {
    title: "Deepfake Detection Using Audio and Video",
    authors: ["John Doe", "Jane Roe"],
    abstract: "A multimodal neural network combining audio and video signals to detect deepfakes.",
    keywords: ["deepfake", "audio", "video"],
    source: "Mock",
    matchType: "keyword",
    confidence: 0,
    ...overrides,
  };
  base.sources ??= [base.source];
  base.sourceLinks ??= [
    { source: base.source, landingPageUrl: base.landingPageUrl, pdfUrl: base.pdfUrl, sourceId: base.sourceId },
  ];
  return base;
}
