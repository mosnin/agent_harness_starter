/**
 * Ingress guards for agent HTTP routes.
 *
 * Client `tools` used to be appended onto the agent and resolved from the
 * global registry, so a caller could enable shell_exec on a research agent.
 * Requested names may only enable tools the agent already has (config + skills).
 * JSON bodies larger than 64 KiB are rejected before parse, same class as
 * the voice 8 MiB cap.
 */

import { getSkill } from "../skills/index";

export const MAX_JSON_BODY_BYTES = 64 * 1024;
export const MAX_TOOL_NAMES = 32;
export const MAX_LIST_THREADS = 50;
export const MAX_LIST_MESSAGES = 100;

export function capListedThreads<T>(threads: T[], max = MAX_LIST_THREADS): T[] {
  return threads.slice(0, max);
}

/** Adapter default when the caller omits `limit`. Explicit `0` stays 0. */
export function resolveListLimit(limit: number | undefined, fallback: number): number {
  if (limit !== undefined && Number.isFinite(limit) && limit >= 0) return limit;
  return fallback;
}

/** Keep the most recent N messages (chronological tail). */
export function capListedMessages<T>(rows: T[], max = MAX_LIST_MESSAGES): T[] {
  if (rows.length <= max) return rows;
  return rows.slice(-max);
}

export type CappedJson =
  | { ok: true; value: unknown }
  | { ok: false; response: Response };

function oversizeBodyResponse(max: number): Response {
  return Response.json({ error: `Request body exceeds ${max} bytes` }, { status: 413 });
}

/** Read at most `max` bytes. Used when Content-Length is missing or forged. */
export async function readCappedBytes(
  req: Request,
  max = MAX_JSON_BODY_BYTES
): Promise<Uint8Array | Response> {
  if (!req.body) return new Uint8Array();
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value?.byteLength) continue;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return oversizeBodyResponse(max);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Same cap as `readCappedBytes`, then rebuild a Request so multipart /
 * MCP transports can still parse the body.
 */
export async function readCappedRequest(
  req: Request,
  max = MAX_JSON_BODY_BYTES
): Promise<Request | Response> {
  const header = oversizeJsonResponse(req, max);
  if (header) return header;
  const raw = await readCappedBytes(req, max);
  if (raw instanceof Response) return raw;
  const copy = new ArrayBuffer(raw.byteLength);
  new Uint8Array(copy).set(raw);
  return new Request(req.url, {
    method: req.method,
    headers: req.headers,
    body: copy,
    signal: req.signal,
  });
}

/**
 * Header check plus a hard read cap. A caller that omits Content-Length
 * cannot stream an unbounded JSON body past the same 64 KiB limit.
 */
export async function readCappedJson(
  req: Request,
  max = MAX_JSON_BODY_BYTES
): Promise<CappedJson> {
  const header = oversizeJsonResponse(req, max);
  if (header) return { ok: false, response: header };
  const raw = await readCappedBytes(req, max);
  if (raw instanceof Response) return { ok: false, response: raw };
  if (raw.byteLength === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(new TextDecoder().decode(raw)) as unknown };
  } catch {
    return {
      ok: false,
      response: Response.json({ error: "Invalid JSON body" }, { status: 400 }),
    };
  }
}

/** Local inspectors only. Production MCP tool calls require auth. */
export function mcpAnonymousAllowed(env: Record<string, string | undefined> = process.env): boolean {
  return env.HADES_MCP_ANON === "true";
}

export function unauthorizedMcpResponse(): Response {
  return Response.json({ error: "Unauthorized" }, { status: 401 });
}

export function oversizeJsonResponse(
  req: Request,
  max = MAX_JSON_BODY_BYTES
): Response | null {
  const header = req.headers.get("content-length");
  if (header == null || header === "") return null;
  const n = Number(header);
  if (!Number.isFinite(n) || n < 0) {
    return Response.json({ error: "Invalid Content-Length" }, { status: 400 });
  }
  if (n > max) {
    return oversizeBodyResponse(max);
  }
  return null;
}

export function allowedToolNames(configured?: string[], skills?: string[]): Set<string> {
  const allow = new Set(configured ?? []);
  for (const id of skills ?? []) {
    const skill = getSkill(id);
    if (!skill) continue;
    for (const tool of skill.tools) allow.add(tool);
  }
  return allow;
}

export function clampRequestedTools(
  configured: string[] | undefined,
  requested: string[] | undefined,
  skills?: string[]
): string[] | undefined {
  if (!requested?.length) return configured;
  const allow = allowedToolNames(configured, skills);
  const extra = requested.filter((name) => allow.has(name)).slice(0, MAX_TOOL_NAMES);
  if (extra.length === 0) return configured;
  return [...new Set([...(configured ?? []), ...extra])];
}
