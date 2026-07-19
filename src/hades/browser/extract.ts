/* ------------------------------------------------------------------ *
 * extract.ts — pure, dependency-free HTML content extraction.
 *
 * Turns a fetched page (raw HTML string, or an `ExtractablePage` seam)
 * into normalized text, harvested links/metadata, and hash-cited
 * passages: every passage carries its source URL, a best-effort
 * selector path, and a sha256 of its exact stored text, so a verifier
 * can recompute the hash instead of trusting it.
 *
 * Imports node built-ins ONLY (`node:crypto` for sha256; `Buffer` is
 * the ambient Node global used for UTF-8 byte accounting). No
 * playwright, no other `src/hades/browser/*` module, no external HTML
 * parsing library — there are none in package.json, so the tokenizer
 * below is hand-rolled and deliberately tolerant of malformed markup
 * (unclosed tags, misnested inline/block elements, comments hiding
 * fake tags, stray "<", unterminated attributes/entities, etc.). It
 * never throws on adversarial input and always makes forward progress.
 *
 * Pure and deterministic: no Date, no Math.random, no I/O. Same input
 * (html + opts) always produces a byte-identical `ExtractResult`.
 * ------------------------------------------------------------------ */

import { createHash } from "node:crypto";

// ===========================================================================
// Public contract (locked)
// ===========================================================================

export interface CitedPassage {
  text: string;
  sourceUrl: string;
  /** Best-effort element path, e.g. "html>body>main>p:nth-of-type(2)". A
   *  `:nth-of-type(N)` suffix is only appended when the block has more than
   *  one sibling sharing its tag name under the same parent (disambiguation
   *  only where needed) — a singleton `<html>`/`<body>`/`<main>` never gets
   *  a suffix, matching the illustrative example above. */
  selectorPath: string;
  index: number;
  /** Lowercase hex sha256 of the UTF-8 bytes of `text` exactly as stored. */
  sha256: string;
}

export interface ExtractResult {
  url: string;
  title: string;
  text: string;
  passages: CitedPassage[];
  links: { href: string; text: string }[];
  meta: { description?: string; lang?: string; canonical?: string };
  truncated: boolean;
  bytes: number;
  contentType: "html" | "text";
}

export interface ExtractOptions {
  url: string;
  /** Byte budget applied to the normalized `text` field. Default 200_000. */
  maxBytes?: number;
  /** Max number of cited passages returned. Default 64. */
  maxPassages?: number;
  /** Minimum `text.length` (UTF-16 code units) for a block run to become a
   *  cited passage. Default 40. */
  minPassageChars?: number;
  /** Max number of links returned. Default 100. */
  maxLinks?: number;
}

/**
 * Structural seam matching driver-core's `DriverPage` shape (`url()`,
 * `title()`, `html()`). This is a local, structural duplicate — it does
 * NOT import `driver.ts` — so any value satisfying that shape (real or
 * test double) satisfies this interface too, and vice versa.
 */
export interface ExtractablePage {
  url(): string;
  title(): Promise<string>;
  html(): Promise<string>;
}

// ===========================================================================
// Small shared helpers
// ===========================================================================

function sha256Hex(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

const WHITESPACE_RE = /\s+/g;

function collapseWhitespace(text: string): string {
  return text.replace(WHITESPACE_RE, " ");
}

/** Byte-accurate truncation to at most `maxBytes` UTF-8 bytes. Never splits
 *  a multi-byte codepoint into mojibake or throws — Node's UTF-8 decoder
 *  replaces an incomplete trailing sequence with U+FFFD. */
function truncateUtf8(text: string, maxBytes: number): string {
  const encoded = Buffer.from(text, "utf8");
  if (encoded.length <= maxBytes) return text;
  const sliced = encoded.subarray(0, Math.max(0, maxBytes));
  return sliced.toString("utf8");
}

function resolveHref(href: string, base: string): string | null {
  const trimmed = href.trim();
  if (trimmed === "") return null;
  let resolved: URL;
  try {
    resolved = new URL(trimmed, base);
  } catch {
    return null;
  }
  if (resolved.protocol === "javascript:" || resolved.protocol === "data:") return null;
  return resolved.toString();
}

// ===========================================================================
// Entity decoding — bounded, single-pass, non-recursive (so
// "&amp;amp;" decodes to the literal text "&amp;", never further).
// ===========================================================================

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  copy: "©",
  reg: "®",
  trade: "™",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  times: "×",
  divide: "÷",
  deg: "°",
  plusmn: "±",
  sect: "§",
  para: "¶",
  middot: "·",
  laquo: "«",
  raquo: "»",
  euro: "€",
  pound: "£",
  yen: "¥",
  cent: "¢",
};

