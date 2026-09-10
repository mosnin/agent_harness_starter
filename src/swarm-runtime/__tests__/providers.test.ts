import { describe, it, expect } from "vitest";
import { createChat, PROVIDERS, providerKeyEnv } from "../worker/providers";

describe("provider directory", () => {
  it("maps known providers to base URLs and key envs", () => {
    expect(PROVIDERS.openai.style).toBe("openai");
    expect(PROVIDERS.anthropic.style).toBe("anthropic");
    expect(PROVIDERS.nous.baseUrl).toContain("nousresearch");
    expect(PROVIDERS.openrouter.baseUrl).toContain("openrouter");
    expect(providerKeyEnv("groq")).toBe("GROQ_API_KEY");
    expect(providerKeyEnv("local")).toBeUndefined();
  });

  it("throws on an unknown provider", () => {
    // @ts-expect-error intentional bad input
    expect(() => createChat({ provider: "nope", model: "x" })).toThrow();
  });
});

describe("Anthropic chat via createChat", () => {
  it("shapes the messages request and parses the response", async () => {
    let captured: { url: string; body: Record<string, unknown>; headers: Record<string, string> } | undefined;
    const fakeFetch = (async (url: string, init: RequestInit) => {
      captured = {
        url: String(url),
        body: JSON.parse(String(init.body)),
        headers: init.headers as Record<string, string>,
      };
      return {
        ok: true,
        status: 200,
        async json() {
          return { content: [{ type: "text", text: "Paris" }] };
        },
        async text() {
          return "";
        },
      } as Response;
    }) as unknown as typeof fetch;

    const chat = createChat({
      provider: "anthropic",
      model: "claude-x",
      apiKey: "sk-test",
      maxTokens: 256,
      fetchImpl: fakeFetch,
    });

    const out = await chat([
      { role: "system", content: "be terse" },
      { role: "user", content: "capital of France?" },
    ]);

    expect(out).toBe("Paris");
    expect(captured?.url).toContain("/v1/messages");
    expect(captured?.headers["x-api-key"]).toBe("sk-test");
    expect(captured?.headers["anthropic-version"]).toBe("2023-06-01");
    expect(captured?.body.system).toBe("be terse");
    expect(captured?.body.max_tokens).toBe(256);
    expect((captured?.body.messages as unknown[]).length).toBe(1); // system extracted out
  });
});
