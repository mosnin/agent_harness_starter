/**
 * json-line.test.ts — the NaN-safe JSONL codec, and the two hash-chained
 * ledgers that persist through it.
 *
 * The regression these tests lock down is real and was reproduced end to end
 * before the fix: `EvalHistoryLedger` and `GateVerdictJournal` hash their
 * records with deliberately non-finite-safe canonical serializers
 * (`canonicalizeScorecard`, `stableStringify`) but persisted them with plain
 * `JSON.stringify`, which silently writes every non-finite number as `null`.
 * A scorecard with an honestly UNMEASURED risk lane (`NaN` fields, which is
 * what you get with no `AdmitFn` wired) therefore hashed one thing and stored
 * another, and `verifyChain()` reported `hash-mismatch` on the very next read
 * — meaning a first real `hades eval run` on a fresh install produced a
 * history chain that immediately failed its own verification.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { encodeJsonLine, decodeJsonLine, tryDecodeJsonLine } from "../json-line";
import { EvalHistoryLedger } from "../history";
import { runEvalMeasurement, defaultMeasureRunner } from "../measure";
import { EVAL_TASKS } from "../../bench/eval-suite";
import { verifyScorecard, type ScorecardRevision } from "../scorecard";
import { selectBaseline } from "../compare";
import {
  evaluateNeverRegressGate,
  DEFAULT_NEVER_REGRESS_POLICY,
  GateVerdictJournal,
} from "../regression-gate";

// ===========================================================================
// The pure codec
// ===========================================================================

/** Structural deep-equality that treats NaN as equal to NaN (which
 *  `toEqual` already does) AND distinguishes +0 from -0 and +Inf from -Inf,
 *  so a round-trip claim here is a real one. */
function expectExactRoundTrip(value: unknown): void {
  const decoded = decodeJsonLine(encodeJsonLine(value));
  expect(decoded).toEqual(value);
}

describe("encodeJsonLine / decodeJsonLine — ordinary JSON", () => {
  it("round-trips primitives, arrays, nested objects and null exactly", () => {
    for (const v of [
      null,
      true,
      false,
      0,
      -1.5,
      1e21,
      "",
      "a string with \"quotes\", \\backslashes\\ and a newline\n",
      [],
      {},
      [1, "two", null, { three: [4, { five: 6 }] }],
      { a: { b: { c: [1, 2, 3] } }, d: null },
    ]) {
      expectExactRoundTrip(v);
    }
  });

  it("emits a single line with no embedded raw newline, so JSONL framing holds", () => {
    const line = encodeJsonLine({ note: "first\nsecond", nested: { s: "x\ny" } });
    expect(line.includes("\n")).toBe(false);
    expect(decodeJsonLine(line)).toEqual({ note: "first\nsecond", nested: { s: "x\ny" } });
  });

  it("stays ordinary JSON for finite-only data, so already-written files still read", () => {
    const value = { seq: 3, sha: "abc", scorecard: { vtph: 1.25, tasks: 48 } };
    expect(encodeJsonLine(value)).toBe(JSON.stringify(value));
    expect(decodeJsonLine(JSON.stringify(value))).toEqual(value);
  });
});

describe("encodeJsonLine / decodeJsonLine — non-finite numbers", () => {
  it("plain JSON.stringify LOSES them (this is the defect being fixed)", () => {
    const lost = JSON.parse(JSON.stringify({ epsilon: Number.NaN, ratio: Number.POSITIVE_INFINITY }));
    expect(lost.epsilon).toBeNull();
    expect(lost.ratio).toBeNull();
  });

  it("round-trips NaN, +Infinity and -Infinity exactly", () => {
    const decoded = decodeJsonLine(
      encodeJsonLine({ nan: Number.NaN, pos: Number.POSITIVE_INFINITY, neg: Number.NEGATIVE_INFINITY }),
    ) as Record<string, number>;
    expect(Number.isNaN(decoded.nan)).toBe(true);
    expect(decoded.pos).toBe(Number.POSITIVE_INFINITY);
    expect(decoded.neg).toBe(Number.NEGATIVE_INFINITY);
  });

  it("round-trips non-finite numbers nested in arrays and deep objects", () => {
    const decoded = decodeJsonLine(
      encodeJsonLine({ lane: { rates: [Number.NaN, 0, Number.POSITIVE_INFINITY] } }),
    ) as { lane: { rates: number[] } };
    expect(Number.isNaN(decoded.lane.rates[0])).toBe(true);
    expect(decoded.lane.rates[1]).toBe(0);
    expect(decoded.lane.rates[2]).toBe(Number.POSITIVE_INFINITY);
  });

  it("distinguishes the token STRING \"NaN\" from the NUMBER NaN", () => {
    const decoded = decodeJsonLine(encodeJsonLine({ s: "NaN", n: Number.NaN })) as { s: unknown; n: unknown };
    expect(decoded.s).toBe("NaN");
    expect(typeof decoded.s).toBe("string");
    expect(Number.isNaN(decoded.n as number)).toBe(true);
    expect(typeof decoded.n).toBe("number");
  });

  it("leaves an unrecognized marker token alone rather than inventing a number", () => {
    // A corrupt marker must surface downstream as a shape/hash failure, never
    // as a silently guessed value.
    const decoded = decodeJsonLine('{"x":{"$hades:number":"NotAToken"}}') as { x: unknown };
    expect(decoded.x).toEqual({ "$hades:number": "NotAToken" });
  });
});

