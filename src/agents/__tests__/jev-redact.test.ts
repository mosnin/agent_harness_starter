import { describe, it, expect, beforeEach } from "vitest";
import { z } from "zod";
import {
  createJevAsker,
  createMockJevClient,
  resetJevCircuit,
  harvestToolEvidence,
  mergeEvidence,
  redactSecrets,
  redactValue,
  createRedactStream,
  applyCompaction,
  formatCompactThread,
  abstainReply,
} from "../jev/index";
import { withJev } from "../plugins/jev";
import type { JevAnswer } from "../jev/types";
import type { PluginRunContext } from "../types";

const OPENAI_KEY = "sk-abcdefghijklmnopqrstuvwxyz0123456789";
const GITHUB_KEY = "ghp_abcdefghijklmnopqrstuvwxyz0123456789abcd";

function noulAns(value: number): JevAnswer {
  return { type: "noul", noul: value };
}

function ctx(): PluginRunContext {
  return {
    runId: "r1",
    agentName: "Hades",
    model: "qwen/qwen-2.5-72b-instruct",
    startedAt: Date.now(),
    context: {},
  };
}

function plugin() {
  const client = createMockJevClient((req) => {
    const answers: Record<string, JevAnswer> = {};
    for (const id of Object.keys(req.questions)) answers[id] = noulAns(0.04);
    return { model: "jev-latest", answers };
  });
  return withJev({
    asker: createJevAsker(client),
    screenInput: false,
    screenOutput: false,
    routeModel: false,
    autoMode: false,
    judgePatch: false,
    companyOs: false,
    scanMalicious: false,
    rerankSearch: false,
    stopHook: false,
    compact: false,
    scoreQuality: false,
    decideCompletion: false,
    heedPolicy: false,
    verifyCitations: false,
  });
}

describe("zero-RTT secret redaction", () => {
  beforeEach(() => {
    resetJevCircuit();
  });

  it("replaces API keys, github tokens, and connection strings", () => {
    const leaked = `token ${OPENAI_KEY} gh ${GITHUB_KEY} db postgres://u:hunter2@db.internal/app`;
    const { text, redacted } = redactSecrets(leaked);
    expect(redacted).toBe(true);
    expect(text).not.toContain(OPENAI_KEY);
    expect(text).not.toContain(GITHUB_KEY);
    expect(text).not.toContain("hunter2");
    expect(text).toContain("[API_KEY]");
    expect(text).toContain("[CONNECTION_STRING]");
  });

  it("walks nested tool payloads", () => {
    const cleaned = redactValue({
      stdout: `export KEY=${OPENAI_KEY}`,
      nested: { email: "ada@example.com" },
    }) as { stdout: string; nested: { email: string } };
    expect(cleaned.stdout).not.toContain(OPENAI_KEY);
    expect(cleaned.nested.email).toBe("[EMAIL]");
  });

  it("harvests a redacted evidence card", () => {
    const card = harvestToolEvidence("file_read", { content: `OPENAI_API_KEY=${OPENAI_KEY}` });
    expect(card).toContain("file_read");
    expect(card).not.toContain(OPENAI_KEY);
    expect(card).toContain("[API_KEY]");
  });

  it("mergeEvidence redacts both sides", () => {
    const merged = mergeEvidence(`prior ${OPENAI_KEY}`, `next ${GITHUB_KEY}`);
    expect(merged).not.toContain(OPENAI_KEY);
    expect(merged).not.toContain(GITHUB_KEY);
  });

  it("does not echo secrets in an abstain or compacted thread", () => {
    expect(abstainReply(`Invoice paid with ${OPENAI_KEY}`)).not.toContain(OPENAI_KEY);
    const thread = applyCompaction(
      [
        { role: "user", content: `key ${OPENAI_KEY}` },
        { role: "assistant", content: "ok" },
      ],
      "keep"
    );
    expect(thread[0]?.content).not.toContain(OPENAI_KEY);
    expect(formatCompactThread(thread)).not.toContain(OPENAI_KEY);
  });

  it("holds a split key across stream chunks", () => {
    const stream = createRedactStream();
    const first = stream.push(OPENAI_KEY.slice(0, 12));
    const rest = stream.push(OPENAI_KEY.slice(12)) + stream.flush();
    expect(`${first}${rest}`).not.toContain(OPENAI_KEY);
    expect(`${first}${rest}`).toContain("[API_KEY]");
  });

  it("withJev redacts tool output before it reaches Qwen or jevEvidence", async () => {
    const jev = plugin();
    const runCtx = ctx();
    const wrapped = await jev.wrapTools!(
      [
        {
          name: "file_read",
          description: "Read a file",
          parameters: z.object({ path: z.string() }),
          execute: async () => ({ content: `secret ${OPENAI_KEY}` }),
        },
      ],
      runCtx,
      new Map()
    );
    const output = (await wrapped[0]!.execute({ path: ".env" }, {})) as { content: string };
    expect(output.content).not.toContain(OPENAI_KEY);
    expect(output.content).toContain("[API_KEY]");
    expect(String(runCtx.context.jevEvidence)).not.toContain(OPENAI_KEY);
  });

  it("withJev redacts streamed deltas and instruction extras", async () => {
    const jev = plugin();
    const runCtx = ctx();
    runCtx.context.jevEvidence = `leaked ${OPENAI_KEY}`;
    const extras = jev.onResolveInstructions!("Base.", "hi", runCtx);
    expect(extras).not.toContain(OPENAI_KEY);
    expect(extras).toContain("[API_KEY]");

    const delta = await jev.onEvent?.({ type: "message_delta", delta: `use ${OPENAI_KEY}` }, runCtx);
    expect(delta && delta.type === "message_delta" ? delta.delta : "").not.toContain(OPENAI_KEY);

    const after = await jev.onAfterRun!(`Here is ${OPENAI_KEY}`, runCtx);
    expect(after).not.toContain(OPENAI_KEY);

    const toolOut = await jev.onEvent?.(
      { type: "tool_result", name: "file_read", output: { content: OPENAI_KEY }, callId: "c1" },
      runCtx
    );
    expect(JSON.stringify(toolOut)).not.toContain(OPENAI_KEY);
  });
});
