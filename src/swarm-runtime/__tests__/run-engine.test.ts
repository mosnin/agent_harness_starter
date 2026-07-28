/**
 * The `hermes-swarm run` engine decision table (`run-engine.ts`), pinned case
 * by case. `resolveRunEngine` is pure — environment is a parameter — so every
 * row is tested directly with plain objects; no subprocess, no network, no
 * `process.env` mutation (the subprocess-level behaviour is pinned in
 * `cli-engine.test.ts`).
 *
 * The honesty invariants under test:
 *  - `--offline` beats everything, even fully-configured real providers.
 *  - a named provider whose key env var is missing is a HARD error naming
 *    that exact variable — never a silent fallback to the offline executor;
 *  - `local` is the one keyless provider;
 *  - auto-selection mirrors `engine-select.ts` (anthropic first, then openai,
 *    with the same default models);
 *  - flags beat SWARM_PROVIDER / SWARM_MODEL env fallbacks;
 *  - printed lines carry env variable NAMES only, never key values.
 */
import { describe, it, expect } from "vitest";
import {
  DEFAULT_MODELS,
  OFFLINE_EXPLICIT_REASON,
  OFFLINE_NO_KEY_REASON,
  formatEngineLine,
  resolveRunEngine,
} from "../run-engine";

describe("resolveRunEngine — offline rows", () => {
  it("--offline wins even with keys AND a provider configured", () => {
    const d = resolveRunEngine(
      { offline: true, provider: "openai", model: "gpt-4o" },
      { OPENAI_API_KEY: "sk-real", ANTHROPIC_API_KEY: "sk-real-too", SWARM_PROVIDER: "anthropic" },
    );
    expect(d).toEqual({ kind: "offline", reason: OFFLINE_EXPLICIT_REASON });
  });

  it("nothing configured + no keys → offline with the honest no-key reason", () => {
    const d = resolveRunEngine({}, {});
    expect(d).toEqual({ kind: "offline", reason: OFFLINE_NO_KEY_REASON });
    // The reason must tell the user how to get a real engine, by variable NAME.
    expect(OFFLINE_NO_KEY_REASON).toContain("ANTHROPIC_API_KEY");
    expect(OFFLINE_NO_KEY_REASON).toContain("OPENAI_API_KEY");
    expect(OFFLINE_NO_KEY_REASON).toContain("--provider local");
  });
});

describe("resolveRunEngine — named provider rows", () => {
  it("provider flag + key present → real, naming the key VARIABLE", () => {
    const d = resolveRunEngine({ provider: "openai" }, { OPENAI_API_KEY: "sk-fake" });
    expect(d).toEqual({ kind: "real", provider: "openai", model: "gpt-4o-mini", keyVar: "OPENAI_API_KEY" });
  });

  it("provider flag + key MISSING → hard error naming the exact env var", () => {
    expect(() => resolveRunEngine({ provider: "openai" }, {})).toThrow(/OPENAI_API_KEY/);
    // Never a silent mock: it must throw, not return kind:"offline".
  });

  it("SWARM_PROVIDER env fallback is honoured — including its missing-key hard error", () => {
    expect(() => resolveRunEngine({}, { SWARM_PROVIDER: "openai" })).toThrow(/OPENAI_API_KEY/);
    const ok = resolveRunEngine({}, { SWARM_PROVIDER: "groq", GROQ_API_KEY: "k", SWARM_MODEL: "llama-3.3-70b" });
    expect(ok).toEqual({ kind: "real", provider: "groq", model: "llama-3.3-70b", keyVar: "GROQ_API_KEY" });
  });

  it("--provider flag beats SWARM_PROVIDER, --model beats SWARM_MODEL", () => {
    const d = resolveRunEngine(
      { provider: "anthropic", model: "claude-opus-x" },
      { SWARM_PROVIDER: "openai", SWARM_MODEL: "gpt-4o", ANTHROPIC_API_KEY: "k", OPENAI_API_KEY: "k2" },
    );
    expect(d).toEqual({
      kind: "real",
      provider: "anthropic",
      model: "claude-opus-x",
      keyVar: "ANTHROPIC_API_KEY",
    });
  });

  it("local needs no key…", () => {
    const d = resolveRunEngine({ provider: "local", model: "llama3.1" }, {});
    expect(d).toEqual({ kind: "real", provider: "local", model: "llama3.1" });
    expect((d as { keyVar?: string }).keyVar).toBeUndefined();
  });

  it("…but local has no honest default model, so a model is required", () => {
    expect(() => resolveRunEngine({ provider: "local" }, {})).toThrow(/--model|SWARM_MODEL/);
  });

  it("keyed providers without a documented default model also require one", () => {
    expect(() => resolveRunEngine({ provider: "nous" }, { NOUS_API_KEY: "k" })).toThrow(/--model|SWARM_MODEL/);
  });

  it("--base-url is carried through as an explicit override", () => {
    const d = resolveRunEngine(
      { provider: "local", model: "m", baseUrl: "http://127.0.0.1:9999/v1" },
      {},
    );
    expect(d).toEqual({ kind: "real", provider: "local", model: "m", baseUrl: "http://127.0.0.1:9999/v1" });
  });

  it("unknown provider names are rejected with the valid list", () => {
    expect(() => resolveRunEngine({ provider: "nope" }, {})).toThrow(/unknown provider "nope".*local/);
  });

  it("prototype-chain junk is not a provider (own-property lookup)", () => {
    expect(() => resolveRunEngine({ provider: "constructor" }, {})).toThrow(/unknown provider/);
  });
});

