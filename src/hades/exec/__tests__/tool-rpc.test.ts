import { describe, it, expect } from "vitest";
import {
  createToolRpcBridge,
  validateToolRpcRequest,
  sha256Hex,
  type ToolRpcRequest,
  type ToolRpcResponse,
} from "../tool-rpc";
import { builtinRegistry, ToolRegistry, type Tool } from "../../agent/tools";

// ---------------------------------------------------------------------------
// Test fixtures: real tools with real, deliberately adversarial behavior,
// registered on top of the real builtin registry. Nothing here is a mock —
// each `run` genuinely throws/rejects/hangs/produces huge output.
// ---------------------------------------------------------------------------

const throwsTool: Tool = {
  name: "throws",
  description: "throws synchronously",
  run: () => {
    throw new Error("synchronous boom");
  },
};

const rejectsTool: Tool = {
  name: "rejects",
  description: "returns a rejected promise",
  run: async () => {
    throw new Error("async boom");
  },
};

const hangsTool: Tool = {
  name: "hangs",
  description: "never settles",
  run: () => new Promise(() => undefined),
};

const failTool: Tool = {
  name: "fail",
  description: "returns a controlled ok:false result",
  run: (input: string) => ({ ok: false, output: `deliberately failed: ${input}` }),
};

const echoTool: Tool = {
  name: "echo",
  description: "echoes input back",
  run: (input: string) => ({ ok: true, output: input }),
};

const bigOutputTool: Tool = {
  name: "big_output",
  description: "returns a multi-megabyte ascii string",
  run: (input: string) => ({ ok: true, output: "a".repeat(Number(input) || 3_000_000) }),
};

const unicodeBigTool: Tool = {
  name: "unicode_big",
  description: "returns a string of repeated 2-byte UTF-8 characters",
  run: (input: string) => ({ ok: true, output: "é".repeat(Number(input) || 50) }),
};

const delayTool: Tool = {
  name: "delay",
  description: "resolves after <input> ms with a value derived from input",
  run: (input: string) =>
    new Promise((resolve) => {
      setTimeout(() => resolve({ ok: true, output: `done:${input}` }), Number(input));
    }),
};

function testRegistry(): ToolRegistry {
  const registry = builtinRegistry();
  for (const t of [throwsTool, rejectsTool, hangsTool, failTool, echoTool, bigOutputTool, unicodeBigTool, delayTool]) {
    registry.register(t);
  }
  return registry;
}

// ---------------------------------------------------------------------------
// sha256Hex — known vectors, independently computed (via `sha256sum`), not
// just self-consistency against the module under test.
// ---------------------------------------------------------------------------