/** Mutable decode-budget carried across every `decodeEntities` call within
 *  one `extractFromHtml` invocation, so a document stuffed with thousands
 *  of entities cannot blow past a bounded multiple of the input size.
 *  Defense in depth (entities can only ever expand modestly, unlike DTD
 *  entity recursion), but it makes the bound explicit and tested. */
interface DecodeBudget {
  used: number;
  cap: number;
}

function decodeEntities(input: string, budget: DecodeBudget): string {
  let out = "";
  let i = 0;
  const n = input.length;
  while (i < n) {
    if (budget.used >= budget.cap) {
      out += input.slice(i);
      budget.used += input.length - i;
      break;
    }
    const c = input[i];
    if (c === "&") {
      const semi = input.indexOf(";", i + 1);
      if (semi !== -1 && semi - i <= 12) {
        const body = input.slice(i + 1, semi);
        let decodedChar: string | null = null;
        if (Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, body)) {
          decodedChar = NAMED_ENTITIES[body];
        } else if (body.length > 1 && body[0] === "#") {
          const isHex = body[1] === "x" || body[1] === "X";
          const numStr = isHex ? body.slice(2) : body.slice(1);
          const validDigits = isHex ? /^[0-9a-fA-F]+$/ : /^[0-9]+$/;
          if (numStr.length > 0 && validDigits.test(numStr)) {
            const code = parseInt(numStr, isHex ? 16 : 10);
            if (Number.isFinite(code) && code >= 0 && code <= 0x10ffff) {
              try {
                decodedChar = String.fromCodePoint(code);
              } catch {
                decodedChar = null;
              }
            }
          }
        }
        if (decodedChar !== null) {
          out += decodedChar;
          budget.used += decodedChar.length;
          i = semi + 1;
          continue;
        }
      }
    }
    out += c;
    budget.used += 1;
    i++;
  }
  return out;
}

// ===========================================================================
// Attribute-aware tag tokenizer
// ===========================================================================

interface ParsedTag {
  name: string;
  attrs: Map<string, string>;
  closing: boolean;
  selfClose: boolean;
  endIndex: number;
}

const TAG_NAME_CHAR = /[a-zA-Z0-9:_-]/;
const WS_CHAR = /\s/;

/** A `>` inside a quoted attribute value does not end the tag early; an
 *  unterminated tag/attribute consumes to end-of-document rather than
 *  throwing or looping. Returns null when `start` isn't actually a tag
 *  opener (e.g. "< foo" or a lone "<"). */
function parseTagAt(html: string, start: number): ParsedTag | null {
  const n = html.length;
  let i = start + 1;
  let closing = false;
  if (html[i] === "/") {
    closing = true;
    i++;
  }
  const nameStart = i;
  while (i < n && TAG_NAME_CHAR.test(html[i])) i++;
  if (i === nameStart) return null;
  const name = html.slice(nameStart, i).toLowerCase();

  const attrs = new Map<string, string>();
  let selfClose = false;

  while (i < n) {
    const c = html[i];
    if (c === ">") {
      i++;
      break;
    }
    if (c === "/" && html[i + 1] === ">") {
      selfClose = true;
      i += 2;
      break;
    }
    if (WS_CHAR.test(c)) {
      i++;
      continue;
    }
    const attrNameStart = i;
    while (i < n && !WS_CHAR.test(html[i]) && html[i] !== "=" && html[i] !== ">" && html[i] !== "/") {
      i++;
    }
    const attrName = html.slice(attrNameStart, i).toLowerCase();
    if (attrName === "") {
      i++;
      continue;
    }
    while (i < n && WS_CHAR.test(html[i])) i++;
    if (html[i] === "=") {
      i++;
      while (i < n && WS_CHAR.test(html[i])) i++;
      const quote = html[i];
      let value: string;
      if (quote === '"' || quote === "'") {
        i++;
        const valStart = i;
        while (i < n && html[i] !== quote) i++;
        value = html.slice(valStart, i);
        i = i < n ? i + 1 : n;
      } else {
        const valStart = i;
        while (i < n && !WS_CHAR.test(html[i]) && html[i] !== ">") i++;
        value = html.slice(valStart, i);
      }
      attrs.set(attrName, value);
    } else {
      attrs.set(attrName, "");
    }
  }

  return { name, attrs, closing, selfClose, endIndex: i };
}

