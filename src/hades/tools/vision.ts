/* ------------------------------------------------------------------ *
 * vision_describe — a `media` category CatalogEntry.
 *
 * REAL mode (ANTHROPIC_API_KEY non-empty AND a `fetchFn` transport is
 * injected): POSTs the image (base64) to Anthropic's messages endpoint
 * as an image content block and relays the model's text response.
 *
 * MOCK mode (anything else — no key, no transport, or both missing):
 * NEVER touches the network and NEVER invents a description. Instead
 * it does REAL byte-level image analysis: `sniffImage` decodes the
 * actual magic bytes and, where the format's header layout allows it,
 * the actual pixel dimensions — real PNG IHDR parsing, real GIF
 * logical-screen-descriptor parsing, a real JPEG SOF0/SOF2 marker
 * scan, a real PPM/Netpbm header tokenizer, and a real SVG root-tag
 * sniff. The mock description reports ONLY facts it actually parsed
 * from the bytes (format, dimensions if found, byte length) — never a
 * guess about image content.
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

export interface VisionDescribeOutput {
  mode: ToolMode;
  question: string;
  description: string;
  note?: string;
}

const TOOL_NAME = "vision_describe";
const ENV_KEY = "ANTHROPIC_API_KEY";
const ANTHROPIC_MESSAGES_ENDPOINT = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const ANTHROPIC_MODEL = "claude-sonnet-4-5";
const DEFAULT_QUESTION = "Describe this image in detail.";
const MOCK_PREFIX = "[mock] byte-level analysis only — no vision model was called";

const MAX_BASE64_CHARS = 1_000_000;

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// ---------------------------------------------------------------------------
// Base64 — manual encode/validate/decode, full control over rejection
// ---------------------------------------------------------------------------

const B64_TABLE = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_VALID_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** True iff `s` is syntactically valid standard base64: alphabet-only
 *  characters, length a multiple of 4, and '=' padding (0-2 chars)
 *  only in the final group. Does not attempt to decode. */
export function isValidBase64(s: string): boolean {
  if (s.length === 0) return true;
  if (s.length % 4 !== 0) return false;
  return B64_VALID_RE.test(s);
}

const B64_LOOKUP: Record<string, number> = (() => {
  const map: Record<string, number> = {};
  for (let i = 0; i < B64_TABLE.length; i++) map[B64_TABLE[i]] = i;
  return map;
})();

