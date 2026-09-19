import { describe, it, expect } from "vitest";
import { defineSkill } from "../skills/index";
import {
  allowedToolNames,
  clampRequestedTools,
  mcpAnonymousAllowed,
  oversizeJsonResponse,
  MAX_JSON_BODY_BYTES,
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

  it("does not reject a missing Content-Length", () => {
    const res = oversizeJsonResponse(new Request("http://local/api/hades", { method: "POST", body: "{}" }));
    expect(res).toBeNull();
  });

  it("requires MCP auth unless HADES_MCP_ANON is set", () => {
    expect(mcpAnonymousAllowed({})).toBe(false);
    expect(mcpAnonymousAllowed({ HADES_MCP_ANON: "true" })).toBe(true);
    expect(mcpAnonymousAllowed({ HADES_MCP_ANON: "false" })).toBe(false);
  });
});
