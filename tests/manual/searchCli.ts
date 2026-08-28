/**
 * Interactive terminal client for manual testing.
 *
 * It talks to the running HTTP API over the network, so what you see in the
 * terminal is exactly what a frontend would receive - this exercises the real
 * server, routing, validation and JSON contract, not an in-process shortcut.
 *
 *   npm run search                     # menu-driven prompt
 *   npm run search -- "Some title"     # one-shot
 *   npm run search -- --author "Bengio"
 *
 * Requires the server to be running (`npm run dev` or `npm start`).
 */

import readline from "node:readline";
import { pathToFileURL } from "node:url";

const SERVER = process.env.API_URL ?? "http://localhost:3000";
const COLOR = process.stdout.isTTY && process.env.NO_COLOR === undefined;

const c = {
  reset: COLOR ? "\x1b[0m" : "",
  bold: COLOR ? "\x1b[1m" : "",
  red: COLOR ? "\x1b[31m" : "",
  green: COLOR ? "\x1b[32m" : "",
  yellow: COLOR ? "\x1b[33m" : "",
  blue: COLOR ? "\x1b[34m" : "",
  cyan: COLOR ? "\x1b[36m" : "",
  grey: COLOR ? "\x1b[90m" : "",
};

interface SearchQuery {
  title?: string;
  authors?: string[];
  keywords?: string[];
  doi?: string;
  fromYear?: number;
  toYear?: number;
}

let showJson = false;

/* ------------------------------------------------------------------ */
/* Search modes                                                        */
/* ------------------------------------------------------------------ */

type Mode = "title" | "author" | "keywords" | "doi" | "auto";

interface ModeSpec {
  key: Mode;
  label: string;
  hint: string;
  prompt: string;
  example: string;
}

const MODES: ModeSpec[] = [
  {
    key: "title",
    label: "Paper title",
    hint: "the full or partial title of one paper",
    prompt: "title",
    example: "Attention Is All You Need",
  },
  {
    key: "author",
    label: "Author name",
    hint: 'any format; use ";" between several authors',
    prompt: "author(s)",
    example: 'Yoshua Bengio   /   Bengio, Yoshua   /   Bengio; Goodfellow',
  },
  {
    key: "keywords",
    label: "Keywords / topic",
    hint: "comma separated",
    prompt: "keywords",
    example: "deepfake, audio, video",
  },
  {
    key: "doi",
    label: "DOI",
    hint: "bare, doi: prefixed, or a doi.org URL",
    prompt: "DOI",
    example: "10.1371/journal.pone.0266462",
  },
  {
    key: "auto",
    label: "Anything (auto-detect)",
    hint: "mixed input; prefixes like @Name and doi: still work",
    prompt: "search",
    example: "title: Deep learning + @Bengio",
  },
];

function renderMenu(): void {
  console.log(`\n${c.bold}What are you searching by?${c.reset}`);
  MODES.forEach((m, i) => {
    console.log(`  ${c.cyan}${i + 1}${c.reset}) ${m.label.padEnd(24)}${c.grey}${m.hint}${c.reset}`);
  });
  console.log(
    `${c.grey}  Pick a number, or type e.g. "2 Yoshua Bengio" to do both at once.${c.reset}\n` +
      `${c.grey}  Year filter on any search: ${c.reset}${c.cyan}+ since: 2020${c.reset}${c.grey} / ${c.reset}${c.cyan}+ year: 2020-2024${c.reset}\n` +
      `${c.grey}  Commands: ${c.reset}${c.cyan}:help  :status  :json  :quit${c.reset}`,
  );
}

/** Resolves "2", "author", "authors" to a mode. */
function resolveMode(token: string): ModeSpec | undefined {
  const value = token.trim().toLowerCase();
  if (!value) return undefined;

  const index = Number(value);
  if (Number.isInteger(index) && index >= 1 && index <= MODES.length) return MODES[index - 1];

  return MODES.find(
    (m) =>
      m.key === value ||
      (value === "authors" && m.key === "author") ||
      (value === "keyword" && m.key === "keywords") ||
      (value === "any" && m.key === "auto"),
  );
}

/* ------------------------------------------------------------------ */
/* Input parsing                                                       */
/* ------------------------------------------------------------------ */

const DOI_LIKE = /(^|\/)10\.\d{4,9}\//;

