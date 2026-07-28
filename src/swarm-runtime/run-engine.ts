/**
 * Engine resolution for `hermes-swarm run` — decides, *honestly*, whether a
 * run gets a real model-backed {@link LLMExecutor} or the deterministic
 * offline `DemoExecutor`, and says WHY in a form that is always safe to print.
 *
 * This module deliberately mirrors the decision-table / honesty pattern of
 * `src/hades/gateway/engine-select.ts` (the gateway's engine picker):
 *
 * - It is **pure**: environment is a parameter, nothing is constructed, so the
 *   full decision table is unit-testable and status surfaces (`doctor`) can
 *   report the configured engine without building a swarm.
 * - Its output carries **only environment-variable NAMES and model/provider
 *   words — never a key VALUE** — so every string here is safe to log.
 * - There is **no silent fallback to the offline executor** once the user has
 *   configured anything real: a named provider whose key env var is missing is
 *   a hard error naming that exact variable, never a quiet mock run.
 * - API keys are **never accepted as flags**: they are read only from the
 *   provider's documented env var (`apiKeyEnv` in {@link PROVIDERS}), so keys
 *   never land in shell history or `ps` output.
 *
 * Decision table (`flags` win over env; `env` supplies `SWARM_PROVIDER` /
 * `SWARM_MODEL` fallbacks and the per-provider key variables):
 *
 * | `--offline` | provider (flag/env)     | key state                        | result |
 * |---|---|---|---|
 * | yes         | anything                | anything (even keys set)         | offline, "explicitly requested via --offline" |
 * | no          | unknown name            | n/a                              | **throw**: unknown provider, listing valid names |
 * | no          | `local`                 | n/a (keyless by design)          | real, no `keyVar` — but a model is required (`--model`/`SWARM_MODEL`; Ollama/vLLM have no universal default) |
 * | no          | any keyed provider      | its `apiKeyEnv` unset            | **throw** naming that exact env var |
 * | no          | keyed, no default model | key set, no model given          | **throw**: pass `--model`/`SWARM_MODEL` |
 * | no          | keyed provider          | key set                          | real, with `keyVar` |
 * | no          | none                    | `ANTHROPIC_API_KEY` set          | real `anthropic` (auto-select, anthropic first — mirrors engine-select) |
 * | no          | none                    | `OPENAI_API_KEY` set             | real `openai` (auto-select) |
 * | no          | none, but `--model`/`SWARM_MODEL`/`--base-url` given | no key | **throw** — the user configured something real; never silently mock |
 * | no          | none                    | no key                           | offline, honest "no provider key detected" reason |
 *
 * @module swarm-runtime/run-engine
 */

import { PROVIDERS, type ProviderName } from "./worker/providers";

/** The engine-relevant subset of the CLI's parsed flags. */
export interface RunEngineFlags {
  /** `--provider` — must be a {@link PROVIDERS} name. Beats `SWARM_PROVIDER`. */
  provider?: string;
  /** `--model` — beats `SWARM_MODEL`. */
  model?: string;
  /** `--base-url` — explicit endpoint override (e.g. a custom vLLM host). */
  baseUrl?: string;
  /** `--offline` — force the deterministic executor even when keys exist. */
  offline?: boolean;
}

/**
 * What `cmdRun` will execute with, and why. `keyVar`/`reason` carry env
 * variable NAMES and status words only — never a secret value — so a decision
 * is always safe to print (see {@link formatEngineLine}).
 */
export type RunEngineDecision =
  | {
      kind: "real";
      provider: ProviderName;
      model: string;
      /** Explicit `--base-url` override; `undefined` = the provider's default. */
      baseUrl?: string;
      /** NAME of the env var supplying the key; absent for keyless `local`. */
      keyVar?: string;
    }
  | { kind: "offline"; reason: string };

/** Reason string when the user forced offline mode themselves. */
export const OFFLINE_EXPLICIT_REASON = "explicitly requested via --offline";

/** Reason string when nothing real is configured and no key is present. */
export const OFFLINE_NO_KEY_REASON =
  "no provider key detected — set ANTHROPIC_API_KEY or OPENAI_API_KEY, or pass --provider local for Ollama/vLLM";

/**
 * Per-provider default models, mirroring `engine-select.ts`'s `detectKey`
 * exactly. Providers absent here (nous, openrouter, together, groq, local)
 * have no honest universal default, so they require an explicit
 * `--model`/`SWARM_MODEL` instead of us guessing one.
 */
export const DEFAULT_MODELS: Partial<Record<ProviderName, string>> = {
  anthropic: "claude-sonnet-5",
  openai: "gpt-4o-mini",
};

