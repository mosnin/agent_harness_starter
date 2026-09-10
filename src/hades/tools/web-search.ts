/* ------------------------------------------------------------------ *
 * web_search — a `web` category CatalogEntry.
 *
 * REAL mode (an env BRAVE_SEARCH_API_KEY is non-empty AND a `fetchFn`
 * transport is injected): GETs Brave Search's web endpoint with the
 * subscription-token header and maps the JSON response into the
 * tool's output shape.
 *
 * MOCK mode (anything else — no key, no transport, or both missing):
 * NEVER touches the network. Results are derived deterministically
 * from a real FNV-1a hash of the query string — no `Math.random`, no
 * `Date`, no I/O — so the same query always produces byte-identical
 * output and a different query always produces different output.
 * Every mock title/snippet is prefixed "[mock] " and every mock url
 * lives under the reserved, unresolvable `https://mock.invalid/`
 * domain (RFC 2606 territory in spirit) so a mock result can never be
 * mistaken for — or accidentally resolve as — a real one.
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

/**
 * A minimal fetch abstraction so real-mode tools that need HTTP stay
 * injectable/testable rather than reaching for the global `fetch`
 * directly. Deliberately narrow — just enough surface for GET/POST-style
 * calls with headers and a text body.
 */
export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string }
) => Promise<{ status: number; headers: Record<string, string>; text(): Promise<string> }>;

/** Everything a tool factory may need injected instead of reaching for a
 *  global — keeps tools deterministic and unit-testable. */
export interface ToolFactoryOptions {
  env?: Record<string, string | undefined>;
  fetchFn?: FetchLike;
  now?: () => number;
}

/** One row of the catalog: a real `Tool` plus the metadata the manager
 *  and CLI need to enable/disable/describe it without inspecting its
 *  implementation. */
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

export interface WebSearchResultItem {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchOutput {
  mode: ToolMode;
  query: string;
  results: WebSearchResultItem[];
}

const TOOL_NAME = "web_search";
const MIN_COUNT = 1;
const MAX_COUNT = 10;
const DEFAULT_COUNT = 5;
const BRAVE_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
const ENV_KEY = "BRAVE_SEARCH_API_KEY";

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// ---------------------------------------------------------------------------
// Input parsing — bare query string, or JSON {query, count?}
// ---------------------------------------------------------------------------

interface ParsedSearchInput {
  query: string;
  count: number;
}

type ParseResult = ParsedSearchInput | { error: string };

function clampCount(n: number): number {
  const floored = Math.floor(n);
  return Math.max(MIN_COUNT, Math.min(MAX_COUNT, floored));
}

export function parseWebSearchInput(input: string): ParseResult {
  const trimmed = input.trim();
  if (trimmed === "") {
    return { error: "empty input: expected a query string or JSON {\"query\": string}" };
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
    if (typeof obj.query !== "string" || obj.query.trim() === "") {
      return { error: "JSON input requires a non-empty 'query' string" };
    }

    let count = DEFAULT_COUNT;
    if (obj.count !== undefined) {
      if (typeof obj.count !== "number" || !Number.isFinite(obj.count)) {
        return { error: "'count' must be a number between 1 and 10" };
      }
      count = clampCount(obj.count);
    }
    return { query: obj.query, count };
  }

  return { query: trimmed, count: DEFAULT_COUNT };
}

// ---------------------------------------------------------------------------
// Mock path — real FNV-1a hashing, zero randomness/clock
// ---------------------------------------------------------------------------

/** 32-bit FNV-1a. Pure, deterministic, no dependency on platform hash seeds. */
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
  return slug === "" ? "query" : slug;
}

function buildMockResult(query: string, index: number): WebSearchResultItem {
  // Seed folds in the query AND the result index so consecutive results
  // for the same query never collide, while remaining a pure function of
  // (query, index) — no randomness, no clock.
  const seed = fnv1a(`${query}\u0000${index}`);
  const id = toHex8(seed);
  const slug = slugify(query);
  return {
    title: `[mock] Result ${index + 1} for "${query}" (${id})`,
    url: `https://mock.invalid/search/${slug}/${id}`,
    snippet:
      `[mock] Deterministic placeholder result #${index + 1} for query "${query}" ` +
      `(hash ${id}). No network call was made; this is not real search content.`,
  };
}

