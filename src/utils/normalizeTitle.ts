/**
 * Title normalization.
 *
 * Goals:
 *  - lowercase and Unicode-normalize (NFKD, then strip combining marks) so that
 *    "Schrödinger" and "Schrodinger" compare equal
 *  - drop punctuation that carries no meaning for matching
 *  - collapse whitespace
 *  - PRESERVE scientific terminology: hyphenated compounds, alphanumeric tokens
 *    (h5n1, covid-19, bert-base), Greek letters transliterated, and chemical
 *    formulae keep their digits.
 *
 * Stop-word removal is opt-in and uses a deliberately small, safe list. Words
 * such as "state", "network", "control" or "self" are NOT stop words - removing
 * them would destroy meaning in scientific titles.
 */

/** Conservative list: only words that never disambiguate a paper title. */
export const SAFE_STOP_WORDS: ReadonlySet<string> = new Set([
  "a",
  "an",
  "the",
  "of",
  "for",
  "and",
  "or",
  "to",
  "in",
  "on",
  "at",
  "by",
  "with",
  "from",
  "as",
  "into",
  "via",
  "using",
  "toward",
  "towards",
  "is",
  "are",
  "be",
]);

const GREEK_MAP: Record<string, string> = {
  "α": "alpha",
  "β": "beta",
  "γ": "gamma",
  "δ": "delta",
  "ε": "epsilon",
  "λ": "lambda",
  "μ": "mu",
  "π": "pi",
  "σ": "sigma",
  "τ": "tau",
  "φ": "phi",
  "ω": "omega",
};

export interface NormalizeTitleOptions {
  /** Remove the safe stop-word list. Default: false. */
  removeStopWords?: boolean;
  /** Keep hyphens inside compounds (covid-19). Default: true. */
  keepHyphens?: boolean;
}

/** One pass of entity decoding. */
function decodeEntitiesOnce(input: string): string {
  return input
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (whole, hex: string) => {
      const n = Number.parseInt(hex, 16);
      return Number.isFinite(n) && n > 0 && n < 0x10ffff ? String.fromCodePoint(n) : whole;
    })
    .replace(/&#(\d+);/g, (whole, code: string) => {
      const n = Number(code);
      return Number.isFinite(n) && n > 0 && n < 0x10ffff ? String.fromCodePoint(n) : whole;
    });
}

/**
 * Strips HTML/JATS markup that some sources embed in titles and abstracts.
 *
 * Entities are decoded REPEATEDLY (bounded), because upstream data is
 * sometimes double-encoded: Crossref really does return
 * `"Audio &amp;amp; Video Deepfake Detection"`, and a single pass would leave
 * a visible `&amp;` in the title. The loop stops as soon as decoding is a
 * no-op, and is capped so a crafted string cannot spin.
 */
export function stripMarkup(input: string): string {
  let value = input.replace(/<[^>]*>/g, " ");

  for (let pass = 0; pass < 3; pass += 1) {
    const decoded = decodeEntitiesOnce(value);
    if (decoded === value) break;
    value = decoded;
  }

  // Any tags revealed by decoding (e.g. "&lt;i&gt;") go too.
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeTitle(
  input: string | undefined | null,
  options: NormalizeTitleOptions = {},
): string {
  if (typeof input !== "string") return "";
  const { removeStopWords = false, keepHyphens = true } = options;

  let value = stripMarkup(input);

  // Unicode: decompose, drop combining marks, fold the common typographic set.
  value = value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // combining diacritical marks
    .replace(/[‘’‛′]/g, "'") // curly single quotes / prime
    .replace(/[“”‟″]/g, '"') // curly double quotes
    .replace(/[‐-―−]/g, "-") // dashes and minus sign
    .replace(/[  -​  　]/g, " "); // exotic spaces

  value = value.toLowerCase();

  for (const [greek, latin] of Object.entries(GREEK_MAP)) {
    if (value.includes(greek)) value = value.split(greek).join(latin);
  }

  // Keep letters, digits, spaces and (optionally) intra-word hyphens.
  value = keepHyphens
    ? value.replace(/[^a-z0-9\s-]+/g, " ")
    : value.replace(/[^a-z0-9\s]+/g, " ");

  // A hyphen only survives when it actually joins two tokens.
  value = value.replace(/(^|\s)-+|-+($|\s)/g, "$1$2");

  value = value.replace(/\s+/g, " ").trim();

  if (removeStopWords) {
    const kept = value.split(" ").filter((token) => token && !SAFE_STOP_WORDS.has(token));
    // Never normalize a title down to nothing - fall back to the full form.
    if (kept.length > 0) value = kept.join(" ");
  }

  return value;
}

/** Tokenizes a title into comparable tokens (stop words removed). */
export function titleTokens(input: string | undefined | null): string[] {
  const normalized = normalizeTitle(input, { removeStopWords: true });
  if (!normalized) return [];
  return normalized.split(" ").filter((t) => t.length > 0);
}

/**
 * A very aggressive form used only as a dedup key: no hyphens, no spaces,
 * no stop words. "Deep-Fake Detection" and "Deepfake detection" collapse
 * to the same key.
 */
export function titleFingerprint(input: string | undefined | null): string {
  return normalizeTitle(input, { removeStopWords: true, keepHyphens: false }).replace(/\s+/g, "");
}
