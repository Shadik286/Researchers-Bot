import type { PaperSearchQuery } from "../models/Search.js";
import { isValidDoi, normalizeDoi } from "../utils/normalizeDoi.js";

/**
 * Request validation for the public API.
 *
 * Principles:
 *  - reject rather than coerce anything structurally wrong
 *  - bound every string and every array, so a huge payload cannot become a
 *    huge upstream query
 *  - strip control characters, which have no place in bibliographic text
 *  - accept NO URL from the user: there is no field through which a caller can
 *    make the backend fetch an address of their choosing
 */

export const LIMITS = {
  titleMaxLength: 500,
  authorMaxLength: 200,
  keywordMaxLength: 100,
  doiMaxLength: 300,
  maxAuthors: 20,
  maxKeywords: 20,
  idMaxLength: 300,
} as const;

export class ValidationError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(message: string, code = "INVALID_REQUEST", details?: unknown) {
    super(message);
    this.name = "ValidationError";
    this.code = code;
    this.details = details;
  }
}

/**
 * Removes C0/C1 control characters and collapses whitespace.
 *
 * Built from code points rather than a literal character class so the source
 * file stays free of raw control bytes.
 */
const CONTROL_CHARS = new RegExp(
  "[" +
    "\\u0000-\\u0008" + // C0 before tab
    "\\u000b\\u000c" + // vertical tab, form feed
    "\\u000e-\\u001f" + // C0 after carriage return
    "\\u007f-\\u009f" + // DEL and C1
    "\\u200b-\\u200f" + // zero-width and bidi marks
    "\\u2028\\u2029" + // line/paragraph separators
    "\\ufeff" + // BOM
    "]",
  "g",
);

export function sanitizeText(input: string): string {
  return input
    .replace(CONTROL_CHARS, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function expectString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string") {
    throw new ValidationError(`"${field}" must be a string`);
  }
  if (value.length > maxLength) {
    throw new ValidationError(`"${field}" must be at most ${maxLength} characters`);
  }
  return sanitizeText(value);
}

function expectStringArray(value: unknown, field: string, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value)) {
    throw new ValidationError(`"${field}" must be an array of strings`);
  }
  if (value.length > maxItems) {
    throw new ValidationError(`"${field}" must contain at most ${maxItems} items`);
  }
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      throw new ValidationError(`"${field}" must contain only strings`);
    }
    if (item.length > maxLength) {
      throw new ValidationError(`Each "${field}" entry must be at most ${maxLength} characters`);
    }
    const cleaned = sanitizeText(item);
    if (cleaned) out.push(cleaned);
  }
  return out;
}

const ALLOWED_SEARCH_FIELDS = new Set(["title", "authors", "keywords", "doi", "fromYear", "toYear"]);

const MIN_YEAR = 1500;
const MAX_YEAR = new Date().getFullYear() + 2;

function expectYear(value: unknown, field: string): number {
  const year = typeof value === "string" && /^\d{4}$/.test(value.trim()) ? Number(value.trim()) : value;
  if (typeof year !== "number" || !Number.isInteger(year)) {
    throw new ValidationError(`"${field}" must be a 4-digit year`);
  }
  if (year < MIN_YEAR || year > MAX_YEAR) {
    throw new ValidationError(`"${field}" must be between ${MIN_YEAR} and ${MAX_YEAR}`);
  }
  return year;
}

/** Validates and normalizes `POST /api/papers/search`. */
export function validateSearchRequest(body: unknown): PaperSearchQuery {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new ValidationError("Request body must be a JSON object");
  }

  const record = body as Record<string, unknown>;

  const unknownFields = Object.keys(record).filter((key) => !ALLOWED_SEARCH_FIELDS.has(key));
  if (unknownFields.length > 0) {
    throw new ValidationError(
      `Unsupported field(s): ${unknownFields.slice(0, 5).join(", ")}. ` +
        "Allowed: title, authors, keywords, doi, fromYear, toYear",
    );
  }

  const query: PaperSearchQuery = {};

  if (record.title !== undefined && record.title !== null) {
    const title = expectString(record.title, "title", LIMITS.titleMaxLength);
    if (title) query.title = title;
  }

  if (record.authors !== undefined && record.authors !== null) {
    const authors = expectStringArray(record.authors, "authors", LIMITS.maxAuthors, LIMITS.authorMaxLength);
    if (authors.length > 0) query.authors = authors;
  }

  if (record.keywords !== undefined && record.keywords !== null) {
    const keywords = expectStringArray(record.keywords, "keywords", LIMITS.maxKeywords, LIMITS.keywordMaxLength);
    if (keywords.length > 0) query.keywords = keywords;
  }

  if (record.doi !== undefined && record.doi !== null) {
    const raw = expectString(record.doi, "doi", LIMITS.doiMaxLength);
    if (raw) {
      if (!isValidDoi(raw)) {
        throw new ValidationError(
          `"doi" is not a recognisable DOI. Expected e.g. "10.1234/example" or "https://doi.org/10.1234/example"`,
          "INVALID_DOI",
        );
      }
      query.doi = normalizeDoi(raw);
    }
  }

  if (record.fromYear !== undefined && record.fromYear !== null) {
    query.fromYear = expectYear(record.fromYear, "fromYear");
  }
  if (record.toYear !== undefined && record.toYear !== null) {
    query.toYear = expectYear(record.toYear, "toYear");
  }
  if (query.fromYear !== undefined && query.toYear !== undefined && query.fromYear > query.toYear) {
    throw new ValidationError('"fromYear" must not be greater than "toYear"');
  }

  if (!query.title && !query.authors && !query.keywords && !query.doi) {
    throw new ValidationError("At least one search field is required", "INVALID_REQUEST", {
      allowed: [...ALLOWED_SEARCH_FIELDS],
    });
  }

  return query;
}