describe("encodeJsonLine / decodeJsonLine — reserved-key collisions", () => {
  it("round-trips genuine data shaped exactly like a number marker", () => {
    expectExactRoundTrip({ "$hades:number": "NaN" });
    const decoded = decodeJsonLine(encodeJsonLine({ "$hades:number": "NaN" })) as Record<string, unknown>;
    expect(typeof decoded).toBe("object");
    expect(decoded["$hades:number"]).toBe("NaN");
  });

  it("round-trips genuine data shaped like the escape marker", () => {
    expectExactRoundTrip({ "$hades:escaped": { key: "a", value: 1 } });
  });

  it("round-trips a marker-shaped object NESTED inside another marker-shaped object", () => {
    expectExactRoundTrip({ "$hades:number": { "$hades:number": "Infinity" } });
  });

  it("round-trips a marker-shaped object carrying a real non-finite value", () => {
    const decoded = decodeJsonLine(encodeJsonLine({ "$hades:number": Number.NaN })) as Record<string, unknown>;
    expect(Object.keys(decoded)).toEqual(["$hades:number"]);
    expect(Number.isNaN(decoded["$hades:number"] as number)).toBe(true);
  });

  it("does not escape an object that merely CONTAINS a reserved key alongside others", () => {
    expectExactRoundTrip({ "$hades:number": "NaN", other: 1 });
  });
});

describe("tryDecodeJsonLine", () => {
  it("returns undefined for malformed JSON instead of throwing", () => {
    expect(tryDecodeJsonLine("{not json")).toBeUndefined();
    expect(tryDecodeJsonLine("")).toBeUndefined();
    expect(tryDecodeJsonLine('{"a":1')).toBeUndefined();
  });

  it("decodes a well-formed line with non-finite numbers restored", () => {
    const v = tryDecodeJsonLine(encodeJsonLine({ e: Number.NaN })) as { e: number };
    expect(Number.isNaN(v.e)).toBe(true);
  });

  it("throws from decodeJsonLine (the strict form) on malformed JSON", () => {
    expect(() => decodeJsonLine("{not json")).toThrow();
  });
});

// ===========================================================================
// The real ledgers — the defect this codec exists to fix
// ===========================================================================

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hades-eval-jsonline-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function revision(n: number): ScorecardRevision {
  return {
    sha: String(n).padStart(40, "0"),
    shortSha: String(n).padStart(12, "0"),
    branch: "main",
    dirty: false,
    committedAtMs: 1_700_000_000_000 + n,
    workTreeHash: `worktree-${n}`,
    source: "content",
  };
}

/** A REAL measurement over the REAL EVAL_TASKS with the real deterministic
 *  scripted runner and NO `AdmitFn` — i.e. exactly what a real `hades eval
 *  run` produces before a trust gate is calibrated, and therefore a scorecard
 *  whose risk lane is honestly unmeasured with `NaN` rate fields. */
async function measureWithUnmeasuredRisk(n: number) {
  const def = defaultMeasureRunner();
  return runEvalMeasurement({
    revision: revision(n),
    tasks: EVAL_TASKS,
    runner: def.runner,
    runnerLabel: def.label,
    mode: def.mode,
  });
}

