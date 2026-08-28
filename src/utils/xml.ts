/**
 * Minimal, dependency-free, non-validating XML reader.
 *
 * Scope: exactly what the two XML-returning official APIs need -
 * the arXiv Atom feed and NCBI E-utilities EFetch. It is intentionally small;
 * it is not a general-purpose XML processor.
 *
 * Safety notes:
 *  - DOCTYPE / internal subsets are skipped, never expanded, so external and
 *    parameter entity expansion (XXE, billion laughs) cannot happen.
 *  - Only the five predefined XML entities plus numeric character references
 *    are decoded.
 *  - Depth and node count are bounded to keep a hostile document from
 *    exhausting memory.
 */

export interface XmlNode {
  name: string;
  attributes: Record<string, string>;
  children: XmlNode[];
  text: string;
}

export class XmlParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "XmlParseError";
  }
}

const MAX_DEPTH = 100;
const MAX_NODES = 200_000;

export function parseXml(input: string): XmlNode {
  if (typeof input !== "string" || input.trim() === "") {
    throw new XmlParseError("Empty XML document");
  }

  const root: XmlNode = { name: "#document", attributes: {}, children: [], text: "" };
  const stack: XmlNode[] = [root];
  let nodeCount = 0;
  let i = 0;

  while (i < input.length) {
    const lt = input.indexOf("<", i);
    if (lt === -1) {
      appendText(stack[stack.length - 1]!, input.slice(i));
      break;
    }
    if (lt > i) appendText(stack[stack.length - 1]!, input.slice(i, lt));

    // <!-- comment -->  |  <![CDATA[ ... ]]>  |  <!DOCTYPE ...>
    if (input.startsWith("<!--", lt)) {
      const end = input.indexOf("-->", lt + 4);
      i = end === -1 ? input.length : end + 3;
      continue;
    }
    if (input.startsWith("<![CDATA[", lt)) {
      const end = input.indexOf("]]>", lt + 9);
      const raw = end === -1 ? input.slice(lt + 9) : input.slice(lt + 9, end);
      stack[stack.length - 1]!.text += raw;
      i = end === -1 ? input.length : end + 3;
      continue;
    }
    if (input.startsWith("<!", lt)) {
      i = skipDeclaration(input, lt);
      continue;
    }
    if (input.startsWith("<?", lt)) {
      const end = input.indexOf("?>", lt + 2);
      i = end === -1 ? input.length : end + 2;
      continue;
    }

    const gt = findTagEnd(input, lt);
    if (gt === -1) throw new XmlParseError("Unterminated tag");
    const rawTag = input.slice(lt + 1, gt).trim();
    i = gt + 1;

    if (rawTag.startsWith("/")) {
      const name = localName(rawTag.slice(1).trim());
      // Close the innermost matching element; tolerate stray close tags.
      for (let depth = stack.length - 1; depth > 0; depth -= 1) {
        if (stack[depth]!.name === name) {
          stack.length = depth;
          break;
        }
      }
      continue;
    }

    const selfClosing = rawTag.endsWith("/");
    const body = selfClosing ? rawTag.slice(0, -1).trim() : rawTag;
    const { name, attributes } = parseTagBody(body);

    nodeCount += 1;
    if (nodeCount > MAX_NODES) throw new XmlParseError("XML document has too many nodes");

    const node: XmlNode = { name, attributes, children: [], text: "" };
    stack[stack.length - 1]!.children.push(node);

    if (!selfClosing) {
      if (stack.length >= MAX_DEPTH) throw new XmlParseError("XML document nested too deeply");
      stack.push(node);
    }
  }

  return root;
}

function skipDeclaration(input: string, start: number): number {
  // Handles <!DOCTYPE ...> including an internal subset [...] without expanding it.
  let depth = 0;
  let inSubset = false;
  for (let i = start; i < input.length; i += 1) {
    const ch = input[i];
    if (ch === "[") inSubset = true;
    else if (ch === "]") inSubset = false;
    else if (ch === "<") depth += 1;
    else if (ch === ">") {
      depth -= 1;
      if (depth <= 0 && !inSubset) return i + 1;
    }
  }
  return input.length;
}

/** Finds the ">" that closes a tag, ignoring ">" inside attribute quotes. */
function findTagEnd(input: string, start: number): number {
  let quote: string | undefined;
  for (let i = start + 1; i < input.length; i += 1) {
    const ch = input[i]!;
    if (quote) {
      if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === ">") return i;
  }
  return -1;
}

function parseTagBody(body: string): { name: string; attributes: Record<string, string> } {
  const match = /^([^\s/>]+)/.exec(body);
  if (!match) throw new XmlParseError(`Malformed tag: <${body}>`);
  const name = localName(match[1]!);
  const attributes: Record<string, string> = {};

  const attrPattern = /([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  attrPattern.lastIndex = match[1]!.length;
  let attr: RegExpExecArray | null;
  while ((attr = attrPattern.exec(body)) !== null) {
    const key = localName(attr[1]!);
    const value = attr[3] ?? attr[4] ?? attr[5] ?? "";
    attributes[key] = decodeEntities(value);
  }
  return { name, attributes };
}

/** Drops the namespace prefix: "atom:entry" -> "entry". */
function localName(name: string): string {
  const colon = name.indexOf(":");
  return colon === -1 ? name : name.slice(colon + 1);
}

function appendText(node: XmlNode, chunk: string): void {
  if (!chunk) return;
  node.text += decodeEntities(chunk);
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

export function decodeEntities(input: string): string {
  if (!input.includes("&")) return input;
  return input.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, entity: string) => {
    if (entity.startsWith("#")) {
      const isHex = entity[1] === "x" || entity[1] === "X";
      const code = Number.parseInt(isHex ? entity.slice(2) : entity.slice(1), isHex ? 16 : 10);
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
        try {
          return String.fromCodePoint(code);
        } catch {
          return whole;
        }
      }
      return whole;
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? whole;
  });
}

/* ------------------------------------------------------------------ */
/* Query helpers                                                       */
/* ------------------------------------------------------------------ */

export function findAll(node: XmlNode, name: string): XmlNode[] {
  const out: XmlNode[] = [];
  const walk = (current: XmlNode): void => {
    for (const child of current.children) {
      if (child.name === name) out.push(child);
      walk(child);
    }
  };
  walk(node);
  return out;
}

export function findFirst(node: XmlNode, name: string): XmlNode | undefined {
  for (const child of node.children) {
    if (child.name === name) return child;
    const nested = findFirst(child, name);
    if (nested) return nested;
  }
  return undefined;
}

/** Direct children with the given name (does not descend). */
export function childrenNamed(node: XmlNode, name: string): XmlNode[] {
  return node.children.filter((child) => child.name === name);
}

export function childNamed(node: XmlNode, name: string): XmlNode | undefined {
  return node.children.find((child) => child.name === name);
}

/** All text inside a node, including descendants, whitespace-collapsed. */
export function textOf(node: XmlNode | undefined): string {
  if (!node) return "";
  let out = node.text;
  for (const child of node.children) out += " " + textOf(child);
  return out.replace(/\s+/g, " ").trim();
}

export function textOfChild(node: XmlNode | undefined, name: string): string | undefined {
  if (!node) return undefined;
  const child = childNamed(node, name);
  if (!child) return undefined;
  const value = textOf(child);
  return value === "" ? undefined : value;
}