/** Parses a `since: 2020` / `year: 2020-2024` style fragment. */
function parseYearPart(part: string): { fromYear?: number; toYear?: number } | undefined {
  const range = /^(year|years)\s*:\s*(\d{4})\s*-\s*(\d{4})$/i.exec(part);
  if (range) return { fromYear: Number(range[2]), toYear: Number(range[3]) };

  const single = /^(year|since|from|after|until|to|before)\s*:\s*(\d{4})$/i.exec(part);
  if (!single) return undefined;

  const key = single[1]!.toLowerCase();
  const value = Number(single[2]);
  if (key === "year") return { fromYear: value, toYear: value };
  if (["since", "from", "after"].includes(key)) return { fromYear: value };
  return { toYear: value };
}

/**
 * Pulls any year fragments out of a value, returning the rest.
 * Lets a year filter be appended to a moded input: "deepfake + since: 2024".
 */
function extractYearFilters(value: string): { rest: string; fromYear?: number; toYear?: number } {
  const kept: string[] = [];
  let fromYear: number | undefined;
  let toYear: number | undefined;

  for (const part of value.split(/\s+\+\s+/)) {
    const years = parseYearPart(part.trim());
    if (years) {
      if (years.fromYear !== undefined) fromYear = years.fromYear;
      if (years.toYear !== undefined) toYear = years.toYear;
      continue;
    }
    kept.push(part.trim());
  }
  return { rest: kept.filter(Boolean).join(" ").trim(), fromYear, toYear };
}

/**
 * Free-form parsing, used by the "Anything" mode and by one-shot arguments.
 *
 *   10.1371/journal.pone.0266462   -> doi
 *   @Vaswani                       -> author
 *   author: Ashish Vaswani         -> author
 *   kw: deepfake, audio, video     -> keywords
 *   title: Attention Is All ...    -> title
 *   Attention Is All You Need      -> title (default)
 *
 * Parts can be combined with `+`.
 */
export function parseInput(line: string): SearchQuery {
  const query: SearchQuery = {};

  for (const rawPart of line.split(/\s+\+\s+/)) {
    const part = rawPart.trim();
    if (!part) continue;

    const years = parseYearPart(part);
    if (years) {
      if (years.fromYear !== undefined) query.fromYear = years.fromYear;
      if (years.toYear !== undefined) query.toYear = years.toYear;
      continue;
    }

    const prefixed = /^(doi|title|author|authors|kw|keyword|keywords)\s*:\s*(.+)$/i.exec(part);
    if (prefixed) {
      const key = prefixed[1]!.toLowerCase();
      const value = prefixed[2]!.trim();
      if (key === "doi") query.doi = value;
      else if (key === "title") query.title = value;
      else if (key.startsWith("author")) {
        // Split on ";" only. A comma is part of a single name in the common
        // citation form "Bengio, Yoshua" - splitting there would invent two
        // authors called "Bengio" and "Yoshua".
        query.authors = [...(query.authors ?? []), ...splitList(value, ";")];
      } else {
        query.keywords = [...(query.keywords ?? []), ...splitList(value)];
      }
      continue;
    }

    if (part.startsWith("@")) {
      query.authors = [...(query.authors ?? []), part.slice(1).trim()];
      continue;
    }

    if (DOI_LIKE.test(part) || /^https?:\/\/(dx\.)?doi\.org\//i.test(part)) {
      query.doi = part;
      continue;
    }

    // A short comma-separated list of terms reads as keywords. A comma inside
    // a sentence does not: "Deep learning, a review" is a title, so a part
    // that starts with an article is treated as prose, not a keyword.
    if (looksLikeKeywordList(part)) {
      query.keywords = [...(query.keywords ?? []), ...splitList(part)];
      continue;
    }

    query.title = query.title ? `${query.title} ${part}` : part;
  }

  return query;
}

/**
 * Builds the request for an EXPLICITLY chosen mode.
 *
 * Nothing is guessed here: if the user picked "Author", the text goes in the
 * `authors` field even when it also looks like a title.
 */
