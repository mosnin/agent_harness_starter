import { describe, it, expect, afterEach } from "vitest";
import {
  generateShowdownSuite,
  runShowdown,
  verifyAuditChain,
  type AuditRecord,
  type ShowdownMode,
} from "../showdown";
import type { AgentRunner } from "../vtph";
import type { InlineSwarmOptions } from "../../../swarm-runtime/factory";

// ---------------------------------------------------------------------------
// Independent re-derivations of ground truth (deliberately NOT reusing the
// module's own solve/compute code) — these exist to catch a real bug in
// `computeSpec`/`grade`, not to restate it.
// ---------------------------------------------------------------------------

function extractSpec(prompt: string): Record<string, unknown> {
  const m = prompt.match(/SPEC:(\{[\s\S]*?\})\nRespond/);
  if (!m) throw new Error("no SPEC block in prompt");
  return JSON.parse(m[1]) as Record<string, unknown>;
}

function independentArithmetic(spec: { start: number; ops: Array<[string, number]> }): number {
  let acc = spec.start;
  for (const [op, val] of spec.ops) {
    if (op === "add") acc = acc + val;
    else if (op === "sub") acc = acc - val;
    else acc = acc * val;
  }
  return acc;
}

function independentRot13(s: string): string {
  let out = "";
  for (const ch of s) {
    const code = ch.charCodeAt(0);
    if (code >= 65 && code <= 90) out += String.fromCharCode(((code - 65 + 13) % 26) + 65);
    else if (code >= 97 && code <= 122) out += String.fromCharCode(((code - 97 + 13) % 26) + 97);
    else out += ch;
  }
  return out;
}

function independentFnv1a(s: string): string {
  // 32-bit FNV-1a. Uses Math.imul for the multiply step — the only way to
  // get correct wraparound 32-bit multiplication in JS (plain `* | 0` loses
  // precision once the product exceeds 2^53) — everything else here is a
  // fresh implementation, not a copy of the module's.
  let hash = 0x811c9dc5 | 0;
  for (let i = 0; i < s.length; i++) {
    hash = hash ^ s.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

// ---------------------------------------------------------------------------
// Env helpers for real-mode key tests
// ---------------------------------------------------------------------------

function clearProviderEnv(): { restore: () => void } {
  const savedA = process.env.ANTHROPIC_API_KEY;
  const savedO = process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  return {
    restore: () => {
      if (savedA !== undefined) process.env.ANTHROPIC_API_KEY = savedA;
      else delete process.env.ANTHROPIC_API_KEY;
      if (savedO !== undefined) process.env.OPENAI_API_KEY = savedO;
      else delete process.env.OPENAI_API_KEY;
    },
  };
}

afterEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
});

// ===========================================================================
// generateShowdownSuite
// ===========================================================================

