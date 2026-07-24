import { describe, it, expect } from "vitest";
import { validateWorkerId, suggestWorkerId, WorkerIdSuggester } from "../core/worker-id-suggest";

describe("validateWorkerId — boundary table", () => {
  it("accepts a single lowercase letter", () => {
    expect(validateWorkerId("a")).toEqual({ ok: true });
  });

  it("accepts a single digit", () => {
    expect(validateWorkerId("7")).toEqual({ ok: true });
  });

  it("accepts a digits-only id", () => {
    expect(validateWorkerId("12345")).toEqual({ ok: true });
  });

  it("accepts interior dashes", () => {
    expect(validateWorkerId("worker-a-1")).toEqual({ ok: true });
  });

  it("accepts exactly 63 characters", () => {
    const id = "a".repeat(63);
    expect(id.length).toBe(63);
    expect(validateWorkerId(id)).toEqual({ ok: true });
  });

  it("accepts 63 characters with interior dashes", () => {
    const id = `a${"b-".repeat(30)}c`; // 1 + 60 + 1 = 62... adjust to exactly 63
    const padded = id.length === 63 ? id : id + "d".repeat(63 - id.length);
    expect(padded.length).toBe(63);
    expect(validateWorkerId(padded)).toEqual({ ok: true });
  });

  it("rejects the empty string", () => {
    const result = validateWorkerId("");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/empty/i);
  });

  it("rejects exactly 64 characters as too long", () => {
    const id = "a".repeat(64);
    const result = validateWorkerId(id);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/too long/i);
      expect(result.reason).toContain("64");
    }
  });

  it("rejects a very long (1000 char) id as too long", () => {
    const id = "a".repeat(1000);
    const result = validateWorkerId(id);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/too long/i);
  });

  it("rejects uppercase letters with a bad-char reason", () => {
    const result = validateWorkerId("Worker1");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/index 0/);
      expect(result.reason).toMatch(/invalid character/i);
    }
  });

  it("rejects an uppercase letter in the middle at the right index", () => {
    const result = validateWorkerId("worker-X-1");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("index 7");
  });

  it("rejects unicode characters", () => {
    const result = validateWorkerId("café");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/index 3/);
      expect(result.reason).toMatch(/invalid character/i);
    }
  });

  it("rejects emoji", () => {
    const result = validateWorkerId("worker-🚀");
    expect(result.ok).toBe(false);
  });

  it("rejects a leading dash", () => {
    const result = validateWorkerId("-worker");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/leading dash|start with a dash/i);
  });

  it("rejects a trailing dash", () => {
    const result = validateWorkerId("worker-");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/trailing dash|end with a dash/i);
  });

  it("rejects a lone dash as a leading-dash violation", () => {
    const result = validateWorkerId("-");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/start with a dash/i);
  });

  it("rejects both-ends dashes, reporting the leading dash first", () => {
    const result = validateWorkerId("-worker-");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/start with a dash/i);
  });

  it("rejects internal whitespace", () => {
    const result = validateWorkerId("worker 1");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("index 6");
  });

  it("accepts consecutive interior dashes", () => {
    expect(validateWorkerId("worker--1")).toEqual({ ok: true });
  });
});

