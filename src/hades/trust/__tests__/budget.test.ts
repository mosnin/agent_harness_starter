import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sha256Hex } from "../../styx/certificate";
import {
  formatTrustBudgetReport,
  TRUST_BUDGET_GENESIS,
  TrustBudgetLedger,
  type TrustBudgetEntry,
} from "../budget";

// ===========================================================================
// Test helpers — real fs against a mkdtempSync temp dir, real sha256, only
// the clock is injected. No fs mocking anywhere in this file.
// ===========================================================================

function tempPath(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), "trust-budget-"));
  return join(dir, name);
}

function manualClock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    set: (v: number) => {
      t = v;
    },
    advance: (ms: number) => {
      t += ms;
    },
  };
}

function subjectHash(text: string): string {
  return sha256Hex(text);
}

// ===========================================================================
// Basic quote/spend accounting
// ===========================================================================

describe("TrustBudgetLedger — basic quote/spend accounting", () => {
  it("quotes and spends risk against an in-memory global budget", () => {
    const clock = manualClock();
    const ledger = TrustBudgetLedger.open({ totalRisk: 1, window: { kind: "session" }, now: clock.now });

    const q1 = ledger.quote({ domain: "tool", taskId: "t1", risk: 0.3 });
    expect(q1.allowed).toBe(true);
    expect(q1.remaining).toBeCloseTo(1, 12);

    const s1 = ledger.spend({
      domain: "tool",
      taskId: "t1",
      risk: 0.3,
      subjectSha256: subjectHash("out-1"),
      issuedAt: clock.now(),
    });
    expect(s1.accepted).toBe(true);
    expect(s1.remaining).toBeCloseTo(0.7, 12);
    expect(s1.entrySha256).toHaveLength(64);

    const report = ledger.report();
    expect(report.spentRisk).toBeCloseTo(0.3, 12);
    expect(report.remainingRisk).toBeCloseTo(0.7, 12);
    expect(report.spentRisk + report.remainingRisk).toBeCloseTo(report.totalRisk, 9);
    expect(report.exhausted).toBe(false);
    expect(report.entries).toBe(1);
    expect(report.chainRoot).toBe(TRUST_BUDGET_GENESIS);
    expect(report.chainHead).toBe(s1.entrySha256);
  });

  it("computes a real, independently-verifiable sha256 chain (entrySha256 recomputes from fields)", () => {
    const clock = manualClock();
    const ledger = TrustBudgetLedger.open({ totalRisk: 10, window: { kind: "session" }, now: clock.now });

    ledger.spend({ domain: "tool", taskId: "t1", risk: 0.1, subjectSha256: subjectHash("a"), issuedAt: clock.now() });
    const entry = ledger.entries()[0]!;

    const canonical =
      `{"seq":${entry.seq},"domain":${JSON.stringify(entry.domain)},"taskId":${JSON.stringify(entry.taskId)},` +
      `"risk":${JSON.stringify(entry.risk)},"subjectSha256":${JSON.stringify(entry.subjectSha256)},` +
      `"issuedAt":${JSON.stringify(entry.issuedAt)},"prevSha256":${JSON.stringify(entry.prevSha256)}}`;
    expect(entry.entrySha256).toBe(sha256Hex(canonical));
    expect(entry.prevSha256).toBe(TRUST_BUDGET_GENESIS);
  });

  it("chains prevSha256 -> entrySha256 across multiple spends", () => {
    const clock = manualClock();
    const ledger = TrustBudgetLedger.open({ totalRisk: 10, window: { kind: "session" }, now: clock.now });

    const s1 = ledger.spend({ domain: "tool", taskId: "t1", risk: 0.1, subjectSha256: subjectHash("a"), issuedAt: clock.now() });
    const s2 = ledger.spend({ domain: "tool", taskId: "t2", risk: 0.1, subjectSha256: subjectHash("b"), issuedAt: clock.now() });
    const s3 = ledger.spend({ domain: "tool", taskId: "t3", risk: 0.1, subjectSha256: subjectHash("c"), issuedAt: clock.now() });

    const entries = ledger.entries();
    expect(entries.map((e) => e.seq)).toEqual([0, 1, 2]);
    expect(entries[0]!.prevSha256).toBe(TRUST_BUDGET_GENESIS);
    expect(entries[1]!.prevSha256).toBe(s1.entrySha256);
    expect(entries[2]!.prevSha256).toBe(s2.entrySha256);
    expect(entries[2]!.entrySha256).toBe(s3.entrySha256);
    expect(ledger.verifyChain()).toEqual({ ok: true, length: 3 });
  });
});

// ===========================================================================
// (1) Tamper evidence — hand-edit the on-disk JSON and prove open() refuses
// to silently continue.
// ===========================================================================

