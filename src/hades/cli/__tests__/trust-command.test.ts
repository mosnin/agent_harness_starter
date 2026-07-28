/**
 * `hades trust` CLI tests.
 *
 * Every case drives the REAL command over a REAL stack in a REAL temp data
 * dir — real ed25519 keys, the real hash-chained ledger, the real
 * ConformalGate, the real verifier registry and the real EVAL_TASKS corpus.
 * Nothing is stubbed except the clock and, where a file-read failure is the
 * subject under test, the injected `readFile`/`fileExists` hooks.
 */

import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runTrustCommand, defaultTrustDeps, TRUST_USAGE, type TrustCommandDeps } from "../trust-command";
import { HadesCli } from "../cli";
import { openTrustStack, trustRoot, type TrustStack } from "../../trust/wiring";
import type { CalibrationPoint } from "../../styx/gate";
import { ProvenanceLedger } from "../../exec/provenance";
import { sha256Hex } from "../../styx/certificate";

/**
 * A REAL, fully JSON-expressible `tool` subject drawing TWO real verifiers:
 * `verify.shell` (via `evidence.toolResult`) and `verify.exec-provenance`
 * (via `evidence.ledgerJSON`, produced by a REAL `ProvenanceLedger`).
 *
 * This is the shape a subject file can actually carry. Note the contrast
 * with the `memory` domain: `verify.user-model` only claims a subject whose
 * `evidence.model` has a callable `.all()`, and a function cannot survive
 * JSON — so a memory subject loaded from a file draws exactly ONE verifier
 * and is always "degraded-evidence". That is a real property of the
 * file-driven surface, asserted below rather than worked around.
 */
function toolSubjectJson(): Record<string, unknown> {
  const input = "echo hi";
  const output = '{"ok":true}';
  const ledger = new ProvenanceLedger();
  ledger.append({
    seq: 1,
    tool: "shell",
    inputSha256: sha256Hex(input),
    outputSha256: sha256Hex(output),
    ok: true,
    startedAt: 0,
    elapsedMs: 1,
  });
  return {
    domain: "tool",
    subjectId: "shell",
    taskId: "task-abc",
    input,
    output,
    evidence: { toolResult: { ok: true, output }, ledgerJSON: ledger.toJSON() },
    trace: [{ seq: 1, kind: "shell", detail: output }],
  };
}

const noEnv = {} as NodeJS.ProcessEnv;

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "hades-trust-cli-"));
}

/** Deps over one REAL stack rooted in a fresh temp data dir. */
function realDeps(overrides: Partial<TrustCommandDeps> = {}): { deps: TrustCommandDeps; dataDir: string; stack: TrustStack } {
  const dataDir = tempDir();
  const stack = openTrustStack({ dataDir, env: noEnv, now: () => 1_000, epsilon: 0.2 });
  return { deps: { stack: () => stack, ...overrides }, dataDir, stack };
}

/** Real labeled observations with genuine separation, as an operator would
 *  supply from a graded run. The FIT is done by the real ConformalGate. */
function separatingPoints(): CalibrationPoint[] {
  const points: CalibrationPoint[] = [];
  for (let i = 0; i < 30; i++) points.push({ score: 0.9, correct: true });
  for (let i = 0; i < 30; i++) points.push({ score: 0.1, correct: false });
  return points;
}

function text(lines: string[]): string {
  return lines.join("\n");
}