function runMock(query: string, count: number): ToolResult {
  const results: WebSearchResultItem[] = [];
  for (let i = 0; i < count; i++) results.push(buildMockResult(query, i));
  const output: WebSearchOutput = { mode: "mock", query, results };
  return { ok: true, output: JSON.stringify(output) };
}

// ---------------------------------------------------------------------------
// Real path — Brave Search API via injected fetchFn
// ---------------------------------------------------------------------------

interface BraveWebResult {
  title?: unknown;
  url?: unknown;
  description?: unknown;
}

interface BraveSearchResponse {
  web?: { results?: unknown };
}

async function runReal(
  fetchFn: FetchLike,
  apiKey: string,
  query: string,
  count: number
): Promise<ToolResult> {
  const url = `${BRAVE_ENDPOINT}?q=${encodeURIComponent(query)}&count=${count}`;

  let res: { status: number; headers: Record<string, string>; text(): Promise<string> };
  try {
    res = await fetchFn(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "X-Subscription-Token": apiKey,
      },
    });
  } catch (err) {
    return { ok: false, output: `web_search: request failed: ${messageOf(err)}` };
  }

  if (res.status < 200 || res.status >= 300) {
    return { ok: false, output: `web_search: search request failed with HTTP ${res.status}` };
  }

  let bodyText: string;
  try {
    bodyText = await res.text();
  } catch (err) {
    return { ok: false, output: `web_search: failed to read response body: ${messageOf(err)}` };
  }

  let parsed: BraveSearchResponse;
  try {
    parsed = JSON.parse(bodyText) as BraveSearchResponse;
  } catch {
    return { ok: false, output: "web_search: search response was not valid JSON" };
  }

  const rawResults = Array.isArray(parsed.web?.results) ? (parsed.web!.results as unknown[]) : [];
  const results: WebSearchResultItem[] = rawResults.slice(0, count).map((raw) => {
    const item = (raw ?? {}) as BraveWebResult;
    return {
      title: typeof item.title === "string" ? item.title : "",
      url: typeof item.url === "string" ? item.url : "",
      snippet: typeof item.description === "string" ? item.description : "",
    };
  });

  const output: WebSearchOutput = { mode: "real", query, results };
  return { ok: true, output: JSON.stringify(output) };
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

const DESCRIPTION =
  "Search the web. Input is either a bare query string or JSON " +
  '{"query": string, "count"?: number (1-10, default 5)}. Returns single-line JSON ' +
  '{"mode":"real"|"mock","query":string,"results":[{"title":string,"url":string,"snippet":string}]}. ' +
  "Runs for real against Brave Search when BRAVE_SEARCH_API_KEY and a fetch transport are " +
  "configured; otherwise every result is a clearly labelled ('[mock] ') deterministic " +
  "placeholder under the unresolvable mock.invalid domain.";

/**
 * Build the `web_search` CatalogEntry. `mode` is decided ONCE, at
 * construction time, from `opts.env`/`opts.fetchFn` — never per-call —
 * so a tool's mode cannot silently drift mid-session.
 */
export function createWebSearchTool(opts: ToolFactoryOptions = {}): CatalogEntry {
  const apiKey = (opts.env?.[ENV_KEY] ?? "").trim();
  const fetchFn = opts.fetchFn;
  const mode: ToolMode = apiKey !== "" && fetchFn !== undefined ? "real" : "mock";

  const run: Tool["run"] = async (input: string): Promise<ToolResult> => {
    const parsed = parseWebSearchInput(input);
    if ("error" in parsed) {
      return { ok: false, output: `web_search: ${parsed.error}` };
    }
    if (mode === "real") {
      return runReal(fetchFn as FetchLike, apiKey, parsed.query, parsed.count);
    }
    return runMock(parsed.query, parsed.count);
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
    requiredEnvKeys: [ENV_KEY],
    verifierId: "verify.web_search",
  };
}
