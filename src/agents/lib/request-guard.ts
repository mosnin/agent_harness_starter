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

/** Keep the most recent N messages (chronological tail). */
export function capListedMessages<T>(rows: T[], max = MAX_LIST_MESSAGES): T[] {
  if (rows.length <= max) return rows;
  return rows.slice(-max);
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
    return Response.json({ error: `Request body exceeds ${max} bytes` }, { status: 413 });
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