describe("hades trust — routing and help", () => {
  it("returns usage for help/no-args and rejects an unknown subcommand", async () => {
    const { deps } = realDeps();
    for (const argv of [[], ["help"], ["--help"], ["-h"]]) {
      const res = await runTrustCommand(argv, deps);
      expect(res.code).toBe(0);
      expect(res.lines).toEqual(TRUST_USAGE);
    }
    const bad = await runTrustCommand(["nope"], deps);
    expect(bad.code).toBe(1);
    expect(bad.lines[0]).toContain("Unknown trust command: nope");
  });

  it("is reachable through the real `hades` router without touching disk for help", async () => {
    // The route must exist AND stay lazy: building the CLI and asking for
    // help must not mint a signing key or open a ledger.
    let built = 0;
    const { deps } = realDeps();
    const cli = new HadesCli({
      trust: () => {
        built += 1;
        return deps;
      },
    });

    const help = await cli.run(["help"]);
    expect(help.code).toBe(0);
    expect(text(help.lines)).toContain("trust <sub>");
    expect(built).toBe(0);

    const res = await cli.run(["trust", "verifiers"]);
    expect(res.code).toBe(0);
    expect(built).toBe(1);
    expect(text(res.lines)).toContain("verify.procedure-run");

    // The deps factory is CACHED — one stack per process, so `calibrate`
    // then `admit` share a registry, a key and a budget chain.
    await cli.run(["trust", "budget"]);
    expect(built).toBe(1);
  });

  it("does not collide with the pre-existing `hades skill trust` subcommand", async () => {
    const { deps } = realDeps();
    const cli = new HadesCli({ trust: () => deps });
    const top = await cli.run(["trust", "verifiers"]);
    expect(text(top.lines)).toContain("REGISTERED VERIFIERS");
    // `hades skill trust` still routes to the skill-evolution command.
    const skill = await cli.run(["skill", "trust", "show"]);
    expect(text(skill.lines)).not.toContain("REGISTERED VERIFIERS");
  });
});

describe("hades trust verifiers", () => {
  it("lists every REAL registered verifier with its registered tier and prior", async () => {
    const { deps } = realDeps();
    const res = await runTrustCommand(["verifiers"], deps);
    expect(res.code).toBe(0);
    const out = text(res.lines);
    for (const id of [
      "verify.shell",
      "verify.browser",
      "verify.exec-provenance",
      "verify.memory-write",
      "verify.user-model",
      "verify.outbound-message",
      "verify.procedure-run",
    ]) {
      expect(out).toContain(id);
    }
    expect(out).toContain("prior is a HARD ceiling");
    expect(out).not.toMatch(/<[a-z]+>/i); // never HTML
  });

  it("--json emits the real calibration values, and --domain filters", async () => {
    const { deps, stack } = realDeps();
    const res = await runTrustCommand(["verifiers", "--domain", "memory", "--json"], deps);
    const parsed = JSON.parse(text(res.lines)) as { id: string; tier: string; prior: number }[];
    expect(parsed.map((v) => v.id).sort()).toEqual(["verify.memory-write", "verify.user-model"]);
    // Values match the live registry exactly — no re-derivation in the CLI.
    for (const row of parsed) {
      const live = stack.registry.list().find((v) => v.id === row.id)!;
      expect(row.tier).toBe(live.tier);
      expect(row.prior).toBe(live.prior);
    }
  });

  it("rejects an unknown --domain instead of silently listing everything", async () => {
    const { deps } = realDeps();
    const res = await runTrustCommand(["verifiers", "--domain", "sideways"], deps);
    expect(res.code).toBe(1);
    expect(res.lines[0]).toContain("unknown domain");
  });
});