describe("sha256Hex", () => {
  it("matches the well-known NIST test vector for 'abc'", () => {
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("matches the empty-string vector", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("hashes unicode input byte-correctly (independently verified vector)", () => {
    expect(sha256Hex("héllo wörld 日本語 🚀")).toBe(
      "477af86c54bf4e2bdce082d719b17422680d5f42e70cfbceaaa26bcb1f934133",
    );
  });

  it("is deterministic and lowercase hex", () => {
    const h = sha256Hex("repeat me");
    expect(h).toBe(sha256Hex("repeat me"));
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// validateToolRpcRequest
// ---------------------------------------------------------------------------

describe("validateToolRpcRequest", () => {
  it("accepts a well-formed request, including negative and fractional ids", () => {
    expect(validateToolRpcRequest({ id: 1, tool: "calc", input: "1+1" })).toEqual({
      ok: true,
      req: { id: 1, tool: "calc", input: "1+1" },
    });
    expect(validateToolRpcRequest({ id: -5, tool: "calc", input: "1+1" }).ok).toBe(true);
    expect(validateToolRpcRequest({ id: 1.5, tool: "calc", input: "1+1" }).ok).toBe(true);
  });

  it("rejects non-object values", () => {
    for (const bad of [null, undefined, "string", 42, true, ["a"]]) {
      expect(validateToolRpcRequest(bad)).toEqual({ ok: false, error: "malformed_request" });
    }
  });

  it("rejects a non-numeric or non-finite id", () => {
    for (const bad of [{ tool: "calc", input: "1" }, { id: "1", tool: "calc", input: "1" }, {
      id: NaN,
      tool: "calc",
      input: "1",
    }, { id: Infinity, tool: "calc", input: "1" }]) {
      expect(validateToolRpcRequest(bad)).toEqual({ ok: false, error: "malformed_request" });
    }
  });

  it("rejects a non-string or empty tool name", () => {
    expect(validateToolRpcRequest({ id: 1, tool: 123, input: "1" })).toEqual({
      ok: false,
      error: "malformed_request",
    });
    expect(validateToolRpcRequest({ id: 1, tool: "", input: "1" })).toEqual({
      ok: false,
      error: "malformed_request",
    });
  });

  it("rejects a non-string input", () => {
    expect(validateToolRpcRequest({ id: 1, tool: "calc", input: 123 })).toEqual({
      ok: false,
      error: "malformed_request",
    });
    expect(validateToolRpcRequest({ id: 1, tool: "calc" })).toEqual({
      ok: false,
      error: "malformed_request",
    });
  });
});

// ---------------------------------------------------------------------------
// Basic dispatch happy path
// ---------------------------------------------------------------------------

describe("dispatch — happy path", () => {
  it("runs a real registry tool and returns its output", async () => {
    const bridge = createToolRpcBridge(testRegistry());
    const res = await bridge.dispatch({ id: 1, tool: "calc", input: "6*7" });
    expect(res).toMatchObject({ id: 1, ok: true, output: "42" });
    expect(res.error).toBeUndefined();
    expect(typeof res.elapsedMs).toBe("number");
    expect(res.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it("does not require unique ids across calls", async () => {
    const bridge = createToolRpcBridge(testRegistry());
    const r1 = await bridge.dispatch({ id: 7, tool: "calc", input: "1+1" });
    const r2 = await bridge.dispatch({ id: 7, tool: "calc", input: "2+2" });
    expect(r1).toMatchObject({ id: 7, ok: true, output: "2" });
    expect(r2).toMatchObject({ id: 7, ok: true, output: "4" });
    const events = bridge.events();
    expect(events).toHaveLength(2);
    expect(events[0].seq).toBe(1);
    expect(events[1].seq).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------

describe("dispatch — unknown_tool", () => {
  it("reports unknown_tool for a name absent from the registry", async () => {
    const bridge = createToolRpcBridge(testRegistry());
    const res = await bridge.dispatch({ id: 1, tool: "does_not_exist", input: "" });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("unknown_tool");
    expect(res.output).toContain("does_not_exist");
  });
});

describe("dispatch — not_allowed", () => {
  it("blocks a denied tool while leaving others reachable", async () => {
    const bridge = createToolRpcBridge(testRegistry(), { deny: ["uppercase"] });
    const blocked = await bridge.dispatch({ id: 1, tool: "uppercase", input: "hi" });
    expect(blocked.ok).toBe(false);
    expect(blocked.error).toBe("not_allowed");
    const allowed = await bridge.dispatch({ id: 2, tool: "calc", input: "1+1" });
    expect(allowed.ok).toBe(true);
  });

  it("restricts to the allow list when one is set", async () => {
    const bridge = createToolRpcBridge(testRegistry(), { allow: ["calc"] });
    const allowed = await bridge.dispatch({ id: 1, tool: "calc", input: "3+3" });
    expect(allowed.ok).toBe(true);
    const blocked = await bridge.dispatch({ id: 2, tool: "uppercase", input: "hi" });
    expect(blocked.ok).toBe(false);
    expect(blocked.error).toBe("not_allowed");
  });

  it("permits every registry tool when allow is undefined", async () => {
    const bridge = createToolRpcBridge(testRegistry());
    const validInputs: Record<string, string> = {
      calc: "1+1",
      uppercase: "hi",
      lowercase: "HI",
      word_count: "hi there",
    };
    for (const tool of Object.keys(validInputs)) {
      const res = await bridge.dispatch({ id: 1, tool, input: validInputs[tool] });
      expect(res.ok).toBe(true);
      expect(res.error).toBeUndefined();
    }
  });

  it("deny beats allow for a tool present in both lists", async () => {
    const bridge = createToolRpcBridge(testRegistry(), { allow: ["calc"], deny: ["calc"] });
    const res = await bridge.dispatch({ id: 1, tool: "calc", input: "1+1" });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("not_allowed");
  });
});

describe("dispatch — tool_error", () => {
  it("maps a synchronously throwing tool to tool_error", async () => {
    const bridge = createToolRpcBridge(testRegistry());
    const res = await bridge.dispatch({ id: 1, tool: "throws", input: "" });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("tool_error");
    expect(res.output).toContain("synchronous boom");
  });

  it("maps a rejecting tool to tool_error", async () => {
    const bridge = createToolRpcBridge(testRegistry());
    const res = await bridge.dispatch({ id: 1, tool: "rejects", input: "" });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("tool_error");
    expect(res.output).toContain("async boom");
  });

  it("maps a tool that itself returns ok:false to tool_error", async () => {
    const bridge = createToolRpcBridge(testRegistry());
    const res = await bridge.dispatch({ id: 1, tool: "fail", input: "x" });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("tool_error");
    expect(res.output).toBe("deliberately failed: x");
  });
});

describe("dispatch — timeout", () => {
  it("times out a tool that never settles via a real timer, while elapsedMs reflects the injected clock", async () => {
    const ticks = [5000, 5031];
    let i = 0;
    const now = () => ticks[i++] ?? 5031;
    const bridge = createToolRpcBridge(testRegistry(), { now, perCallTimeoutMs: 20 });

    const realStart = Date.now();
    const res = await bridge.dispatch({ id: 1, tool: "hangs", input: "" });
    const realElapsed = Date.now() - realStart;

    expect(res.ok).toBe(false);
    expect(res.error).toBe("timeout");
    expect(res.elapsedMs).toBe(31); // from the injected clock, not real wall time
    expect(realElapsed).toBeGreaterThanOrEqual(15); // the real 20ms timer genuinely fired

    const events = bridge.events();
    expect(events[0].error).toBe("timeout");
    expect(events[0].startedAt).toBe(5000);
    expect(events[0].elapsedMs).toBe(31);
  }, 2000);
});

describe("dispatch — output_truncated", () => {
  it("truncates a multi-megabyte ascii output to maxOutputBytes and hashes the truncated bytes", async () => {
    const bridge = createToolRpcBridge(testRegistry()); // default maxOutputBytes = 262144
    const res = await bridge.dispatch({ id: 1, tool: "big_output", input: "3000000" });
    expect(res.ok).toBe(true);
    expect(res.error).toBe("output_truncated");
    expect(Buffer.byteLength(res.output, "utf8")).toBe(262144);

    const events = bridge.events();
    expect(events[0].error).toBe("output_truncated");
    expect(events[0].ok).toBe(true);
    expect(events[0].outputSha256).toBe(sha256Hex(res.output));
    // Proves the FULL untruncated output is not what got hashed.
    expect(events[0].outputSha256).not.toBe(sha256Hex("a".repeat(3_000_000)));
  });

  it("truncates multi-byte UTF-8 output without throwing, even mid-character", async () => {
    const bridge = createToolRpcBridge(testRegistry(), { maxOutputBytes: 11 });
    const res = await bridge.dispatch({ id: 1, tool: "unicode_big", input: "50" });
    expect(res.ok).toBe(true);
    expect(res.error).toBe("output_truncated");
    expect(Buffer.byteLength(res.output, "utf8")).toBeLessThanOrEqual(11);
    const events = bridge.events();
    expect(events[0].outputSha256).toBe(sha256Hex(res.output));
  });

  it("does not truncate output exactly at the cap, but does one byte over", async () => {
    const bridge = createToolRpcBridge(testRegistry(), { maxOutputBytes: 100 });
    const exact = await bridge.dispatch({ id: 1, tool: "big_output", input: "100" });
    expect(exact.error).toBeUndefined();
    expect(exact.output).toHaveLength(100);

    const over = await bridge.dispatch({ id: 2, tool: "big_output", input: "101" });
    expect(over.error).toBe("output_truncated");
    expect(over.output).toHaveLength(100);
  });

  it("keeps tool_error precedence over output_truncated for an oversized failing output", async () => {
    const overshootTool: Tool = {
      name: "overshoot_fail",
      description: "fails with an oversized output",
      run: () => ({ ok: false, output: "x".repeat(500) }),
    };
    const registry = testRegistry();
    registry.register(overshootTool);
    const bridge = createToolRpcBridge(registry, { maxOutputBytes: 50 });
    const res = await bridge.dispatch({ id: 1, tool: "overshoot_fail", input: "" });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("tool_error");
    expect(res.output).toHaveLength(50);
  });
});

// ---------------------------------------------------------------------------
// Call budget
// ---------------------------------------------------------------------------

describe("dispatch — call_budget_exceeded", () => {
  it("exhausts at exactly maxCalls and rejects the next attempt", async () => {
    const bridge = createToolRpcBridge(testRegistry(), { maxCalls: 3 });
    for (let i = 0; i < 3; i++) {
      const res = await bridge.dispatch({ id: i, tool: "calc", input: "1+1" });
      expect(res.ok).toBe(true);
    }
    const fourth = await bridge.dispatch({ id: 4, tool: "calc", input: "1+1" });
    expect(fourth.ok).toBe(false);
    expect(fourth.error).toBe("call_budget_exceeded");
    expect(bridge.callCount()).toBe(4);
  });

  it("defaults maxCalls to 64", async () => {
    const bridge = createToolRpcBridge(testRegistry());
    for (let i = 0; i < 64; i++) {
      const res = await bridge.dispatch({ id: i, tool: "calc", input: "1+1" });
      expect(res.ok).toBe(true);
    }
    const overBudget = await bridge.dispatch({ id: 65, tool: "calc", input: "1+1" });
    expect(overBudget.error).toBe("call_budget_exceeded");
  });

  it("takes precedence over unknown_tool once exhausted", async () => {
    const bridge = createToolRpcBridge(testRegistry(), { maxCalls: 1 });
    await bridge.dispatch({ id: 1, tool: "calc", input: "1+1" });
    const res = await bridge.dispatch({ id: 2, tool: "totally_unknown", input: "" });
    expect(res.error).toBe("call_budget_exceeded");
  });

  it("is not consumed by malformed_request attempts", async () => {
    const bridge = createToolRpcBridge(testRegistry(), { maxCalls: 1 });
    const malformed = await bridge.dispatch({ id: 1, tool: 123, input: "x" } as unknown as ToolRpcRequest);
    expect(malformed.error).toBe("malformed_request");
    expect(bridge.callCount()).toBe(0);

    const ok = await bridge.dispatch({ id: 2, tool: "calc", input: "1+1" });
    expect(ok.ok).toBe(true);
    expect(bridge.callCount()).toBe(1);

    const exceeded = await bridge.dispatch({ id: 3, tool: "calc", input: "2+2" });
    expect(exceeded.error).toBe("call_budget_exceeded");
    expect(bridge.callCount()).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// malformed_request adversarial cases at the dispatch() boundary itself
// (not just validateToolRpcRequest), proving dispatch() never throws even
// when handed values that violate its own compile-time type.
// ---------------------------------------------------------------------------

describe("dispatch — malformed_request", () => {
  it("never throws for grossly malformed input and echoes a usable id when possible", async () => {
    const bridge = createToolRpcBridge(testRegistry());

    const withBadTool = await bridge.dispatch({ id: 9, tool: 42, input: "hi" } as unknown as ToolRpcRequest);
    expect(withBadTool.error).toBe("malformed_request");
    expect(withBadTool.id).toBe(9);

    const withBadInput = await bridge.dispatch({ id: 1, tool: "calc", input: 123 } as unknown as ToolRpcRequest);
    expect(withBadInput.error).toBe("malformed_request");

    const withNaNId = await bridge.dispatch({ id: NaN, tool: "calc", input: "1+1" });
    expect(withNaNId.error).toBe("malformed_request");
    expect(Number.isNaN(withNaNId.id)).toBe(true);

    const notAnObject = await bridge.dispatch("nope" as unknown as ToolRpcRequest);
    expect(notAnObject.error).toBe("malformed_request");
    expect(Number.isNaN(notAnObject.id)).toBe(true);

    const nullReq = await bridge.dispatch(null as unknown as ToolRpcRequest);
    expect(nullReq.error).toBe("malformed_request");

    expect(bridge.callCount()).toBe(0);
    expect(bridge.events()).toHaveLength(0);
  });

  it("accepts negative ids as well-formed (not malformed)", async () => {
    const bridge = createToolRpcBridge(testRegistry());
    const res = await bridge.dispatch({ id: -5, tool: "calc", input: "10-3" });
    expect(res.error).toBeUndefined();
    expect(res.ok).toBe(true);
    expect(res.id).toBe(-5);
  });
});

// ---------------------------------------------------------------------------
// onEvent robustness
// ---------------------------------------------------------------------------

describe("onEvent", () => {
  it("swallows a throwing observer without affecting dispatch or the event log", async () => {
    const seen: number[] = [];
    const bridge = createToolRpcBridge(testRegistry(), {
      onEvent: (e) => {
        seen.push(e.seq);
        throw new Error("hostile observer");
      },
    });
    const r1 = await bridge.dispatch({ id: 1, tool: "calc", input: "1+1" });
    const r2 = await bridge.dispatch({ id: 2, tool: "does_not_exist", input: "" });
    expect(r1.ok).toBe(true);
    expect(r2.error).toBe("unknown_tool");
    expect(seen).toEqual([1, 2]);
    expect(bridge.events()).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// events() defensive copy
// ---------------------------------------------------------------------------

describe("events()", () => {
  it("returns a defensive copy each call", async () => {
    const bridge = createToolRpcBridge(testRegistry());
    await bridge.dispatch({ id: 1, tool: "calc", input: "1+1" });
    const first = bridge.events();
    first.push({
      seq: 999,
      tool: "injected",
      inputSha256: "x",
      outputSha256: "y",
      ok: true,
      startedAt: 0,
      elapsedMs: 0,
    });
    const second = bridge.events();
    expect(second).toHaveLength(1);
    expect(second[0].tool).toBe("calc");
  });
});

// ---------------------------------------------------------------------------
// Property-style: one event per dispatch, hashes always recompute correctly.
// ---------------------------------------------------------------------------

describe("provenance property", () => {
  it("emits exactly one ProvenanceEvent per non-malformed dispatch with correct hashes", async () => {
    const bridge = createToolRpcBridge(testRegistry());
    const calls: ToolRpcRequest[] = [
      { id: 1, tool: "calc", input: "3*3" },
      { id: 2, tool: "uppercase", input: "hi" },
      { id: 3, tool: "fail", input: "x" },
      { id: 4, tool: "throws", input: "" },
      { id: 5, tool: "totally_unknown", input: "" },
      { id: 6, tool: "echo", input: "héllo 🚀" },
    ];
    const responses: ToolRpcResponse[] = [];
    for (const c of calls) responses.push(await bridge.dispatch(c));

    const events = bridge.events();
    expect(events).toHaveLength(calls.length);
    for (let i = 0; i < calls.length; i++) {
      expect(events[i].seq).toBe(i + 1);
      expect(events[i].tool).toBe(calls[i].tool);
      expect(events[i].inputSha256).toBe(sha256Hex(calls[i].input));
      expect(events[i].outputSha256).toBe(sha256Hex(responses[i].output));
      expect(events[i].ok).toBe(responses[i].ok);
      expect(events[i].error).toBe(responses[i].error);
    }
    expect(bridge.callCount()).toBe(calls.length);
  });
});

// ---------------------------------------------------------------------------
// Concurrency: 20 interleaved dispatches keep seq strictly monotonic.
// ---------------------------------------------------------------------------

describe("concurrency", () => {
  it("keeps seq strictly monotonic and events ordered by seq under interleaving", async () => {
    const bridge = createToolRpcBridge(testRegistry());
    const n = 20;
    const requests: ToolRpcRequest[] = Array.from({ length: n }, (_, i) => ({
      id: i,
      tool: "delay",
      input: String((i * 7) % 17), // varied 0-16ms delays, deliberately out of order
    }));

    const responses = await Promise.all(requests.map((r) => bridge.dispatch(r)));

    expect(responses).toHaveLength(n);
    for (let i = 0; i < n; i++) {
      expect(responses[i].ok).toBe(true);
      expect(responses[i].output).toBe(`done:${requests[i].input}`);
      expect(responses[i].id).toBe(i);
    }

    const events = bridge.events();
    expect(events).toHaveLength(n);
    const seqs = events.map((e) => e.seq);
    expect(new Set(seqs).size).toBe(n); // no duplicates
    expect(Math.min(...seqs)).toBe(1);
    expect(Math.max(...seqs)).toBe(n);
    for (let i = 1; i < events.length; i++) {
      expect(events[i].seq).toBeGreaterThan(events[i - 1].seq); // strictly increasing in array order
    }
    expect(bridge.callCount()).toBe(n);
  }, 5000);
});
