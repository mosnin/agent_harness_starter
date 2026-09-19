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

import { resetJevAskCache, wrapAskerWithCache } from "./cache";
import { overlayLocalSecretAnswers, sanitizeJevRequest } from "./redact";
import type {
  JevAskResult,
  JevAsker,
  JevAskerOptions,
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

const CIRCUIT_FAILURES = 3;
const CIRCUIT_COOLDOWN_MS = 8_000;

let circuitFailures = 0;
let circuitOpenUntil = 0;

export function isJevCircuitOpen(now = Date.now()): boolean {
  return now < circuitOpenUntil;
}

export function recordJevSuccess(): void {
  circuitFailures = 0;
  circuitOpenUntil = 0;
}

export function recordJevFailure(now = Date.now()): void {
  circuitFailures += 1;
  if (circuitFailures >= CIRCUIT_FAILURES) {
    circuitOpenUntil = now + CIRCUIT_COOLDOWN_MS;
  }
}

export function resetJevCircuit(): void {
  circuitFailures = 0;
  circuitOpenUntil = 0;
  resetJevAskCache();
}

export function createJevClient(config: JevClientConfig = {}): JevClient {
  const apiKey = resolveJevApiKey(config.apiKey);
  const baseUrl = (config.baseUrl ?? process.env.TYPESAFE_BASE_URL ?? TYPESAFE_SYSTEMONE_URL).replace(/\/$/, "");
  const model = config.model ?? process.env.JEV_MODEL ?? DEFAULT_JEV_MODEL;
  const timeoutMs = config.timeoutMs ?? Number(process.env.JEV_TIMEOUT_MS ?? 1500);
  const maxRetries = config.maxRetries ?? 1;
  const hedgeMs = config.hedgeMs ?? Number(process.env.JEV_HEDGE_MS ?? 200);
  const fetchImpl = config.fetchImpl ?? globalThis.fetch.bind(globalThis);

  if (!apiKey) {
    throw new JevUnavailableError("Missing TYPESAFE_API_KEY (or JEV_API_KEY)");
  }

  async function once(body: string, signal?: AbortSignal): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      return await fetchImpl(baseUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  return {
    async systemOne(request: SystemOneRequest, signal?: AbortSignal): Promise<SystemOneResult> {
      if (!request.questions || Object.keys(request.questions).length === 0) {
        throw new Error("systemOne: questions must be a non-empty map");
      }
      if (isJevCircuitOpen()) {
        throw new JevUnavailableError("Jev circuit open");
      }

      const { request: clean } = sanitizeJevRequest(request);
      const body = JSON.stringify({
        model: clean.model ?? model,
        state: clean.state,
        questions: clean.questions,
      });

      let lastError: Error = new JevUnavailableError("Jev request failed");
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          const response = hedgeMs > 0
            ? await hedgedFetch((hedgeSignal) => once(body, hedgeSignal), hedgeMs, signal)
            : await once(body, signal);

          if (response.status === 429 || response.status === 529) {
            lastError = new JevUnavailableError(`Jev rate limited (${response.status})`);
            recordJevFailure();
            await sleep(200 * 2 ** attempt);
            continue;
          }
          if (!response.ok) {
            const text = await response.text().catch(() => "");
            throw new JevUnavailableError(`Jev HTTP ${response.status}${text ? `: ${text.slice(0, 240)}` : ""}`);
          }

          const json: unknown = await response.json();
          const result = validateResult(request.questions, json);
          recordJevSuccess();
          return result;
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err));
          recordJevFailure();
          if (signal?.aborted) break;
          if (attempt < maxRetries) await sleep(200 * 2 ** attempt);
        }
      }
      throw lastError;
    },
  };
}

export function createJevAsker(client?: JevClient, options: JevAskerOptions = {}): JevAsker {
  const transport: JevAsker = {
    async ask(request: SystemOneRequest, signal?: AbortSignal): Promise<JevAskResult> {
      if (!client && isJevCircuitOpen()) {
        return { ok: false, reason: "jev-circuit-open" };
      }
      try {
        const resolved = client ?? lazyDefaultClient();
        if (!resolved) {
          return { ok: false, reason: "jev-unconfigured" };
        }
        const result = await resolved.systemOne(request, signal);
        return { ok: true, result };
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        const circuit = error.message.includes("circuit open");
        return {
          ok: false,
          reason: circuit ? "jev-circuit-open" : error.name === "JevUnavailableError" ? "jev-unavailable" : "jev-invalid",
          error,
        };
      }
    },
  };
  const cached = options.cache === false ? transport : wrapAskerWithCache(transport);
  return {
    async ask(request: SystemOneRequest, signal?: AbortSignal): Promise<JevAskResult> {
      const { request: clean, severe } = sanitizeJevRequest(request);
      const asked = await cached.ask(clean, signal);
      if (!asked.ok || !severe) return asked;
      return {
        ...asked,
        result: {
          ...asked.result,
          answers: overlayLocalSecretAnswers(clean.questions, asked.result.answers, true),
        },
      };
    },
  };
}