describe("hades trust status", () => {
  it("reports every domain uncalibrated on a fresh install, with the consequence spelled out", async () => {
    const { deps } = realDeps();
    const res = await runTrustCommand(["status"], deps);
    expect(res.code).toBe(0);
    const out = text(res.lines);
    expect(out).toContain("UNIFIED TRUST GATE");
    // The consequence, not just the state.
    expect(out).toContain("uncalibrated — gate abstains");
    expect(out).toContain("TRUST BUDGET");
    expect(out).toContain("chain         VERIFIED");
    expect(out).not.toMatch(/<\/?(div|span|table|html)/i);
  });

  it("flags an admit-nothing threshold rather than showing a tidy number", async () => {
    const { deps, stack } = realDeps();
    // Every point identical -> no separation -> the real fit returns +Infinity.
    stack.gate.calibrate(
      "memory",
      Array.from({ length: 40 }, (_, i) => ({ score: 0.5, correct: i % 2 === 0 })),
    );
    const res = await runTrustCommand(["status"], deps);
    const out = text(res.lines);
    expect(out).toContain("+Inf");
    expect(out).toContain("abstains on everything");
  });

  it("--json carries the real key source and public half, never the private key", async () => {
    const { deps, stack } = realDeps();
    const res = await runTrustCommand(["status", "--json"], deps);
    const parsed = JSON.parse(text(res.lines)) as {
      key: { source: string; publicKeyHex: string };
      verifiers: number;
    };
    expect(parsed.key.source).toBe("generated");
    expect(parsed.key.publicKeyHex).toBe(stack.key.publicKeyHex);
    expect(text(res.lines)).not.toContain(stack.key.privateKeyHex);
    expect(parsed.verifiers).toBe(stack.registry.list().length);
  });
});

describe("hades trust calibrate", () => {
  it("refuses to guess a source", async () => {
    const { deps } = realDeps();
    const res = await runTrustCommand(["calibrate"], deps);
    expect(res.code).toBe(1);
    expect(res.lines[0]).toContain("nothing to calibrate from");
  });

  it("refuses --from-eval and --from together", async () => {
    const { deps } = realDeps();
    const res = await runTrustCommand(["calibrate", "--from-eval", "--from", "x.json"], deps);
    expect(res.code).toBe(1);
    expect(res.lines[0]).toContain("not both");
  });

  it("--from-eval fits the REAL corpus and reports PARTIAL separation honestly", async () => {
    const { deps, dataDir } = realDeps();
    const res = await runTrustCommand(["calibrate", "--from-eval"], deps);
    expect(res.code).toBe(0);
    const out = text(res.lines);
    expect(out).toContain('domain "procedure"');
    // The T1-reference verifier decides the corpus tasks whose answer is
    // recomputable from their own prompt, so AUC is no longer the 0.5 of a
    // purely structural verifier set. It is also not 1.0: on every task
    // nothing can decide, a wrong answer still scores structurally perfect —
    // so the conformal fit STILL cannot place a finite threshold at this
    // epsilon, and the report must keep saying so.
    const auc = /AUC \(correct > wrong\) ([0-9.]+)/.exec(out);
    expect(auc).not.toBeNull();
    expect(Number(auc?.[1])).toBeGreaterThan(0.5);
    expect(Number(auc?.[1])).toBeLessThan(1);
    expect(out).toContain("+Infinity");
    expect(out).toContain("THRESHOLD IS +INFINITY");
    // Provenance must state the solvers are not model calls.
    expect(out).toContain("NOT model calls");
    expect(out).toContain(trustRoot(dataDir));
  });

  it("--dry-run persists nothing", async () => {
    const { deps, stack } = realDeps();
    const res = await runTrustCommand(["calibrate", "--from-eval", "--dry-run"], deps);
    expect(res.code).toBe(0);
    expect(text(res.lines)).toContain("DRY RUN — nothing persisted");
    expect(stack.calibration.points("procedure")).toEqual([]);
  });

  it("--from-eval refuses to invent labeled data for a non-procedure domain", async () => {
    const { deps } = realDeps();
    const res = await runTrustCommand(["calibrate", "--from-eval", "--domain", "memory"], deps);
    expect(res.code).toBe(1);
    expect(res.lines[0]).toContain("cannot produce labeled data");
  });

  it("--from <file> fits real operator points and persists them", async () => {
    const { deps, stack } = realDeps();
    const file = join(tempDir(), "points.json");
    writeFileSync(file, JSON.stringify(separatingPoints()), "utf8");

    const res = await runTrustCommand(["calibrate", "--from", file, "--domain", "memory"], deps);
    expect(res.code).toBe(0);
    const out = text(res.lines);
    expect(out).toContain("AUC (correct > wrong) 1.0000");
    expect(out).toContain("strong separation");
    expect(out).not.toContain("+Infinity");
    expect(stack.calibration.points("memory")).toHaveLength(60);
    expect(stack.calibration.provenance("memory")).toContain(file);
  });

  it("--from requires a domain and reports a missing/invalid file honestly", async () => {
    const { deps } = realDeps();
    const noDomain = await runTrustCommand(["calibrate", "--from", "x.json"], deps);
    expect(noDomain.code).toBe(1);
    expect(noDomain.lines[0]).toContain("needs --domain");

    const missing = await runTrustCommand(["calibrate", "--from", "/nope/x.json", "--domain", "memory"], deps);
    expect(missing.code).toBe(1);
    expect(missing.lines[0]).toContain("calibration file not found");

    const bad = join(tempDir(), "bad.json");
    writeFileSync(bad, "{ not json", "utf8");
    const invalid = await runTrustCommand(["calibrate", "--from", bad, "--domain", "memory"], deps);
    expect(invalid.code).toBe(1);
    expect(invalid.lines[0]).toContain("not valid JSON");
  });

  it("rejects an unlabeled or non-finite point rather than fitting on it", async () => {
    const { deps, stack } = realDeps();
    const file = join(tempDir(), "points.json");

    writeFileSync(file, JSON.stringify([{ score: 0.5 }]), "utf8");
    const unlabeled = await runTrustCommand(["calibrate", "--from", file, "--domain", "memory"], deps);
    expect(unlabeled.code).toBe(1);
    expect(unlabeled.lines[0]).toContain('non-boolean "correct"');

    writeFileSync(file, JSON.stringify([{ score: "high", correct: true }]), "utf8");
    const badScore = await runTrustCommand(["calibrate", "--from", file, "--domain", "memory"], deps);
    expect(badScore.code).toBe(1);
    expect(badScore.lines[0]).toContain('non-finite "score"');

    expect(stack.calibration.points("memory")).toEqual([]);
  });

  it("does NOT persist a point set the real ConformalGate refuses", async () => {
    const { deps, stack } = realDeps();
    const file = join(tempDir(), "tiny.json");
    writeFileSync(file, JSON.stringify([{ score: 0.9, correct: true }]), "utf8");

    const res = await runTrustCommand(["calibrate", "--from", file, "--domain", "memory"], deps);
    expect(res.code).toBe(1);
    expect(text(res.lines)).toContain("FIT REFUSED");
    expect(text(res.lines)).toContain("Nothing was persisted");
    expect(stack.calibration.points("memory")).toEqual([]);
  });
});

