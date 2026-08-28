/**
 * Manual QA probe: exercises each source adapter individually against its REAL
 * public API, one small request per source.
 *
 * This is NOT part of `npm test` (which is fully mocked and must never touch a
 * live API). Run it deliberately:
 *
 *   npx tsx tests/manual/sourceProbe.ts
 *   npx tsx tests/manual/sourceProbe.ts doaj arxiv
 *
 * It exists so adapter/provider compatibility - endpoints, parameters, auth,
 * response shape - can be verified against what the providers actually return
 * today, rather than against a fixture that may have drifted.
 */

import { MemoryCache } from "../../src/cache/MemoryCache.js";
import { buildConfig, loadDotEnv } from "../../src/config/env.js";
import { SourceRegistry } from "../../src/config/sources.js";
import { Logger } from "../../src/logging/Logger.js";
import type { PaperResult } from "../../src/models/Paper.js";
import type { AcademicSource } from "../../src/models/Source.js";

loadDotEnv();

const config = buildConfig(process.env);
const logger = new Logger({ level: "error", sink: () => undefined });
const registry = new SourceRegistry({
  config,
  cache: new MemoryCache({ defaultTtlSeconds: 0, maxEntries: 50 }),
  logger,
});

/** A well-known open-access paper each source can plausibly answer for. */
const PROBE = {
  doi: "10.1371/journal.pone.0266462",
  title: "Blockchain technology in healthcare: A systematic review",
  keywords: ["deepfake", "audio"],
};

interface Check {
  label: string;
  ok: boolean;
  detail: string;
}

function describePaper(p: PaperResult | null | undefined): string {
  if (!p) return "null";
  return [
    `title="${p.title.slice(0, 52)}"`,
    `authors=${p.authors.length}`,
    p.doi ? `doi=${p.doi}` : "doi=-",
    p.year ? `year=${p.year}` : "year=-",
    p.pdfUrl ? "pdf=yes" : "pdf=no",
    `oa=${String(p.isOpenAccess)}`,
  ].join(" ");
}

/** Field-level sanity: no fabricated metadata, no malformed URLs. */
function validate(p: PaperResult, label: string): string[] {
  const bad: string[] = [];
  if (!p.title || !p.title.trim()) bad.push("empty title");
  if (!Array.isArray(p.authors)) bad.push("authors not an array");
  if (p.authors.some((a) => !a || a === "undefined" || a === "null")) bad.push("placeholder author");
  if (!p.source) bad.push("missing source");
  if (p.doi !== undefined && !/^10\.\d{4,9}\//.test(p.doi)) bad.push(`malformed doi ${p.doi}`);
  if (p.year !== undefined && (p.year < 1500 || p.year > 2030)) bad.push(`implausible year ${p.year}`);
  for (const field of ["pdfUrl", "landingPageUrl"] as const) {
    const v = p[field];
    if (v !== undefined && !/^https?:\/\//.test(v)) bad.push(`malformed ${field}: ${v}`);
  }
  if (/&(amp|lt|gt|quot|#\d+);/i.test(p.title)) bad.push("undecoded entity in title");
  return bad.map((b) => `${label}: ${b}`);
}

async function probe(source: AcademicSource): Promise<void> {
  console.log(`\n===== ${source.name} (${source.key}) =====`);

  if (!source.isAvailable()) {
    console.log(`SKIPPED - ${source.unavailableReason() ?? "unavailable"}`);
    console.log("  (this is the required graceful-skip path, not a failure)");
    return;
  }

  const checks: Check[] = [];
  const problems: string[] = [];

  // --- search -------------------------------------------------------------
  const t0 = Date.now();
  try {
    const results = await source.search({ title: PROBE.title, limit: 5 });
    checks.push({
      label: "search(title)",
      ok: true,
      detail: `${results.length} result(s) in ${Date.now() - t0}ms; first: ${describePaper(results[0])}`,
    });
    results.forEach((r, i) => problems.push(...validate(r, `search[${i}]`)));
  } catch (error) {
    checks.push({ label: "search(title)", ok: false, detail: errText(error) });
  }

  // --- getByDOI -----------------------------------------------------------
  if (typeof source.getByDOI === "function") {
    const t = Date.now();
    try {
      const paper = await source.getByDOI(PROBE.doi);
      checks.push({
        label: "getByDOI",
        ok: true,
        detail: `${Date.now() - t}ms; ${describePaper(paper)}`,
      });
      if (paper) problems.push(...validate(paper, "getByDOI"));
    } catch (error) {
      checks.push({ label: "getByDOI", ok: false, detail: errText(error) });
    }
  }

  // --- keyword search -----------------------------------------------------
  const t2 = Date.now();
  try {
    const results = await source.search({ keywords: PROBE.keywords, limit: 3 });
    checks.push({
      label: "search(keywords)",
      ok: true,
      detail: `${results.length} result(s) in ${Date.now() - t2}ms`,
    });
    results.forEach((r, i) => problems.push(...validate(r, `kw[${i}]`)));
  } catch (error) {
    checks.push({ label: "search(keywords)", ok: false, detail: errText(error) });
  }

  // --- getRelated ---------------------------------------------------------
  if (typeof source.getRelated === "function") {
    const t = Date.now();
    try {
      const main: PaperResult = {
        title: PROBE.title,
        authors: [],
        doi: PROBE.doi,
        source: "probe",
        matchType: "exact",
        confidence: 1,
      };
      const related = await source.getRelated(main, 5);
      checks.push({
        label: "getRelated",
        ok: true,
        detail: `${related.length} related in ${Date.now() - t}ms; first: ${describePaper(related[0])}`,
      });
      related.forEach((r, i) => problems.push(...validate(r, `rel[${i}]`)));
    } catch (error) {
      checks.push({ label: "getRelated", ok: false, detail: errText(error) });
    }
  }

  for (const c of checks) console.log(`  ${c.ok ? "OK  " : "FAIL"} ${c.label.padEnd(18)} ${c.detail}`);
  if (problems.length > 0) {
    console.log("  DATA PROBLEMS:");
    for (const p of [...new Set(problems)]) console.log(`    - ${p}`);
  } else {
    console.log("  data quality: OK");
  }
}

function errText(error: unknown): string {
  if (error && typeof error === "object" && "kind" in error) {
    const e = error as { kind: string; status?: number; message: string };
    return `[${e.kind}${e.status ? " " + e.status : ""}] ${e.message.slice(0, 120)}`;
  }
  return error instanceof Error ? error.message.slice(0, 140) : String(error);
}

const requested = process.argv.slice(2);
const keys = requested.length > 0 ? requested : registry.keys();

for (const key of keys) {
  const source = registry.get(key);
  if (!source) {
    console.log(`\n===== ${key} =====\n  UNKNOWN SOURCE KEY`);
    continue;
  }
  await probe(source);
}

console.log("\nprobe complete");
