import { HttpModelClient, type ModelClient } from "../models/client";

/** One provider selection path for chat and local workers. Explicit provider
 * selection never borrows another provider's key. A custom local endpoint may
 * omit a key, but always requires an explicit model. */
export function resolveModel(
  env: Record<string, string | undefined>,
  opts: { model?: string; provider?: string; fetchImpl?: typeof fetch } = {},
): { client: ModelClient; model: string; provider: string } {
  const provider = opts.provider ?? env.HADES_PROVIDER ?? (env.ANTHROPIC_API_KEY ? "anthropic" : "openai");
  if (!["openai", "anthropic", "local"].includes(provider)) throw new Error("HADES_PROVIDER must be openai, anthropic or local.");
  const model = opts.model ?? env.HADES_MODEL ?? env.SWARM_MODEL ?? (provider === "openai" ? "gpt-4o-mini" : undefined);
  if (!model) throw new Error("Set HADES_MODEL to a model your provider serves, or pass --model.");
  const apiKey = provider === "local" ? env.HADES_API_KEY : provider === "anthropic" ? env.ANTHROPIC_API_KEY : env.SWARM_API_KEY ?? env.OPENAI_API_KEY;
  const baseUrl = provider === "anthropic" ? env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com"
    : env.HADES_BASE_URL ?? env.SWARM_BASE_URL ?? env.OPENAI_BASE_URL ?? (provider === "local" ? undefined : "https://api.openai.com/v1");
  if (!baseUrl) throw new Error("Set HADES_BASE_URL for the local provider.");
  if (!apiKey && provider !== "local") throw new Error(`Set ${provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY"}, or use HADES_PROVIDER=local with HADES_BASE_URL and HADES_MODEL.`);
  const client = new HttpModelClient({ name: provider, kind: provider === "anthropic" ? "anthropic" : "openai", models: [model], baseUrl, apiKey }, { fetchImpl: opts.fetchImpl });
  return { client, model, provider };
}
