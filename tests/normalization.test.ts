import { describe, expect, it } from "vitest";

import { authorOverlap, authorSimilarity, cleanAuthorDisplayName, normalizeAuthor, normalizeAuthors } from "../src/utils/normalizeAuthor.js";
import { doiEquals, doiToUrl, extractDoi, isValidDoi, normalizeDoi } from "../src/utils/normalizeDoi.js";
import { keywordTokens, normalizeKeyword, normalizeKeywords } from "../src/utils/normalizeKeywords.js";
import { normalizeTitle, stripMarkup, titleFingerprint, titleTokens } from "../src/utils/normalizeTitle.js";

describe("normalizeDoi", () => {
  it("accepts a bare DOI", () => {
    expect(normalizeDoi("10.1234/example")).toBe("10.1234/example");
  });

  it("accepts the doi: scheme prefix in any casing", () => {
    expect(normalizeDoi("doi:10.1234/example")).toBe("10.1234/example");
    expect(normalizeDoi("DOI: 10.1234/example")).toBe("10.1234/example");
  });

  it("accepts resolver URLs", () => {
    expect(normalizeDoi("https://doi.org/10.1234/example")).toBe("10.1234/example");
    expect(normalizeDoi("http://dx.doi.org/10.1234/example")).toBe("10.1234/example");
    expect(normalizeDoi("https://www.doi.org/10.1234/example")).toBe("10.1234/example");
  });

  it("accepts info:doi and urn:doi forms", () => {
    expect(normalizeDoi("info:doi/10.1234/example")).toBe("10.1234/example");
    expect(normalizeDoi("urn:doi:10.1234/example")).toBe("10.1234/example");
  });

  it("lowercases, since DOIs are case-insensitive", () => {
    expect(normalizeDoi("10.1234/EXAMPLE")).toBe("10.1234/example");
  });

  it("strips a query string, fragment and trailing prose punctuation", () => {
    expect(normalizeDoi("https://doi.org/10.1234/example?utm_source=x")).toBe("10.1234/example");
    expect(normalizeDoi("10.1234/example#section")).toBe("10.1234/example");
    expect(normalizeDoi("10.1234/example.")).toBe("10.1234/example");
    expect(normalizeDoi("(10.1234/example)")).toBe("10.1234/example");
  });

  it("percent-decodes an escaped suffix", () => {
    expect(normalizeDoi("https://doi.org/10.1234%2Fexample")).toBe("10.1234/example");
  });

  it("keeps characters that are legally part of a suffix", () => {
    expect(normalizeDoi("10.1002/(sici)1097-0258")).toBe("10.1002/(sici)1097-0258");
    expect(normalizeDoi("10.1371/journal.pone.0123456")).toBe("10.1371/journal.pone.0123456");
  });

  it("rejects non-DOIs", () => {
    expect(normalizeDoi("not-a-doi")).toBeUndefined();
    expect(normalizeDoi("10.123/tooshortprefix")).toBeUndefined();
    expect(normalizeDoi("11.1234/wrongprefix")).toBeUndefined();
    expect(normalizeDoi("10.1234/")).toBeUndefined();
    expect(normalizeDoi("")).toBeUndefined();
    expect(normalizeDoi(undefined)).toBeUndefined();
  });

  it("supports equality and URL helpers", () => {
    expect(doiEquals("DOI:10.1234/Example", "https://doi.org/10.1234/example")).toBe(true);
    expect(doiEquals("10.1234/a", "10.1234/b")).toBe(false);
    expect(doiEquals(undefined, "10.1234/a")).toBe(false);
    expect(doiToUrl("10.1234/Example")).toBe("https://doi.org/10.1234/example");
    expect(isValidDoi("10.1234/x")).toBe(true);
  });

  it("extracts a DOI out of a citation line", () => {
    expect(extractDoi("Doe J. Title. Journal. 2020. doi:10.1234/example. Accessed 2021.")).toBe("10.1234/example");
  });
});

describe("normalizeTitle", () => {
  it("lowercases and collapses whitespace", () => {
    expect(normalizeTitle("  Deepfake   Detection  ")).toBe("deepfake detection");
  });

  it("folds Unicode diacritics", () => {
    expect(normalizeTitle("Schrödinger Equation")).toBe("schrodinger equation");
    expect(normalizeTitle("Naïve Bayes")).toBe("naive bayes");
  });

  it("normalizes typographic punctuation", () => {
    expect(normalizeTitle("A “Smart” Approach — Revisited")).toBe("a smart approach revisited");
  });

  it("preserves scientific terminology and alphanumerics", () => {
    expect(normalizeTitle("COVID-19 and H5N1 in BERT-base models")).toBe("covid-19 and h5n1 in bert-base models");
  });

  it("removes only safe stop words when asked", () => {
    expect(normalizeTitle("The Detection of Deepfakes in the Wild", { removeStopWords: true })).toBe(
      "detection deepfakes wild",
    );
  });

  it("never reduces a title to nothing", () => {
    expect(normalizeTitle("The Of And", { removeStopWords: true })).toBe("the of and");
  });

  it("strips embedded markup", () => {
    expect(stripMarkup("<jats:p>Hello &amp; welcome</jats:p>")).toBe("Hello & welcome");
    expect(normalizeTitle("<i>In vivo</i> studies")).toBe("in vivo studies");
  });

  it("produces stable fingerprints for equivalent titles", () => {
    expect(titleFingerprint("Deep-Fake Detection")).toBe(titleFingerprint("Deepfake detection"));
  });

  it("tokenizes without stop words", () => {
    expect(titleTokens("The Detection of Deepfakes")).toEqual(["detection", "deepfakes"]);
  });
});