describe("resolveRunEngine — auto-selection (mirrors engine-select.ts)", () => {
  it("ANTHROPIC_API_KEY alone → anthropic with its default model", () => {
    const d = resolveRunEngine({}, { ANTHROPIC_API_KEY: "k" });
    expect(d).toEqual({
      kind: "real",
      provider: "anthropic",
      model: DEFAULT_MODELS.anthropic,
      keyVar: "ANTHROPIC_API_KEY",
    });
  });

  it("OPENAI_API_KEY alone → openai with its default model", () => {
    const d = resolveRunEngine({}, { OPENAI_API_KEY: "k" });
    expect(d).toEqual({
      kind: "real",
      provider: "openai",
      model: DEFAULT_MODELS.openai,
      keyVar: "OPENAI_API_KEY",
    });
  });

  it("both keys present → anthropic first, same order as engine-select", () => {
    const d = resolveRunEngine({}, { ANTHROPIC_API_KEY: "a", OPENAI_API_KEY: "o" });
    expect(d).toMatchObject({ kind: "real", provider: "anthropic" });
  });

  it("--model overrides the auto-selected provider's default model", () => {
    const d = resolveRunEngine({ model: "gpt-4.1" }, { OPENAI_API_KEY: "k" });
    expect(d).toMatchObject({ kind: "real", provider: "openai", model: "gpt-4.1" });
  });

  it("a model configured with no provider and no key is a hard error, not a silent mock", () => {
    expect(() => resolveRunEngine({ model: "gpt-4o" }, {})).toThrow(/ANTHROPIC_API_KEY or OPENAI_API_KEY/);
    expect(() => resolveRunEngine({}, { SWARM_MODEL: "gpt-4o" })).toThrow(/SWARM_MODEL/);
  });

  it("a --base-url alone (no provider, no key) is a hard error suggesting --provider local", () => {
    expect(() => resolveRunEngine({ baseUrl: "http://127.0.0.1:11434/v1" }, {})).toThrow(/--provider local/);
  });
});

describe("formatEngineLine — the one honest line", () => {
  it("real keyed engine names the provider, model and key VARIABLE (never a value)", () => {
    const line = formatEngineLine(resolveRunEngine({ provider: "openai" }, { OPENAI_API_KEY: "sk-SECRET" }));
    expect(line).toBe("engine: real (provider=openai model=gpt-4o-mini via OPENAI_API_KEY)");
    expect(line).not.toContain("sk-SECRET");
  });

  it("real local engine names the effective base URL and says no key is required", () => {
    const line = formatEngineLine(resolveRunEngine({ provider: "local", model: "llama3.1" }, {}));
    expect(line).toBe(
      "engine: real (provider=local model=llama3.1 via http://localhost:11434/v1, no API key required)",
    );
    const overridden = formatEngineLine(
      resolveRunEngine({ provider: "local", model: "m", baseUrl: "http://127.0.0.1:8000/v1" }, {}),
    );
    expect(overridden).toContain("http://127.0.0.1:8000/v1");
  });

  it("offline lines carry the honest reason verbatim", () => {
    expect(formatEngineLine({ kind: "offline", reason: OFFLINE_NO_KEY_REASON })).toBe(
      `engine: deterministic offline executor (${OFFLINE_NO_KEY_REASON})`,
    );
    expect(formatEngineLine({ kind: "offline", reason: OFFLINE_EXPLICIT_REASON })).toContain(
      "explicitly requested via --offline",
    );
  });
});