/** Own-property lookup so junk like `--provider constructor` can never walk the prototype chain into a "valid" provider. */
function knownProvider(name: string): name is ProviderName {
  return Object.prototype.hasOwnProperty.call(PROVIDERS, name);
}

/**
 * Resolve which engine `hermes-swarm run` uses, per the module-level decision
 * table. Pure: reads only its arguments. Throws (a hard, user-facing error —
 * never a silent mock fallback) when the user configured a real engine that
 * cannot actually run; the message names the exact env var or flag to fix.
 */
export function resolveRunEngine(
  flags: RunEngineFlags,
  env: Record<string, string | undefined>,
): RunEngineDecision {
  // 1. --offline always wins — even with providers/keys configured.
  if (flags.offline) return { kind: "offline", reason: OFFLINE_EXPLICIT_REASON };

  const providerRaw = flags.provider ?? env.SWARM_PROVIDER; // flags win over env
  const model = flags.model ?? env.SWARM_MODEL; // flags win over env
  const baseUrl = flags.baseUrl;

  // 2. A provider was named (flag or SWARM_PROVIDER): it must actually work.
  if (providerRaw !== undefined) {
    if (!knownProvider(providerRaw)) {
      throw new Error(
        `unknown provider "${providerRaw}" — valid providers: ${Object.keys(PROVIDERS).join(", ")}`,
      );
    }
    const keyVar = PROVIDERS[providerRaw].apiKeyEnv;
    if (keyVar !== undefined && !env[keyVar]) {
      throw new Error(
        `provider "${providerRaw}" requires the ${keyVar} environment variable, and ${keyVar} is not set — ` +
          `export ${keyVar} (API keys are read only from env, never from flags), or pass --offline for the deterministic executor`,
      );
    }
    const resolvedModel = model ?? DEFAULT_MODELS[providerRaw];
    if (resolvedModel === undefined) {
      throw new Error(
        `provider "${providerRaw}" has no default model — pass --model <id> or set SWARM_MODEL`,
      );
    }
    return {
      kind: "real",
      provider: providerRaw,
      model: resolvedModel,
      ...(baseUrl !== undefined ? { baseUrl } : {}),
      ...(keyVar !== undefined ? { keyVar } : {}),
    };
  }

  // 3. No provider named: auto-select from present keys, anthropic first —
  //    the same order as engine-select.ts's detectKey.
  const auto: ProviderName | undefined = env.ANTHROPIC_API_KEY
    ? "anthropic"
    : env.OPENAI_API_KEY
      ? "openai"
      : undefined;
  if (auto !== undefined) {
    return {
      kind: "real",
      provider: auto,
      // DEFAULT_MODELS is total over the two auto-selectable providers.
      model: model ?? (DEFAULT_MODELS[auto] as string),
      ...(baseUrl !== undefined ? { baseUrl } : {}),
      keyVar: PROVIDERS[auto].apiKeyEnv as string,
    };
  }

  // 4. The user configured *something* real (a model or an endpoint) but no
  //    provider is resolvable and no key exists. Silently mocking here is the
  //    audited failure mode — hard-error naming what would fix it instead.
  if (model !== undefined || baseUrl !== undefined) {
    const configured = [
      flags.model !== undefined ? "--model" : env.SWARM_MODEL !== undefined ? "SWARM_MODEL" : undefined,
      baseUrl !== undefined ? "--base-url" : undefined,
    ]
      .filter((s): s is string => s !== undefined)
      .join(" and ");
    throw new Error(
      `${configured} set but no provider key found — set ANTHROPIC_API_KEY or OPENAI_API_KEY, ` +
        `pass --provider <name> with its key env var exported, or use --provider local for a keyless Ollama/vLLM endpoint`,
    );
  }

  // 5. Nothing configured, no keys: the deterministic executor, honestly labelled.
  return { kind: "offline", reason: OFFLINE_NO_KEY_REASON };
}

/**
 * One-line human description of a decision — the part after `engine: `.
 * Contains env variable NAMES (never values); for the keyless `local`
 * provider it shows the effective base URL instead, since that is the whole
 * story of where the request goes.
 */
export function describeRunEngine(decision: RunEngineDecision): string {
  if (decision.kind === "offline") {
    return `deterministic offline executor (${decision.reason})`;
  }
  if (decision.keyVar !== undefined) {
    return `real (provider=${decision.provider} model=${decision.model} via ${decision.keyVar})`;
  }
  const url = decision.baseUrl ?? PROVIDERS[decision.provider].baseUrl;
  return `real (provider=${decision.provider} model=${decision.model} via ${url}, no API key required)`;
}

/** The single honest engine line `cmdRun` prints before a run starts. */
export function formatEngineLine(decision: RunEngineDecision): string {
  return `engine: ${describeRunEngine(decision)}`;
}
