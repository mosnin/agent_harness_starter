/**
 * Picks the gateway's {@link GatewayAgentEngine} from environment — and picks
 * *honestly*: the real, ed25519-certified swarm engine
 * ({@link verifiedSwarmEngine}) is built ONLY behind an explicit opt-in
 * (`HADES_GATEWAY_ENGINE=swarm`) AND a real provider key
 * (`ANTHROPIC_API_KEY` / `OPENAI_API_KEY`). Every other combination —
 * unset, `"echo"`, `"swarm"` with no key, or an unrecognized value — falls
 * back to {@link echoEngine}, the self-announcing `[mock]` engine, and says
 * so plainly in the returned {@link EngineProbe}.
 *
 * There is no code path in this module that builds a swarm over the
 * `swarm-runtime` default `DemoExecutor` (see `worker/executor.ts`) and
 * calls it `mode: "real"` — `mode: "real"` is reachable ONLY through the
 * key-gated branch, which always wires a real {@link LLMExecutor}.
 *
 * @module hades/gateway/engine-select
 */

import { echoEngine, type GatewayAgentEngine } from "./agent-handler";
import { verifiedSwarmEngine } from "./verified-engine";
import { ConformalGate } from "../styx/gate";
import { CertificateAuthority, generatePrivateKeyHex } from "../styx/certificate";
import { defaultCalibration } from "../styx/runner";
import { createInlineSwarm } from "../../swarm-runtime/factory";
import { LLMExecutor, createOpenAICompatibleChat, type ChatFn } from "../../swarm-runtime/worker/llm-executor";
import { createSwarmTrustBridge } from "../trust/swarm-bridge";

/** The manager type {@link verifiedSwarmEngine} needs — named without an
 * extra import: `GatewayManager` (swarm-runtime/gateway/gateway) is exactly
 * `verifiedSwarmEngine`'s first parameter type. */
type Manager = Parameters<typeof verifiedSwarmEngine>[0];

// ---------------------------------------------------------------------------
// EngineProbe
// ---------------------------------------------------------------------------

/**
 * An honest, side-channel-free report of what {@link resolveGatewayEngine}
 * decided and why. `detail` is documented to hold ONLY environment variable
 * NAMES and model/status words — never a secret VALUE — so it is always
 * safe to log or surface in a status command.
 */
export interface EngineProbe {
  requested: "swarm" | "echo";
  mode: "real" | "mock";
  detail: string;
}

export interface ResolveGatewayEngineDeps {
  /** Injected chat transport — bypasses `createOpenAICompatibleChat`'s real fetch. Tests only. */
  chat?: ChatFn;
  /** Injected manager factory — bypasses the real `createInlineSwarm`. Tests only. */
  createManager?: (executor: LLMExecutor) => Promise<{ manager: Manager; shutdown: () => Promise<void> }>;
  /** Certificate `issuedAt` source, forwarded to `verifiedSwarmEngine`. */
  now?: () => number;
}

export interface ResolvedGatewayEngine {
  engine: GatewayAgentEngine;
  probe: EngineProbe;
  /** Idempotent-in-spirit: tears down whatever manager (if any) was created. No-op for a mock engine. */
  shutdown: () => Promise<void>;
}

const NOOP_SHUTDOWN = async (): Promise<void> => {};

const MISSING_KEY_DETAIL = "missing ANTHROPIC_API_KEY, OPENAI_API_KEY";

const ECHO_OPT_IN_DETAIL =
  "using the mock echo engine; set HADES_GATEWAY_ENGINE=swarm and ANTHROPIC_API_KEY or OPENAI_API_KEY " +
  "to opt into the real, certified swarm engine";