function decodeBase64(s: string): Uint8Array {
  const clean = s.replace(/=+$/, "");
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < clean.length; i++) {
    const val = B64_LOOKUP[clean[i]];
    if (val === undefined) throw new Error(`invalid base64 character at index ${i}`);
    buffer = (buffer << 6) | val;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

// ---------------------------------------------------------------------------
// sniffImage — real magic-byte sniffing + real dimension parsing
// ---------------------------------------------------------------------------

export interface SniffResult {
  format: "png" | "jpeg" | "gif" | "svg" | "ppm" | "unknown";
  width?: number;
  height?: number;
}

function matchesMagic(bytes: Uint8Array, magic: number[], offset = 0): boolean {
  if (offset + magic.length > bytes.length) return false;
  for (let i = 0; i < magic.length; i++) {
    if (bytes[offset + i] !== magic[i]) return false;
  }
  return true;
}

function readUint32BE(bytes: Uint8Array, offset: number): number | null {
  if (offset + 4 > bytes.length) return null;
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

function readUint16BE(bytes: Uint8Array, offset: number): number | null {
  if (offset + 2 > bytes.length) return null;
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function readUint16LE(bytes: Uint8Array, offset: number): number | null {
  if (offset + 2 > bytes.length) return null;
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function asciiPrefix(bytes: Uint8Array, maxLen: number, offset = 0): string {
  const len = Math.min(bytes.length - offset, maxLen);
  let s = "";
  for (let i = 0; i < len; i++) s += String.fromCharCode(bytes[offset + i]);
  return s;
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function sniffPng(bytes: Uint8Array): SniffResult | null {
  if (!matchesMagic(bytes, PNG_MAGIC)) return null;
  // Chunk layout from offset 8: length(4) type(4) data...
  if (asciiPrefix(bytes, 4, 12) !== "IHDR") return { format: "png" };
  const width = readUint32BE(bytes, 16);
  const height = readUint32BE(bytes, 20);
  if (width === null || height === null || width === 0 || height === 0) return { format: "png" };
  return { format: "png", width, height };
}

function sniffGif(bytes: Uint8Array): SniffResult | null {
  const sig = asciiPrefix(bytes, 6);
  if (sig !== "GIF87a" && sig !== "GIF89a") return null;
  const width = readUint16LE(bytes, 6);
  const height = readUint16LE(bytes, 8);
  if (width === null || height === null || width === 0 || height === 0) return { format: "gif" };
  return { format: "gif", width, height };
}

function sniffJpeg(bytes: Uint8Array): SniffResult | null {
  if (!matchesMagic(bytes, [0xff, 0xd8])) return null;
  let offset = 2;
  while (offset + 1 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1];
    if (marker === 0xff) {
      // Fill byte before the real marker — re-scan one byte forward.
      offset += 1;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (marker === 0xd9) break; // EOI
    const length = readUint16BE(bytes, offset + 2);
    if (length === null || length < 2) return { format: "jpeg" };
    if (marker === 0xc0 || marker === 0xc2) {
      const contentStart = offset + 4; // marker(2) + length(2)
      const height = readUint16BE(bytes, contentStart + 1);
      const width = readUint16BE(bytes, contentStart + 3);
      if (height !== null && width !== null && height > 0 && width > 0) {
        return { format: "jpeg", width, height };
      }
      return { format: "jpeg" };
    }
    offset += 2 + length;
  }
  return { format: "jpeg" };
}

function sniffPpm(bytes: Uint8Array): SniffResult | null {
  if (bytes.length < 2 || bytes[0] !== 0x50 /* 'P' */) return null;
  const typeDigit = bytes[1];
  if (typeDigit < 0x31 || typeDigit > 0x36) return null; // 'P1'..'P6'

  let offset = 2;
  const isWhitespace = (c: number): boolean => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;

  const skipWhitespaceAndComments = (): void => {
    while (offset < bytes.length) {
      const c = bytes[offset];
      if (c === 0x23 /* # */) {
        while (offset < bytes.length && bytes[offset] !== 0x0a) offset++;
        continue;
      }
      if (isWhitespace(c)) {
        offset++;
        continue;
      }
      break;
    }
  };

  const readToken = (): string | null => {
    skipWhitespaceAndComments();
    const start = offset;
    while (offset < bytes.length && !isWhitespace(bytes[offset]) && bytes[offset] !== 0x23) {
      offset++;
    }
    if (offset === start) return null;
    let s = "";
    for (let i = start; i < offset; i++) s += String.fromCharCode(bytes[i]);
    return s;
  };

  const widthTok = readToken();
  const heightTok = readToken();
  if (!widthTok || !heightTok) return { format: "ppm" };
  const width = Number.parseInt(widthTok, 10);
  const height = Number.parseInt(heightTok, 10);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return { format: "ppm" };
  return { format: "ppm", width, height };
}

function sniffSvg(bytes: Uint8Array): SniffResult | null {
  const prefix = asciiPrefix(bytes, Math.min(bytes.length, 4096));
  const trimmedStart = prefix.replace(/^[\s﻿]+/, "");
  const startsLikeXml = /^<\?xml/i.test(trimmedStart) || /^<!doctype/i.test(trimmedStart) || /^<!--/.test(trimmedStart) || /^<svg[\s>]/i.test(trimmedStart);
  if (!startsLikeXml) return null;
  if (!/<svg[\s>]/i.test(prefix)) return null;

  const tagMatch = /<svg\b[^>]*>/i.exec(prefix);
  if (!tagMatch) return { format: "svg" };
  const tag = tagMatch[0];
  const wMatch = /\bwidth\s*=\s*"(\d+(?:\.\d+)?)"/i.exec(tag) ?? /\bwidth\s*=\s*'(\d+(?:\.\d+)?)'/i.exec(tag);
  const hMatch = /\bheight\s*=\s*"(\d+(?:\.\d+)?)"/i.exec(tag) ?? /\bheight\s*=\s*'(\d+(?:\.\d+)?)'/i.exec(tag);
  if (!wMatch || !hMatch) return { format: "svg" };
  const width = Math.round(parseFloat(wMatch[1]));
  const height = Math.round(parseFloat(hMatch[1]));
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return { format: "svg" };
  return { format: "svg", width, height };
}

/**
 * Real, defensive magic-byte + header sniffing. Never throws — any
 * truncated/corrupt input that would otherwise cause an out-of-bounds
 * read simply falls through to `{ format: "unknown" }`.
 */
export function sniffImage(bytes: Uint8Array): SniffResult {
  try {
    const png = sniffPng(bytes);
    if (png) return png;
    const gif = sniffGif(bytes);
    if (gif) return gif;
    const jpeg = sniffJpeg(bytes);
    if (jpeg) return jpeg;
    const ppm = sniffPpm(bytes);
    if (ppm) return ppm;
    const svg = sniffSvg(bytes);
    if (svg) return svg;
    return { format: "unknown" };
  } catch {
    return { format: "unknown" };
  }
}

function mediaTypeFor(format: SniffResult["format"]): string {
  switch (format) {
    case "png":
      return "image/png";
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "svg":
      return "image/svg+xml";
    default:
      return "image/png";
  }
}

// ---------------------------------------------------------------------------
// Input parsing — bare base64 string, or JSON {imageBase64, question?}
// ---------------------------------------------------------------------------

interface ParsedVisionInput {
  imageBase64: string;
  question: string;
}

type ParseResult = ParsedVisionInput | { error: string };

export function parseVisionInput(input: string): ParseResult {
  const trimmed = input.trim();
  if (trimmed === "") {
    return {
      error: "empty input: expected a base64 image string or JSON {\"imageBase64\": string, \"question\"?: string}",
    };
  }

  let imageBase64: string;
  let question = DEFAULT_QUESTION;

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
    if (typeof obj.imageBase64 !== "string" || obj.imageBase64.trim() === "") {
      return { error: "JSON input requires a non-empty 'imageBase64' string" };
    }
    imageBase64 = obj.imageBase64.trim();
    if (obj.question !== undefined) {
      if (typeof obj.question !== "string") {
        return { error: "'question' must be a string" };
      }
      question = obj.question.trim() === "" ? DEFAULT_QUESTION : obj.question;
    }
  } else {
    imageBase64 = trimmed;
  }

  if (imageBase64 === "") {
    return { error: "imageBase64 must be a non-empty string" };
  }
  if (imageBase64.length > MAX_BASE64_CHARS) {
    return { error: `imageBase64 exceeds maximum size of ${MAX_BASE64_CHARS} characters` };
  }
  if (!isValidBase64(imageBase64)) {
    return { error: "imageBase64 is not valid base64 (bad alphabet or length)" };
  }

  return { imageBase64, question };
}

// ---------------------------------------------------------------------------
// Mock path — real byte-level analysis, zero network
// ---------------------------------------------------------------------------

function runMock(imageBase64: string, question: string): ToolResult {
  let bytes: Uint8Array;
  try {
    bytes = decodeBase64(imageBase64);
  } catch (err) {
    return { ok: false, output: `vision_describe: failed to decode base64: ${messageOf(err)}` };
  }
  const sniff = sniffImage(bytes);
  const dims = sniff.width !== undefined && sniff.height !== undefined ? `${sniff.width}x${sniff.height}` : "unknown";
  const description = `${MOCK_PREFIX}: format=${sniff.format}, dimensions=${dims}, byteLength=${bytes.length}`;
  const output: VisionDescribeOutput = { mode: "mock", question, description, note: MOCK_PREFIX };
  return { ok: true, output: JSON.stringify(output) };
}

// ---------------------------------------------------------------------------
// Real path — Anthropic messages endpoint via injected fetchFn
// ---------------------------------------------------------------------------

interface AnthropicContentBlock {
  type?: unknown;
  text?: unknown;
}
interface AnthropicMessagesResponse {
  content?: unknown;
}

async function runReal(fetchFn: FetchLike, apiKey: string, imageBase64: string, question: string): Promise<ToolResult> {
  let bytes: Uint8Array;
  try {
    bytes = decodeBase64(imageBase64);
  } catch (err) {
    return { ok: false, output: `vision_describe: failed to decode base64: ${messageOf(err)}` };
  }
  const sniff = sniffImage(bytes);
  const mediaType = mediaTypeFor(sniff.format);

  const body = JSON.stringify({
    model: ANTHROPIC_MODEL,
    max_tokens: 1024,
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: imageBase64 } },
          { type: "text", text: question },
        ],
      },
    ],
  });

  let res: { status: number; headers: Record<string, string>; text(): Promise<string> };
  try {
    res = await fetchFn(ANTHROPIC_MESSAGES_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body,
    });
  } catch (err) {
    return { ok: false, output: `vision_describe: request failed: ${messageOf(err)}` };
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
      output: `vision_describe: Anthropic request failed with HTTP ${res.status}${bodyText ? `: ${bodyText.slice(0, 500)}` : ""}`,
    };
  }

  let bodyText: string;
  try {
    bodyText = await res.text();
  } catch (err) {
    return { ok: false, output: `vision_describe: failed to read response body: ${messageOf(err)}` };
  }

  let parsed: AnthropicMessagesResponse;
  try {
    parsed = JSON.parse(bodyText) as AnthropicMessagesResponse;
  } catch {
    return { ok: false, output: "vision_describe: response was not valid JSON" };
  }

  const blocks = Array.isArray(parsed.content) ? (parsed.content as AnthropicContentBlock[]) : [];
  const textBlock = blocks.find((b) => b && b.type === "text" && typeof b.text === "string");
  if (!textBlock || typeof textBlock.text !== "string" || textBlock.text === "") {
    return { ok: false, output: "vision_describe: response missing text content" };
  }

  const output: VisionDescribeOutput = { mode: "real", question, description: textBlock.text };
  return { ok: true, output: JSON.stringify(output) };
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

