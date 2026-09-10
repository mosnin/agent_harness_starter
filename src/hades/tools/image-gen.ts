/* ------------------------------------------------------------------ *
 * image_gen — a `media` category CatalogEntry.
 *
 * REAL mode (OPENAI_API_KEY non-empty AND a `fetchFn` transport is
 * injected): POSTs OpenAI's image-generation endpoint and relays the
 * base64 PNG payload the provider returns.
 *
 * MOCK mode (anything else — no key, no transport, or both missing):
 * NEVER touches the network and NEVER fabricates image bytes. Instead
 * it does REAL, deterministic procedural generation: a seeded PRNG
 * (mulberry32, seeded from a real FNV-1a hash of the prompt) drives a
 * small scene of shapes rendered as a standalone, valid SVG document.
 * The same prompt always produces byte-identical SVG output — no
 * `Math.random`, no `Date`, no I/O.
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

export interface ImageGenOutput {
  mode: ToolMode;
  prompt: string;
  format: "png-base64" | "svg";
  data: string;
  note?: string;
}

const TOOL_NAME = "image_gen";
const ENV_KEY = "OPENAI_API_KEY";
const OPENAI_IMAGE_ENDPOINT = "https://api.openai.com/v1/images/generations";
const OPENAI_IMAGE_MODEL = "gpt-image-1";
const MOCK_NOTE = "[mock] procedurally generated placeholder — no image model was called";

const MIN_SIZE = 16;
const MAX_SIZE = 2048;
const DEFAULT_SIZE = 512;
const MAX_PROMPT_BYTES = 1_000_000;

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// ---------------------------------------------------------------------------
// Deterministic PRNG: FNV-1a hash -> mulberry32 stream
// ---------------------------------------------------------------------------

/** 32-bit FNV-1a. Pure, deterministic, no dependency on platform hash seeds. */
export function fnv1a32(s: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * mulberry32: a small, fast, well-known deterministic PRNG. Given the
 * same 32-bit seed it produces the exact same sequence of floats in
 * [0, 1) on every run, on every platform — no `Math.random` anywhere
 * in this module.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function clampSize(n: number): number {
  return Math.max(MIN_SIZE, Math.min(MAX_SIZE, Math.floor(n)));
}

/**
 * Render a deterministic, standalone, valid SVG "placeholder image" for
 * `prompt` at `size`x`size`. The seed comes from `fnv1a32(prompt)`; every
 * shape, color and opacity is derived from a `mulberry32` stream fed by
 * that seed, so the same `(prompt, size)` pair always produces the exact
 * same bytes, and different prompts produce visibly different scenes.
 */
export function renderProceduralSvg(prompt: string, size: number): string {
  const s = clampSize(Number.isFinite(size) ? size : DEFAULT_SIZE);
  const seed = fnv1a32(prompt);
  const rng = mulberry32(seed);

  const bgHue = Math.floor(rng() * 360);
  const bgSat = 35 + Math.floor(rng() * 20);
  const bgLight = 12 + Math.floor(rng() * 10);
  const bgColor = `hsl(${bgHue}, ${bgSat}%, ${bgLight}%)`;

  const shapeCount = 5 + Math.floor(rng() * 5); // 5..9, deterministic per seed
  const shapes: string[] = [];
  for (let i = 0; i < shapeCount; i++) {
    const hue = Math.floor(rng() * 360);
    const sat = 55 + Math.floor(rng() * 35);
    const light = 40 + Math.floor(rng() * 35);
    const color = `hsl(${hue}, ${sat}%, ${light}%)`;
    const opacity = (0.35 + rng() * 0.55).toFixed(2);

    if (rng() < 0.5) {
      const cx = (rng() * s).toFixed(2);
      const cy = (rng() * s).toFixed(2);
      const r = (s * (0.04 + rng() * 0.18)).toFixed(2);
      shapes.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="${color}" fill-opacity="${opacity}"/>`);
    } else {
      const w = s * (0.08 + rng() * 0.3);
      const h = s * (0.08 + rng() * 0.3);
      const x = rng() * s - w / 2;
      const y = rng() * s - h / 2;
      const rot = Math.floor(rng() * 360);
      const cxr = (x + w / 2).toFixed(2);
      const cyr = (y + h / 2).toFixed(2);
      shapes.push(
        `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${w.toFixed(2)}" height="${h.toFixed(2)}" ` +
          `fill="${color}" fill-opacity="${opacity}" transform="rotate(${rot} ${cxr} ${cyr})"/>`
      );
    }
  }

  const title = escapeXml(prompt.slice(0, 200));
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${s} ${s}" width="${s}" height="${s}">` +
    `<title>${title}</title>` +
    `<rect x="0" y="0" width="${s}" height="${s}" fill="${bgColor}"/>` +
    shapes.join("") +
    `</svg>`
  );
}

// ---------------------------------------------------------------------------
// Input parsing — bare prompt string, or JSON {prompt, size?}
// ---------------------------------------------------------------------------

interface ParsedImageGenInput {
  prompt: string;
  size: number;
}

type ParseResult = ParsedImageGenInput | { error: string };