describe("normalizeAuthor", () => {
  it('handles "John Doe"', () => {
    expect(normalizeAuthor("John Doe")).toEqual({ full: "john doe", last: "doe", firstInitial: "j" });
  });

  it('handles "Doe, John"', () => {
    expect(normalizeAuthor("Doe, John")).toEqual({ full: "john doe", last: "doe", firstInitial: "j" });
  });

  it('handles "J. Doe"', () => {
    expect(normalizeAuthor("J. Doe")).toEqual({ full: "j doe", last: "doe", firstInitial: "j" });
  });

  it('handles the PubMed "Doe J" form', () => {
    expect(normalizeAuthor("Doe J")).toEqual({ full: "j doe", last: "doe", firstInitial: "j" });
  });

  it("keeps surname particles with the surname", () => {
    expect(normalizeAuthor("Anne van der Berg")?.last).toBe("van der berg");
    expect(normalizeAuthor("van der Berg, Anne")?.last).toBe("van der berg");
  });

  it("folds diacritics and drops suffixes", () => {
    expect(normalizeAuthor("Müller, K.-H.")).toEqual({ full: "k h muller", last: "muller", firstInitial: "k" });
    expect(normalizeAuthor("John Doe Jr.")?.last).toBe("doe");
  });

  it("returns undefined for unusable input", () => {
    expect(normalizeAuthor("")).toBeUndefined();
    expect(normalizeAuthor("   ")).toBeUndefined();
    expect(normalizeAuthor(undefined)).toBeUndefined();
  });

  it("de-duplicates an author list", () => {
    expect(normalizeAuthors(["John Doe", "Doe, John", "Jane Roe"])).toHaveLength(2);
  });

  it("scores author similarity by surname then initial", () => {
    const a = normalizeAuthor("John Doe")!;
    const b = normalizeAuthor("J. Doe")!;
    const c = normalizeAuthor("Alice Doe")!;
    const d = normalizeAuthor("John Smith")!;
    expect(authorSimilarity(a, a)).toBe(1);
    expect(authorSimilarity(a, b)).toBeCloseTo(0.9);
    expect(authorSimilarity(a, c)).toBeCloseTo(0.2);
    expect(authorSimilarity(a, d)).toBe(0);
  });

  it("treats a surname-only query as under-specified, not contradicted", () => {
    const surnameOnly = normalizeAuthor("Vaswani")!;
    const full = normalizeAuthor("Ashish Vaswani")!;
    const different = normalizeAuthor("Ashish Kumar")!;
    expect(authorSimilarity(surnameOnly, full)).toBe(0.75);
    expect(authorSimilarity(surnameOnly, different)).toBe(0);
    // A contradicted given name still scores far lower than an absent one.
    expect(authorSimilarity(normalizeAuthor("Bob Vaswani")!, full)).toBe(0.2);
  });

  it("measures overlap against the shorter list, tolerating truncation", () => {
    const query = normalizeAuthors(["John Doe"]);
    const full = normalizeAuthors(["John Doe", "Jane Roe", "Sam Poe", "Kim Lee"]);
    expect(authorOverlap(query, full)).toBe(1);
    expect(authorOverlap(query, normalizeAuthors(["Someone Else"]))).toBe(0);
    expect(authorOverlap([], full)).toBe(0);
  });

  it("reformats a display name", () => {
    expect(cleanAuthorDisplayName("Doe, John")).toBe("John Doe");
    expect(cleanAuthorDisplayName("  John   Doe ")).toBe("John Doe");
  });
});

describe("normalizeKeywords", () => {
  it("normalizes, splits and de-duplicates", () => {
    expect(normalizeKeywords(["Deepfake, Audio", "audio; Video", "DEEPFAKE"])).toEqual([
      "deepfake",
      "audio",
      "video",
    ]);
  });

  it("drops pure stop words and empties", () => {
    expect(normalizeKeyword("the")).toBeUndefined();
    expect(normalizeKeyword("   ")).toBeUndefined();
    expect(normalizeKeywords(["", "  ", "of"])).toEqual([]);
  });

  it("accepts a bare string", () => {
    expect(normalizeKeywords("Machine Learning")).toEqual(["machine learning"]);
  });

  it("tokenizes keywords for set comparison", () => {
    expect([...keywordTokens(["audio deepfake", "video"])].sort()).toEqual(["audio", "deepfake", "video"]);
  });
});
