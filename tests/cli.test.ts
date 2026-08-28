import { describe, expect, it } from "vitest";

import { buildQueryForMode, parseInput } from "./manual/searchCli.js";

/**
 * The manual CLI is how the backend gets driven by hand, so its input parsing
 * is worth pinning down: a misread line silently searches the wrong field and
 * looks like a backend failure.
 */

describe("CLI input parsing", () => {
  it("treats plain prose as a title", () => {
    expect(parseInput("Attention Is All You Need")).toEqual({ title: "Attention Is All You Need" });
    expect(parseInput("A survey on deepfake detection")).toEqual({ title: "A survey on deepfake detection" });
  });

  it("does not mistake a comma inside a sentence for a keyword list", () => {
    // "Deep learning, a review" is a title; "deepfake, audio" is a keyword list.
    expect(parseInput("Deep learning, a review")).toEqual({ title: "Deep learning, a review" });
    expect(parseInput("Blockchain in healthcare, the state of the art")).toEqual({
      title: "Blockchain in healthcare, the state of the art",
    });
    expect(parseInput("deepfake, audio, video")).toEqual({ keywords: ["deepfake", "audio", "video"] });
  });

  it("recognises DOIs in every accepted form", () => {
    expect(parseInput("10.1371/journal.pone.0266462")).toEqual({ doi: "10.1371/journal.pone.0266462" });
    expect(parseInput("doi: 10.1371/journal.pone.0266462")).toEqual({ doi: "10.1371/journal.pone.0266462" });
    expect(parseInput("https://doi.org/10.1371/journal.pone.0266462")).toEqual({
      doi: "https://doi.org/10.1371/journal.pone.0266462",
    });
  });

  it("parses authors with @ and with the author: prefix", () => {
    expect(parseInput("@Yoshua Bengio")).toEqual({ authors: ["Yoshua Bengio"] });
    expect(parseInput("author: Yoshua Bengio")).toEqual({ authors: ["Yoshua Bengio"] });
  });

  it('keeps "Last, First" as ONE author', () => {
    // Splitting on the comma would invent two people, "Bengio" and "Yoshua".
    expect(parseInput("author: Bengio, Yoshua")).toEqual({ authors: ["Bengio, Yoshua"] });
    expect(parseInput("@Bengio, Yoshua")).toEqual({ authors: ["Bengio, Yoshua"] });
  });

  it('separates several authors on ";"', () => {
    expect(parseInput("author: Bengio; Goodfellow")).toEqual({ authors: ["Bengio", "Goodfellow"] });
  });

  it("parses explicit field prefixes", () => {
    expect(parseInput("title: Deep learning")).toEqual({ title: "Deep learning" });
    expect(parseInput("kw: deepfake, audio")).toEqual({ keywords: ["deepfake", "audio"] });
  });

  it("parses the year filters", () => {
    expect(parseInput("kw: deepfake + since: 2020")).toEqual({ keywords: ["deepfake"], fromYear: 2020 });
    expect(parseInput("kw: deepfake + until: 2024")).toEqual({ keywords: ["deepfake"], toYear: 2024 });
    expect(parseInput("kw: deepfake + year: 2020-2024")).toEqual({
      keywords: ["deepfake"],
      fromYear: 2020,
      toYear: 2024,
    });
    expect(parseInput("kw: deepfake + year: 2023")).toEqual({
      keywords: ["deepfake"],
      fromYear: 2023,
      toYear: 2023,
    });
  });

  it("combines several parts with +", () => {
    expect(parseInput("title: Deep learning + @Bengio + since: 2020")).toEqual({
      title: "Deep learning",
      authors: ["Bengio"],
      fromYear: 2020,
    });
  });

  it("ignores empty input", () => {
    expect(parseInput("")).toEqual({});
    expect(parseInput("   ")).toEqual({});
  });
});

describe("explicit mode selection", () => {
  it("puts the value in the chosen field, never guessing", () => {
    // "Yoshua Bengio" is name-shaped, but the user picked Title.
    expect(buildQueryForMode("title", "Yoshua Bengio")).toEqual({ title: "Yoshua Bengio" });
    // "Random Forests" is a real title, but the user picked Author.
    expect(buildQueryForMode("author", "Random Forests")).toEqual({ authors: ["Random Forests"] });
    expect(buildQueryForMode("keywords", "deepfake, audio")).toEqual({ keywords: ["deepfake", "audio"] });
    expect(buildQueryForMode("doi", "10.1371/journal.pone.0266462")).toEqual({
      doi: "10.1371/journal.pone.0266462",
    });
  });

  it('splits several authors on ";" and keeps "Last, First" intact', () => {
    expect(buildQueryForMode("author", "Bengio; Goodfellow")).toEqual({ authors: ["Bengio", "Goodfellow"] });
    expect(buildQueryForMode("author", "Bengio, Yoshua")).toEqual({ authors: ["Bengio, Yoshua"] });
  });

  it("accepts a year filter appended to any mode", () => {
    expect(buildQueryForMode("keywords", "deepfake + since: 2024")).toEqual({
      keywords: ["deepfake"],
      fromYear: 2024,
    });
    expect(buildQueryForMode("title", "Deep learning + year: 2020-2024")).toEqual({
      title: "Deep learning",
      fromYear: 2020,
      toYear: 2024,
    });
    expect(buildQueryForMode("author", "Bengio + until: 2015")).toEqual({
      authors: ["Bengio"],
      toYear: 2015,
    });
  });

  it("falls back to free-form parsing in auto mode", () => {
    expect(buildQueryForMode("auto", "@Bengio")).toEqual({ authors: ["Bengio"] });
    expect(buildQueryForMode("auto", "title: Deep learning + @Bengio")).toEqual({
      title: "Deep learning",
      authors: ["Bengio"],
    });
  });

  it("returns an empty query for empty input", () => {
    expect(buildQueryForMode("title", "   ")).toEqual({});
  });
});
