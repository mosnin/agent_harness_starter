/**
 * Hades — Jev-powered agent harness.
 *
 * Decision loop (LangChain harness + the open-source Jev routers):
 *   1. OpenAI voice STT (optional)
 *   2. Jev screens the message and routes a Qwen model via OpenRouter
 *   3. Qwen generates / calls tools
 *   4. Jev Auto Mode gates every tool call
 *   5. Jev screens the draft
 *   6. OpenAI TTS (optional)
 *
 * Jev never writes prose. Qwen never makes policy. Voice never decides.
 */

import { createCustomHarness, type AgentHarness } from "../core";
import { HADES_QWEN_ROUTES } from "../jev/catalog";
import { createJevAsker } from "../jev/client";
import { registerJevMcpTools } from "../jev/mcp";
import { routeModel, type ModelRouterResult } from "../jev/router";
import { withJev, type JevPluginOptions } from "../plugins/jev";
import { withMemory } from "../plugins/memory";
import { withObservability } from "../plugins/observability";
import { withApprovals } from "../plugins/approvals";
import { configureOpenRouter, defaultHadesModel } from "../providers/openrouter";
import { synthesizeSpeech, transcribeAudio, type VoiceConfig } from "../providers/voice";
import type { AgentConfig, RunInput, RunResult } from "../types";
import type { JevAsker } from "../jev/types";

export interface HadesConfig extends AgentConfig {
  jev?: JevPluginOptions;
  /** Skip OpenRouter env wiring (tests). */
  skipProviderSetup?: boolean;
  /** Register jev_* MCP tools. Default: true. */
  registerMcp?: boolean;
  voice?: VoiceConfig;
}

export interface HadesHarness extends AgentHarness {
  route(message: string, currentRoute?: string): Promise<ModelRouterResult>;
  voiceTurn(audio: Buffer | Uint8Array, input?: Omit<RunInput, "messages">): Promise<HadesVoiceResult>;
}

export interface HadesVoiceResult extends RunResult {
  transcript: string;
  audio?: Buffer;
}

let mcpRegistered = false;

export function createHadesHarness(agentConfig: HadesConfig): HadesHarness {
  if (!agentConfig.skipProviderSetup) {
    configureOpenRouter();
  }
  if (agentConfig.registerMcp !== false && !mcpRegistered) {
    registerJevMcpTools();
    mcpRegistered = true;
  }

  const asker: JevAsker | undefined = agentConfig.jev?.asker ?? createJevAsker();
  const plugins = [...(agentConfig.plugins ?? [])];
  const has = (name: string) => plugins.some((p) => p.name === name);

  if (!has("jev")) {
    plugins.unshift(withJev({ ...agentConfig.jev, asker }));
  }
  if (agentConfig.memoryKey && !has("memory")) {
    plugins.push(withMemory({ key: agentConfig.memoryKey }));
  }
  if (agentConfig.requireApprovalFor?.length && !has("approvals")) {
    plugins.push(withApprovals({ requireApprovalFor: agentConfig.requireApprovalFor }));
  }
  if (!has("observability")) {
    plugins.push(withObservability());
  }

  const model = agentConfig.model ?? defaultHadesModel();
  const inner = createCustomHarness({
    ...agentConfig,
    model,
    plugins,
  });

  return {
    stream: inner.stream,
    run: inner.run,
    async route(message: string, currentRoute = "balanced") {
      return routeModel({ message, currentRoute, asker });
    },
    async voiceTurn(audio, input) {
      const transcript = await transcribeAudio(audio, "audio.webm", agentConfig.voice);
      const result = await inner.run({
        messages: [{ role: "user", content: transcript }],
        context: { ...(input?.context ?? {}), channel: "voice" },
        signal: input?.signal,
      });
      let spoken: Buffer | undefined;
      try {
        if (result.finalOutput) {
          spoken = await synthesizeSpeech(result.finalOutput, agentConfig.voice);
        }
      } catch {
        spoken = undefined;
      }
      return { ...result, transcript, audio: spoken };
    },
  };
}

export { HADES_QWEN_ROUTES };
export { withJev } from "../plugins/jev";
export type { JevPluginOptions } from "../plugins/jev";