describe("TrustBudgetLedger — tamper evidence (hand-edited on-disk JSON)", () => {
  function seedLedger(path: string, clock: ReturnType<typeof manualClock>, n: number): void {
    const ledger = TrustBudgetLedger.open({ totalRisk: 10, window: { kind: "session" }, path, now: clock.now });
    for (let i = 0; i < n; i++) {
      ledger.spend({
        domain: "tool",
        taskId: `t${i}`,
        risk: 0.1,
        subjectSha256: subjectHash(`out-${i}`),
        issuedAt: clock.now(),
      });
      clock.advance(1);
    }
  }

  it("detects a flipped risk value as hash_mismatch and refuses to spend", () => {
    const clock = manualClock();
    const path = tempPath("budget.json");
    seedLedger(path, clock, 3);

    const raw = JSON.parse(readFileSync(path, "utf8"));
    raw.entries[1].risk = 9.9; // tamper: understate/overstate spend
    writeFileSync(path, JSON.stringify(raw, null, 2), "utf8");

    const reopened = TrustBudgetLedger.open({ totalRisk: 10, window: { kind: "session" }, path, now: clock.now });
    const verification = reopened.verifyChain();
    expect(verification.ok).toBe(false);
    expect(verification.reason).toBe("hash_mismatch");
    expect(verification.firstBadSeq).toBe(1);

    const quote = reopened.quote({ domain: "tool", taskId: "new", risk: 0.01 });
    expect(quote.allowed).toBe(false);
    const spend = reopened.spend({
      domain: "tool",
      taskId: "new",
      risk: 0.01,
      subjectSha256: subjectHash("z"),
      issuedAt: clock.now(),
    });
    expect(spend.accepted).toBe(false);
    expect(spend.entrySha256).toBe("");

    // Fail-safe reporting: never look safer than actually verified.
    const report = reopened.report();
    expect(report.exhausted).toBe(true);
    expect(report.remainingRisk).toBe(0);
  });

  it("detects a deleted middle entry as a seq_gap", () => {
    const clock = manualClock();
    const path = tempPath("budget.json");
    seedLedger(path, clock, 4);

    const raw = JSON.parse(readFileSync(path, "utf8"));
    raw.entries.splice(1, 1); // delete seq 1
    writeFileSync(path, JSON.stringify(raw, null, 2), "utf8");

    const reopened = TrustBudgetLedger.open({ totalRisk: 10, window: { kind: "session" }, path, now: clock.now });
    const verification = reopened.verifyChain();
    expect(verification.ok).toBe(false);
    expect(verification.reason).toBe("seq_gap");
    expect(verification.firstBadSeq).toBe(1);
    expect(reopened.quote({ domain: "tool", taskId: "x", risk: 0.01 }).allowed).toBe(false);
  });

  it("detects a spliced-in forged entry as a chain break", () => {
    const clock = manualClock();
    const path = tempPath("budget.json");
    seedLedger(path, clock, 3);

    const raw = JSON.parse(readFileSync(path, "utf8"));
    const forged: TrustBudgetEntry = {
      seq: 1,
      domain: "tool",
      taskId: "forged",
      risk: 0.0001,
      subjectSha256: subjectHash("forged"),
      issuedAt: clock.now(),
      prevSha256: "0".repeat(64), // wrong link, and not hash-consistent either
      entrySha256: "1".repeat(64),
    };
    raw.entries.splice(1, 0, forged);
    // Re-number the trailing seqs so the shape check doesn't just reject on seq type mismatch trivially
    raw.entries[2].seq = 2;
    raw.entries[3].seq = 3;
    writeFileSync(path, JSON.stringify(raw, null, 2), "utf8");

    const reopened = TrustBudgetLedger.open({ totalRisk: 10, window: { kind: "session" }, path, now: clock.now });
    const verification = reopened.verifyChain();
    expect(verification.ok).toBe(false);
    expect(["chain_break", "hash_mismatch", "seq_gap"]).toContain(verification.reason);
    expect(verification.firstBadSeq).toBe(1);
    expect(reopened.spend({ domain: "tool", taskId: "x", risk: 0.01, subjectSha256: subjectHash("x"), issuedAt: clock.now() }).accepted).toBe(
      false,
    );
  });

  it("detects reordered entries", () => {
    const clock = manualClock();
    const path = tempPath("budget.json");
    seedLedger(path, clock, 3);

    const raw = JSON.parse(readFileSync(path, "utf8"));
    const tmp = raw.entries[0];
    raw.entries[0] = raw.entries[1];
    raw.entries[1] = tmp;
    writeFileSync(path, JSON.stringify(raw, null, 2), "utf8");

    const reopened = TrustBudgetLedger.open({ totalRisk: 10, window: { kind: "session" }, path, now: clock.now });
    const verification = reopened.verifyChain();
    expect(verification.ok).toBe(false);
    expect(reopened.quote({ domain: "tool", taskId: "x", risk: 0.01 }).allowed).toBe(false);
  });

  it("a tampered ledger's entries() still exposes the recovered (tampered) data for forensics", () => {
    const clock = manualClock();
    const path = tempPath("budget.json");
    seedLedger(path, clock, 3);

    const raw = JSON.parse(readFileSync(path, "utf8"));
    raw.entries[2].risk = 999;
    writeFileSync(path, JSON.stringify(raw, null, 2), "utf8");

    const reopened = TrustBudgetLedger.open({ totalRisk: 10, window: { kind: "session" }, path, now: clock.now });
    expect(reopened.entries()).toHaveLength(3);
    expect(reopened.entries()[2]!.risk).toBe(999);
  });

  it("a legitimate, untampered on-disk chain reopens verified and spendable", () => {
    const clock = manualClock();
    const path = tempPath("budget.json");
    seedLedger(path, clock, 3);

    const reopened = TrustBudgetLedger.open({ totalRisk: 10, window: { kind: "session" }, path, now: clock.now });
    expect(reopened.verifyChain()).toEqual({ ok: true, length: 3 });
    const q = reopened.quote({ domain: "tool", taskId: "fresh", risk: 0.1 });
    expect(q.allowed).toBe(true);
  });
});

