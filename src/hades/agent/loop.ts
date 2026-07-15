/* ------------------------------------------------------------------ *
 * A real ReAct-style tool-calling loop — the control flow that turns a
 * ModelClient into an agent that can *act*.
 *
 * The loop drives an injected `ModelClient`, exposes a text-only tool
 * protocol the model speaks, executes the tools the model asks for, and
 * feeds their results back as observations until the model produces a
 * final answer (or a hard step cap is hit). Everything is deterministic
 * given a deterministic client and registry: no Math.random, no clock,
 * no network, no fs. It is fully testable with a scripted fake client.
 *
 * Protocol (see `buildSystemPrompt`): on each turn the model must reply
 * with EITHER a tool call —
 *
 *     TOOL: <name>
 *     INPUT: <input, may span to end of message>
 *
 * — OR a final answer —
 *
 *     ANSWER: <text, may span to end of message>
 *
 * Parsing is tolerant: tags are matched case-insensitively anywhere in
 * the reply, surrounding prose and markdown code fences are ignored, and
 * a reply that matches neither shape is treated as a direct answer (a
 * model that just answers in prose still works).
 * ------------------------------------------------------------------ */

import type { ModelClient, ChatMessage } from "../models/client";
import type { ToolRegistry, ToolCall } from "./tools";

export interface AgentLoopOptions {
  model: string;
  /** Hard cap on model turns; default 6. The loop ALWAYS terminates. */
  maxSteps?: number;
  /** Extra system guidance appended after the always-injected protocol. */
  system?: string;
  temperature?: number;
}

export interface AgentLoopResult {
  answer: string;
  /** Number of model turns (calls to `client.chat`) taken. */
  steps: number;
  toolCalls: Array<{ call: ToolCall; result: string }>;
  tokensIn: number;
  tokensOut: number;
  usd: number;
  /** system + user task + every assistant/observation turn. */
  transcript: ChatMessage[];
  /** True iff the loop stopped on `maxSteps` without a final answer. */
  hitStepLimit: boolean;
}

const DEFAULT_MAX_STEPS = 6;

type ParsedReply =
  | { kind: "answer"; answer: string }
  | { kind: "tool"; call: ToolCall }
  | { kind: "malformed" };

export class AgentLoop {
  private readonly client: ModelClient;
  private readonly tools: ToolRegistry;
  private readonly opts: AgentLoopOptions;
  private readonly maxSteps: number;

  constructor(client: ModelClient, tools: ToolRegistry, opts: AgentLoopOptions) {
    this.client = client;
    this.tools = tools;
    this.opts = opts;
    const cap = opts.maxSteps ?? DEFAULT_MAX_STEPS;
    // A non-positive cap would never run; clamp to at least one turn.
    this.maxSteps = cap > 0 ? Math.floor(cap) : 1;
  }

  async run(task: string): Promise<AgentLoopResult> {
    const messages: ChatMessage[] = [
      { role: "system", content: this.buildSystemPrompt() },
      { role: "user", content: task },
    ];

    const toolCalls: Array<{ call: ToolCall; result: string }> = [];
    let steps = 0;
    let tokensIn = 0;
    let tokensOut = 0;
    let usd = 0;
    let lastText = "";

    while (steps < this.maxSteps) {
      let reply: string;
      try {
        const res = await this.client.chat({
          model: this.opts.model,
          messages,
          temperature: this.opts.temperature,
        });
        reply = res.text ?? "";
        tokensIn += res.tokensIn ?? 0;
        tokensOut += res.tokensOut ?? 0;
        usd += res.usd ?? 0;
      } catch {
        // The loop must never throw. An infrastructure failure ends the
        // run with the best-effort answer collected so far.
        break;
      }

      steps++;
      lastText = reply;
      // The raw model turn is always part of the transcript.
      messages.push({ role: "assistant", content: reply });

      const parsed = parseReply(reply);

      if (parsed.kind === "answer") {
        return {
          answer: parsed.answer,
          steps,
          toolCalls,
          tokensIn,
          tokensOut,
          usd,
          transcript: messages,
          hitStepLimit: false,
        };
      }

      if (parsed.kind === "tool") {
        // `tools.run` is total — it never throws — so a bad tool becomes
        // a TOOL_ERROR observation the model can react to on the next turn.
        const result = await this.tools.run(parsed.call);
        toolCalls.push({ call: parsed.call, result: result.output });
        const observation = result.ok
          ? `TOOL_RESULT: ${result.output}`
          : `TOOL_ERROR: ${result.output}`;
        messages.push({ role: "user", content: observation });
        continue;
      }

      // Malformed: no ANSWER and no complete TOOL/INPUT pair. Be lenient —
      // treat the whole reply as the final answer and stop.
      return {
        answer: stripFences(reply),
        steps,
        toolCalls,
        tokensIn,
        tokensOut,
        usd,
        transcript: messages,
        hitStepLimit: false,
      };
    }

    // Fell out of the loop on the step cap while still tool-calling.
    return {
      answer: stripFences(lastText),
      steps,
      toolCalls,
      tokensIn,
      tokensOut,
      usd,
      transcript: messages,
      hitStepLimit: true,
    };
  }

