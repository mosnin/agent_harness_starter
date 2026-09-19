import { describe, it, expect } from "vitest";
import {
  appendHarnessTurn,
  isThreadOwner,
  messagesForHarness,
  toAgentInput,
} from "../lib/thread-history";

const KEY = "sk-abcdefghijklmnopqrstuvwxyz0123456789";

describe("thread history for the harness", () => {
  it("rejects threads the caller does not own", () => {
    expect(isThreadOwner(null, "u1")).toBe(false);
    expect(isThreadOwner({ userId: "u2" }, "u1")).toBe(false);
    expect(isThreadOwner({ userId: "u1" }, "u1")).toBe(true);
  });

  it("keeps the tail, drops tool roles, and redacts secrets", () => {
    const rows = [
      { role: "system", content: "sys" },
      { role: "tool", content: "stdout" },
      ...Array.from({ length: 42 }, (_, i) => ({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `turn ${i}`,
      })),
      { role: "user", content: `key ${KEY}` },
    ];
    const messages = messagesForHarness(rows);
    expect(messages.some((m) => m.content === "stdout")).toBe(false);
    expect(messages).toHaveLength(40);
    expect(messages.at(-1)?.content).not.toContain(KEY);
    expect(messages.at(0)?.content).toMatch(/turn|sys/);
  });

  it("appends a turn without growing past the cap", () => {
    const prior = messagesForHarness(
      Array.from({ length: 40 }, (_, i) => ({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `m${i}`,
      }))
    );
    const next = appendHarnessTurn(prior, { role: "user", content: "newest" });
    expect(next).toHaveLength(40);
    expect(next.at(-1)?.content).toBe("newest");
  });

  it("keeps a single-turn SDK input as a string", () => {
    expect(toAgentInput([{ role: "user", content: "hi" }], "hi")).toBe("hi");
  });

  it("passes prior turns as typed Agent items so Qwen sees the thread", () => {
    const input = toAgentInput(
      [
        { role: "user", content: "first" },
        { role: "assistant", content: "ok" },
        { role: "user", content: "second" },
      ],
      "second now"
    );
    expect(Array.isArray(input)).toBe(true);
    expect(input).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "first" }] },
      {
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "ok" }],
      },
      { type: "message", role: "user", content: [{ type: "input_text", text: "second now" }] },
    ]);
  });
});