export function buildQueryForMode(mode: Mode, rawValue: string): SearchQuery {
  // Auto mode parses the ORIGINAL line: `parseInput` splits on "+" itself and
  // handles year fragments, so pre-stripping them here would join the
  // remaining parts with a space and destroy those separators.
  if (mode === "auto") return parseInput(rawValue);

  const { rest, fromYear, toYear } = extractYearFilters(rawValue);
  const years = {
    ...(fromYear !== undefined ? { fromYear } : {}),
    ...(toYear !== undefined ? { toYear } : {}),
  };
  if (!rest) return { ...years };

  switch (mode) {
    case "title":
      return { title: rest, ...years };
    case "author":
      return { authors: splitList(rest, ";"), ...years };
    case "keywords":
      return { keywords: splitList(rest), ...years };
    case "doi":
    default:
      return { doi: rest, ...years };
  }
}

/** True for "deepfake, audio, video"; false for "Deep learning, a review". */
function looksLikeKeywordList(part: string): boolean {
  if (!part.includes(",")) return false;
  const terms = splitList(part);
  if (terms.length < 2) return false;
  return terms.every((term) => {
    const words = term.split(/\s+/);
    if (words.length > 3) return false;
    // An article or conjunction means this is prose, not a keyword.
    return !/^(a|an|the|and|or|of|for|with|in|on)$/i.test(words[0] ?? "");
  });
}

function splitList(value: string, separator: "," | ";" = ","): string[] {
  return value
    .split(separator)
    .map((v) => v.trim())
    .filter(Boolean);
}

/** Parses `--doi X --title Y --author A --keywords a,b` style arguments. */
function parseArgs(argv: string[]): SearchQuery | undefined {
  if (argv.length === 0) return undefined;
  if (!argv.some((a) => a.startsWith("--"))) return parseInput(argv.join(" "));

  const query: SearchQuery = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]!;
    const value = argv[i + 1];
    if (!flag.startsWith("--") || value === undefined) continue;
    i += 1;
    switch (flag) {
      case "--doi":
        query.doi = value;
        break;
      case "--title":
        query.title = value;
        break;
      case "--author":
      case "--authors":
        query.authors = [...(query.authors ?? []), ...splitList(value, ";")];
        break;
      case "--keyword":
      case "--keywords":
        query.keywords = [...(query.keywords ?? []), ...splitList(value)];
        break;
      case "--from":
      case "--since":
      case "--from-year":
        query.fromYear = Number(value);
        break;
      case "--to":
      case "--until":
      case "--to-year":
        query.toYear = Number(value);
        break;
      default:
        break;
    }
  }
  return query;
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

function bar(score: number): string {
  const filled = Math.round(Math.max(0, Math.min(1, score)) * 20);
  const colour = score >= 0.95 ? c.green : score >= 0.7 ? c.yellow : c.grey;
  return `${colour}${"#".repeat(filled)}${c.grey}${".".repeat(20 - filled)}${c.reset}`;
}

