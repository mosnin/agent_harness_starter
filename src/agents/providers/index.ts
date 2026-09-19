export { createAnthropicHarness } from "./anthropic";
export type { AnthropicAgentHarness } from "./anthropic";
export type { AnthropicAgentConfig } from "./anthropic/types";

export {
  createOpenRouterClient,
  configureOpenRouter,
  generateWithQwen,
  defaultHadesModel,
  OPENROUTER_BASE_URL,
} from "./openrouter";
export type { OpenRouterConfig, OpenRouterChatInput } from "./openrouter";

export { transcribeAudio, synthesizeSpeech, voiceIntentHint } from "./voice";
export type { VoiceConfig } from "./voice";

export {
  createProviderManager,
} from "./manager";
export type {
  ProviderManager,
  ProviderManagerConfig,
  ProviderConfig,
  ProviderStats,
  ProviderStrategy,
  SelectedProvider,
} from "./manager";
