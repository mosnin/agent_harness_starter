import { describe, expect, it } from "vitest";
import { HttpModelClient } from "../models/client";
const event = (value: unknown) => `data: ${JSON.stringify(value)}\r\n\r\n`;
function fixture(
  kind: "openai" | "anthropic",
  source: string,
  capture?: (body: any) => void,
) {
  return new HttpModelClient(
    {
      name: kind,
      kind,
      baseUrl: "https://example.invalid",
      models: ["gpt-4o-mini"],
    },
    {
      fetchImpl: (async (_url, init) => {
        capture?.(JSON.parse(String(init?.body)));
        const bytes = new TextEncoder().encode(source);
        return new Response(
          new ReadableStream({
            start(controller) {
              // Deliberately split UTF-8 and SSE frames at every byte.
              for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
              controller.close();
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }) as typeof fetch,
    },
  );
}
describe("streaming model transport", () => {
  it.each(["openai", "anthropic"] as const)("preserves %s length stop reasons", async kind => {
    const ending = kind === "openai" ? event({ choices: [{ delta: {}, finish_reason: "length" }] }) : event({ type: "message_delta", delta: { stop_reason: "max_tokens" } }) + event({ type: "message_stop" });
    const reply = await fixture(kind, ending + "data: [DONE]\n\n").chat({ model: "gpt-4o-mini", messages: [], onText: () => {} });
    expect(reply.finishReason).toBe(kind === "openai" ? "length" : "max_tokens");
  });
  it("decodes split UTF-8 and measures OpenAI usage", async () => {
    const chunks: string[] = [];
    const client = fixture(
      "openai",
      event({ choices: [{ delta: { content: "Hello ✳" } }] }) +
        event({
          choices: [],
          usage: { prompt_tokens: 8, completion_tokens: 4 },
        }) +
        "data: [DONE]\n\n",
    );
    const reply = await client.chat({
      model: "gpt-4o-mini",
      messages: [],
      onText: (c) => chunks.push(c),
    });
    expect(chunks.join("")).toBe("Hello ✳");
    expect(reply).toMatchObject({
      text: "Hello ✳",
      tokensIn: 8,
      tokensOut: 4,
      costMeasured: true,
    });
  });
  it("combines Anthropic usage events and encodes image attachments", async () => {
    let body: any;
    const client = fixture(
      "anthropic",
      event({
        type: "message_start",
        message: { usage: { input_tokens: 12, output_tokens: 0 } },
      }) +
        event({
          type: "content_block_delta",
          delta: { text: "Image received" },
        }) +
        event({ type: "message_delta", usage: { output_tokens: 3 } }) +
        event({ type: "message_stop" }),
      (value) => (body = value),
    );
    const reply = await client.chat({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "user",
          content: "Look",
          images: ["data:image/png;base64,aGVsbG8="],
        },
      ],
      onText: () => {},
    });
    expect(reply).toMatchObject({
      tokensIn: 12,
      tokensOut: 3,
      text: "Image received",
    });
    expect(body.messages[0].content[1]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" },
    });
  });
  it("rejects truncated replies instead of saving partial success", async () => {
    await expect(
      fixture(
        "openai",
        event({ choices: [{ delta: { content: "partial" } }] }),
      ).chat({ model: "gpt-4o-mini", messages: [], onText: () => {} }),
    ).rejects.toThrow("before completion");
  });
  it("surfaces provider errors mid-stream", async () => {
    await expect(
      fixture("openai", event({ error: { message: "quota reached" } })).chat({
        model: "gpt-4o-mini",
        messages: [],
        onText: () => {},
      }),
    ).rejects.toThrow("quota reached");
  });
  it("cancels a pending read promptly", async () => {
    const controller = new AbortController();
    let cancelled = false;
    const client = new HttpModelClient(
      {
        name: "local",
        kind: "openai",
        baseUrl: "https://example.invalid",
        models: ["m"],
      },
      {
        fetchImpl: (async () =>
          new Response(
            new ReadableStream({
              cancel() {
                cancelled = true;
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          )) as typeof fetch,
      },
    );
    const pending = client.chat({
      model: "m",
      messages: [],
      signal: controller.signal,
      onText: () => {},
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(cancelled).toBe(true);
  });
});