const DESCRIPTION =
  "Describe an image. Input is either a bare base64 image string or JSON " +
  '{"imageBase64": string, "question"?: string}. Returns single-line JSON ' +
  '{"mode":"real"|"mock","question":string,"description":string,"note"?:string}. Runs for real ' +
  "against an Anthropic vision model when ANTHROPIC_API_KEY and a fetch transport are configured; " +
  "otherwise performs real byte-level format/dimension sniffing and reports only what was actually " +
  "parsed from the bytes — never a fabricated visual description.";

/**
 * Build the `vision_describe` CatalogEntry. `mode` is decided ONCE, at
 * construction time, from `opts.env`/`opts.fetchFn` — never per-call —
 * so a tool's mode cannot silently drift mid-session.
 */
export function createVisionDescribeTool(opts: ToolFactoryOptions = {}): CatalogEntry {
  const apiKey = (opts.env?.[ENV_KEY] ?? "").trim();
  const fetchFn = opts.fetchFn;
  const mode: ToolMode = apiKey !== "" && fetchFn !== undefined ? "real" : "mock";

  const run: Tool["run"] = async (input: string): Promise<ToolResult> => {
    const parsed = parseVisionInput(input);
    if ("error" in parsed) {
      return { ok: false, output: `vision_describe: ${parsed.error}` };
    }
    if (mode === "real") {
      return runReal(fetchFn as FetchLike, apiKey, parsed.imageBase64, parsed.question);
    }
    return runMock(parsed.imageBase64, parsed.question);
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
    verifierId: "verify.vision_describe",
  };
}