function indexOfLower(haystackLower: string, needleLower: string, from: number): number {
  return haystackLower.indexOf(needleLower, from);
}

/** Content of these tags is treated as wholly opaque: we search for the
 *  literal closing tag rather than parsing nested markup, so a `<script>`
 *  body containing literal `</div>` text is never mistaken for real
 *  markup. Per the contract, script/style/noscript/template/iframe/svg
 *  content is stripped entirely. */
const OPAQUE_TAGS = new Set(["script", "style", "noscript", "template", "iframe", "svg"]);

function skipOpaqueBlock(html: string, htmlLower: string, tagName: string, from: number): number {
  const closeNeedle = `</${tagName}`;
  const idx = indexOfLower(htmlLower, closeNeedle, from);
  if (idx === -1) return html.length;
  const gt = html.indexOf(">", idx);
  return gt === -1 ? html.length : gt + 1;
}

// ===========================================================================
// Block-level structure
// ===========================================================================

const BLOCK_TAGS = new Set([
  "html", "body", "div", "section", "article", "aside", "header", "footer", "nav", "main",
  "address", "blockquote", "details", "dialog", "fieldset", "figcaption", "figure", "form",
  "li", "ol", "ul", "dl", "dt", "dd", "table", "thead", "tbody", "tfoot", "tr", "td", "th",
  "caption", "colgroup", "p", "pre", "h1", "h2", "h3", "h4", "h5", "h6", "hgroup", "summary", "hr",
]);

const VOID_TAGS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr",
]);

/** Mirrors the small set of HTML5 auto-close rules that matter for
 *  tolerant recovery from unclosed tags ("<p> soup", unclosed <li>/<td>). */
function shouldAutoClose(topTag: string, newTag: string): boolean {
  if (topTag === "p" && BLOCK_TAGS.has(newTag)) return true;
  if (topTag === "li" && newTag === "li") return true;
  if ((topTag === "td" || topTag === "th") && (newTag === "td" || newTag === "th" || newTag === "tr")) return true;
  if (topTag === "tr" && newTag === "tr") return true;
  if ((topTag === "dt" || topTag === "dd") && (newTag === "dt" || newTag === "dd")) return true;
  return false;
}

interface BlockFrame {
  tag: string;
  parent: BlockFrame | null;
  /** Running (and, once parsing completes, final) count of direct
   *  same-tag children, keyed by child tag name. */
  childCounts: Map<string, number>;
  /** 1-based position of this frame among its same-tag siblings, fixed at
   *  push time (position never changes once assigned). */
  myIndex: number;
}

interface RawPassage {
  text: string;
  node: BlockFrame | null;
}

/** Resolves a frame's ancestor chain into a selector path string, using
 *  each ancestor's FINAL same-tag sibling count (known only once parsing
 *  has finished) to decide whether `:nth-of-type(N)` is needed. */
function resolvePath(node: BlockFrame | null, rootChildCounts: Map<string, number>): string {
  if (node === null) return "html";
  const segments: string[] = [];
  let cur: BlockFrame | null = node;
  while (cur !== null) {
    const siblingCounts = cur.parent ? cur.parent.childCounts : rootChildCounts;
    const total = siblingCounts.get(cur.tag) ?? 1;
    segments.push(total > 1 ? `${cur.tag}:nth-of-type(${cur.myIndex})` : cur.tag);
    cur = cur.parent;
  }
  segments.reverse();
  return segments.join(">");
}

// ===========================================================================
// <base href> pre-scan (must be known before resolving canonical/links)
// ===========================================================================

function findBaseHref(html: string, htmlLower: string, pageUrl: string, budget: DecodeBudget): string | null {
  let searchFrom = 0;
  while (true) {
    const idx = htmlLower.indexOf("<base", searchFrom);
    if (idx === -1) return null;
    const after = html[idx + 5];
    if (after === undefined || after === ">" || after === "/" || WS_CHAR.test(after)) {
      const tag = parseTagAt(html, idx);
      if (tag && !tag.closing && tag.name === "base") {
        const hrefRaw = tag.attrs.get("href");
        if (hrefRaw === undefined) return null;
        const decoded = decodeEntities(hrefRaw, budget);
        try {
          return new URL(decoded, pageUrl).toString();
        } catch {
          return null;
        }
      }
    }
    searchFrom = idx + 5;
  }
}