describe("generateShowdownSuite", () => {
  it("defaults to 200 tasks", () => {
    const tasks = generateShowdownSuite({ seed: 1 });
    expect(tasks.length).toBe(200);
  });

  it("respects an explicit taskCount", () => {
    const tasks = generateShowdownSuite({ seed: 1, taskCount: 37 });
    expect(tasks.length).toBe(37);
  });

  it("is byte-for-byte deterministic for the same seed", () => {
    const a = generateShowdownSuite({ seed: 123, taskCount: 40 });
    const b = generateShowdownSuite({ seed: 123, taskCount: 40 });
    expect(a.map((t) => t.id)).toEqual(b.map((t) => t.id));
    expect(a.map((t) => t.prompt)).toEqual(b.map((t) => t.prompt));
    expect(a.map((t) => t.category)).toEqual(b.map((t) => t.category));
  });

  it("produces a different suite for a different seed", () => {
    const a = generateShowdownSuite({ seed: 1, taskCount: 20 });
    const b = generateShowdownSuite({ seed: 2, taskCount: 20 });
    expect(a.map((t) => t.prompt)).not.toEqual(b.map((t) => t.prompt));
  });

  it("covers at least 4 real task families, every one graded", () => {
    const tasks = generateShowdownSuite({ seed: 9, taskCount: 200 });
    const categories = new Set(tasks.map((t) => t.category));
    expect(categories.size).toBeGreaterThanOrEqual(4);
    expect([...categories].sort()).toEqual(["arithmetic", "checksum", "extraction", "transform"]);
    for (const t of tasks) expect(typeof t.grade).toBe("function");
  });

  it("rejects a non-positive taskCount", () => {
    expect(() => generateShowdownSuite({ seed: 1, taskCount: 0 })).toThrow(/taskCount/);
    expect(() => generateShowdownSuite({ seed: 1, taskCount: -5 })).toThrow(/taskCount/);
    expect(() => generateShowdownSuite({ seed: 1, taskCount: 1.5 })).toThrow(/taskCount/);
  });

  it("rejects a non-finite seed", () => {
    expect(() => generateShowdownSuite({ seed: NaN, taskCount: 4 })).toThrow(/seed/);
    expect(() => generateShowdownSuite({ seed: Infinity, taskCount: 4 })).toThrow(/seed/);
  });

  it("grades arithmetic tasks against an independently recomputed ground truth", () => {
    const tasks = generateShowdownSuite({ seed: 5, taskCount: 200 }).filter((t) => t.category === "arithmetic");
    expect(tasks.length).toBeGreaterThan(0);
    for (const t of tasks.slice(0, 10)) {
      const spec = extractSpec(t.prompt) as { start: number; ops: Array<[string, number]> };
      const expected = independentArithmetic(spec);
      expect(t.grade(String(expected))).toBe(true);
      expect(t.grade(String(expected + 1))).toBe(false);
      expect(t.grade(`  ${expected}  `)).toBe(true); // whitespace-tolerant
    }
  });

  it("grades extraction tasks against the field actually present in the record", () => {
    const tasks = generateShowdownSuite({ seed: 5, taskCount: 200 }).filter((t) => t.category === "extraction");
    for (const t of tasks.slice(0, 10)) {
      const spec = extractSpec(t.prompt) as { record: Record<string, string>; field: string };
      expect(t.grade(spec.record[spec.field])).toBe(true);
      expect(t.grade("definitely-not-the-value")).toBe(false);
    }
  });

  it("grades transform tasks (rot13 case) against an independent rot13", () => {
    const tasks = generateShowdownSuite({ seed: 5, taskCount: 400 }).filter(
      (t) => t.category === "transform" && (extractSpec(t.prompt) as { op: string }).op === "rot13"
    );
    expect(tasks.length).toBeGreaterThan(0);
    for (const t of tasks.slice(0, 5)) {
      const spec = extractSpec(t.prompt) as { text: string };
      expect(t.grade(independentRot13(spec.text))).toBe(true);
      expect(t.grade(spec.text)).toBe(false); // rot13 of itself only matches if text has no letters
    }
  });

  it("grades checksum tasks against an independent FNV-1a implementation", () => {
    const tasks = generateShowdownSuite({ seed: 5, taskCount: 200 }).filter((t) => t.category === "checksum");
    expect(tasks.length).toBeGreaterThan(0);
    for (const t of tasks.slice(0, 10)) {
      const spec = extractSpec(t.prompt) as { text: string };
      expect(t.grade(independentFnv1a(spec.text))).toBe(true);
      expect(t.grade("00000000")).toBe(false);
    }
  });
});

// ===========================================================================
// verifyAuditChain
// ===========================================================================

async function realChain(seed: number, taskCount: number): Promise<AuditRecord[]> {
  let c = 0;
  const now = () => (c += 1);
  const result = await runShowdown({ mode: "modeled", seed, taskCount, now });
  return result.audit;
}

