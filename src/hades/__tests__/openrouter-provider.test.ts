import { describe, expect, it } from "vitest";
import { resolveModel } from "../runtime/model";
describe("OpenRouter provider routing and accounting", () => {
  it("uses only its own key and endpoint and records the provider's reported streamed cost", async () => {
    let request: { url: string; headers: any; body: any } | undefined;
    const model = resolveModel({ HADES_PROVIDER: "openrouter", OPENROUTER_API_KEY: "router-key", OPENAI_API_KEY: "wrong-openai", ANTHROPIC_API_KEY: "wrong-anthropic", HADES_BASE_URL: "https://wrong.example" }, { fetchImpl: (async (url, init) => {
      request = { url: String(url), headers: init?.headers, body: JSON.parse(String(init?.body)) };
      return new Response('data: {"choices":[{"delta":{"content":"hello"}}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":8,"completion_tokens":2,"cost":0.00123}}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch });
    const result = await model.client.chat({ model: model.model, messages: [], onText: () => {} });
    expect(request?.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(new Headers(request?.headers).get("authorization")).toBe("Bearer router-key");
    expect(request?.body.model).toBe("openrouter/auto");
    expect(result).toMatchObject({ text: "hello", usd: 0.00123, costMeasured: true, provider: "openrouter" });
  });
  it("does not borrow another provider's key and keeps missing cost unmeasured", async () => {
    expect(() => resolveModel({ HADES_PROVIDER: "openrouter", OPENAI_API_KEY: "wrong" })).toThrow("OPENROUTER_API_KEY");
    const model = resolveModel({ HADES_PROVIDER: "openrouter", OPENROUTER_API_KEY: "key" }, { fetchImpl: (async () => new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 2, completion_tokens: 1 } }))) as typeof fetch });
    expect(await model.client.chat({ model: model.model, messages: [] })).toMatchObject({ text: "ok", costMeasured: false });
  });
});