// ===========================================================================
// HTML-mode extraction
// ===========================================================================

const HAS_TAG_RE = /<[a-zA-Z!/]/;

function extractHtmlMode(
  html: string,
  url: string,
  maxBytes: number,
  maxPassages: number,
  minPassageChars: number,
  maxLinks: number
): ExtractResult {
  const htmlLower = html.toLowerCase();
  const budget: DecodeBudget = { used: 0, cap: Math.max(1_000_000, html.length * 4) };
  const effectiveBase = findBaseHref(html, htmlLower, url, budget) ?? url;

  const stack: BlockFrame[] = [];
  const rootChildCounts = new Map<string, number>();
  let activeBuffer: string[] = [];
  const textSegments: string[] = [];
  const rawPassages: RawPassage[] = [];

  let title = "";
  let titleCaptured = false;
  let capturingTitle = false;
  let titleBuffer: string[] = [];

  let descriptionMeta: string | undefined;
  let langMeta: string | undefined;
  let canonicalMeta: string | undefined;

  let inHead = 0;
  let anchorDepth = 0;
  const anchorHrefStack: string[] = [];
  let anchorTextBuf = "";
  const links: { href: string; text: string }[] = [];

  function flush(node: BlockFrame | null): void {
    if (activeBuffer.length === 0) return;
    const raw = activeBuffer.join("");
    activeBuffer = [];
    const collapsed = collapseWhitespace(raw).trim();
    if (collapsed === "") return;
    textSegments.push(collapsed);
    rawPassages.push({ text: collapsed, node });
  }

  function pushBlock(tag: string): void {
    while (stack.length > 0 && shouldAutoClose(stack[stack.length - 1].tag, tag)) {
      flush(stack[stack.length - 1]);
      stack.pop();
    }
    flush(stack.length ? stack[stack.length - 1] : null);
    const parent = stack.length ? stack[stack.length - 1] : null;
    const counts = parent ? parent.childCounts : rootChildCounts;
    const nextCount = (counts.get(tag) ?? 0) + 1;
    counts.set(tag, nextCount);
    stack.push({ tag, parent, childCounts: new Map(), myIndex: nextCount });
  }

  function closeBlock(tag: string): void {
    let idx = -1;
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i].tag === tag) {
        idx = i;
        break;
      }
    }
    if (idx === -1) return;
    flush(stack[stack.length - 1]);
    while (stack.length > idx) stack.pop();
  }

  function softBreak(): void {
    flush(stack.length ? stack[stack.length - 1] : null);
  }

  let i = 0;
  const n = html.length;
  while (i < n) {
    if (html[i] === "<") {
      if (html.startsWith("<!--", i)) {
        const end = html.indexOf("-->", i + 4);
        i = end === -1 ? n : end + 3;
        continue;
      }
      if (html.startsWith("<![CDATA[", i)) {
        const end = html.indexOf("]]>", i + 9);
        i = end === -1 ? n : end + 3;
        continue;
      }
      if (html[i + 1] === "!" || html[i + 1] === "?") {
        const gt = html.indexOf(">", i + 2);
        i = gt === -1 ? n : gt + 1;
        continue;
      }

      const tag = parseTagAt(html, i);
      if (!tag) {
        if (capturingTitle) titleBuffer.push("<");
        else if (inHead === 0) activeBuffer.push("<");
        i++;
        continue;
      }
      const name = tag.name;

      // An unclosed <title> must not swallow the rest of the document:
      // any other recognized tag implicitly ends title capture.
      if (capturingTitle && name !== "title") {
        title = collapseWhitespace(decodeEntities(titleBuffer.join(""), budget)).trim();
        titleCaptured = true;
        capturingTitle = false;
        titleBuffer = [];
      }

      // A <body> start implicitly ends <head> even if </head> was never
      // seen (browsers do this too) — otherwise an unclosed <head> would
      // permanently suppress all body text.
      if (name === "body" && !tag.closing && inHead > 0) inHead = 0;

      // Side-effect metadata extraction (does not consume control flow).
      if (name === "html" && !tag.closing) {
        const lang = tag.attrs.get("lang");
        if (lang !== undefined && langMeta === undefined) {
          const decodedLang = decodeEntities(lang, budget).trim();
          if (decodedLang !== "") langMeta = decodedLang;
        }
      }
      if (name === "meta" && !tag.closing) {
        const nameAttr = (tag.attrs.get("name") ?? "").toLowerCase();
        if (nameAttr === "description" && descriptionMeta === undefined && tag.attrs.has("content")) {
          const decoded = decodeEntities(tag.attrs.get("content") as string, budget).trim();
          if (decoded !== "") descriptionMeta = decoded;
        }
      }
      if (name === "link" && !tag.closing) {
        const relTokens = (tag.attrs.get("rel") ?? "").toLowerCase().trim().split(/\s+/);
        if (relTokens.includes("canonical") && canonicalMeta === undefined && tag.attrs.has("href")) {
          const hrefRaw = decodeEntities(tag.attrs.get("href") as string, budget);
          const resolved = resolveHref(hrefRaw, effectiveBase);
          if (resolved !== null) canonicalMeta = resolved;
        }
      }

      // Structural dispatch.
      if (name === "head") {
        if (!tag.closing) inHead++;
        else inHead = Math.max(0, inHead - 1);
        i = tag.endIndex;
        continue;
      }
      if (name === "title") {
        if (!tag.closing && !tag.selfClose) {
          if (!titleCaptured) {
            capturingTitle = true;
            titleBuffer = [];
          }
        } else if (tag.closing) {
          if (capturingTitle) {
            title = collapseWhitespace(decodeEntities(titleBuffer.join(""), budget)).trim();
            titleCaptured = true;
            capturingTitle = false;
            titleBuffer = [];
          }
        }
        i = tag.endIndex;
        continue;
      }
      if (OPAQUE_TAGS.has(name)) {
        if (!tag.closing) {
          i = tag.selfClose ? tag.endIndex : skipOpaqueBlock(html, htmlLower, name, tag.endIndex);
        } else {
          i = tag.endIndex;
        }
        continue;
      }
      if (name === "a") {
        if (!tag.closing) {
          anchorHrefStack.push(tag.attrs.get("href") ?? "");
          anchorDepth++;
          if (anchorDepth === 1) anchorTextBuf = "";
          if (tag.selfClose) {
            anchorHrefStack.pop();
            anchorDepth--;
          }
        } else if (anchorDepth > 0) {
          const href = anchorHrefStack.pop() as string;
          anchorDepth--;
          if (anchorDepth === 0) {
            const resolved = resolveHref(href, effectiveBase);
            const text = collapseWhitespace(anchorTextBuf).trim();
            if (resolved !== null && links.length < maxLinks) links.push({ href: resolved, text });
            anchorTextBuf = "";
          }
        }
        i = tag.endIndex;
        continue;
      }
      if (name === "br") {
        softBreak();
        i = tag.endIndex;
        continue;
      }
      if (name === "hr") {
        if (!tag.closing) {
          pushBlock("hr");
          closeBlock("hr");
        }
        i = tag.endIndex;
        continue;
      }
      if (VOID_TAGS.has(name)) {
        i = tag.endIndex;
        continue;
      }
      if (BLOCK_TAGS.has(name)) {
        if (tag.closing) {
          closeBlock(name);
        } else {
          pushBlock(name);
          if (tag.selfClose) closeBlock(name);
        }
        i = tag.endIndex;
        continue;
      }
      // Inline or unrecognized element: no structural effect.
      i = tag.endIndex;
      continue;
    }

    const nextLt = html.indexOf("<", i);
    const chunkRaw = nextLt === -1 ? html.slice(i) : html.slice(i, nextLt);
    if (chunkRaw.length > 0) {
      const decoded = decodeEntities(chunkRaw, budget);
      if (capturingTitle) {
        titleBuffer.push(decoded);
      } else {
        if (inHead === 0) activeBuffer.push(decoded);
        if (anchorDepth > 0) anchorTextBuf += decoded;
      }
    }
    i = nextLt === -1 ? n : nextLt;
  }

  // Finalize a still-open <title> (unclosed at EOF).
  if (capturingTitle) {
    title = collapseWhitespace(decodeEntities(titleBuffer.join(""), budget)).trim();
  }
  // Final flush for trailing text under whatever block is (still) open.
  flush(stack.length ? stack[stack.length - 1] : null);

  const fullText = textSegments.join("\n");
  const fullBytes = Buffer.byteLength(fullText, "utf8");
  let finalText = fullText;
  let truncated = false;
  if (fullBytes > maxBytes) {
    finalText = truncateUtf8(fullText, maxBytes);
    truncated = true;
  }
  const truncatedBytes = truncated ? Buffer.byteLength(finalText, "utf8") : fullBytes;

  const passages: CitedPassage[] = [];
  let offset = 0;
  for (let k = 0; k < textSegments.length; k++) {
    const segText = textSegments[k];
    const segBytes = Buffer.byteLength(segText, "utf8");
    const segEnd = offset + segBytes;
    offset = segEnd + 1; // "\n" separator
    if (truncated && segEnd > truncatedBytes) break;
    if (segText.length < minPassageChars) continue;
    passages.push({
      text: segText,
      sourceUrl: url,
      selectorPath: resolvePath(rawPassages[k].node, rootChildCounts),
      index: passages.length,
      sha256: sha256Hex(segText),
    });
    if (passages.length >= maxPassages) break;
  }

  const meta: ExtractResult["meta"] = {};
  if (descriptionMeta !== undefined) meta.description = descriptionMeta;
  if (langMeta !== undefined) meta.lang = langMeta;
  if (canonicalMeta !== undefined) meta.canonical = canonicalMeta;

  return {
    url,
    title,
    text: finalText,
    passages,
    links,
    meta,
    truncated,
    bytes: fullBytes,
    contentType: "html",
  };
}

