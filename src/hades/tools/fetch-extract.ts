/* ------------------------------------------------------------------ *
 * fetch_extract — a `web` category CatalogEntry.
 *
 * REAL mode (a `fetchFn` transport is injected — no env key required):
 * fetches an http(s) URL through `fetchFn`, enforces a byte cap on the
 * response body, then runs `extractHtml` — a hand-written HTML scanner
 * with no regex-only nesting hacks and no external deps — over the
 * (possibly truncated) body.
 *
 * MOCK mode (no `fetchFn` injected): NEVER touches the network. A
 * small built-in fixture corpus is selected deterministically from a
 * real FNV-1a hash of the URL, rendered into synthetic HTML labelled
 * "[mock]" throughout, and run through the exact same truncate +
 * extract pipeline as the real path — so mock and real behave
 * identically except for where the bytes came from.
 *
 * `extractHtml` is exported and independently tested: it strips
 * script/style/head/comments as opaque blocks (a `<script>` containing
 * a literal `</div>` does not confuse it — it looks for the actual
 * closing tag, not nested markup), is attribute-aware (a `>` inside a
 * quoted attribute value does not end the tag early), decodes the
 * named entities amp/lt/gt/quot/apos plus numeric entities (decimal
 * and hex) with a bounded expansion cap, collapses whitespace, pulls
 * `<title>`, and resolves relative hrefs against `baseUrl` via the
 * real `URL` constructor.
 *
 * This module deliberately does NOT import `../tools/catalog` (that
 * module belongs to another team in this build). `CatalogEntry`,
 * `ToolFactoryOptions`, `ToolMode`, `ToolCategory` and `FetchLike`
 * below are local, structural duplicates of that locked contract —
 * TypeScript's structural typing means a value built here satisfies
 * that module's types (and vice versa) without either module ever
 * importing the other.
 * ------------------------------------------------------------------ */

import type { Tool, ToolResult } from "../agent/tools";

// ---------------------------------------------------------------------------
// Locked shapes (local structural duplicates — see file header)
// ---------------------------------------------------------------------------

export type ToolMode = "real" | "mock";
export type ToolCategory = "web" | "system" | "media" | "data";

export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string }
) => Promise<{ status: number; headers: Record<string, string>; text(): Promise<string> }>;

export interface ToolFactoryOptions {
  env?: Record<string, string | undefined>;
  fetchFn?: FetchLike;
  now?: () => number;
}

export interface CatalogEntry {
  tool: Tool;
  id: string;
  category: ToolCategory;
  mode: ToolMode;
  requiresNetwork: boolean;
  requiredEnvKeys: string[];
  verifierId: string;
}

// ---------------------------------------------------------------------------
// Output contract
// ---------------------------------------------------------------------------

export type ExtractKind = "text" | "title" | "links";

export interface FetchExtractOutput {
  mode: ToolMode;
  url: string;
  extract: ExtractKind;
  content: string;
  truncated: boolean;
}

const TOOL_NAME = "fetch_extract";
const DEFAULT_MAX_BYTES = 65536;

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// ---------------------------------------------------------------------------
// Real FNV-1a hashing (duplicated locally — see web-search.ts for the twin)
// ---------------------------------------------------------------------------