describe("hades trust admit", () => {
  const subject = {
    domain: "memory",
    subjectId: "fact-1",
    taskId: "t-1",
    input: "remember this",
    output: "the sky is blue",
    evidence: { existingRecords: [] },
    trace: [{ seq: 1, kind: "write", detail: "the sky is blue" }],
  };

  it("abstains with exit 2 (not 0, not a crash) before calibration, and shows the real verdicts", async () => {
    const { deps } = realDeps();
    const file = join(tempDir(), "s.json");
    writeFileSync(file, JSON.stringify(subject), "utf8");

    const res = await runTrustCommand(["admit", "--file", file], deps);
    expect(res.code).toBe(2);
    const out = text(res.lines);
    expect(out).toContain("ABSTAINED");
    expect(out).toContain("uncalibrated");
    expect(out).toContain("certificate   none");
    expect(out).toContain("verify.memory-write");
  });

  it("issues a REAL certificate once the domain is calibrated, and charges the budget", async () => {
    const { deps, stack } = realDeps();
    stack.gate.calibrate("tool", separatingPoints());

    const file = join(tempDir(), "s.json");
    writeFileSync(file, JSON.stringify(toolSubjectJson()), "utf8");

    const res = await runTrustCommand(["admit", "--file", file, "--json"], deps);
    expect(res.code).toBe(0);
    const parsed = JSON.parse(text(res.lines)) as {
      admission: { accepted: boolean; spentRisk: number; certificate?: { signature: string; publicKey: string } };
      verdicts: { verifierId: string; abstained: boolean }[];
    };
    // Two REAL verifiers co-voted — the lone-voter rule does not fire.
    expect(parsed.verdicts.filter((v) => !v.abstained).map((v) => v.verifierId).sort()).toEqual([
      "verify.exec-provenance",
      "verify.shell",
    ]);
    expect(parsed.admission.accepted).toBe(true);
    expect(parsed.admission.certificate).toBeDefined();
    expect(parsed.admission.certificate!.publicKey).toBe(stack.key.publicKeyHex);
    expect(parsed.admission.spentRisk).toBeGreaterThan(0);
    expect(stack.budget!.report().entries).toBe(1);
  });

  it("abstains when a real provenance ledger in the subject file is tampered with", async () => {
    const { deps, stack } = realDeps();
    stack.gate.calibrate("tool", separatingPoints());

    const tampered = toolSubjectJson();
    const evidence = tampered.evidence as { ledgerJSON: string };
    // Flip one byte of a recorded output hash: the real chain no longer
    // recomputes, and the real ProvenanceLedger.verifyJSON says so.
    evidence.ledgerJSON = evidence.ledgerJSON.replace(/"outputSha256":"(.)/, (_m, c: string) =>
      `"outputSha256":"${c === "a" ? "b" : "a"}`,
    );
    const file = join(tempDir(), "s.json");
    writeFileSync(file, JSON.stringify(tampered), "utf8");

    const res = await runTrustCommand(["admit", "--file", file, "--json"], deps);
    expect(res.code).toBe(2);
    const parsed = JSON.parse(text(res.lines)) as {
      admission: { accepted: boolean; certificate?: unknown };
      verdicts: { verifierId: string; passed: boolean; reasons: string[] }[];
    };
    expect(parsed.admission.accepted).toBe(false);
    expect(parsed.admission.certificate).toBeUndefined();
    const prov = parsed.verdicts.find((v) => v.verifierId === "verify.exec-provenance")!;
    expect(prov.passed).toBe(false);
    expect(prov.reasons.join(",")).toMatch(/LEDGER_(HASH_MISMATCH|CHAIN_BREAK|MALFORMED)/);
  });

  it("a memory subject from a FILE can only ever draw one verifier (functions do not survive JSON)", async () => {
    const { deps, stack } = realDeps();
    stack.gate.calibrate("memory", separatingPoints());
    const file = join(tempDir(), "s.json");
    // Written with a `.all()` that JSON silently drops.
    writeFileSync(file, JSON.stringify({ ...subject, evidence: { existingRecords: [], model: { all: () => [] } } }), "utf8");

    const res = await runTrustCommand(["admit", "--file", file, "--json"], deps);
    const parsed = JSON.parse(text(res.lines)) as {
      admission: { accepted: boolean; abstention?: { code: string } };
      verdicts: { verifierId: string; abstained: boolean }[];
    };
    expect(parsed.verdicts.filter((v) => !v.abstained)).toHaveLength(1);
    expect(parsed.admission.accepted).toBe(false);
    expect(parsed.admission.abstention?.code).toBe("degraded-evidence");
  });

  it("rejects a malformed subject rather than admitting a half-parsed one", async () => {
    const { deps } = realDeps();
    const file = join(tempDir(), "s.json");

    writeFileSync(file, JSON.stringify({ ...subject, domain: "elsewhere" }), "utf8");
    const badDomain = await runTrustCommand(["admit", "--file", file], deps);
    expect(badDomain.code).toBe(1);
    expect(badDomain.lines[0]).toContain("subject.domain must be one of");

    writeFileSync(file, JSON.stringify({ ...subject, output: 42 }), "utf8");
    const badOutput = await runTrustCommand(["admit", "--file", file], deps);
    expect(badOutput.code).toBe(1);
    expect(badOutput.lines[0]).toContain("subject.output must be a string");

    writeFileSync(file, JSON.stringify({ ...subject, trace: [{ seq: "one", kind: "k", detail: "d" }] }), "utf8");
    const badTrace = await runTrustCommand(["admit", "--file", file], deps);
    expect(badTrace.code).toBe(1);
    expect(badTrace.lines[0]).toContain("subject.trace step");
  });

  it("needs --file, and reports a read failure with the real reason", async () => {
    const { deps } = realDeps({
      fileExists: () => true,
      readFile: () => {
        throw new Error("EACCES: permission denied");
      },
    });
    const missing = await runTrustCommand(["admit"], deps);
    expect(missing.code).toBe(1);
    expect(missing.lines[0]).toContain("needs --file");

    const unreadable = await runTrustCommand(["admit", "--file", "/x.json"], deps);
    expect(unreadable.code).toBe(1);
    expect(unreadable.lines[0]).toContain("EACCES: permission denied");
  });
});

