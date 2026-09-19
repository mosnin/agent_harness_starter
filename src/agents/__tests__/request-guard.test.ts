import { describe, it, expect } from "vitest";
import { defineSkill } from "../skills/index";
import {
  allowedToolNames,
  clampRequestedTools,
  mcpAnonymousAllowed,
  oversizeJsonResponse,
  readCappedJson,
  readCappedRequest,
  capListedThreads,
  capListedMessages,
  MAX_JSON_BODY_BYTES,
  MAX_LIST_THREADS,
  MAX_LIST_MESSAGES,
} from "../lib/request-guard";

defineSkill({
  name: "request-guard-research",
  description: "test skill",
  tools: ["web_search", "browser_scrape"],
});

describe("request-guard", () => {
  it("drops client tool names that are not on the agent", () => {
    const tools = clampRequestedTools(["web_search"], ["shell_exec", "deploy_prod"], []);
    expect(tools).toEqual(["web_search"]);
  });

  it("keeps a requested tool that the agent's skill already has", () => {
    const tools = clampRequestedTools(undefined, ["web_search", "shell_exec"], ["request-guard-research"]);
    expect(tools).toEqual(["web_search"]);
    expect(allowedToolNames(undefined, ["request-guard-research"]).has("browser_scrape")).toBe(true);
  });

  it("leaves the configured list alone when the client sends nothing", () => {
    expect(clampRequestedTools(["file_read"], undefined)).toEqual(["file_read"]);
  });

  it("rejects an oversized Content-Length before JSON parse", () => {
    const res = oversizeJsonResponse(
      new Request("http://local/api/hades", {
        method: "POST",
        headers: { "content-length": String(MAX_JSON_BODY_BYTES + 1) },
        body: "{}",
      })
    );
    expect(res?.status).toBe(413);
  });

  it("rejects an oversized voice body before form parse", () => {
    const max = 8 * 1024 * 1024 + 64 * 1024;
    const res = oversizeJsonResponse(
      new Request("http://local/api/voice", {
        method: "POST",
        headers: { "content-length": String(max + 1) },
        body: "x",
      }),
      max
    );
    expect(res?.status).toBe(413);
  });

  it("does not reject a missing Content-Length", () => {
    const res = oversizeJsonResponse(new Request("http://local/api/hades", { method: "POST", body: "{}" }));
    expect(res).toBeNull();
  });

  it("parses a small JSON body", async () => {
    const parsed = await readCappedJson(
      new Request("http://local/api/hades", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "hi" }),
      })
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value).toEqual({ message: "hi" });
  });

  it("rejects a streamed body larger than the cap without Content-Length", async () => {
    const bytes = new TextEncoder().encode("x".repeat(MAX_JSON_BODY_BYTES + 8));
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
    const parsed = await readCappedJson(
      new Request("http://local/api/hades", {
        method: "POST",
        body,
        duplex: "half",
      } as RequestInit)
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.response.status).toBe(413);
  });

  it("rebuilds a Request after a capped read so multipart can parse", async () => {
    const rebuilt = await readCappedRequest(
      new Request("http://local/api/voice", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "audio-bytes",
      })
    );
    expect(rebuilt).toBeInstanceOf(Request);
    if (rebuilt instanceof Request) {
      expect(await rebuilt.text()).toBe("audio-bytes");
    }
  });

  it("rejects invalid JSON after a capped read", async () => {
    const parsed = await readCappedJson(
      new Request("http://local/api/hades", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not-json",
      })
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.response.status).toBe(400);
  });

  it("caps an unbounded thread list", () => {
    const threads = Array.from({ length: MAX_LIST_THREADS + 20 }, (_, i) => ({ id: String(i) }));
    expect(capListedThreads(threads)).toHaveLength(MAX_LIST_THREADS);
    expect(capListedThreads(threads.slice(0, 3))).toHaveLength(3);
  });

  it("keeps the chronological tail of an unbounded message list", () => {
    const rows = Array.from({ length: MAX_LIST_MESSAGES + 7 }, (_, i) => ({ id: String(i) }));
    const capped = capListedMessages(rows);
    expect(capped).toHaveLength(MAX_LIST_MESSAGES);
    expect(capped[0]?.id).toBe("7");
    expect(capped.at(-1)?.id).toBe(String(MAX_LIST_MESSAGES + 6));
  });

  it("requires MCP auth unless HADES_MCP_ANON is set", () => {
    expect(mcpAnonymousAllowed({})).toBe(false);
    expect(mcpAnonymousAllowed({ HADES_MCP_ANON: "true" })).toBe(true);
    expect(mcpAnonymousAllowed({ HADES_MCP_ANON: "false" })).toBe(false);
  });
});