  private buildSystemPrompt(): string {
    const toolLines = this.tools
      .list()
      .map((t) => `- ${t.name}: ${t.description}`)
      .join("\n");

    const protocol = [
      "You are a tool-using agent. Work step by step toward the user's task.",
      "",
      "You may use these tools:",
      toolLines || "- (no tools available)",
      "",
      "On every turn reply in EXACTLY ONE of two forms.",
      "",
      "To call a tool, use two lines:",
      "TOOL: <tool name>",
      "INPUT: <the tool input; may span multiple lines to the end of the message>",
      "",
      "To give your final answer, use one line (which may span to the end):",
      "ANSWER: <your final answer>",
      "",
      "Rules:",
      "- Call one tool per turn. The tool's result comes back as a following",
      "  message beginning with TOOL_RESULT: (or TOOL_ERROR: on failure).",
      "- Use tool results to decide your next step; when you are done, reply",
      "  with ANSWER:.",
      "- Do not wrap tags in markdown; the tags are matched case-insensitively.",
    ].join("\n");

    const extra = this.opts.system?.trim();
    return extra ? `${protocol}\n\n${extra}` : protocol;
  }
}

/* ------------------------------------------------------------------ *
 * Tolerant reply parsing
 * ------------------------------------------------------------------ */

const ANSWER_RE = /ANSWER:\s*([\s\S]*)$/i;
const TOOL_RE = /TOOL:[ \t]*([^\n\r]*)/i;
const INPUT_RE = /INPUT:\s*([\s\S]*)$/i;

function parseReply(reply: string): ParsedReply {
  // ANSWER takes precedence: a reply that declares a final answer ends the run.
  const answerMatch = reply.match(ANSWER_RE);
  if (answerMatch) {
    return { kind: "answer", answer: stripFences(answerMatch[1] ?? "") };
  }

  const toolMatch = reply.match(TOOL_RE);
  const inputMatch = reply.match(INPUT_RE);
  if (toolMatch && inputMatch) {
    // Tool names are identifiers: take the first whitespace-delimited token,
    // stripped of stray backticks, so "`calc` (the calculator)" -> "calc".
    const rawName = (toolMatch[1] ?? "").trim();
    const name = (rawName.split(/\s+/)[0] ?? "").replace(/`/g, "").trim();
    const input = stripFences(inputMatch[1] ?? "");
    if (name) {
      return { kind: "tool", call: { tool: name, input } };
    }
  }

  return { kind: "malformed" };
}

/**
 * Strip surrounding markdown code fences and trim. A leading ```` ```lang ````
 * line and a trailing ```` ``` ```` line are removed if present; otherwise the
 * value is just trimmed. Deterministic and total.
 */
function stripFences(value: string): string {
  let t = value.trim();
  t = t.replace(/^```[^\n]*\n?/, "");
  t = t.replace(/\n?```$/, "");
  return t.trim();
}