function fnv1a(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function toHex8(n: number): string {
  return (n >>> 0).toString(16).padStart(8, "0");
}

function slugify(str: string): string {
  const slug = str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug === "" ? "url" : slug;
}

// ===========================================================================
// extractHtml — the real, hand-written, dependency-free HTML scanner
// ===========================================================================

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

/** Mutable decode-budget carried across every `decodeEntities` call within a
 *  single `extractHtml` invocation, so a document stuffed with thousands of
 *  entities cannot blow past a bounded multiple of the input size. Named/
 *  numeric HTML entities can only ever expand to a handful of characters
 *  each (unlike DTD entity-recursion "billion laughs" attacks), so this is
 *  defense in depth rather than a fix for genuine exponential blowup — but
 *  it makes the bound explicit and tested rather than assumed. */
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
      // Budget exhausted: stop decoding, emit the remainder verbatim so the
      // function still terminates promptly and produces bounded output.
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

const WHITESPACE_RE = /\s+/g;

function collapseWhitespace(text: string): string {
  return text.replace(WHITESPACE_RE, " ");
}

/** Case-insensitive `indexOf` against a haystack the caller already
 *  lower-cased once, so repeated searches over a large document stay
 *  linear rather than re-lowercasing on every call. */
function indexOfLower(haystackLower: string, needleLower: string, from: number): number {
  return haystackLower.indexOf(needleLower, from);
}

interface ParsedTag {
  name: string;
  attrs: Map<string, string>;
  closing: boolean;
  selfClose: boolean;
  /** Index of the character just past this tag's terminating '>' (or the
   *  end of the string if the tag was never terminated). */
  endIndex: number;
}

const TAG_NAME_CHAR = /[a-zA-Z0-9:_-]/;
const WS_CHAR = /\s/;

/** Attribute-aware tag parser: a `>` inside a quoted attribute value does
 *  NOT end the tag early, and an unterminated tag/attribute consumes to
 *  the end of the document rather than throwing or looping forever
 *  (adversarial "unclosed tags" input must still terminate cleanly). */
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
  if (i === nameStart) return null; // not actually a tag (e.g. "< foo" or "<3")
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
      // Stray character (e.g. a bare '=' or an unexpected symbol); skip it
      // so the scanner always makes forward progress.
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
        i = i < n ? i + 1 : n; // consume closing quote if present
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

/** Tags whose entire content is treated as opaque raw text — we search for
 *  the literal closing tag rather than parsing nested markup, so e.g. a
 *  `<script>` body containing the literal text `</div>` is not mistaken
 *  for a real closing tag. */
const OPAQUE_TAGS = new Set(["script", "style", "head"]);

function skipOpaqueBlock(html: string, htmlLower: string, tagName: string, from: number): number {
  const closeNeedle = `</${tagName}`;
  const idx = indexOfLower(htmlLower, closeNeedle, from);
  if (idx === -1) return html.length;
  const gt = html.indexOf(">", idx);
  return gt === -1 ? html.length : gt + 1;
}

function extractTitle(html: string, htmlLower: string, budget: DecodeBudget): string {
  const openIdx = indexOfLower(htmlLower, "<title", 0);
  if (openIdx === -1) return "";
  const gt = html.indexOf(">", openIdx);
  if (gt === -1) return "";
  const closeIdx = indexOfLower(htmlLower, "</title", gt);
  const contentEnd = closeIdx === -1 ? html.length : closeIdx;
  const raw = html.slice(gt + 1, contentEnd);
  const decoded = decodeEntities(raw, budget);
  return collapseWhitespace(decoded).trim();
}

function resolveHref(href: string, baseUrl?: string): string | null {
  const trimmed = href.trim();
  if (trimmed === "") return null;
  if (baseUrl) {
    try {
      return new URL(trimmed, baseUrl).toString();
    } catch {
      return null;
    }
  }
  try {
    return new URL(trimmed).toString();
  } catch {
    return trimmed; // best-effort: no base to resolve a relative href against
  }
}

interface ScannedLink {
  text: string;
  href: string;
}

function scanBody(
  html: string,
  mode: "text" | "links",
  baseUrl: string | undefined,
  budget: DecodeBudget
): { text: string; links: ScannedLink[] } {
  const htmlLower = html.toLowerCase();
  const n = html.length;
  let i = 0;
  const textChunks: string[] = [];
  const links: ScannedLink[] = [];

  let anchorDepth = 0;
  const anchorHrefStack: string[] = [];
  let anchorTextBuf = "";

  const emit = (raw: string): void => {
    if (raw.length === 0) return;
    const decoded = decodeEntities(raw, budget);
    if (mode === "text") textChunks.push(decoded);
    if (mode === "links" && anchorDepth > 0) anchorTextBuf += decoded;
  };

  while (i < n) {
    if (html[i] === "<") {
      if (html.startsWith("<!--", i)) {
        const end = html.indexOf("-->", i + 4);
        i = end === -1 ? n : end + 3;
        continue;
      }
      const tag = parseTagAt(html, i);
      if (!tag) {
        emit("<");
        i++;
        continue;
      }
      if (!tag.closing && OPAQUE_TAGS.has(tag.name)) {
        i = skipOpaqueBlock(html, htmlLower, tag.name, tag.endIndex);
        continue;
      }
      if (mode === "links") {
        if (!tag.closing && tag.name === "a") {
          anchorHrefStack.push(tag.attrs.get("href") ?? "");
          anchorTextBuf = "";
          anchorDepth++;
        } else if (tag.closing && tag.name === "a" && anchorDepth > 0) {
          const href = anchorHrefStack.pop() ?? "";
          anchorDepth--;
          const resolved = resolveHref(href, baseUrl);
          const text = collapseWhitespace(anchorTextBuf).trim();
          if (resolved !== null) links.push({ text, href: resolved });
          anchorTextBuf = "";
        }
      }
      i = tag.endIndex;
      // A tag boundary always breaks text flow so adjoining elements don't
      // glue words together (e.g. "<p>a</p><p>b</p>" -> "a b", not "ab").
      if (mode === "text") textChunks.push(" ");
      continue;
    }
    const nextLt = html.indexOf("<", i);
    const chunk = nextLt === -1 ? html.slice(i) : html.slice(i, nextLt);
    emit(chunk);
    i = nextLt === -1 ? n : nextLt;
  }

  return { text: collapseWhitespace(textChunks.join("")).trim(), links };
}

function formatLinks(links: ScannedLink[]): string {
  return links.map((l) => (l.text ? `${l.text} -> ${l.href}` : l.href)).join("\n");
}

/**
 * Extract `mode`-shaped content from raw HTML. Never throws: malformed
 * markup (unclosed tags, unterminated comments/attribute values, a
 * `<script>` body containing arbitrary "closing-tag-looking" text) all
 * degrade to a best-effort result rather than an exception, because the
 * scanner always makes forward progress and every unmatched opener falls
 * back to "consume to end of document" instead of looping.
 */
export function extractHtml(html: string, mode: ExtractKind, baseUrl?: string): string {
  // Decode budget: generous relative to input size (each entity can only
  // ever shrink or hold roughly steady in length versus its `&name;`/
  // `&#NNN;` source), floored so tiny documents still decode fully.
  const budget: DecodeBudget = { used: 0, cap: Math.max(1_000_000, html.length * 4) };

  if (mode === "title") {
    return extractTitle(html, html.toLowerCase(), budget);
  }
  if (mode === "links") {
    return formatLinks(scanBody(html, "links", baseUrl, budget).links);
  }
  return scanBody(html, "text", baseUrl, budget).text;
}

// ---------------------------------------------------------------------------
// Byte-accurate truncation
// ---------------------------------------------------------------------------

function truncateToMaxBytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const encoded = new TextEncoder().encode(text);
  if (encoded.length <= maxBytes) return { text, truncated: false };
  const sliced = encoded.slice(0, Math.max(0, maxBytes));
  const decoded = new TextDecoder("utf-8", { fatal: false }).decode(sliced);
  return { text: decoded, truncated: true };
}