function statusColour(status: string): string {
  if (status === "success") return c.green;
  if (status === "skipped") return c.grey;
  if (status === "rate-limited") return c.yellow;
  return c.red;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function renderPaper(p: any, indent = ""): void {
  console.log(`${indent}${c.bold}${p.title}${c.reset}`);
  if (p.authors?.length) {
    const names = p.authors.slice(0, 5).join(", ");
    const more = p.authors.length > 5 ? ` +${p.authors.length - 5} more` : "";
    console.log(`${indent}${c.grey}authors ${c.reset}${names}${c.grey}${more}${c.reset}`);
  }
  const venue = p.journal ?? p.conference;
  const meta = [
    p.year ? `${p.year}` : undefined,
    venue ? truncate(venue, 45) : undefined,
    p.citationCount !== undefined ? `${p.citationCount} citations` : undefined,
  ].filter(Boolean);
  if (meta.length) console.log(`${indent}${c.grey}meta    ${c.reset}${meta.join(`${c.grey} · ${c.reset}`)}`);
  if (p.doi) console.log(`${indent}${c.grey}doi     ${c.reset}${p.doi}`);
  if (p.id) console.log(`${indent}${c.grey}id      ${c.reset}${p.id}`);
  console.log(`${indent}${c.grey}sources ${c.reset}${(p.sources ?? [p.source]).join(", ")}`);
  if (p.abstract) console.log(`${indent}${c.grey}abstract${c.reset} ${truncate(p.abstract.replace(/\s+/g, " "), 220)}`);
}

function renderFullText(ft: any, paper: any): void {
  if (!ft) return;
  const label = ft.available ? `${c.green}available${c.reset}` : `${c.yellow}not open${c.reset}`;
  console.log(
    `\n${c.bold}Full text${c.reset}  ${label} ${c.grey}(${ft.accessType}${ft.type ? `, ${ft.type}` : ""})${c.reset}`,
  );

  const pdf = paper?.pdfUrl ?? (ft.type === "pdf" ? ft.url : undefined);
  if (pdf) console.log(`  ${c.green}PDF ${c.reset}${c.cyan}${pdf}${c.reset}`);
  if (ft.url && ft.url !== pdf) console.log(`  ${c.grey}page${c.reset} ${ft.url}`);
  if (paper?.landingPageUrl && paper.landingPageUrl !== ft.url && paper.landingPageUrl !== pdf) {
    console.log(`  ${c.grey}page${c.reset} ${paper.landingPageUrl}`);
  }
  if (!ft.available && !pdf) {
    console.log(`  ${c.grey}paywalled or unavailable - this is the official landing page, never a bypass${c.reset}`);
  }
}

function renderResponse(body: any, elapsedMs: number): void {
  if (showJson) {
    console.log(JSON.stringify(body, null, 2));
    return;
  }

  if (body.success === false) {
    console.log(`\n${c.red}${c.bold}Error ${body.error.code}${c.reset}: ${body.error.message}`);
    if (body.error.details) console.log(`${c.grey}${JSON.stringify(body.error.details)}${c.reset}`);
    return;
  }

  const q = body.query ?? {};
  const parts = [
    q.doi ? `doi=${q.doi}` : undefined,
    q.title ? `title="${truncate(q.title, 50)}"` : undefined,
    q.authors?.length ? `authors=[${q.authors.join(", ")}]` : undefined,
    q.keywords?.length ? `keywords=[${q.keywords.join(", ")}]` : undefined,
    q.fromYear !== undefined || q.toYear !== undefined ? `years=${q.fromYear ?? "…"}-${q.toYear ?? "…"}` : undefined,
  ].filter(Boolean);
  console.log(`\n${c.grey}query   ${c.reset}${parts.join("  ")}  ${c.grey}strategy=${q.strategy}${c.reset}`);

  if (body.exactPaper) {
    const p = body.exactPaper;
    const typeColour = p.matchType === "exact" ? c.green : p.matchType === "near-exact" ? c.yellow : c.grey;
    console.log(
      `\n${c.bold}${c.blue}MATCH${c.reset}  ${typeColour}${p.matchType}${c.reset}  confidence ${bar(p.confidence)} ${p.confidence.toFixed(3)}`,
    );
    console.log();
    renderPaper(p, "  ");
    renderFullText(body.fullText, p);
  } else {
    console.log(
      `\n${c.yellow}No single paper identified${c.reset} ${c.grey}(a name or keyword does not name one paper)${c.reset}`,
    );
  }

  const similar = body.similarPapers ?? [];
  if (similar.length > 0) {
    const heading = body.exactPaper ? "Similar papers" : "Top results";
    const withPdf = similar.filter((s: any) => s.pdfUrl).length;
    console.log(`\n${c.bold}${heading}${c.reset} ${c.grey}(${similar.length}; ${withPdf} with a direct PDF)${c.reset}`);
    similar.forEach((s: any, i: number) => {
      const score = s.similarityScore ?? s.confidence ?? 0;
      console.log(
        `  ${c.grey}${String(i + 1).padStart(2)}.${c.reset} ${score.toFixed(3)} ${bar(score)}  ${truncate(s.title, 62)}`,
      );
      const sub = [s.year ? String(s.year) : undefined, s.doi].filter(Boolean);
      if (sub.length) console.log(`      ${c.grey}${sub.join(" · ")}${c.reset}`);
      if (s.pdfUrl) console.log(`      ${c.green}PDF ${c.reset}${c.cyan}${s.pdfUrl}${c.reset}`);
    });
  }

  const checked = body.sourcesChecked ?? [];
  if (checked.length > 0) {
    console.log(`\n${c.bold}Sources${c.reset}`);
    for (const s of checked) {
      const line =
        `  ${s.name.padEnd(18)} ${statusColour(s.status)}${s.status.padEnd(13)}${c.reset}` +
        `${String(s.resultCount).padStart(3)} result(s)  ${c.grey}${String(s.durationMs).padStart(6)}ms${c.reset}`;
      console.log(s.error ? `${line}  ${c.grey}${s.error}${c.reset}` : line);
    }
  }

  if (body.notes?.length) {
    console.log();
    for (const note of body.notes) console.log(`${c.grey}note: ${note}${c.reset}`);
  }

  const t = body.timings ?? {};
  console.log(
    `\n${c.grey}stoppedEarly=${body.stoppedEarly}  main=${t.mainPaperMs}ms  similar=${t.similarPapersMs}ms  server=${t.totalMs}ms  wall=${elapsedMs}ms${c.reset}`,
  );
}

/* ------------------------------------------------------------------ */
/* HTTP                                                                */
/* ------------------------------------------------------------------ */

async function runSearch(query: SearchQuery): Promise<void> {
  if (!query.title && !query.authors && !query.keywords && !query.doi) {
    console.log(`${c.yellow}Nothing to search for.${c.reset}`);
    return;
  }

  console.log(`${c.grey}searching…${c.reset}`);
  const startedAt = Date.now();
  try {
    const response = await fetch(`${SERVER}/api/papers/search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(query),
    });
    const body = await response.json();
    console.log(`${c.grey}HTTP ${response.status}${c.reset}`);
    renderResponse(body, Date.now() - startedAt);
  } catch (error) {
    console.log(`\n${c.red}Could not reach the API at ${SERVER}${c.reset}`);
    console.log(`${c.grey}${error instanceof Error ? error.message : String(error)}${c.reset}`);
    console.log(`${c.grey}Start it in another terminal with:  npm run dev${c.reset}`);
  }
}

async function checkServer(): Promise<boolean> {
  try {
    const response = await fetch(`${SERVER}/health`, { signal: AbortSignal.timeout(3000) });
    const body: any = await response.json();
    console.log(`${c.green}connected${c.reset} ${c.grey}${SERVER} · ${body.service} v${body.version}${c.reset}`);
    return true;
  } catch {
    console.log(`${c.red}Cannot reach the API at ${SERVER}${c.reset}`);
    console.log(
      `${c.grey}Start the server first:${c.reset}\n  npm run dev        ${c.grey}# or: npm run build && npm start${c.reset}\n`,
    );
    return false;
  }
}

function showHelp(): void {
  console.log(`
${c.bold}How it works${c.reset}
  1. Pick what you are searching by (the numbered menu).
  2. Type the value.
  3. Results print here, then you return to the menu.

${c.bold}Shortcuts${c.reset}
  ${c.cyan}2 Yoshua Bengio${c.reset}          ${c.grey}mode + value in one line${c.reset}
  ${c.cyan}b${c.reset} / ${c.cyan}back${c.reset}                ${c.grey}return to the menu from a value prompt${c.reset}

${c.bold}Year filters${c.reset} ${c.grey}(append to any value)${c.reset}
  ${c.cyan}+ since: 2020${c.reset}            ${c.grey}2020 or later${c.reset}
  ${c.cyan}+ until: 2024${c.reset}            ${c.grey}2024 or earlier${c.reset}
  ${c.cyan}+ year: 2020-2024${c.reset}        ${c.grey}range${c.reset}

${c.bold}Commands${c.reset}
  ${c.cyan}:help${c.reset}    this text
  ${c.cyan}:json${c.reset}    toggle raw JSON output ${c.grey}(currently ${showJson ? "on" : "off"})${c.reset}
  ${c.cyan}:status${c.reset}  source, circuit and cache status
  ${c.cyan}:health${c.reset}  ping /health
  ${c.cyan}:quit${c.reset}    exit ${c.grey}(Ctrl+C also works)${c.reset}
`);
}

async function showStatus(): Promise<void> {
  try {
    const response = await fetch(`${SERVER}/api/sources/status`);
    const body: any = await response.json();
    if (showJson) {
      console.log(JSON.stringify(body, null, 2));
      return;
    }
    console.log(`\n${c.bold}Sources${c.reset}`);
    for (const s of body.sources) {
      const avail = s.available ? `${c.green}available${c.reset}` : `${c.grey}skipped  ${c.reset}`;
      console.log(
        `  ${s.name.padEnd(18)} ${avail}  ${c.grey}${(s.role.join("+") || "-").padEnd(18)} circuit=${s.circuit.state.padEnd(9)} requests=${s.rateLimit?.totalRequests ?? 0}${c.reset}` +
          (s.reason ? `  ${c.grey}${s.reason}${c.reset}` : ""),
      );
    }
    console.log(`\n${c.grey}cache ${JSON.stringify(body.cache)}${c.reset}`);
  } catch (error) {
    console.log(`${c.red}status failed: ${error instanceof Error ? error.message : String(error)}${c.reset}`);
  }
}

/* ------------------------------------------------------------------ */
/* Entrypoint                                                          */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  const oneShot = parseArgs(process.argv.slice(2));

  if (oneShot) {
    if (!(await checkServer())) process.exitCode = 1;
    else await runSearch(oneShot);
    return;
  }

  console.log(`${c.bold}Academic Paper Finder${c.reset} ${c.grey}- manual test client${c.reset}`);
  if (!(await checkServer())) {
    process.exitCode = 1;
    return;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  /** `undefined` => at the menu; otherwise waiting for that mode's value. */
  let pending: ModeSpec | undefined;

  const toMenu = (): void => {
    pending = undefined;
    renderMenu();
    rl.setPrompt(`${c.bold}${c.blue}choice>${c.reset} `);
    rl.prompt();
  };

  const askValue = (mode: ModeSpec): void => {
    pending = mode;
    console.log(`\n${c.bold}${mode.label}${c.reset} ${c.grey}- ${mode.hint}${c.reset}`);
    console.log(`${c.grey}e.g. ${mode.example}${c.reset}`);
    rl.setPrompt(`${c.bold}${c.blue}${mode.prompt}>${c.reset} `);
    rl.prompt();
  };

  toMenu();

  // A search takes seconds. Input is paused while one runs, so a line typed
  // (or piped) mid-search cannot start a second one or interleave its output.
  let busy = false;
  let quitRequested = false;

  const finish = (next: "menu" | "value" | "quit"): void => {
    busy = false;
    if (quitRequested || next === "quit") {
      rl.close();
      return;
    }
    rl.resume();
    if (next === "value" && pending) askValue(pending);
    else toMenu();
  };

  rl.on("line", (line) => {
    if (busy) return; // ignore anything typed while a search is in flight
    const input = line.trim();
    busy = true;
    rl.pause();

    void (async () => {
      try {
        // Commands work from either prompt.
        if (input === ":quit" || input === ":q" || input === ":exit") return finish("quit");

        if (input === ":help" || input === ":h" || input === "?") {
          showHelp();
          return finish(pending ? "value" : "menu");
        }
        if (input === ":json") {
          showJson = !showJson;
          console.log(`${c.grey}raw JSON output ${showJson ? "on" : "off"}${c.reset}`);
          return finish(pending ? "value" : "menu");
        }
        if (input === ":status") {
          await showStatus();
          return finish(pending ? "value" : "menu");
        }
        if (input === ":health") {
          await checkServer();
          return finish(pending ? "value" : "menu");
        }

        // Waiting for a value for the mode already chosen.
        if (pending) {
          if (!input || input === "b" || input === "back") return finish("menu");
          await runSearch(buildQueryForMode(pending.key, input));
          return finish("menu");
        }

        if (!input) return finish("menu");

        // "2"  or  "2 Yoshua Bengio"
        const [token, ...rest] = input.split(/\s+/);
        const mode = resolveMode(token!);
        if (!mode) {
          console.log(`${c.yellow}Pick 1-${MODES.length}, or type :help${c.reset}`);
          return finish("menu");
        }
        const value = rest.join(" ").trim();
        if (value) {
          await runSearch(buildQueryForMode(mode.key, value));
          return finish("menu");
        }
        pending = mode;
        return finish("value");
      } catch (error) {
        console.log(`${c.red}${error instanceof Error ? error.message : String(error)}${c.reset}`);
        return finish("menu");
      }
    })();
  });

  rl.on("close", () => {
    // Never tear down mid-search: doing so aborts an in-flight request and
    // trips a libuv assertion on Windows.
    if (busy) {
      quitRequested = true;
      return;
    }
    console.log(`${c.grey}bye${c.reset}`);
    process.exitCode = 0;
  });
}

// Only start the REPL when run directly, so the parser can be imported and
// unit tested without launching an interactive session.
const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  await main();
}
