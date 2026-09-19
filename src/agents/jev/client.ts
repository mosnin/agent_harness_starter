/**
 * TypeSafe System One client.
 *
 * POST https://api.typesafe.ai/v1/systemone
 * Authorization: Bearer $TYPESAFE_API_KEY
 *
 * `askJev` never throws — routing stays fail-open, security stays fail-closed
 * at the policy layer. Official SDK is optional; this HTTP client matches the
 * documented wire format so Hades does not depend on early-access packages.
 */

import type {
  JevAskResult,
  JevAsker,
  JevClient,
  JevClientConfig,
  SystemOneRequest,
  SystemOneResult,
} from "./types";
import { validateResult } from "./validate";

export const TYPESAFE_SYSTEMONE_URL = "https://api.typesafe.ai/v1/systemone";
export const DEFAULT_JEV_MODEL = "jev-latest";

export class JevUnavailableError extends Error {
  constructor(message = "Jev is unavailable") {
    super(message);
    this.name = "JevUnavailableError";
  }
}

export function resolveJevApiKey(explicit?: string): string | undefined {
  return explicit || process.env.TYPESAFE_API_KEY || process.env.JEV_API_KEY || undefined;
}

export function createJevClient(config: JevClientConfig = {}): JevClient {
  const apiKey = resolveJevApiKey(config.apiKey);
  const baseUrl = (config.baseUrl ?? process.env.TYPESAFE_BASE_URL ?? TYPESAFE_SYSTEMONE_URL).replace(/\/$/, "");
  const model = config.model ?? process.env.JEV_MODEL ?? DEFAULT_JEV_MODEL;
  const timeoutMs = config.timeoutMs ?? Number(process.env.JEV_TIMEOUT_MS ?? 2500);
  const maxRetries = config.maxRetries ?? 1;
  const fetchImpl = config.fetchImpl ?? globalThis.fetch.bind(globalThis);

  if (!apiKey) {
    throw new JevUnavailableError("Missing TYPESAFE_API_KEY (or JEV_API_KEY)");
  }

  return {
    async systemOne(request: SystemOneRequest, signal?: AbortSignal): Promise<SystemOneResult> {
      if (!request.questions || Object.keys(request.questions).length === 0) {
        throw new Error("systemOne: questions must be a non-empty map");
      }

      let lastError: Error = new JevUnavailableError("Jev request failed");
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const onAbort = () => controller.abort();
        signal?.addEventListener("abort", onAbort, { once: true });
        try {
          const response = await fetchImpl(baseUrl, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model: request.model ?? model,
              state: request.state,
              questions: request.questions,
            }),
            signal: controller.signal,
          });

          if (response.status === 429 || response.status === 529) {
            lastError = new JevUnavailableError(`Jev rate limited (${response.status})`);
            await sleep(200 * 2 ** attempt);
            continue;
          }
          if (!response.ok) {
            const body = await response.text().catch(() => "");
            throw new JevUnavailableError(`Jev HTTP ${response.status}${body ? `: ${body.slice(0, 240)}` : ""}`);
          }

          const json: unknown = await response.json();
          return validateResult(request.questions, json);
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err));
          if (signal?.aborted) break;
          if (attempt < maxRetries) await sleep(200 * 2 ** attempt);
        } finally {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
        }
      }
      throw lastError;
    },
  };
}

export function createJevAsker(client?: JevClient): JevAsker {
  return {
    async ask(request: SystemOneRequest, signal?: AbortSignal): Promise<JevAskResult> {
      try {
        const resolved = client ?? lazyDefaultClient();
        if (!resolved) {
          return { ok: false, reason: "jev-unconfigured" };
        }
        const result = await resolved.systemOne(request, signal);
        return { ok: true, result };
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        return { ok: false, reason: error.name === "JevUnavailableError" ? "jev-unavailable" : "jev-invalid", error };
      }
    },
  };
}

let cachedDefault: JevClient | null | undefined;

function lazyDefaultClient(): JevClient | null {
  if (cachedDefault !== undefined) return cachedDefault;
  if (!resolveJevApiKey()) {
    cachedDefault = null;
    return null;
  }
  try {
    cachedDefault = createJevClient();
    return cachedDefault;
  } catch {
    cachedDefault = null;
    return null;
  }
}

/** Test helper — reset the lazy default client. */
export function resetDefaultJevClient(): void {
  cachedDefault = undefined;
}

export function createMockJevClient(
  handler: (request: SystemOneRequest) => SystemOneResult | Promise<SystemOneResult>
): JevClient {
  return {
    async systemOne(request: SystemOneRequest): Promise<SystemOneResult> {
      const raw = await handler(request);
      return validateResult(request.questions, raw);
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