// ===========================================================================
// Plain-text mode (input with no HTML tags at all)
// ===========================================================================

function extractTextMode(
  input: string,
  url: string,
  maxBytes: number,
  maxPassages: number,
  minPassageChars: number
): ExtractResult {
  const normalizedRaw = input.replace(/\r\n/g, "\n");
  const rawParagraphs = normalizedRaw.split(/\n\s*\n+/);
  const paragraphs = rawParagraphs.map((p) => collapseWhitespace(p).trim()).filter((p) => p.length > 0);
  const fullText = paragraphs.join("\n\n");
  const fullBytes = Buffer.byteLength(fullText, "utf8");
  let finalText = fullText;
  let truncated = false;
  if (fullBytes > maxBytes) {
    finalText = truncateUtf8(fullText, maxBytes);
    truncated = true;
  }
  const truncatedBytes = truncated ? Buffer.byteLength(finalText, "utf8") : fullBytes;

  const passages: CitedPassage[] = [];
  let offset = 0;
  for (let k = 0; k < paragraphs.length; k++) {
    const p = paragraphs[k];
    const segBytes = Buffer.byteLength(p, "utf8");
    const segEnd = offset + segBytes;
    offset = segEnd + 2; // "\n\n" separator
    if (truncated && segEnd > truncatedBytes) break;
    if (p.length < minPassageChars) continue;
    passages.push({
      text: p,
      sourceUrl: url,
      selectorPath: `text>p:nth-of-type(${k + 1})`,
      index: passages.length,
      sha256: sha256Hex(p),
    });
    if (passages.length >= maxPassages) break;
  }

  return {
    url,
    title: "",
    text: finalText,
    passages,
    links: [],
    meta: {},
    truncated,
    bytes: fullBytes,
    contentType: "text",
  };
}