// ===========================================================================
// (2) Input hardening
// ===========================================================================

describe("TrustBudgetLedger — input hardening", () => {
  it("rejects negative, zero, NaN, Infinity, and non-number risk on quote", () => {
    const clock = manualClock();
    const ledger = TrustBudgetLedger.open({ totalRisk: 1, window: { kind: "session" }, now: clock.now });

    for (const bad of [-1, 0, NaN, Infinity, -Infinity, "0.5" as unknown as number]) {
      const q = ledger.quote({ domain: "tool", taskId: "t", risk: bad });
      expect(q.allowed).toBe(false);
      expect(q.reason).toMatch(/invalid risk/);
    }
  });

  it("rejects negative, zero, NaN, Infinity, and non-number risk on spend, charging nothing", () => {
    const clock = manualClock();
    const ledger = TrustBudgetLedger.open({ totalRisk: 1, window: { kind: "session" }, now: clock.now });

    for (const bad of [-1, 0, NaN, Infinity, -Infinity, "0.5" as unknown as number]) {
      const s = ledger.spend({
        domain: "tool",
        taskId: `bad-${String(bad)}`,
        risk: bad,
        subjectSha256: subjectHash(`bad-${String(bad)}`),
        issuedAt: clock.now(),
      });
      expect(s.accepted).toBe(false);
      expect(s.entrySha256).toBe("");
    }
    expect(ledger.report().spentRisk).toBe(0);
  });

  it("refuses (never clamps, never partially spends) a risk greater than remaining", () => {
    const clock = manualClock();
    const ledger = TrustBudgetLedger.open({ totalRisk: 1, window: { kind: "session" }, now: clock.now });

    const q = ledger.quote({ domain: "tool", taskId: "t1", risk: 1.5 });
    expect(q.allowed).toBe(false);
    expect(q.reason).toBeDefined();

    const s = ledger.spend({ domain: "tool", taskId: "t1", risk: 1.5, subjectSha256: subjectHash("x"), issuedAt: clock.now() });
    expect(s.accepted).toBe(false);
    expect(s.entrySha256).toBe("");
    expect(ledger.report().spentRisk).toBe(0);
    expect(ledger.entries()).toHaveLength(0);
  });

  it("refuses a risk that exceeds a configured domain cap even though global budget has room", () => {
    const clock = manualClock();
    const ledger = TrustBudgetLedger.open({
      totalRisk: 10,
      window: { kind: "session" },
      perDomainCaps: { tool: 0.2 },
      now: clock.now,
    });

    const q = ledger.quote({ domain: "tool", taskId: "t1", risk: 0.5 });
    expect(q.allowed).toBe(false);
    expect(q.reason).toMatch(/domain/);

    const s = ledger.spend({ domain: "tool", taskId: "t1", risk: 0.5, subjectSha256: subjectHash("x"), issuedAt: clock.now() });
    expect(s.accepted).toBe(false);
    expect(ledger.report().perDomain.tool!.spent).toBe(0);
  });

  it("an unknown domain with no configured cap falls back to the global cap and reports cap:null", () => {
    const clock = manualClock();
    const ledger = TrustBudgetLedger.open({
      totalRisk: 1,
      window: { kind: "session" },
      perDomainCaps: { tool: 0.5 },
      now: clock.now,
    });

    const q = ledger.quote({ domain: "memory", taskId: "t1", risk: 0.9 });
    expect(q.allowed).toBe(true); // bounded only by the global cap (1), not any domain cap

    ledger.spend({ domain: "memory", taskId: "t1", risk: 0.9, subjectSha256: subjectHash("x"), issuedAt: clock.now() });

    const report = ledger.report();
    expect(report.perDomain.memory!.cap).toBeNull();
    expect(report.perDomain.memory!.remaining).toBeNull();
    expect(report.perDomain.memory!.spent).toBeCloseTo(0.9, 12);
    expect(report.perDomain.memory!.admissions).toBe(1);

    // And it still correctly binds the *global* remaining (0.1 left).
    const q2 = ledger.quote({ domain: "memory", taskId: "t2", risk: 0.2 });
    expect(q2.allowed).toBe(false);
    expect(q2.reason).toMatch(/remaining global trust budget/);

    // Fully exhaust it and confirm the exhaustion reason is stable.
    ledger.spend({ domain: "memory", taskId: "t2b", risk: 0.1, subjectSha256: subjectHash("y"), issuedAt: clock.now() });
    const q3 = ledger.quote({ domain: "memory", taskId: "t3", risk: 0.01 });
    expect(q3.allowed).toBe(false);
    expect(q3.reason).toBe("trust budget exhausted");
  });
});