// ---------------------------------------------------------------------------
// URL validation
// ---------------------------------------------------------------------------

type UrlValidation = { url: URL } | { error: string };

function validateUrl(raw: string): UrlValidation {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { error: `invalid URL: ${raw}` };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { error: `unsupported URL scheme: ${parsed.protocol.replace(/:$/, "")}` };
  }
  if (parsed.username !== "" || parsed.password !== "") {
    return { error: "URLs with embedded credentials are not allowed" };
  }
  return { url: parsed };
}

// ---------------------------------------------------------------------------
// Input parsing — bare URL, or JSON {url, extract?, maxBytes?}
// ---------------------------------------------------------------------------

interface ParsedExtractInput {
  url: string;
  extract: ExtractKind;
  maxBytes: number;
}

type ParseResult = ParsedExtractInput | { error: string };

export function parseFetchExtractInput(input: string): ParseResult {
  const trimmed = input.trim();
  if (trimmed === "") {
    return { error: "empty input: expected a URL or JSON {\"url\": string}" };
  }

  if (trimmed.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return { error: "invalid JSON input" };
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { error: "JSON input must be an object" };
    }
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.url !== "string" || obj.url.trim() === "") {
      return { error: "JSON input requires a non-empty 'url' string" };
    }

    let extract: ExtractKind = "text";
    if (obj.extract !== undefined) {
      if (obj.extract !== "text" && obj.extract !== "title" && obj.extract !== "links") {
        return { error: "'extract' must be one of 'text' | 'title' | 'links'" };
      }
      extract = obj.extract;
    }

    let maxBytes = DEFAULT_MAX_BYTES;
    if (obj.maxBytes !== undefined) {
      if (typeof obj.maxBytes !== "number" || !Number.isFinite(obj.maxBytes) || obj.maxBytes <= 0) {
        return { error: "'maxBytes' must be a positive number" };
      }
      maxBytes = Math.floor(obj.maxBytes);
    }

    return { url: obj.url.trim(), extract, maxBytes };
  }

  return { url: trimmed, extract: "text", maxBytes: DEFAULT_MAX_BYTES };
}