/** Tiny System One ping so TLS + HTTP/2 are warm before the first user turn. */
export async function warmupJev(asker?: JevAsker): Promise<{ ok: boolean; latencyMs: number; reason?: string }> {
  const started = Date.now();
  const resolved = asker ?? createJevAsker();
  const asked = await resolved.ask({
    state: { warmup: true },
    questions: {
      ping: { type: "noul", instructions: "This is a connection warmup ping. The proposition is true." },
    },
  });
  return {
    ok: asked.ok,
    latencyMs: Date.now() - started,
    reason: asked.ok ? undefined : asked.reason,
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
  resetJevCircuit();
  resetJevAskCache();
}

async function hedgedFetch(
  send: (signal?: AbortSignal) => Promise<Response>,
  hedgeMs: number,
  signal?: AbortSignal
): Promise<Response> {
  const primaryAbort = new AbortController();
  const hedgeAbort = new AbortController();
  const onParentAbort = () => {
    primaryAbort.abort();
    hedgeAbort.abort();
  };
  signal?.addEventListener("abort", onParentAbort, { once: true });

  const primary = send(primaryAbort.signal);
  let settled = false;
  const marked = primary.finally(() => {
    settled = true;
  });
  try {
    await Promise.race([marked, sleep(hedgeMs)]);
    if (settled || signal?.aborted) return primary;
    const secondary = send(hedgeAbort.signal);
    const winner = await Promise.any([
      primary.then((response) => ({ response, loser: hedgeAbort })),
      secondary.then((response) => ({ response, loser: primaryAbort })),
    ]);
    winner.loser.abort();
    return winner.response;
  } finally {
    signal?.removeEventListener("abort", onParentAbort);
  }
}

export function createMockJevClient(
  handler: (request: SystemOneRequest) => SystemOneResult | Promise<SystemOneResult>
): JevClient {
  return {
    async systemOne(request: SystemOneRequest): Promise<SystemOneResult> {
      const raw = await handler(request);
      return validateResult(request.questions, coerceMockAnswers(request.questions, raw));
    },
  };
}

function coerceMockAnswers(
  questions: SystemOneRequest["questions"],
  raw: SystemOneResult
): SystemOneResult {
  const answers: SystemOneResult["answers"] = { ...raw.answers };
  for (const [id, question] of Object.entries(questions)) {
    const current = answers[id];
    if (question.type === "noul" && current?.type === "noul") continue;
    if (question.type === "choice" && current?.type === "choice") continue;
    if (question.type === "score" && current?.type === "score") continue;
    if (question.type === "noul") {
      answers[id] = { type: "noul", noul: current?.type === "noul" ? current.noul : 0.1 };
    } else if (question.type === "choice") {
      const keys = Object.keys(question.criteria);
      const pick = current?.type === "choice" && keys.includes(current.choice) ? current.choice : keys[0]!;
      const probabilities = Object.fromEntries(
        keys.map((k) => [k, k === pick ? 0.9 : 0.1 / Math.max(1, keys.length - 1)])
      );
      const sum = Object.values(probabilities).reduce((a, b) => a + b, 0);
      for (const k of Object.keys(probabilities)) probabilities[k] = (probabilities[k] ?? 0) / sum;
      answers[id] = { type: "choice", choice: pick, probabilities, confidence: 0.9 };
    } else {
      answers[id] = {
        type: "score",
        score: 1,
        legend: Object.fromEntries(question.criteria.map((l, i) => [String(i), l])),
        probabilities: Object.fromEntries(question.criteria.map((_, i) => [String(i), i === 1 ? 0.7 : 0.3 / Math.max(1, question.criteria.length - 1)])),
        confidence: 0.8,
      };
    }
  }
  return { ...raw, answers };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