// ===========================================================================
// (3) Idempotency
// ===========================================================================

describe("TrustBudgetLedger — idempotency on (taskId, subjectSha256)", () => {
  it("does not double-charge a repeated spend for the same (taskId, subjectSha256)", () => {
    const clock = manualClock();
    const ledger = TrustBudgetLedger.open({ totalRisk: 1, window: { kind: "session" }, now: clock.now });
    const subj = subjectHash("same-output");

    const first = ledger.spend({ domain: "tool", taskId: "t1", risk: 0.3, subjectSha256: subj, issuedAt: clock.now() });
    expect(first.accepted).toBe(true);

    const second = ledger.spend({ domain: "tool", taskId: "t1", risk: 0.3, subjectSha256: subj, issuedAt: clock.now() });
    expect(second.accepted).toBe(true);
    expect(second.entrySha256).toBe(first.entrySha256);

    expect(ledger.report().spentRisk).toBeCloseTo(0.3, 12);
    expect(ledger.entries()).toHaveLength(1);
  });

  it("a retry storm of 50 identical spends moves the total exactly once", () => {
    const clock = manualClock();
    const ledger = TrustBudgetLedger.open({ totalRisk: 1, window: { kind: "session" }, now: clock.now });
    const subj = subjectHash("retry-storm-output");

    const results = [];
    for (let i = 0; i < 50; i++) {
      results.push(
        ledger.spend({ domain: "tool", taskId: "retry-task", risk: 0.25, subjectSha256: subj, issuedAt: clock.now() }),
      );
    }

    expect(results.every((r) => r.accepted)).toBe(true);
    const hashes = new Set(results.map((r) => r.entrySha256));
    expect(hashes.size).toBe(1);

    const report = ledger.report();
    expect(report.spentRisk).toBeCloseTo(0.25, 12);
    expect(report.entries).toBe(1);
    expect(ledger.verifyChain()).toEqual({ ok: true, length: 1 });
  });

  it("different taskId/subjectSha256 pairs are charged independently even with identical risk", () => {
    const clock = manualClock();
    const ledger = TrustBudgetLedger.open({ totalRisk: 1, window: { kind: "session" }, now: clock.now });

    ledger.spend({ domain: "tool", taskId: "a", risk: 0.1, subjectSha256: subjectHash("a"), issuedAt: clock.now() });
    ledger.spend({ domain: "tool", taskId: "b", risk: 0.1, subjectSha256: subjectHash("b"), issuedAt: clock.now() });

    expect(ledger.report().spentRisk).toBeCloseTo(0.2, 12);
    expect(ledger.entries()).toHaveLength(2);
  });
});

// ===========================================================================
// (4) Multi-process safety
// ===========================================================================