// ---------------------------------------------------------------------------
// Mock fixture corpus — deterministic per URL, always labelled "[mock]"
// ---------------------------------------------------------------------------

function escapeForHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function buildMockHtml(url: string): string {
  const id = toHex8(fnv1a(url));
  const slug = slugify(url);
  const safeUrl = escapeForHtml(url);
  return (
    "<!doctype html>\n<html><head><title>[mock] Fixture for " +
    safeUrl +
    "</title></head><body>" +
    "<h1>[mock] Deterministic fixture " +
    id +
    "</h1>" +
    "<p>[mock] This is a deterministic mock document generated for " +
    safeUrl +
    ". No network request was made; mode is mock because no fetch transport was configured.</p>" +
    "<p>[mock] Reference id: " +
    id +
    ", slug: " +
    slug +
    ".</p>" +
    '<a href="https://mock.invalid/related/' +
    slug +
    '/1">[mock] related link one</a>' +
    '<a href="https://mock.invalid/related/' +
    slug +
    '/2">[mock] related link two</a>' +
    "</body></html>"
  );
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

const DESCRIPTION =
  "Fetch a URL and extract its content. Input is either a bare http(s) URL or JSON " +
  '{"url": string, "extract"?: "text"|"title"|"links" (default "text"), "maxBytes"?: number ' +
  '(default 65536)}. Returns single-line JSON {"mode":"real"|"mock","url":string,"extract":string,' +
  '"content":string,"truncated":boolean}. Runs for real when a fetch transport is configured ' +
  "(only http/https URLs without embedded credentials are allowed); otherwise serves a clearly " +
  "labelled ('[mock]') deterministic fixture without touching the network.";

/**
 * Build the `fetch_extract` CatalogEntry. `mode` is decided ONCE, at
 * construction time, from `opts.fetchFn` — never per-call.
 */
export function createFetchExtractTool(opts: ToolFactoryOptions = {}): CatalogEntry {
  const fetchFn = opts.fetchFn;
  const mode: ToolMode = fetchFn !== undefined ? "real" : "mock";

  const run: Tool["run"] = async (input: string): Promise<ToolResult> => {
    const parsedInput = parseFetchExtractInput(input);
    if ("error" in parsedInput) {
      return { ok: false, output: `fetch_extract: ${parsedInput.error}` };
    }
    const { extract, maxBytes } = parsedInput;

    const validated = validateUrl(parsedInput.url);
    if ("error" in validated) {
      return { ok: false, output: `fetch_extract: ${validated.error}` };
    }
    const url = validated.url.toString();

    if (mode === "mock") {
      const html = buildMockHtml(url);
      const { text: body, truncated } = truncateToMaxBytes(html, maxBytes);
      let content: string;
      try {
        content = extractHtml(body, extract, url);
      } catch (err) {
        return { ok: false, output: `fetch_extract: extraction failed: ${messageOf(err)}` };
      }
      const out: FetchExtractOutput = { mode: "mock", url, extract, content, truncated };
      return { ok: true, output: JSON.stringify(out) };
    }

    let res: { status: number; headers: Record<string, string>; text(): Promise<string> };
    try {
      res = await (fetchFn as FetchLike)(url, {
        method: "GET",
        headers: { Accept: "text/html,application/xhtml+xml,*/*" },
      });
    } catch (err) {
      return { ok: false, output: `fetch_extract: request failed: ${messageOf(err)}` };
    }

    if (res.status < 200 || res.status >= 300) {
      return { ok: false, output: `fetch_extract: request failed with HTTP ${res.status}` };
    }

    let body: string;
    try {
      body = await res.text();
    } catch (err) {
      return { ok: false, output: `fetch_extract: failed to read response body: ${messageOf(err)}` };
    }

    const { text: truncatedBody, truncated } = truncateToMaxBytes(body, maxBytes);
    let content: string;
    try {
      content = extractHtml(truncatedBody, extract, url);
    } catch (err) {
      return { ok: false, output: `fetch_extract: extraction failed: ${messageOf(err)}` };
    }

    const out: FetchExtractOutput = { mode: "real", url, extract, content, truncated };
    return { ok: true, output: JSON.stringify(out) };
  };

  const tool: Tool = {
    name: TOOL_NAME,
    description: DESCRIPTION,
    run,
  };

  return {
    tool,
    id: TOOL_NAME,
    category: "web",
    mode,
    requiresNetwork: true,
    requiredEnvKeys: [],
    verifierId: "verify.fetch_extract",
  };
}
