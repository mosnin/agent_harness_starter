import { describe, it, expect, vi } from "vitest";
import { createJevAsker, createMockJevClient } from "../jev/client";
import {
  assessDesktopAction,
  isDesktopWrite,
  shouldExecuteDesktop,
} from "../jev/desktop";
import {
  createDesktopHost,
  decodeDesktopCommand,
  encodeDesktopMessage,
  detectDesktopInference,
  runDesktopSidecar,
  type CapRunner,
} from "../hades/desktop/index";
import type { HadesHarness } from "../hades/index";
import type { JevAnswer } from "../jev/types";
import { Readable, Writable } from "node:stream";

function noulAns(value: number): JevAnswer {
  return { type: "noul", noul: value };
}

function choiceAns(id: string, keys: string[], confidence = 0.92): JevAnswer {
  const probabilities = Object.fromEntries(
    keys.map((k) => [k, k === id ? 0.9 : 0.1 / Math.max(1, keys.length - 1)])
  );
  const sum = Object.values(probabilities).reduce((a, b) => a + b, 0);
  for (const k of Object.keys(probabilities)) {
    probabilities[k] = (probabilities[k] ?? 0) / sum;
  }
  return { type: "choice", choice: id, probabilities, confidence };
}

function stubHarness(overrides: Partial<HadesHarness> = {}): HadesHarness {
  return {
    async *stream() {
      yield { type: "jev_decision", node: "model_router", decision: "balanced", reason: "jev", action: "auto" as const };
      yield { type: "message_delta", delta: "Hello" };
      yield { type: "done", finalOutput: "Hello" };
    },
    async run() {
      return { finalOutput: "Hello", messages: [], toolCalls: [] };
    },
    async route() {
      return {
        action: "auto",
        value: "balanced",
        reason: "test",
        node: "model_router",
        model: "qwen/qwen-2.5-72b-instruct",
        tier: "balanced",
      };
    },
    async voiceTurn() {
      return { finalOutput: "Okay", messages: [], toolCalls: [], transcript: "hi" };
    },
    ...overrides,
  };
}

describe("desktop inference + wire", () => {
  it("detects the Hades brain only when Jev and Qwen keys exist", () => {
    expect(detectDesktopInference({}).kind).toBe("mock");
    expect(
      detectDesktopInference({
        TYPESAFE_API_KEY: "t",
        OPENROUTER_API_KEY: "o",
        OPENAI_API_KEY: "v",
      }).detail
    ).toBe("jev+qwen+voice");
  });

  it("round-trips commands and events", () => {
    const line = encodeDesktopMessage({ type: "desktop.act", action: "targets" });
    expect(decodeDesktopCommand(line.trim()).type).toBe("desktop.act");
  });
});

describe("desktop Jev policy", () => {
  it("allows read-only inspect without calling Jev", async () => {
    const client = createMockJevClient(async () => {
      throw new Error("should not be asked");
    });
    const decision = await assessDesktopAction({
      action: "targets",
      asker: createJevAsker(client),
    });
    expect(decision.action).toBe("auto");
    expect(decision.reason).toBe("desktop-read");
  });

  it("blocks writes when Jev is down", async () => {
    const client = createMockJevClient(async () => {
      throw new Error("network");
    });
    const decision = await assessDesktopAction({
      action: "record_start",
      args: { screen: "1" },
      asker: createJevAsker(client),
    });
    expect(decision.action).toBe("block");
    expect(decision.reason).toBe("jev-unavailable");
    expect(shouldExecuteDesktop(decision)).toBe(false);
  });

  it("blocks a capture that looks like it would leak the screen", async () => {
    const client = createMockJevClient((req) => {
      const answers: Record<string, JevAnswer> = {};
      for (const [id, q] of Object.entries(req.questions)) {
        if (q.type === "choice") {
          answers[id] = choiceAns("allow", Object.keys(q.criteria));
        } else {
          answers[id] = noulAns(id === "leaks_screen" ? 0.92 : 0.1);
        }
      }
      return { model: "jev-latest", answers };
    });
    const decision = await assessDesktopAction({
      action: "export",
      asker: createJevAsker(client),
    });
    expect(decision.action).toBe("block");
    expect(decision.reason).toBe("desktop-screen-secrets");
  });

  it("executes only on auto/allow", () => {
    expect(shouldExecuteDesktop({ action: "auto", value: "allow" })).toBe(true);
    expect(shouldExecuteDesktop({ action: "review", value: "allow" })).toBe(false);
    expect(shouldExecuteDesktop({ action: "block", value: "block" })).toBe(false);
    expect(isDesktopWrite("record_start")).toBe(true);
  });
});

