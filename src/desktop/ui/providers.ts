export const providers = {
  codex: { label: "ChatGPT subscription", model: "gpt-5.6-sol", url: "https://chatgpt.com", key: false },
  openrouter: { label: "OpenRouter", model: "openrouter/auto", url: "https://openrouter.ai/api/v1", key: true },
  openai: { label: "OpenAI API", model: "gpt-4o-mini", url: "https://api.openai.com/v1", key: true },
  anthropic: { label: "Anthropic", model: "claude-sonnet-4-6", url: "https://api.anthropic.com", key: true },
  local: { label: "Local / compatible API", model: "qwen3.5:latest", url: "http://127.0.0.1:11434/v1", key: true },
} as const;