describe("verifyAuditChain", () => {
  it("verifies an empty chain as ok", () => {
    expect(verifyAuditChain([])).toEqual({ ok: true });
  });

  it("verifies a genuine chain produced by runShowdown", async () => {
    const audit = await realChain(11, 6);
    expect(audit.length).toBe(12);
    expect(verifyAuditChain(audit)).toEqual({ ok: true });
  });

  it("detects a single tampered field at the exact broken index", async () => {
    const audit = await realChain(11, 6);
    const tampered = audit.map((r) => ({ ...r }));
    tampered[5].verdict = tampered[5].verdict === "verified" ? "rejected" : "verified";
    const result = verifyAuditChain(tampered);
    expect(result.ok).toBe(false);
    expect(result.brokenAt).toBe(5);
  });

  it("detects a tampered numeric field (usd) at the exact broken index", async () => {
    const audit = await realChain(11, 6);
    const tampered = audit.map((r) => ({ ...r }));
    tampered[3].usd = tampered[3].usd + 0.000001;
    const result = verifyAuditChain(tampered);
    expect(result.ok).toBe(false);
    expect(result.brokenAt).toBe(3);
  });

  it("detects reordered records at the exact broken index", async () => {
    const audit = await realChain(11, 6);
    const reordered = [...audit];
    [reordered[2], reordered[3]] = [reordered[3], reordered[2]];
    const result = verifyAuditChain(reordered);
    expect(result.ok).toBe(false);
    // seq no longer matches position at index 2.
    expect(result.brokenAt).toBe(2);
  });

  it("detects truncation (dropped tail records) via prevHash/seq mismatch on re-append", async () => {
    const audit = await realChain(11, 6);
    const truncated = audit.slice(0, audit.length - 2);
    expect(verifyAuditChain(truncated)).toEqual({ ok: true }); // a clean prefix still verifies
    // But splicing a later record back in without the removed ones breaks seq continuity.
    const brokenSplice = [...truncated, audit[audit.length - 1]];
    const result = verifyAuditChain(brokenSplice);
    expect(result.ok).toBe(false);
    expect(result.brokenAt).toBe(truncated.length);
  });

  it("flags a malformed record (missing required field)", async () => {
    const audit = await realChain(11, 6);
    const malformed = audit.map((r) => ({ ...r })) as Array<Partial<AuditRecord>>;
    delete malformed[1].hash;
    const result = verifyAuditChain(malformed as AuditRecord[]);
    expect(result.ok).toBe(false);
    expect(result.brokenAt).toBe(1);
  });
});

// ===========================================================================
// runShowdown
// ===========================================================================

describe("runShowdown — modeled mode", () => {
  it("swarm silent-wrong stays 0 by measurement while baseline's does not, on a suite with real errors", async () => {
    let c = 0;
    const now = () => (c += 1);
    const result = await runShowdown({ mode: "modeled", seed: 7, taskCount: 16, now });

    expect(verifyAuditChain(result.audit)).toEqual({ ok: true });
    expect(result.swarmReport.silentWrong).toBe(0);
    expect(result.swarmReport.declined).toBeGreaterThan(0); // the gate actually caught something
    expect(result.baselineReport.silentWrong).toBeGreaterThan(0); // baseline actually self-deceived
    expect(result.baselineReport.silentWrong).toBe(result.swarmReport.declined); // same difficulty stream
    expect(result.mode).toBe("modeled");
    expect(result.taskCount).toBe(16);
    expect(result.audit.length).toBe(32);
    for (const rec of result.audit) expect(rec.mode).toBe("modeled");
  }, 30000);

  it("a scripted dishonest worker is REJECTED by the real gate, not just declined generically", async () => {
    let c = 0;
    const now = () => (c += 1);
    const result = await runShowdown({ mode: "modeled", seed: 7, taskCount: 16, now });
    const swarmRejections = result.audit.filter((r) => r.lane === "swarm" && r.verdict === "rejected");
    expect(swarmRejections.length).toBeGreaterThan(0);
  }, 30000);

  it("produces byte-identical audit hashes across two runs of the same seed", async () => {
    let c1 = 0;
    const r1 = await runShowdown({ mode: "modeled", seed: 99, taskCount: 24, now: () => (c1 += 1) });
    let c2 = 0;
    const r2 = await runShowdown({ mode: "modeled", seed: 99, taskCount: 24, now: () => (c2 += 1) });
    expect(r1.audit.map((a) => a.hash)).toEqual(r2.audit.map((a) => a.hash));
    expect(r1.audit).toEqual(r2.audit);
  }, 30000);

  it("the 200-task default suite runs end-to-end through the real SwarmManager deterministically", async () => {
    let c1 = 0;
    const r1 = await runShowdown({ mode: "modeled", seed: 42, now: () => (c1 += 1) });
    expect(r1.taskCount).toBe(200);
    expect(r1.audit.length).toBe(400);
    expect(verifyAuditChain(r1.audit)).toEqual({ ok: true });

    let c2 = 0;
    const r2 = await runShowdown({ mode: "modeled", seed: 42, now: () => (c2 += 1) });
    expect(r1.audit.map((a) => a.hash)).toEqual(r2.audit.map((a) => a.hash));
  }, 60000);

  it("fires onProgress monotonically from 1 to taskCount*2", async () => {
    const seen: Array<[number, number]> = [];
    let c = 0;
    await runShowdown({
      mode: "modeled",
      seed: 3,
      taskCount: 10,
      now: () => (c += 1),
      onProgress: (done, total) => seen.push([done, total]),
    });
    expect(seen.length).toBe(20);
    for (const [, total] of seen) expect(total).toBe(20);
    for (let i = 1; i < seen.length; i++) expect(seen[i][0]).toBeGreaterThan(seen[i - 1][0]);
    expect(seen[seen.length - 1][0]).toBe(20);
  }, 30000);

  it("isolates a baseline-lane failure to one task — never aborts the batch", async () => {
    const flaky: AgentRunner = async (task) => {
      if (task.id.includes("-0002-")) throw new Error("simulated baseline crash");
      return { output: "whatever", claimedVerified: false, tokensIn: 1, tokensOut: 1, usd: 0, provenance: [] };
    };
    let c = 0;
    const result = await runShowdown({
      mode: "modeled",
      seed: 4,
      taskCount: 6,
      now: () => (c += 1),
      baselineRunner: flaky,
    });
    expect(result.baselineReport.tasks).toBe(6); // batch completed, not aborted
    expect(result.baselineReport.declined).toBe(6); // "whatever" never claimed verified, plus the thrown one
    const failedRecord = result.audit.find((r) => r.lane === "baseline" && r.taskId.includes("-0002-"));
    expect(failedRecord?.verdict).toBe("failed");
    expect(verifyAuditChain(result.audit)).toEqual({ ok: true });
  }, 30000);

  it("ignores an injected planner override — the single-task-per-goal contract always wins", async () => {
    const rogue: InlineSwarmOptions["planner"] = {
      plan: async () => {
        throw new Error("rogue planner should never be invoked");
      },
    };
    let c = 0;
    const result = await runShowdown({
      mode: "modeled",
      seed: 8,
      taskCount: 4,
      now: () => (c += 1),
      swarm: { planner: rogue },
    });
    expect(result.swarmReport.tasks).toBe(4);
    expect(verifyAuditChain(result.audit)).toEqual({ ok: true });
  }, 30000);

  it("rejects an unknown mode", async () => {
    await expect(
      runShowdown({ mode: "fast" as unknown as ShowdownMode, seed: 1, taskCount: 4 })
    ).rejects.toThrow(/mode/);
  });

  it("rejects a non-finite seed", async () => {
    await expect(runShowdown({ mode: "modeled", seed: NaN, taskCount: 4 })).rejects.toThrow(/seed/);
  });
});