interface DetectedKey {
  /** The exact environment variable NAME that supplied the key — never the key value. */
  variable: "ANTHROPIC_API_KEY" | "OPENAI_API_KEY";
  apiKey: string;
  defaultModel: string;
  /**
   * Default base URL for this provider's OpenAI-compatible endpoint.
   * Anthropic's native wire dialect is `/v1/messages`, not OpenAI's
   * `/chat/completions` — but Anthropic also serves a real OpenAI SDK
   * compatibility endpoint at this exact base
   * (https://docs.anthropic.com/en/api/openai-sdk), which is what
   * `createOpenAICompatibleChat` (an OpenAI-dialect-only `ChatFn`) needs.
   * `undefined` lets `createOpenAICompatibleChat` fall back to its own
   * default (`https://api.openai.com/v1`).
   */
  defaultBaseUrl: string | undefined;
}

function detectKey(env: Record<string, string | undefined>): DetectedKey | undefined {
  if (env.ANTHROPIC_API_KEY) {
    return {
      variable: "ANTHROPIC_API_KEY",
      apiKey: env.ANTHROPIC_API_KEY,
      defaultModel: "claude-sonnet-5",
      defaultBaseUrl: "https://api.anthropic.com/v1",
    };
  }
  if (env.OPENAI_API_KEY) {
    return {
      variable: "OPENAI_API_KEY",
      apiKey: env.OPENAI_API_KEY,
      defaultModel: "gpt-4o-mini",
      defaultBaseUrl: undefined,
    };
  }
  return undefined;
}

/**
 * Real default: a genuine inline swarm wrapping `shutdown` into the
 * `{manager, shutdown}` shape.
 *
 * The swarm's `VerificationGate` is handed the STYX trust bridge
 * (`../trust/swarm-bridge.ts`), which adds exactly ONE correctness check to
 * this path: T1-reference recompute. When a goal's objective carries a
 * machine-checkable `SPEC:` reference, the goal's final answer is recomputed
 * and compared, and a mismatch declines the turn instead of certifying it.
 * Nothing else in the STYX stack votes here — see the bridge's module docs for
 * why the structural verifier abstains — so this is one check, not "the trust
 * stack".
 *
 * Everywhere else the bridge abstains and the gate scores exactly as it always
 * did: an objective with no reference, and every intermediate subtask result
 * even on a goal that has one. So this is additive — it can decline a provably
 * wrong answer, it can never accept one the grounding checks would have
 * refused, and it cannot fail a correct run. Constructing it costs no key, no
 * data directory and no network call.
 */
async function defaultCreateManager(executor: LLMExecutor): Promise<{ manager: Manager; shutdown: () => Promise<void> }> {
  const manager = await createInlineSwarm({
    executor,
    gate: { externalVerifier: createSwarmTrustBridge() },
  });
  return { manager, shutdown: () => manager.shutdown() };
}

// ---------------------------------------------------------------------------
// probeGatewayEngine — the pure, construction-free view of the decision table
// ---------------------------------------------------------------------------

/**
 * Compute the {@link EngineProbe} {@link resolveGatewayEngine} WOULD produce
 * for `env`, without constructing anything — no swarm, no `LLMExecutor`, no
 * gate, no signing key. This is what status surfaces (`hades gateway status`,
 * the desktop sidecar's gateway card, the TUI GATEWAY pane) call: they need
 * to report the configured engine honestly, and building a real inline swarm
 * just to print a status line would be wrong.
 *
 * Same decision table as {@link resolveGatewayEngine}, same honesty rules
 * (`detail` carries variable NAMES and model/status words only, never a
 * secret value). The one wording difference is deliberate: the real-engine
 * branch says "configured", not "active", because this function proves
 * configuration, not a running engine.
 */