describe("desktop host", () => {
  it("does not spawn cap when Jev blocks a write", async () => {
    const run = vi.fn();
    const cap: CapRunner = { run };
    const events: string[] = [];
    const host = createDesktopHost({
      harness: stubHarness(),
      cap,
      asker: createJevAsker(
        createMockJevClient(async () => {
          throw new Error("down");
        })
      ),
      onEvent: (event) => events.push(event.type),
    });
    await host.handle({ type: "desktop.act", action: "record_start", args: { screen: "1" } });
    expect(run).not.toHaveBeenCalled();
    expect(events).toContain("jev.decision");
    expect(events).toContain("desktop.result");
  });

  it("runs a read-only Cap action after Jev allows it", async () => {
    const cap: CapRunner = {
      async run(action) {
        return { action, screens: ["built-in"] };
      },
    };
    const outputs: unknown[] = [];
    const host = createDesktopHost({
      harness: stubHarness(),
      cap,
      onEvent: (event) => {
        if (event.type === "desktop.result") outputs.push(event);
      },
    });
    await host.handle({ type: "desktop.act", action: "targets" });
    expect(outputs).toEqual([
      { type: "desktop.result", action: "targets", ok: true, output: { action: "targets", screens: ["built-in"] } },
    ]);
  });

  it("forwards Jev decisions from a chat turn onto the IPC stream", async () => {
    const events: string[] = [];
    const host = createDesktopHost({
      harness: stubHarness(),
      onEvent: (event) => events.push(event.type),
    });
    await host.handle({ type: "chat.send", text: "summarize the last take" });
    expect(events).toEqual(["jev.decision", "message.delta", "run.done"]);
  });

  it("announces inference on runtime.start", async () => {
    const events: Array<{ type: string }> = [];
    const host = createDesktopHost({
      harness: stubHarness(),
      onEvent: (event) => events.push(event),
    });
    await host.handle({ type: "runtime.start" });
    expect(events[0]).toMatchObject({ type: "runtime.ready" });
    expect(events.some((event) => event.type === "jev.timing")).toBe(true);
  });

  it("prefetches a turn so the next send can reuse Jev answers", async () => {
    let calls = 0;
    const client = createMockJevClient((req) => {
      calls += 1;
      const answers: Record<string, JevAnswer> = {};
      for (const id of Object.keys(req.questions)) answers[id] = noulAns(0.05);
      return { model: "jev-latest", answers };
    });
    const events: Array<{ type: string; cached?: boolean }> = [];
    const host = createDesktopHost({
      harness: stubHarness(),
      asker: createJevAsker(client),
      onEvent: (event) => events.push(event),
    });
    await host.handle({ type: "chat.prefetch", text: "Trim silence on the last take." });
    await host.handle({ type: "chat.prefetch", text: "Trim silence on the last take." });
    expect(calls).toBe(1);
    const prefetch = events.filter((event) => event.type === "jev.prefetch");
    expect(prefetch).toHaveLength(2);
    expect(prefetch[1]?.cached).toBe(true);
  });
});

describe("desktop sidecar", () => {
  it("reads a command line and writes events", async () => {
    const input = Readable.from([`${JSON.stringify({ type: "runtime.start" })}\n`]);
    let written = "";
    const output = new Writable({
      write(chunk, _enc, cb) {
        written += String(chunk);
        cb();
      },
    });
    await runDesktopSidecar({
      input,
      output,
      harness: stubHarness(),
    });
    expect(written).toContain("runtime.ready");
  });
});