describe("runShowdown — real mode", () => {
  it("throws naming the missing env var when no provider key is configured", async () => {
    const { restore } = clearProviderEnv();
    try {
      await expect(runShowdown({ mode: "real", seed: 1, taskCount: 4 })).rejects.toThrow(
        /ANTHROPIC_API_KEY/
      );
      await expect(runShowdown({ mode: "real", seed: 1, taskCount: 4 })).rejects.toThrow(/OPENAI_API_KEY/);
    } finally {
      restore();
    }
  });

  it("never silently downgrades to modeled numbers when a key is missing", async () => {
    const { restore } = clearProviderEnv();
    try {
      let threw = false;
      try {
        await runShowdown({ mode: "real", seed: 1, taskCount: 4 });
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
    } finally {
      restore();
    }
  });

  it("with a key present, uses injected executor/baselineRunner and stamps mode:real everywhere (no network call made)", async () => {
    process.env.ANTHROPIC_API_KEY = "fake-test-key-not-a-real-secret";
    const injectedExecutor = {
      execute: async () => ({
        output: "42",
        claims: [{ statement: "computed 42", evidence: ["evidence:42"], confidence: 0.9 }],
        toolTrace: [{ tool: "t", args: {}, ok: true, output: "evidence:42", at: 0 }],
      }),
    };
    const injectedBaseline: AgentRunner = async () => ({
      output: "42",
      claimedVerified: true,
      tokensIn: 1,
      tokensOut: 1,
      usd: 0.001,
      provenance: [],
    });
    let c = 0;
    const result = await runShowdown({
      mode: "real",
      seed: 2,
      taskCount: 3,
      now: () => (c += 1),
      swarm: { executor: injectedExecutor },
      baselineRunner: injectedBaseline,
    });
    expect(result.mode).toBe("real");
    for (const rec of result.audit) expect(rec.mode).toBe("real");
    expect(verifyAuditChain(result.audit)).toEqual({ ok: true });
  }, 30000);
});