export function probeGatewayEngine(env: Record<string, string | undefined>): EngineProbe {
  const requested = env.HADES_GATEWAY_ENGINE;

  if (requested === undefined || requested === "echo") {
    return { requested: "echo", mode: "mock", detail: ECHO_OPT_IN_DETAIL };
  }

  if (requested === "swarm") {
    const key = detectKey(env);
    if (!key) {
      return { requested: "swarm", mode: "mock", detail: MISSING_KEY_DETAIL };
    }
    const model = env.HADES_GATEWAY_MODEL ?? key.defaultModel;
    return {
      requested: "swarm",
      mode: "real",
      detail: `real verified swarm engine configured via ${key.variable}, model "${model}"`,
    };
  }

  return {
    requested: "echo",
    mode: "mock",
    detail: `unknown engine requested via HADES_GATEWAY_ENGINE (expected unset, "echo", or "swarm"); falling back to the mock echo engine`,
  };
}

// ---------------------------------------------------------------------------
// resolveGatewayEngine
// ---------------------------------------------------------------------------

/**
 * Resolve the gateway's engine from environment.
 *
 * | `HADES_GATEWAY_ENGINE` | key present? | result                                              |
 * |---|---|---|
 * | unset / `"echo"`       | n/a          | `echoEngine`, probe `{requested:"echo", mode:"mock"}` |
 * | `"swarm"`               | yes          | real `verifiedSwarmEngine` over a real `LLMExecutor` swarm, probe `mode:"real"` naming the key variable |
 * | `"swarm"`               | no           | `echoEngine`, probe `{requested:"swarm", mode:"mock"}` naming the missing variables — NEVER a swarm over the default demo executor |
 * | anything else           | n/a          | `echoEngine`, probe `{requested:"echo", mode:"mock"}` explaining the value was unrecognized |
 *
 * `HADES_GATEWAY_MODEL` / `HADES_GATEWAY_BASE_URL` override the per-provider
 * default model/base URL when the swarm engine is actually built.
 * `HADES_STYX_KEY` (32-byte hex ed25519 seed) overrides the certificate
 * authority's signing key; without it a fresh key is generated per call
 * (fine for a single long-lived process, but callers that need a *stable*
 * public key across restarts must set `HADES_STYX_KEY`).
 */
export async function resolveGatewayEngine(
  env: Record<string, string | undefined>,
  deps?: ResolveGatewayEngineDeps,
): Promise<ResolvedGatewayEngine> {
  const requested = env.HADES_GATEWAY_ENGINE;

  if (requested === undefined || requested === "echo") {
    return {
      engine: echoEngine(),
      probe: { requested: "echo", mode: "mock", detail: ECHO_OPT_IN_DETAIL },
      shutdown: NOOP_SHUTDOWN,
    };
  }

  if (requested === "swarm") {
    const key = detectKey(env);
    if (!key) {
      return {
        engine: echoEngine(),
        probe: { requested: "swarm", mode: "mock", detail: MISSING_KEY_DETAIL },
        shutdown: NOOP_SHUTDOWN,
      };
    }

    const model = env.HADES_GATEWAY_MODEL ?? key.defaultModel;
    const baseUrl = env.HADES_GATEWAY_BASE_URL ?? key.defaultBaseUrl;

    const chat: ChatFn = deps?.chat ?? createOpenAICompatibleChat({ apiKey: key.apiKey, model, baseUrl });
    const executor = new LLMExecutor(chat);

    const createManager = deps?.createManager ?? defaultCreateManager;
    const { manager, shutdown } = await createManager(executor);

    const gate = new ConformalGate({ epsilon: 0.1 });
    gate.calibrate(defaultCalibration());

    const authority = new CertificateAuthority(env.HADES_STYX_KEY ?? generatePrivateKeyHex());

    const engine = verifiedSwarmEngine(manager, { gate, authority, now: deps?.now });

    return {
      engine,
      probe: {
        requested: "swarm",
        mode: "real",
        detail: `real verified swarm engine active via ${key.variable}, model "${model}"`,
      },
      shutdown,
    };
  }

  return {
    engine: echoEngine(),
    probe: {
      requested: "echo",
      mode: "mock",
      detail: `unknown engine requested via HADES_GATEWAY_ENGINE (expected unset, "echo", or "swarm"); falling back to the mock echo engine`,
    },
    shutdown: NOOP_SHUTDOWN,
  };
}