describe("suggestWorkerId — adversarial taken sets", () => {
  it("suggests worker-1 against an empty taken set", () => {
    expect(suggestWorkerId({ taken: [] })).toBe("worker-1");
  });

  it("suggests worker-501 against a dense worker-1..worker-500 taken set", () => {
    const taken = Array.from({ length: 500 }, (_, i) => `worker-${i + 1}`);
    expect(suggestWorkerId({ taken })).toBe("worker-501");
  });

  it("finds a gap in a sparse taken set", () => {
    const taken = ["worker-1", "worker-2", "worker-4"];
    expect(suggestWorkerId({ taken })).toBe("worker-3");
  });

  it("treats collisions case-insensitively", () => {
    const taken = ["Worker-1", "WORKER-2", "wOrKeR-3"];
    expect(suggestWorkerId({ taken })).toBe("worker-4");
  });

  it("respects a custom base", () => {
    expect(suggestWorkerId({ base: "gpu-node", taken: ["gpu-node-1"] })).toBe("gpu-node-2");
  });

  it("falls back to 'worker' when the base itself is invalid (uppercase)", () => {
    expect(suggestWorkerId({ base: "GPU_NODE", taken: [] })).toBe("worker-1");
  });

  it("falls back to 'worker' when the base itself is invalid (empty)", () => {
    expect(suggestWorkerId({ base: "", taken: [] })).toBe("worker-1");
  });

  it("falls back to 'worker' when the base itself is invalid (leading dash)", () => {
    expect(suggestWorkerId({ base: "-bad", taken: [] })).toBe("worker-1");
  });

  it("falls back to 'worker' when the base itself is invalid (too long)", () => {
    expect(suggestWorkerId({ base: "a".repeat(200), taken: [] })).toBe("worker-1");
  });

  it("still avoids collisions after falling back to the default base", () => {
    const taken = ["worker-1", "worker-2"];
    expect(suggestWorkerId({ base: "BAD BASE", taken })).toBe("worker-3");
  });

  it("every suggestion always passes validateWorkerId, across many bases/taken-set shapes", () => {
    const cases: Array<{ base?: string; taken: string[] }> = [
      { taken: [] },
      { base: "x", taken: Array.from({ length: 50 }, (_, i) => `x-${i + 1}`) },
      { base: "a".repeat(62), taken: [] },
      { base: "a".repeat(61), taken: Array.from({ length: 20 }, (_, i) => `${"a".repeat(61)}-${i + 1}`) },
      { base: undefined, taken: ["WORKER-1", "worker-2", "Worker-3"] },
    ];
    for (const c of cases) {
      const suggestion = suggestWorkerId(c);
      expect(validateWorkerId(suggestion)).toEqual({ ok: true });
      expect(suggestion.length).toBeLessThanOrEqual(63);
    }
  });

  it("truncates an oversized-but-valid base so the suggestion never exceeds 63 chars", () => {
    const base = "b".repeat(62); // "<base>-1" would be 64 chars without truncation
    const suggestion = suggestWorkerId({ base, taken: [] });
    expect(suggestion.length).toBeLessThanOrEqual(63);
    expect(validateWorkerId(suggestion)).toEqual({ ok: true });
  });

  it("is O(taken) via a Set: a huge taken array with the target free does not hang", () => {
    const taken = Array.from({ length: 20_000 }, (_, i) => `worker-${i + 2}`); // worker-1 is free
    const start = Date.now();
    const suggestion = suggestWorkerId({ taken });
    expect(suggestion).toBe("worker-1");
    expect(Date.now() - start).toBeLessThan(500);
  });

  it("taken containing the suggestion's own future outputs still skips them all", () => {
    // Simulates a caller who already knows worker-1..worker-3 will be
    // produced elsewhere and pre-seeds them as taken.
    const taken = ["worker-1", "worker-2", "worker-3"];
    expect(suggestWorkerId({ taken })).toBe("worker-4");
  });

  it("is deterministic for the same inputs", () => {
    const taken = ["worker-1", "worker-3"];
    expect(suggestWorkerId({ taken })).toBe(suggestWorkerId({ taken: [...taken] }));
  });
});

describe("WorkerIdSuggester — stateful", () => {
  it("consecutive next() calls never repeat", () => {
    const s = new WorkerIdSuggester();
    const first = s.next();
    const second = s.next();
    const third = s.next();
    expect(new Set([first, second, third]).size).toBe(3);
    expect(first).toBe("worker-1");
    expect(second).toBe("worker-2");
    expect(third).toBe("worker-3");
  });

  it("seeds taken ids from the constructor", () => {
    const s = new WorkerIdSuggester(["worker-1", "worker-2"]);
    expect(s.isTaken("worker-1")).toBe(true);
    expect(s.isTaken("Worker-2")).toBe(true); // case-insensitive
    expect(s.isTaken("worker-3")).toBe(false);
    expect(s.next()).toBe("worker-3");
  });

  it("markTaken affects future suggestions", () => {
    const s = new WorkerIdSuggester();
    s.markTaken("worker-1");
    s.markTaken("WORKER-2");
    expect(s.next()).toBe("worker-3");
  });

  it("isTaken is case-insensitive", () => {
    const s = new WorkerIdSuggester();
    s.markTaken("Gpu-Node-1");
    expect(s.isTaken("gpu-node-1")).toBe(true);
    expect(s.isTaken("GPU-NODE-1")).toBe(true);
  });

  it("next() respects a custom base independently per call", () => {
    const s = new WorkerIdSuggester(["gpu-1"]);
    expect(s.next("gpu")).toBe("gpu-2");
    expect(s.next("gpu")).toBe("gpu-3");
    expect(s.next()).toBe("worker-1");
  });

  it("never mutates a seed array passed to the constructor", () => {
    const seed = ["worker-1"];
    const s = new WorkerIdSuggester(seed);
    s.next();
    s.markTaken("worker-99");
    expect(seed).toEqual(["worker-1"]);
  });
});