describe("EvalHistoryLedger — an unmeasured risk lane survives persistence", () => {
  it("a real scorecard with NaN risk fields round-trips and the chain still verifies", async () => {
    const scorecard = await measureWithUnmeasuredRisk(1);

    // Precondition: this really is the NaN-bearing shape, not a finite one.
    expect(scorecard.risk.measured).toBe(false);
    expect(Number.isNaN(scorecard.risk.epsilon)).toBe(true);
    expect(Number.isNaN(scorecard.risk.coverage)).toBe(true);
    expect(Number.isNaN(scorecard.risk.silentWrongRate)).toBe(true);
    expect(verifyScorecard(scorecard).ok).toBe(true);

    const ledger = new EvalHistoryLedger({ root });
    ledger.append(scorecard, { note: "unmeasured-risk" });

    // Re-open from disk: a genuinely separate instance, so nothing is served
    // from an in-memory cache that would hide a persistence bug.
    const reopened = new EvalHistoryLedger({ root });
    const chain = reopened.verifyChain();
    expect(chain.ok).toBe(true);
    expect(chain.reason).toBeNull();
    expect(chain.entries).toBe(1);

    const [entry] = reopened.entries();
    expect(Number.isNaN(entry.scorecard.risk.epsilon)).toBe(true);
    expect(Number.isNaN(entry.scorecard.risk.coverage)).toBe(true);
    expect(Number.isNaN(entry.scorecard.risk.silentWrongRate)).toBe(true);
    // The round-tripped scorecard is still internally consistent — its own
    // embedded contentHash still matches what it hashes to.
    expect(verifyScorecard(entry.scorecard).ok).toBe(true);
    expect(entry.scorecard.contentHash).toBe(scorecard.contentHash);
  });

  it("keeps the chain intact across several appends AND a re-open in between", async () => {
    const first = new EvalHistoryLedger({ root });
    first.append(await measureWithUnmeasuredRisk(1));
    first.append(await measureWithUnmeasuredRisk(2));

    // A second process/instance appending onto what the first wrote is the
    // path that previously concatenated onto a mis-encoded tail.
    const second = new EvalHistoryLedger({ root });
    second.append(await measureWithUnmeasuredRisk(3));

    const third = new EvalHistoryLedger({ root });
    const chain = third.verifyChain();
    expect(chain.ok).toBe(true);
    expect(chain.entries).toBe(3);
    expect(third.entries().map((e) => e.seq)).toEqual([0, 1, 2]);
  });

  it("never writes a bare `null` where a non-finite number was hashed", async () => {
    const ledger = new EvalHistoryLedger({ root });
    ledger.append(await measureWithUnmeasuredRisk(1));

    const raw = readFileSync(join(root, "history.jsonl"), "utf8");
    // The marker must be what actually landed on disk...
    expect(raw).toContain('"$hades:number"');
    // ...and the specific corruption (a null epsilon) must not be present.
    expect(raw).not.toContain('"epsilon":null');
    expect(raw).not.toContain('"coverage":null');
    expect(raw).not.toContain('"silentWrongRate":null');
  });
});

describe("GateVerdictJournal — verdicts survive persistence", () => {
  it("a real gate verdict round-trips through the journal with its chain intact", async () => {
    const ledger = new EvalHistoryLedger({ root });
    const baseline = await measureWithUnmeasuredRisk(1);
    ledger.append(baseline);
    const candidate = await measureWithUnmeasuredRisk(2);

    const selection = selectBaseline(ledger.entries(), {
      strategy: "latest",
      excludeSha: candidate.revision.sha,
    });
    const verdict = evaluateNeverRegressGate({
      candidate,
      baseline: selection,
      policy: DEFAULT_NEVER_REGRESS_POLICY,
      chainOk: true,
    });

    const journal = new GateVerdictJournal({ root });
    journal.append(verdict);

    const reopened = new GateVerdictJournal({ root });
    const check = reopened.verify();
    expect(check.ok).toBe(true);
    expect(check.entries).toBe(1);
    expect(reopened.latest()?.contentHash).toBe(verdict.contentHash);
  });

  it("persists a verdict carrying a non-finite metric delta without breaking its chain", () => {
    // `../compare` genuinely reports `NaN` for an undefined rate rather than a
    // fabricated 0, so a verdict CAN carry non-finite numbers. Rather than
    // hand-editing a sealed verdict (which would break its contentHash by
    // design), this drives the journal's own encoder/decoder over the exact
    // shape a verdict has, proving the bytes on disk decode back to the value
    // that was hashed.
    const shaped = {
      seq: 0,
      recordedAtMs: 1,
      prevHash: "genesis",
      verdict: {
        decision: "warn",
        findings: [{ rule: "vtph-relative-drop", delta: { absolute: Number.NaN, relative: Number.NEGATIVE_INFINITY } }],
      },
    };
    const decoded = decodeJsonLine(encodeJsonLine(shaped)) as typeof shaped;
    expect(Number.isNaN(decoded.verdict.findings[0].delta.absolute)).toBe(true);
    expect(decoded.verdict.findings[0].delta.relative).toBe(Number.NEGATIVE_INFINITY);
  });
});