describe("TrustBudgetLedger — multi-process safety over a shared path", () => {
  it("two ledger instances interleaving spends over the same path never lose an entry or corrupt the chain", () => {
    const clock = manualClock();
    const path = tempPath("shared-budget.json");

    const ledgerA = TrustBudgetLedger.open({ totalRisk: 100, window: { kind: "session" }, path, now: clock.now });
    const ledgerB = TrustBudgetLedger.open({ totalRisk: 100, window: { kind: "session" }, path, now: clock.now });

    const spends: Array<{ instance: "A" | "B"; taskId: string; risk: number }> = [];
    for (let i = 0; i < 20; i++) {
      spends.push({ instance: i % 2 === 0 ? "A" : "B", taskId: `interleave-${i}`, risk: 0.05 + (i % 3) * 0.01 });
    }

    let expectedTotal = 0;
    for (const s of spends) {
      const ledger = s.instance === "A" ? ledgerA : ledgerB;
      const result = ledger.spend({
        domain: "tool",
        taskId: s.taskId,
        risk: s.risk,
        subjectSha256: subjectHash(s.taskId),
        issuedAt: clock.now(),
      });
      expect(result.accepted).toBe(true);
      expectedTotal += s.risk;
      clock.advance(1);
    }

    // A third, freshly-opened instance sees the full merged, unbroken chain.
    const ledgerC = TrustBudgetLedger.open({ totalRisk: 100, window: { kind: "session" }, path, now: clock.now });
    expect(ledgerC.verifyChain()).toEqual({ ok: true, length: 20 });
    expect(ledgerC.entries()).toHaveLength(20);
    expect(ledgerC.report().spentRisk).toBeCloseTo(expectedTotal, 9);

    // Both original instances, having synced from disk on every call, agree.
    expect(ledgerA.verifyChain().ok).toBe(true);
    expect(ledgerB.verifyChain().ok).toBe(true);
    expect(ledgerA.report().spentRisk).toBeCloseTo(expectedTotal, 9);
    expect(ledgerB.report().spentRisk).toBeCloseTo(expectedTotal, 9);

    const seqs = ledgerC.entries().map((e) => e.seq);
    expect(seqs).toEqual(Array.from({ length: 20 }, (_, i) => i));
  });

  it("idempotent retries interleaved across two instances still only charge once", () => {
    const clock = manualClock();
    const path = tempPath("shared-idem.json");
    const subj = subjectHash("shared-output");

    const ledgerA = TrustBudgetLedger.open({ totalRisk: 5, window: { kind: "session" }, path, now: clock.now });
    const ledgerB = TrustBudgetLedger.open({ totalRisk: 5, window: { kind: "session" }, path, now: clock.now });

    const rA = ledgerA.spend({ domain: "tool", taskId: "shared", risk: 0.4, subjectSha256: subj, issuedAt: clock.now() });
    const rB = ledgerB.spend({ domain: "tool", taskId: "shared", risk: 0.4, subjectSha256: subj, issuedAt: clock.now() });

    expect(rA.accepted).toBe(true);
    expect(rB.accepted).toBe(true);
    expect(rA.entrySha256).toBe(rB.entrySha256);

    const ledgerC = TrustBudgetLedger.open({ totalRisk: 5, window: { kind: "session" }, path, now: clock.now });
    expect(ledgerC.entries()).toHaveLength(1);
    expect(ledgerC.report().spentRisk).toBeCloseTo(0.4, 12);
  });
});

// ===========================================================================
// (5) Window semantics
// ===========================================================================

