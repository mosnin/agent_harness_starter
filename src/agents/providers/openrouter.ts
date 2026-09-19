/**
 * OpenRouter generation provider — Hades uses Qwen here.
 *
 * The OpenAI Agents SDK talks OpenAI-compatible chat completions.
 * Point the client at https://openrouter.ai/api/v1 and pass a Qwen model id
 * such as qwen/qwen-2.5-72b-instruct.
 */

import OpenAI from "openai";
import { HADES_QWEN_ROUTES } from "../jev/catalog";

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

export interface OpenRouterConfig {
  apiKey?: string;
  baseUrl?: string;
  defaultModel?: string;
  siteUrl?: string;
  appName?: string;
}

export function resolveOpenRouterKey(explicit?: string): string | undefined {
  return explicit || process.env.OPENROUTER_API_KEY || undefined;
}

export function createOpenRouterClient(config: OpenRouterConfig = {}): OpenAI {
  const apiKey = resolveOpenRouterKey(config.apiKey);
  if (!apiKey) {
    throw new Error("Missing OPENROUTER_API_KEY — required for Hades Qwen generation");
  }
  return new OpenAI({
    apiKey,
    baseURL: config.baseUrl ?? process.env.OPENROUTER_BASE_URL ?? OPENROUTER_BASE_URL,
    defaultHeaders: {
      "HTTP-Referer": config.siteUrl ?? process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000",
      "X-Title": config.appName ?? "Hades",
    },
  });
}

export function defaultHadesModel(): string {
  return process.env.HADES_MODEL ?? process.env.OPENROUTER_MODEL ?? HADES_QWEN_ROUTES[1]?.model ?? "qwen/qwen-2.5-72b-instruct";
}

/**
 * Install OpenRouter as the process-wide OpenAI-compatible endpoint so
 * `@openai/agents` Agent({ model: "qwen/..." }) resolves through Qwen.
 * Call once at process start (Hades preset does this).
 */
export function configureOpenRouter(config: OpenRouterConfig = {}): void {
  const apiKey = resolveOpenRouterKey(config.apiKey);
  if (!apiKey) return;
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || apiKey;
  process.env.OPENAI_BASE_URL = config.baseUrl ?? process.env.OPENROUTER_BASE_URL ?? OPENROUTER_BASE_URL;
  if (!process.env.OPENAI_MODEL) {
    process.env.OPENAI_MODEL = config.defaultModel ?? defaultHadesModel();
  }
}

export interface OpenRouterChatInput {
  model: string;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  temperature?: number;
  maxTokens?: number;
}

export async function generateWithQwen(input: OpenRouterChatInput, client?: OpenAI): Promise<string> {
  if (!input.model.trim()) throw new Error("generateWithQwen: model is required");
  if (input.messages.length === 0) throw new Error("generateWithQwen: messages must be non-empty");
  const openai = client ?? createOpenRouterClient();
  const completion = await openai.chat.completions.create({
    model: input.model,
    messages: input.messages,
    temperature: input.temperature ?? 0.3,
    max_tokens: input.maxTokens ?? 2048,
  });
  return completion.choices[0]?.message?.content ?? "";
}
