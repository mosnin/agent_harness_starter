/* ------------------------------------------------------------------ *
 * http_request — an SSRF-defended HTTP tool.
 *
 * Real mode requires an injected `fetchFn` (never the global `fetch`
 * reached for directly) — without one the tool runs in a clearly
 * labelled deterministic mock mode ("[mock] ..."), never silently
 * pretending to have hit the network.
 *
 * `isForbiddenHost` is the SSRF gate and is exported so its full
 * decision matrix — private/loopback/link-local ranges, IPv6
 * equivalents, and the exotic decimal/hex/octal single-integer IPv4
 * encodings browsers and curl still accept — is independently testable.
 * The allowlist (when configured) is applied strictly AFTER the
 * forbidden-host check: an allowlisted hostname can never override an
 * otherwise-forbidden literal.
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * Locked structural duplicates (see LOCKED CONTRACT rationale).
 * ------------------------------------------------------------------ */

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

export interface Tool {
  name: string;
  description: string;
  run: (input: string) => ToolResult | Promise<ToolResult>;
}

export interface ToolResult {
  ok: boolean;
  output: string;
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

/* ------------------------------------------------------------------ *
 * SSRF gate
 * ------------------------------------------------------------------ */

/** Parse a dotted-quad string strictly: exactly 4 decimal octets,
 *  0-255, no leading zeros beyond a bare "0" (avoids octal ambiguity
 *  in this specific check — the "single integer" encodings below are
 *  handled separately). Returns null if not a strict dotted quad. */
function parseDottedQuad(host: string): [number, number, number, number] | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n < 0 || n > 255) return null;
    octets.push(n);
  }
  return [octets[0], octets[1], octets[2], octets[3]];
}

/** Decode a single-integer IPv4 host encoding (decimal, 0x hex, or
 *  0-prefixed octal) into a 32-bit unsigned integer, or null if `host`
 *  isn't one of those forms. */
function parseIntegerIPv4(host: string): number | null {
  if (!/^\d+$/.test(host) && !/^0x[0-9a-fA-F]+$/.test(host)) return null;
  // A run of 1-3 digit groups already looks like a dotted quad and is
  // handled by parseDottedQuad; only treat this as a single-integer
  // encoding when it's genuinely one atom (no dots, checked by caller).
  let value: number;
  if (/^0x[0-9a-fA-F]+$/.test(host)) {
    value = Number.parseInt(host, 16);
  } else if (/^0\d+$/.test(host)) {
    // Leading-zero all-digit string: octal.
    if (!/^[0-7]+$/.test(host)) return null;
    value = Number.parseInt(host, 8);
  } else {
    value = Number.parseInt(host, 10);
  }
  if (!Number.isFinite(value) || value < 0 || value > 0xffffffff) return null;
  return value;
}

function integerToOctets(value: number): [number, number, number, number] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function isForbiddenOctets(o: [number, number, number, number]): boolean {
  const [a, b] = o;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local
  return false;
}

/** True if `host` (already lower-cased hostname or literal from a URL)
 *  resolves — lexically, no DNS involved — to a forbidden loopback /
 *  private / link-local / metadata-style target. */
export function isForbiddenHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  if (h === "") return true;

  if (h === "localhost" || h.endsWith(".localhost")) return true;

  // IPv6 literals may arrive bracketed (as they appear in a URL
  // authority) or bare (as callers may pass them directly).
  const v6 = h.startsWith("[") && h.endsWith("]") ? h.slice(1, -1) : h;
  if (v6.includes(":")) {
    if (v6 === "::1") return true; // loopback
    if (v6.startsWith("fc") || v6.startsWith("fd")) return true; // fc00::/7 unique local
    if (v6.startsWith("fe8") || v6.startsWith("fe9") || v6.startsWith("fea") || v6.startsWith("feb")) {
      return true; // fe80::/10 link-local
    }
    // IPv4-mapped IPv6 (::ffff:a.b.c.d) — unwrap and re-check as IPv4.
    const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(v6);
    if (mapped) {
      const quad = parseDottedQuad(mapped[1]);
      if (quad && isForbiddenOctets(quad)) return true;
    }
    return false;
  }

  const dotted = parseDottedQuad(h);
  if (dotted) {
    return isForbiddenOctets(dotted);
  }

  // Not a dotted quad — check for single-integer IPv4 encodings
  // (decimal, 0x hex, 0-leading octal), which browsers/curl/getaddrinfo
  // still happily resolve as IPv4 addresses (e.g. 2130706433 == 127.0.0.1,
  // 0x7f000001 == 127.0.0.1, 017700000001 == 127.0.0.1).
  const intVal = parseIntegerIPv4(h);
  if (intVal !== null) {
    return isForbiddenOctets(integerToOctets(intVal));
  }

  return false;
}

/* ------------------------------------------------------------------ *
 * Input / output shapes
 * ------------------------------------------------------------------ */

type HttpMethod = "GET" | "POST" | "HEAD";
const VALID_METHODS: readonly HttpMethod[] = ["GET", "POST", "HEAD"];
const DEFAULT_MAX_BYTES = 65_536;
const SENSITIVE_HEADERS = new Set(["authorization", "cookie"]);