export interface ParsedPaperId {
  scheme: string;
  value: string;
}

const ID_SCHEMES = new Set(["doi", "pmid", "pmcid", "arxiv", "s2", "openalex", "core", "doaj"]);

/**
 * Validates `GET /api/papers/:id`.
 *
 * The id is a scheme-prefixed identifier ("doi:10.1234/x", "arxiv:2101.00001").
 * Only known schemes with well-formed values are accepted, so this route can
 * never be used to reach an arbitrary address.
 */
export function validatePaperId(rawId: string): ParsedPaperId {
  if (typeof rawId !== "string" || rawId.trim() === "") {
    throw new ValidationError("A paper id is required", "INVALID_PAPER_ID");
  }
  if (rawId.length > LIMITS.idMaxLength) {
    throw new ValidationError(`Paper id must be at most ${LIMITS.idMaxLength} characters`, "INVALID_PAPER_ID");
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(rawId).trim();
  } catch {
    throw new ValidationError("Paper id is not valid URL encoding", "INVALID_PAPER_ID");
  }

  const separator = decoded.indexOf(":");
  if (separator <= 0) {
    throw new ValidationError(
      'Paper id must be "<scheme>:<value>", e.g. "doi:10.1234/example" or "arxiv:2101.00001"',
      "INVALID_PAPER_ID",
    );
  }

  const scheme = decoded.slice(0, separator).toLowerCase();
  const value = sanitizeText(decoded.slice(separator + 1));

  if (!ID_SCHEMES.has(scheme)) {
    throw new ValidationError(
      `Unsupported id scheme "${scheme}". Supported: ${[...ID_SCHEMES].join(", ")}`,
      "INVALID_PAPER_ID",
    );
  }
  if (!value) {
    throw new ValidationError("Paper id value is empty", "INVALID_PAPER_ID");
  }

  switch (scheme) {
    case "doi":
      if (!isValidDoi(value)) throw new ValidationError("Malformed DOI", "INVALID_PAPER_ID");
      return { scheme, value: normalizeDoi(value)! };
    case "pmid":
      if (!/^\d{1,9}$/.test(value)) throw new ValidationError("Malformed PMID", "INVALID_PAPER_ID");
      return { scheme, value };
    case "pmcid":
      if (!/^PMC\d{1,9}$/i.test(value)) throw new ValidationError("Malformed PMCID", "INVALID_PAPER_ID");
      return { scheme, value: value.toUpperCase() };
    case "arxiv":
      if (!/^(\d{4}\.\d{4,5}(v\d+)?|[a-z-]+(\.[A-Za-z]{2})?\/\d{7}(v\d+)?)$/i.test(value)) {
        throw new ValidationError("Malformed arXiv id", "INVALID_PAPER_ID");
      }
      return { scheme, value };
    case "openalex":
      if (!/^W\d{4,12}$/i.test(value)) throw new ValidationError("Malformed OpenAlex id", "INVALID_PAPER_ID");
      return { scheme, value: value.toUpperCase() };
    case "s2":
      if (!/^[0-9a-f]{40}$/i.test(value)) throw new ValidationError("Malformed Semantic Scholar id", "INVALID_PAPER_ID");
      return { scheme, value: value.toLowerCase() };
    case "core":
      if (!/^\d{1,12}$/.test(value)) throw new ValidationError("Malformed CORE id", "INVALID_PAPER_ID");
      return { scheme, value };
    case "doaj":
      if (!/^[a-z0-9]{8,64}$/i.test(value)) throw new ValidationError("Malformed DOAJ id", "INVALID_PAPER_ID");
      return { scheme, value };
    default:
      throw new ValidationError("Unsupported id scheme", "INVALID_PAPER_ID");
  }
}

/** Parses a JSON body, converting every failure into a 400-shaped error. */
export function parseJsonBody(raw: string): unknown {
  if (raw.trim() === "") {
    throw new ValidationError("Request body is empty; expected JSON");
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new ValidationError("Request body is not valid JSON");
  }
}