describe("hades trust budget", () => {
  it("prints the real report plus an independent chain verdict", async () => {
    const { deps } = realDeps();
    const res = await runTrustCommand(["budget"], deps);
    expect(res.code).toBe(0);
    const out = text(res.lines);
    expect(out).toContain("TRUST BUDGET");
    expect(out).toContain("chain verification  OK");
    expect(out).not.toMatch(/<\/?(div|span|table|html)/i);
  });

  it("--entries shows real chain entries after a real admission", async () => {
    const { deps, stack } = realDeps();
    stack.gate.calibrate("memory", separatingPoints());
    const admission = await stack.gate.admit({
      domain: "memory",
      subjectId: "s",
      taskId: "task-abc",
      input: "i",
      output: "o",
      evidence: { existingRecords: [], model: { all: (): unknown[] => [] } },
      trace: [],
    });
    expect(admission.accepted).toBe(true);

    const res = await runTrustCommand(["budget", "--entries", "5"], deps);
    const out = text(res.lines);
    expect(out).toContain("LAST 1 ENTRY");
    expect(out).toContain("task-abc");
  });

  it("exits non-zero and says spending is refused when the chain fails", async () => {
    const { deps, stack, dataDir } = realDeps();
    stack.gate.calibrate("memory", separatingPoints());
    await stack.gate.admit({
      domain: "memory",
      subjectId: "s",
      taskId: "t",
      input: "i",
      output: "o",
      evidence: { existingRecords: [], model: { all: (): unknown[] => [] } },
      trace: [],
    });

    const budgetPath = join(trustRoot(dataDir), "budget.json");
    const raw = JSON.parse(readFileSync(budgetPath, "utf8")) as { entries: { risk: number }[] };
    raw.entries[0].risk = 0.0000001;
    writeFileSync(budgetPath, JSON.stringify(raw, null, 2), "utf8");

    const res = await runTrustCommand(["budget"], deps);
    expect(res.code).toBe(1);
    const out = text(res.lines);
    expect(out).toContain("chain verification  FAILED");
    expect(out).toContain("will NOT reset itself");
  });
});