// ===========================================================================
// Public entry points
// ===========================================================================

/**
 * Pure, deterministic extraction from a raw HTML (or plain-text) string.
 * Same input always produces byte-identical output.
 */
export function extractFromHtml(html: string, opts: ExtractOptions): ExtractResult {
  const url = opts.url;
  const maxBytes = opts.maxBytes ?? 200_000;
  const maxPassages = opts.maxPassages ?? 64;
  const minPassageChars = opts.minPassageChars ?? 40;
  const maxLinks = opts.maxLinks ?? 100;

  if (!HAS_TAG_RE.test(html)) {
    return extractTextMode(html, url, maxBytes, maxPassages, minPassageChars);
  }
  return extractHtmlMode(html, url, maxBytes, maxPassages, minPassageChars, maxLinks);
}

/**
 * Reads `url()` / `title()` / `html()` off an `ExtractablePage` and
 * delegates to `extractFromHtml`. `page.title()` wins over any `<title>`
 * found in the markup when it resolves to a non-empty string.
 */
export async function extractFromPage(
  page: ExtractablePage,
  opts: Omit<ExtractOptions, "url"> = {}
): Promise<ExtractResult> {
  const url = page.url();
  const [pageTitle, html] = await Promise.all([page.title(), page.html()]);
  const result = extractFromHtml(html, { url, ...opts });
  const trimmedPageTitle = pageTitle.trim();
  if (trimmedPageTitle !== "") {
    return { ...result, title: pageTitle };
  }
  return result;
}