describe("TrustBudgetLedger — window semantics", () => {
  it("session windows never roll, however far the clock advances", () => {
    const clock = manualClock();
    const ledger = TrustBudgetLedger.open({ totalRisk: 1, window: { kind: "session" }, now: clock.now });

    ledger.spend({ domain: "tool", taskId: "t1", risk: 0.9, subjectSha256: subjectHash("a"), issuedAt: clock.now() });
    clock.advance(10_000_000);
    expect(ledger.report().spentRisk).toBeCloseTo(0.9, 12);
    expect(ledger.quote({ domain: "tool", taskId: "t2", risk: 0.2 }).allowed).toBe(false);

    ledger.rollWindow(clock.now()); // explicit roll must also be a no-op for session
    expect(ledger.report().spentRisk).toBeCloseTo(0.9, 12);
  });

  it("fixed-ms rolls exactly at the boundary (ms-1 does not roll, ms rolls, ms+1 stays rolled)", () => {
    const clock = manualClock(0);
    const WINDOW_MS = 1000;
    const ledger = TrustBudgetLedger.open({ totalRisk: 1, window: { kind: "fixed-ms", ms: WINDOW_MS }, now: clock.now });

    ledger.spend({ domain: "tool", taskId: "t1", risk: 0.9, subjectSha256: subjectHash("a"), issuedAt: clock.now() });
    expect(ledger.report().spentRisk).toBeCloseTo(0.9, 12);

    clock.set(WINDOW_MS - 1);
    expect(ledger.report().spentRisk).toBeCloseTo(0.9, 12); // still the old window

    clock.set(WINDOW_MS);
    expect(ledger.report().spentRisk).toBe(0); // rolled: new window, nothing spent yet
    expect(ledger.report().windowStartedAt).toBe(WINDOW_MS);

    clock.set(WINDOW_MS + 1);
    expect(ledger.report().spentRisk).toBe(0); // still rolled
    expect(ledger.report().windowStartedAt).toBe(WINDOW_MS);
  });

  it("a roll archives rather than discards: the chain stays continuous and verifiable across a roll", () => {
    const clock = manualClock(0);
    const WINDOW_MS = 100;
    const path = tempPath("windowed-budget.json");
    const ledger = TrustBudgetLedger.open({ totalRisk: 1, window: { kind: "fixed-ms", ms: WINDOW_MS }, path, now: clock.now });

    ledger.spend({ domain: "tool", taskId: "pre-roll-1", risk: 0.3, subjectSha256: subjectHash("a"), issuedAt: clock.now() });
    ledger.spend({ domain: "tool", taskId: "pre-roll-2", risk: 0.3, subjectSha256: subjectHash("b"), issuedAt: clock.now() });

    clock.set(WINDOW_MS); // roll
    const spendAfterRoll = ledger.spend({
      domain: "tool",
      taskId: "post-roll-1",
      risk: 0.5,
      subjectSha256: subjectHash("c"),
      issuedAt: clock.now(),
    });
    expect(spendAfterRoll.accepted).toBe(true);

    // Full chain (spanning the roll) is still one continuous, verifiable sequence.
    expect(ledger.entries()).toHaveLength(3);
    expect(ledger.entries().map((e) => e.seq)).toEqual([0, 1, 2]);
    expect(ledger.verifyChain()).toEqual({ ok: true, length: 3 });

    // But the CURRENT window's accounting only reflects the post-roll spend.
    const report = ledger.report();
    expect(report.spentRisk).toBeCloseTo(0.5, 12);
    expect(report.entries).toBe(3); // full-chain length, not windowed count

    const reopened = TrustBudgetLedger.open({ totalRisk: 1, window: { kind: "fixed-ms", ms: WINDOW_MS }, path, now: clock.now });
    expect(reopened.verifyChain()).toEqual({ ok: true, length: 3 });
    expect(reopened.entries()).toHaveLength(3);
  });

  it("rollWindow(at) explicitly advances a fixed-ms window and refuses to move it backward", () => {
    const clock = manualClock(0);
    const ledger = TrustBudgetLedger.open({ totalRisk: 1, window: { kind: "fixed-ms", ms: 1000 }, now: clock.now });

    ledger.spend({ domain: "tool", taskId: "t1", risk: 0.9, subjectSha256: subjectHash("a"), issuedAt: clock.now() });
    ledger.rollWindow(500);
    expect(ledger.report().windowStartedAt).toBe(500);
    expect(ledger.report().spentRisk).toBe(0); // 0.9 entry's issuedAt (0) < new windowStartedAt (500)

    ledger.rollWindow(100); // backward — must be ignored
    expect(ledger.report().windowStartedAt).toBe(500);
  });
});

// ===========================================================================
// (6) Exhaustion behavior
// ===========================================================================

describe("TrustBudgetLedger — exhaustion behavior", () => {
  it("once globally exhausted, quote returns allowed:false with a stable reason string", () => {
    const clock = manualClock();
    const ledger = TrustBudgetLedger.open({ totalRisk: 0.5, window: { kind: "session" }, now: clock.now });

    ledger.spend({ domain: "tool", taskId: "t1", risk: 0.5, subjectSha256: subjectHash("a"), issuedAt: clock.now() });

    const q1 = ledger.quote({ domain: "tool", taskId: "t2", risk: 0.01 });
    const q2 = ledger.quote({ domain: "memory", taskId: "t3", risk: 0.001 });
    expect(q1.allowed).toBe(false);
    expect(q2.allowed).toBe(false);
    expect(q1.reason).toBe("trust budget exhausted");
    expect(q1.reason).toBe(q2.reason); // stable across calls/domains
    expect(ledger.report().exhausted).toBe(true);
  });

  it("global exhaustion blocks every domain, including ones with untouched per-domain caps", () => {
    const clock = manualClock();
    const ledger = TrustBudgetLedger.open({
      totalRisk: 0.2,
      window: { kind: "session" },
      perDomainCaps: { tool: 10, memory: 10 },
      now: clock.now,
    });

    ledger.spend({ domain: "tool", taskId: "t1", risk: 0.2, subjectSha256: subjectHash("a"), issuedAt: clock.now() });

    expect(ledger.quote({ domain: "tool", taskId: "t2", risk: 0.01 }).allowed).toBe(false);
    expect(ledger.quote({ domain: "memory", taskId: "t3", risk: 0.01 }).allowed).toBe(false); // untouched domain, still blocked
  });

  it("per-domain exhaustion blocks only that domain while other domains keep spending", () => {
    const clock = manualClock();
    const ledger = TrustBudgetLedger.open({
      totalRisk: 10,
      window: { kind: "session" },
      perDomainCaps: { tool: 0.2, memory: 5 },
      now: clock.now,
    });

    ledger.spend({ domain: "tool", taskId: "t1", risk: 0.2, subjectSha256: subjectHash("a"), issuedAt: clock.now() });

    const toolQuote = ledger.quote({ domain: "tool", taskId: "t2", risk: 0.01 });
    expect(toolQuote.allowed).toBe(false);
    expect(toolQuote.reason).toMatch(/tool/);

    const memoryQuote = ledger.quote({ domain: "memory", taskId: "t3", risk: 2 });
    expect(memoryQuote.allowed).toBe(true);
    const memorySpend = ledger.spend({ domain: "memory", taskId: "t3", risk: 2, subjectSha256: subjectHash("b"), issuedAt: clock.now() });
    expect(memorySpend.accepted).toBe(true);

    const report = ledger.report();
    expect(report.perDomain.tool!.remaining).toBeCloseTo(0, 9);
    expect(report.perDomain.memory!.remaining).toBeCloseTo(3, 12);
    expect(report.exhausted).toBe(false); // global budget (10) still has plenty of room
  });
});

