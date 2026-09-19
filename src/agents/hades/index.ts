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
import { DEFAULT_HADES_SKILLS, HADES_QWEN_ROUTES } from "../jev/catalog";
import { createJevAsker } from "../jev/client";
import { classifyVoiceIntent } from "../jev/hooks";
import { registerJevMcpTools } from "../jev/mcp";
import { routeModel, type ModelRouterResult } from "../jev/router";
import type { SkillRoute } from "../jev/types";
import { withJev, type JevPluginOptions } from "../plugins/jev";
import { withMemory } from "../plugins/memory";
import { withObservability } from "../plugins/observability";
import { withApprovals } from "../plugins/approvals";
import { configureOpenRouter, defaultHadesModel } from "../providers/openrouter";
import { synthesizeSpeech, transcribeAudio, voiceIntentHint, type VoiceConfig } from "../providers/voice";
import type { AgentConfig, RunInput, RunResult } from "../types";
import type { JevAsker } from "../jev/types";

function skillsFromConfig(agentConfig: AgentConfig): SkillRoute[] {
  const named = (agentConfig.skills ?? []).map((id) => {
    const known = DEFAULT_HADES_SKILLS.find((s) => s.id === id);
    return known ?? { id, description: `Specialist skill: ${id}` };
  });
  return named.length > 0 ? named : DEFAULT_HADES_SKILLS.filter((s) => !s.id.startsWith("__"));
}

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
  const enableMcp = agentConfig.registerMcp === true
    || (agentConfig.registerMcp !== false && process.env.HADES_MCP_JEV === "true");
  if (enableMcp && !mcpRegistered) {
    registerJevMcpTools();
    mcpRegistered = true;
  }

  const asker: JevAsker | undefined = agentConfig.jev?.asker ?? createJevAsker();
  const plugins = [...(agentConfig.plugins ?? [])];
  const has = (name: string) => plugins.some((p) => p.name === name);

  if (!has("jev")) {
    plugins.unshift(withJev({
      ...agentConfig.jev,
      asker,
      skills: agentConfig.jev?.skills ?? skillsFromConfig(agentConfig),
    }));
  }
  if (agentConfig.memoryKey && !has("memory")) {
    plugins.push(withMemory({ key: agentConfig.memoryKey, jevFilter: true, asker }));
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
      const hint = await voiceIntentHint(transcript);
      let spokenReply: string | undefined;
      if (hint === "out_of_scope") {
        spokenReply = "Okay, cancelled.";
      } else {
        const intent = await classifyVoiceIntent({ transcript, asker });
        if (shouldExecuteVoice(intent)) {
          spokenReply = undefined;
        } else if (intent.action === "block" || intent.value === "unsafe") {
          spokenReply = "I can't do that.";
        } else if (intent.value === "out_of_scope") {
          spokenReply = "Okay, cancelled.";
        } else {
          spokenReply = "Could you say that again more specifically?";
        }
      }
      if (spokenReply) {
        let audio: Buffer | undefined;
        try {
          audio = await synthesizeSpeech(spokenReply, agentConfig.voice);
        } catch {
          audio = undefined;
        }
        return {
          finalOutput: spokenReply,
          messages: [{ role: "user", content: transcript }],
          toolCalls: [],
          transcript,
          audio,
        };
      }
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

/** Voice executes only on a confident Jev auto / execute_now decision. */
export function shouldExecuteVoice(intent: { action: string; value: unknown }): boolean {
  return intent.action === "auto" && intent.value === "execute_now";
}
