import { describe, it, expect } from "vitest";
import {
  appendHarnessTurn,
  isThreadOwner,
  messagesForHarness,
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
});