// ===========================================================================
// (7) Durability
// ===========================================================================

describe("TrustBudgetLedger — durability", () => {
  it("kill-and-reopen after each of 20 spends reconstructs identical state and an identical chainHead", () => {
    const clock = manualClock();
    const path = tempPath("durable-budget.json");
    let expectedTotal = 0;
    let lastHead = TRUST_BUDGET_GENESIS;

    for (let i = 0; i < 20; i++) {
      const ledger = TrustBudgetLedger.open({ totalRisk: 100, window: { kind: "session" }, path, now: clock.now });
      // Before this spend, the reopened ledger must already match everything so far.
      expect(ledger.report().spentRisk).toBeCloseTo(expectedTotal, 9);
      expect(ledger.report().chainHead).toBe(lastHead);
      expect(ledger.verifyChain()).toEqual({ ok: true, length: i });

      const risk = 0.01 * (i + 1);
      const result = ledger.spend({
        domain: "tool",
        taskId: `durable-${i}`,
        risk,
        subjectSha256: subjectHash(`durable-${i}`),
        issuedAt: clock.now(),
      });
      expect(result.accepted).toBe(true);
      expectedTotal += risk;
      lastHead = result.entrySha256;
      clock.advance(1);
    }

    const final = TrustBudgetLedger.open({ totalRisk: 100, window: { kind: "session" }, path, now: clock.now });
    expect(final.entries()).toHaveLength(20);
    expect(final.report().spentRisk).toBeCloseTo(expectedTotal, 9);
    expect(final.report().chainHead).toBe(lastHead);
    expect(final.verifyChain()).toEqual({ ok: true, length: 20 });
  });

  it("a truncated/half-written file is detected as malformed, not parsed into a smaller budget", () => {
    const clock = manualClock();
    const path = tempPath("truncated-budget.json");
    const seedLedger = TrustBudgetLedger.open({ totalRisk: 10, window: { kind: "session" }, path, now: clock.now });
    seedLedger.spend({ domain: "tool", taskId: "t1", risk: 0.5, subjectSha256: subjectHash("a"), issuedAt: clock.now() });
    seedLedger.spend({ domain: "tool", taskId: "t2", risk: 0.5, subjectSha256: subjectHash("b"), issuedAt: clock.now() });

    const full = readFileSync(path, "utf8");
    writeFileSync(path, full.slice(0, Math.floor(full.length / 2)), "utf8"); // simulate a crash mid-write

    const reopened = TrustBudgetLedger.open({ totalRisk: 10, window: { kind: "session" }, path, now: clock.now });
    const verification = reopened.verifyChain();
    expect(verification.ok).toBe(false);
    expect(verification.reason).toBe("malformed");

    // Never silently parsed into "1 entry" or "0 entries and a fresh 10 remaining" — refuses instead.
    expect(reopened.quote({ domain: "tool", taskId: "t3", risk: 0.01 }).allowed).toBe(false);
    expect(reopened.report().exhausted).toBe(true);
  });

  it("an unparseable (non-JSON) file is detected as malformed and refuses to spend", () => {
    const clock = manualClock();
    const path = tempPath("garbage-budget.json");
    writeFileSync(path, "{not: valid json at all", "utf8");

    const ledger = TrustBudgetLedger.open({ totalRisk: 10, window: { kind: "session" }, path, now: clock.now });
    expect(ledger.verifyChain()).toEqual({ ok: false, length: 0, reason: "malformed" });
    expect(ledger.quote({ domain: "tool", taskId: "t1", risk: 0.01 }).allowed).toBe(false);
  });

  it("a missing file is a genuinely fresh, empty, spendable ledger (not treated as tampered)", () => {
    const clock = manualClock();
    const path = tempPath("does-not-exist-yet.json");
    const ledger = TrustBudgetLedger.open({ totalRisk: 1, window: { kind: "session" }, path, now: clock.now });

    expect(ledger.verifyChain()).toEqual({ ok: true, length: 0 });
    expect(ledger.quote({ domain: "tool", taskId: "t1", risk: 0.5 }).allowed).toBe(true);
  });

  it("flush() durably writes in-memory state even without an intervening spend", () => {
    const clock = manualClock();
    const path = tempPath("flush-budget.json");
    const ledger = TrustBudgetLedger.open({ totalRisk: 1, window: { kind: "session" }, path, now: clock.now });
    ledger.spend({ domain: "tool", taskId: "t1", risk: 0.2, subjectSha256: subjectHash("a"), issuedAt: clock.now() });
    ledger.flush();

    const onDisk = JSON.parse(readFileSync(path, "utf8"));
    expect(onDisk.entries).toHaveLength(1);
    expect(onDisk.genesis).toBe(TRUST_BUDGET_GENESIS);
    expect(onDisk.version).toBe(1);
  });
});