export function parseImageGenInput(input: string): ParseResult {
  const trimmed = input.trim();
  if (trimmed === "") {
    return { error: "empty input: expected a prompt string or JSON {\"prompt\": string}" };
  }

  let prompt: string;
  let size = DEFAULT_SIZE;

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
    if (typeof obj.prompt !== "string") {
      return { error: "JSON input requires a 'prompt' string" };
    }
    prompt = obj.prompt;
    if (obj.size !== undefined) {
      if (typeof obj.size !== "number" || !Number.isFinite(obj.size) || obj.size <= 0) {
        return { error: "'size' must be a positive finite number" };
      }
      size = obj.size;
    }
  } else {
    prompt = trimmed;
  }

  if (prompt.trim() === "") {
    return { error: "prompt must be a non-empty string" };
  }
  const byteLen = new TextEncoder().encode(prompt).length;
  if (byteLen > MAX_PROMPT_BYTES) {
    return { error: `prompt exceeds maximum size of ${MAX_PROMPT_BYTES} bytes` };
  }

  return { prompt, size };
}

// ---------------------------------------------------------------------------
// Mock path — real procedural SVG generation, zero network
// ---------------------------------------------------------------------------

function runMock(prompt: string, size: number): ToolResult {
  const svg = renderProceduralSvg(prompt, size);
  const output: ImageGenOutput = {
    mode: "mock",
    prompt,
    format: "svg",
    data: svg,
    note: MOCK_NOTE,
  };
  return { ok: true, output: JSON.stringify(output) };
}

// ---------------------------------------------------------------------------
// Real path — OpenAI images endpoint via injected fetchFn
// ---------------------------------------------------------------------------

interface OpenAiImageDatum {
  b64_json?: unknown;
}
interface OpenAiImageResponse {
  data?: unknown;
}

async function runReal(fetchFn: FetchLike, apiKey: string, prompt: string, size: number): Promise<ToolResult> {
  const s = clampSize(size);
  const body = JSON.stringify({ model: OPENAI_IMAGE_MODEL, prompt, size: `${s}x${s}`, n: 1 });

  let res: { status: number; headers: Record<string, string>; text(): Promise<string> };
  try {
    res = await fetchFn(OPENAI_IMAGE_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body,
    });
  } catch (err) {
    return { ok: false, output: `image_gen: request failed: ${messageOf(err)}` };
  }

  if (res.status < 200 || res.status >= 300) {
    let bodyText = "";
    try {
      bodyText = await res.text();
    } catch {
      // best-effort diagnostics only
    }
    return {
      ok: false,
      output: `image_gen: OpenAI request failed with HTTP ${res.status}${bodyText ? `: ${bodyText.slice(0, 500)}` : ""}`,
    };
  }

  let bodyText: string;
  try {
    bodyText = await res.text();
  } catch (err) {
    return { ok: false, output: `image_gen: failed to read response body: ${messageOf(err)}` };
  }

  let parsed: OpenAiImageResponse;
  try {
    parsed = JSON.parse(bodyText) as OpenAiImageResponse;
  } catch {
    return { ok: false, output: "image_gen: response was not valid JSON" };
  }

  const arr = Array.isArray(parsed.data) ? (parsed.data as OpenAiImageDatum[]) : [];
  const first = arr[0];
  if (!first || typeof first.b64_json !== "string" || first.b64_json === "") {
    return { ok: false, output: "image_gen: response missing image data (data[0].b64_json)" };
  }

  const output: ImageGenOutput = { mode: "real", prompt, format: "png-base64", data: first.b64_json };
  return { ok: true, output: JSON.stringify(output) };
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

const DESCRIPTION =
  "Generate an image. Input is either a bare prompt string or JSON " +
  '{"prompt": string, "size"?: number (square side length in px, default 512)}. Returns ' +
  'single-line JSON {"mode":"real"|"mock","prompt":string,"format":"png-base64"|"svg","data":string,' +
  '"note"?:string}. Runs for real against OpenAI image generation when OPENAI_API_KEY and a fetch ' +
  "transport are configured; otherwise emits a deterministic, clearly labelled procedural SVG " +
  "placeholder — never a fabricated photo-realistic result.";

/**
 * Build the `image_gen` CatalogEntry. `mode` is decided ONCE, at
 * construction time, from `opts.env`/`opts.fetchFn` — never per-call —
 * so a tool's mode cannot silently drift mid-session.
 */
export function createImageGenTool(opts: ToolFactoryOptions = {}): CatalogEntry {
  const apiKey = (opts.env?.[ENV_KEY] ?? "").trim();
  const fetchFn = opts.fetchFn;
  const mode: ToolMode = apiKey !== "" && fetchFn !== undefined ? "real" : "mock";

  const run: Tool["run"] = async (input: string): Promise<ToolResult> => {
    const parsed = parseImageGenInput(input);
    if ("error" in parsed) {
      return { ok: false, output: `image_gen: ${parsed.error}` };
    }
    if (mode === "real") {
      return runReal(fetchFn as FetchLike, apiKey, parsed.prompt, parsed.size);
    }
    return runMock(parsed.prompt, parsed.size);
  };

  const tool: Tool = {
    name: TOOL_NAME,
    description: DESCRIPTION,
    run,
  };

  return {
    tool,
    id: TOOL_NAME,
    category: "media",
    mode,
    requiresNetwork: true,
    requiredEnvKeys: [ENV_KEY],
    verifierId: "verify.image_gen",
  };
}