describe("hades trust riskeval", () => {
  it("reports DEGENERATE with exit 3 for an abstain-all gate — never PASS", async () => {
    const { deps } = realDeps();
    const res = await runTrustCommand(["riskeval", "--limit", "3"], deps);
    expect(res.code).toBe(3);
    const out = text(res.lines);
    expect(out).toContain("RESULT: DEGENERATE");
    expect(out).not.toContain("RESULT: PASS");
    // And it names the real admission port rather than implying a stand-in.
    expect(out).toContain("the REAL UnifiedTrustGate from this install");
  });

  it("validates --epsilon", async () => {
    const { deps } = realDeps();
    const res = await runTrustCommand(["riskeval", "--epsilon", "5"], deps);
    expect(res.code).toBe(1);
    expect(res.lines[0]).toContain("strictly inside (0,1)");
  });
});

describe("hades trust doctor", () => {
  it("FAILS a fresh install (nothing calibrated) but still proves the crypto round-trips", async () => {
    const { deps } = realDeps();
    const res = await runTrustCommand(["doctor"], deps);
    expect(res.code).toBe(1);
    const out = text(res.lines);
    expect(out).toContain("[PASS] verifiers registered");
    expect(out).toContain("[PASS] signing identity is durable");
    expect(out).toContain("[PASS] certificate round-trip");
    expect(out).toContain("[FAIL] at least one domain calibrated");
    expect(out).toContain("RESULT: NOT healthy");
  });

  it("FAILS the single-verifier domains — one verifier can never certify", async () => {
    const { deps } = realDeps();
    const res = await runTrustCommand(["doctor", "--json"], deps);
    const parsed = JSON.parse(text(res.lines)) as { checks: { name: string; ok: boolean; detail: string }[] };
    const byName = new Map(parsed.checks.map((c) => [c.name, c]));
    // `message` is the remaining lone-voter domain and must still be failed
    // loudly rather than reported healthy.
    expect(byName.get('domain "message" can certify')!.ok).toBe(false);
    // `message` registers a second verifier (T3-agreement) but it is
    // conditional on provider keys, so the detail must report the EFFECTIVE
    // count and name what would enable it — never imply two working voters.
    expect(byName.get('domain "message" can certify')!.detail).toContain("only 1 can vote here");
    expect(byName.get('domain "message" can certify')!.detail).toContain("ANTHROPIC_API_KEY");
    expect(byName.get('domain "memory" can certify')!.ok).toBe(true);
    // `procedure` gained the T1-reference recompute verifier, so it now has
    // two co-voters and is structurally certifiable — the doctor must report
    // that change rather than keep failing a domain that was fixed.
    expect(byName.get('domain "procedure" can certify')!.ok).toBe(true);
  });

  it("FAILS a calibrated-but-non-discriminating domain rather than calling it healthy", async () => {
    const { deps, stack } = realDeps();
    stack.calibration.record(
      "memory",
      Array.from({ length: 40 }, (_, i) => ({ score: 0.5, correct: i % 2 === 0 })),
      "deliberately non-discriminating",
    );
    stack.gate.calibrate("memory", stack.calibration.points("memory"));

    const res = await runTrustCommand(["doctor", "--json"], deps);
    const parsed = JSON.parse(text(res.lines)) as { ok: boolean; checks: { name: string; ok: boolean; detail: string }[] };
    const sep = parsed.checks.find((c) => c.name === 'domain "memory" separation')!;
    expect(sep.ok).toBe(false);
    expect(sep.detail).toContain("NO discrimination");
    expect(parsed.ok).toBe(false);
  });

  it("reports an in-memory stack's ephemeral key as a FAILURE", async () => {
    const stack = openTrustStack({ dataDir: null, env: noEnv, now: () => 0 });
    const res = await runTrustCommand(["doctor", "--json"], { stack: () => stack });
    const parsed = JSON.parse(text(res.lines)) as { checks: { name: string; ok: boolean; detail: string }[] };
    const key = parsed.checks.find((c) => c.name === "signing identity is durable")!;
    expect(key.ok).toBe(false);
    expect(key.detail).toContain("ephemeral");
  });

  it("reports a stack that cannot even be opened, rather than throwing", async () => {
    const res = await runTrustCommand(["doctor"], {
      stack: () => {
        throw new Error("signing key is unreadable");
      },
    });
    expect(res.code).toBe(1);
    expect(text(res.lines)).toContain("[FAIL] open trust stack: signing key is unreadable");
  });
});

describe("defaultTrustDeps", () => {
  it("is lazy and caches one stack per factory", () => {
    const dataDir = tempDir();
    const deps = defaultTrustDeps(noEnv, { dataDir, now: () => 0 });
    const a = deps.stack();
    const b = deps.stack();
    expect(a).toBe(b);
    expect(a.root).toBe(trustRoot(dataDir));
  });
});