// ===========================================================================
// (8) Exact accounting + terminal-text formatting
// ===========================================================================

describe("TrustBudgetLedger — report() exact accounting and formatTrustBudgetReport()", () => {
  it("spent + remaining === total within a float epsilon, across many small spends", () => {
    const clock = manualClock();
    const ledger = TrustBudgetLedger.open({ totalRisk: 1, window: { kind: "session" }, now: clock.now });

    for (let i = 0; i < 37; i++) {
      ledger.spend({
        domain: "tool",
        taskId: `frac-${i}`,
        risk: 1 / 137,
        subjectSha256: subjectHash(`frac-${i}`),
        issuedAt: clock.now(),
      });
    }

    const report = ledger.report();
    expect(report.spentRisk + report.remainingRisk).toBeCloseTo(report.totalRisk, 9);
  });

  it("formatTrustBudgetReport renders aligned, non-HTML terminal text with the key figures", () => {
    const clock = manualClock(5_000_000);
    const ledger = TrustBudgetLedger.open({
      totalRisk: 1,
      window: { kind: "session" },
      perDomainCaps: { tool: 0.5 },
      now: clock.now,
    });
    ledger.spend({ domain: "tool", taskId: "t1", risk: 0.25, subjectSha256: subjectHash("a"), issuedAt: clock.now() });

    const text = formatTrustBudgetReport(ledger.report());

    expect(text).not.toMatch(/<[a-z][\s\S]*>/i); // no HTML tags
    expect(text).toContain("TRUST BUDGET");
    expect(text).toContain("total risk");
    expect(text).toContain("spent risk");
    expect(text).toContain("remaining");
    expect(text).toContain(TRUST_BUDGET_GENESIS);
    expect(text).toContain("tool");

    const lines = text.split("\n");
    expect(lines.length).toBeGreaterThan(5);
  });

  it("formatTrustBudgetReport reflects an exhausted ledger's status", () => {
    const clock = manualClock();
    const ledger = TrustBudgetLedger.open({ totalRisk: 0.1, window: { kind: "session" }, now: clock.now });
    ledger.spend({ domain: "tool", taskId: "t1", risk: 0.1, subjectSha256: subjectHash("a"), issuedAt: clock.now() });

    const text = formatTrustBudgetReport(ledger.report());
    expect(text).toContain("EXHAUSTED");
  });
});

// ===========================================================================
// TRUST_BUDGET_GENESIS + structural compatibility with T3's TrustBudgetPort
// ===========================================================================

describe("TrustBudgetLedger — genesis constant and TrustBudgetPort structural compatibility", () => {
  it("TRUST_BUDGET_GENESIS is exactly sha256Hex of the documented literal", () => {
    expect(TRUST_BUDGET_GENESIS).toBe(sha256Hex("hades.trust.budget.v1"));
    expect(TRUST_BUDGET_GENESIS).toHaveLength(64);
  });

  it("quote/spend are structurally usable as a TrustBudgetPort (duck-typed, no import of unified-gate)", () => {
    interface TrustBudgetPort {
      quote(req: { domain: string; taskId: string; risk: number }): { allowed: boolean; reason?: string; remaining: number };
      spend(req: { domain: string; taskId: string; risk: number; subjectSha256: string; issuedAt: number }): {
        accepted: boolean;
        remaining: number;
        entrySha256: string;
      };
    }

    const clock = manualClock();
    const ledger = TrustBudgetLedger.open({ totalRisk: 1, window: { kind: "session" }, now: clock.now });
    const port: TrustBudgetPort = ledger; // compiles only if the shapes are byte-identical

    const q = port.quote({ domain: "tool", taskId: "t1", risk: 0.1 });
    expect(q.allowed).toBe(true);
    const s = port.spend({ domain: "tool", taskId: "t1", risk: 0.1, subjectSha256: subjectHash("a"), issuedAt: clock.now() });
    expect(s.accepted).toBe(true);
  });
});