interface HttpInput {
  method: HttpMethod;
  url: string;
  headers?: Record<string, string>;
  body?: string;
  maxBytes?: number;
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function parseInput(raw: string): { ok: true; value: HttpInput } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: "invalid json input" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "input must be a json object" };
  }
  const obj = parsed as Record<string, unknown>;

  if (typeof obj.method !== "string" || !VALID_METHODS.includes(obj.method as HttpMethod)) {
    return { ok: false, error: `method must be one of: ${VALID_METHODS.join(", ")}` };
  }
  if (typeof obj.url !== "string" || obj.url.length === 0) {
    return { ok: false, error: "url must be a non-empty string" };
  }
  if (obj.headers !== undefined) {
    if (
      obj.headers === null ||
      typeof obj.headers !== "object" ||
      Array.isArray(obj.headers) ||
      Object.values(obj.headers as Record<string, unknown>).some((v) => typeof v !== "string")
    ) {
      return { ok: false, error: "headers must be a string-valued object" };
    }
  }
  if (obj.body !== undefined && typeof obj.body !== "string") {
    return { ok: false, error: "body must be a string" };
  }
  if (obj.maxBytes !== undefined) {
    if (typeof obj.maxBytes !== "number" || !Number.isFinite(obj.maxBytes) || obj.maxBytes < 0) {
      return { ok: false, error: "maxBytes must be a non-negative finite number" };
    }
  }

  return {
    ok: true,
    value: {
      method: obj.method as HttpMethod,
      url: obj.url,
      headers: obj.headers as Record<string, string> | undefined,
      body: obj.body as string | undefined,
      maxBytes: obj.maxBytes as number | undefined,
    },
  };
}

function redactHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    out[key] = SENSITIVE_HEADERS.has(key.toLowerCase()) ? "[redacted]" : value;
  }
  return out;
}

/** Validate a URL against the SSRF gate: scheme must be http/https, the
 *  hostname must not be forbidden, and — if `allowHosts` is set — the
 *  hostname must appear in it exactly (checked strictly AFTER the
 *  forbidden-host check, so it can never rescue a forbidden literal). */
function checkUrl(rawUrl: string, allowHosts?: string[]): { ok: true; url: URL } | { ok: false; error: string } {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, error: `invalid url: ${rawUrl}` };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, error: `forbidden scheme: ${url.protocol}` };
  }
  if (isForbiddenHost(url.hostname)) {
    return { ok: false, error: `forbidden host: ${url.hostname}` };
  }
  if (allowHosts && allowHosts.length > 0 && !allowHosts.includes(url.hostname)) {
    return { ok: false, error: `host not in allowlist: ${url.hostname}` };
  }
  return { ok: true, url };
}

/* ------------------------------------------------------------------ *
 * Mock mode — deterministic, clearly labelled, no network
 * ------------------------------------------------------------------ */

function mockResponse(input: HttpInput): { status: number; headers: Record<string, string>; body: string } {
  // Deterministic from the input alone: a stable hash of method+url+body
  // maps into a small set of plausible status codes, so repeated calls
  // with the same input always produce the same mock — useful for
  // testing agent logic without ever touching the network.
  const seed = `${input.method} ${input.url} ${input.body ?? ""}`;
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  }
  const statuses = [200, 200, 200, 404, 500];
  const status = statuses[Math.abs(hash) % statuses.length];
  return {
    status,
    headers: { "content-type": "text/plain", "x-mock": "true" },
    body: `[mock] ${input.method} ${input.url} -> ${status}`,
  };
}

/* ------------------------------------------------------------------ *
 * Factory
 * ------------------------------------------------------------------ */

export function createHttpTool(opts: ToolFactoryOptions & { allowHosts?: string[] }): CatalogEntry {
  const mode: ToolMode = opts.fetchFn ? "real" : "mock";
  const fetchFn = opts.fetchFn;

  const tool: Tool = {
    name: "http_request",
    description:
      "Make an SSRF-defended GET/POST/HEAD request. Blocks loopback, private, link-local, and " +
      'metadata-style targets (including numeric-IP encodings). Input JSON: ' +
      '{"method":"GET|POST|HEAD","url":string,"headers"?:object,"body"?:string,"maxBytes"?:number}',
    run: async (input: string): Promise<ToolResult> => {
      const parsed = parseInput(input);
      if (!parsed.ok) {
        return { ok: false, output: JSON.stringify({ mode, error: parsed.error }) };
      }
      const value = parsed.value;

      const urlCheck = checkUrl(value.url, opts.allowHosts);
      if (!urlCheck.ok) {
        return { ok: false, output: JSON.stringify({ mode, error: urlCheck.error }) };
      }

      const maxBytes = value.maxBytes ?? DEFAULT_MAX_BYTES;
      const redactedRequestHeaders = redactHeaders(value.headers);

      if (mode === "mock") {
        const mock = mockResponse(value);
        const truncated = mock.body.length > maxBytes;
        const body = truncated ? mock.body.slice(0, maxBytes) : mock.body;
        return {
          ok: mock.status < 400,
          output: JSON.stringify({
            mode: "mock",
            method: value.method,
            url: value.url,
            requestHeaders: redactedRequestHeaders,
            status: mock.status,
            headers: mock.headers,
            body,
            truncated,
          }),
        };
      }

      try {
        const response = await fetchFn!(urlCheck.url.toString(), {
          method: value.method,
          headers: value.headers,
          body: value.method === "GET" || value.method === "HEAD" ? undefined : value.body,
        });
        const text = await response.text();
        const truncated = text.length > maxBytes;
        const body = truncated ? text.slice(0, maxBytes) : text;
        return {
          ok: response.status < 400,
          output: JSON.stringify({
            mode: "real",
            method: value.method,
            url: value.url,
            requestHeaders: redactedRequestHeaders,
            status: response.status,
            headers: response.headers,
            body,
            truncated,
          }),
        };
      } catch (err) {
        return {
          ok: false,
          output: JSON.stringify({
            mode: "real",
            method: value.method,
            url: value.url,
            requestHeaders: redactedRequestHeaders,
            error: messageOf(err),
          }),
        };
      }
    },
  };

  return {
    tool,
    id: "http_request",
    category: "system",
    mode,
    requiresNetwork: true,
    requiredEnvKeys: [],
    verifierId: "verify.http_request",
  };
}
