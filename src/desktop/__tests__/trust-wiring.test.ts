/**
 * Desktop `trust.*` lane tests — contract, service and sidecar routing.
 *
 * The service runs against a REAL `openTrustStack()` in a REAL temp data dir
 * (real ed25519 key file, real hash-chained ledger, real ConformalGate, real
 * verifier registry, real EVAL_TASKS corpus). Only the clock is injected.
 */

import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  isTrustCommand,
  isTrustEvent,
  isTrustStatusView,
  isTrustBudgetView,
  TRUST_COMMAND_KINDS,
  TRUST_EVENT_KINDS,
  type TrustCommand,
  type TrustEvent,
} from "../ipc/trust-contract";
import {
  isCommand,
  isAppEvent,
  encodeCommand,
  decodeCommand,
  encodeEvent,
  decodeEvent,
} from "../ipc/contract";
import { TrustService } from "../core/trust-service";
import { Sidecar } from "../core/sidecar";
import { reduce, initialState } from "../core/app-store";
import { openTrustStack, trustRoot, type TrustStack } from "../../hades/trust/wiring";
import type { AppEvent, Command } from "../ipc/contract";

const noEnv = {} as NodeJS.ProcessEnv;

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "hades-desktop-trust-"));
}

function realStack(): TrustStack {
  return openTrustStack({ dataDir: tempDir(), env: noEnv, now: () => 5_000, epsilon: 0.2 });
}

function service(stack = realStack()): { svc: TrustService; stack: TrustStack } {
  return { svc: new TrustService({ stack: () => stack, now: () => 5_000 }), stack };
}

describe("trust-contract guards", () => {
  it("accepts every documented command shape and rejects malformed ones", () => {
    const good: TrustCommand[] = [
      { kind: "trust.status" },
      { kind: "trust.budget" },
      { kind: "trust.verifiers" },
      { kind: "trust.verifiers", domain: "memory" },
      { kind: "trust.calibrate", confirm: true },
      { kind: "trust.calibrate", confirm: false, domain: "procedure" },
    ];
    for (const cmd of good) expect(isTrustCommand(cmd)).toBe(true);

    // `confirm` is REQUIRED and must be a real boolean: a payload that merely
    // forgot it must never reach the persisting path.
    expect(isTrustCommand({ kind: "trust.calibrate" })).toBe(false);
    expect(isTrustCommand({ kind: "trust.calibrate", confirm: "yes" })).toBe(false);
    expect(isTrustCommand({ kind: "trust.calibrate", confirm: 1 })).toBe(false);
    expect(isTrustCommand({ kind: "trust.verifiers", domain: 7 })).toBe(false);
    expect(isTrustCommand({ kind: "trust.nope" })).toBe(false);
    expect(isTrustCommand(null)).toBe(false);
    expect(isTrustCommand("trust.status")).toBe(false);
  });

  it("rejects prototype-pollution payloads outright", () => {
    const hostile = JSON.parse('{"kind":"trust.status","__proto__":{"polluted":true}}') as unknown;
    expect(isTrustCommand(hostile)).toBe(false);
  });

  it("rejects a non-finite number rather than letting NaN reach a renderer", () => {
    const view = {
      totalRisk: Number.NaN,
      spentRisk: 0,
      remainingRisk: 0,
      exhausted: false,
      entries: 0,
      chainRoot: "r",
      chainHead: "h",
      chainOk: true,
      perDomain: [],
    };
    expect(isTrustBudgetView(view)).toBe(false);
    expect(isTrustBudgetView({ ...view, totalRisk: 1 })).toBe(true);
  });

  it("keeps its kind tuples exhaustive against the unions", () => {
    expect([...TRUST_COMMAND_KINDS].sort()).toEqual(
      ["trust.budget", "trust.calibrate", "trust.status", "trust.verifiers"].sort(),
    );
    expect([...TRUST_EVENT_KINDS].sort()).toEqual(
      ["trust.budget", "trust.calibrated", "trust.error", "trust.status", "trust.verifiers"].sort(),
    );
  });
});

describe("composed desktop contract", () => {
  it("merges the trust lane into Command/AppEvent and round-trips it over the wire", () => {
    const cmd: Command = { kind: "trust.calibrate", confirm: true };
    expect(isCommand(cmd)).toBe(true);
    expect(decodeCommand(encodeCommand(cmd))).toEqual(cmd);

    const ev: AppEvent = { kind: "trust.error", op: "trust.status", message: "boom", at: 1 };
    expect(isAppEvent(ev)).toBe(true);
    expect(isTrustEvent(ev)).toBe(true);
    expect(decodeEvent(encodeEvent(ev))).toEqual(ev);
  });

  it("leaves the swarm app state untouched — trust events are read-only reports", () => {
    const before = initialState();
    const events: AppEvent[] = [
      { kind: "trust.error", op: "trust.status", message: "m", at: 1 },
      { kind: "trust.verifiers", verifiers: [], at: 1 },
    ];
    let state = before;
    for (const ev of events) state = reduce(state, ev);
    expect(state).toEqual(before);
  });
});

describe("TrustService over the REAL stack", () => {
  it("trust.verifiers returns the real registry, filterable by domain", async () => {
    const { svc, stack } = service();
    const all = await svc.handle({ kind: "trust.verifiers" });
    expect(all.kind).toBe("trust.verifiers");
    expect(isTrustEvent(all)).toBe(true);
    if (all.kind !== "trust.verifiers") throw new Error("unreachable");
    expect(all.verifiers).toHaveLength(stack.registry.list().length);
    expect(all.verifiers.map((v) => v.id)).toContain("verify.exec-provenance");

    const memory = await svc.handle({ kind: "trust.verifiers", domain: "memory" });
    if (memory.kind !== "trust.verifiers") throw new Error("unreachable");
    expect(memory.verifiers.map((v) => v.id).sort()).toEqual(["verify.memory-write", "verify.user-model"]);

    // An unknown domain is not a silent filter-to-nothing: it falls back to
    // the full list rather than pretending no verifier exists.
    const bogus = await svc.handle({ kind: "trust.verifiers", domain: "sideways" });
    if (bogus.kind !== "trust.verifiers") throw new Error("unreachable");
    expect(bogus.verifiers.length).toBe(stack.registry.list().length);
  });

  it("trust.status never carries the private key, and passes its own guard", async () => {
    const { svc, stack } = service();
    const ev = await svc.handle({ kind: "trust.status" });
    expect(isTrustEvent(ev)).toBe(true);
    if (ev.kind !== "trust.status") throw new Error("unreachable");

    expect(isTrustStatusView(ev.status)).toBe(true);
    expect(ev.status.publicKeyHex).toBe(stack.key.publicKeyHex);
    expect(ev.status.keySource).toBe("generated");
    expect(JSON.stringify(ev)).not.toContain(stack.key.privateKeyHex);
    expect(ev.status.root).toBe(stack.root);
    // Fresh install: every domain uncalibrated, and the view says so.
    for (const d of ev.status.domains) {
      expect(d.calibrated).toBe(false);
      expect(d.threshold).toBeNull();
      expect(d.separation).toContain("uncalibrated");
    }
  });

  it("transports an admit-nothing threshold as null + thresholdIsInfinite, never as a number", async () => {
    const { svc, stack } = service();
    // Real fit, no separation -> the real ConformalGate returns +Infinity.
    const points = Array.from({ length: 40 }, (_, i) => ({ score: 0.5, correct: i % 2 === 0 }));
    stack.calibration.record("memory", points, "non-discriminating on purpose");
    stack.gate.calibrate("memory", points);

    const ev = await svc.handle({ kind: "trust.status" });
    if (ev.kind !== "trust.status") throw new Error("unreachable");
    const memory = ev.status.domains.find((d) => d.domain === "memory")!;
    expect(memory.calibrated).toBe(true);
    expect(memory.threshold).toBeNull();
    expect(memory.thresholdIsInfinite).toBe(true);
    expect(memory.auc).toBe(0.5);
    expect(memory.separation).toContain("NO discrimination");
    // Survives the wire without becoming a bare `null` that reads as absent.
    expect(isTrustEvent(decodeEvent(encodeEvent(ev)))).toBe(true);
  });

  it("trust.calibrate without confirm is a DRY RUN that persists nothing", async () => {
    const { svc, stack } = service();
    const ev = await svc.handle({ kind: "trust.calibrate", confirm: false });
    expect(isTrustEvent(ev)).toBe(true);
    if (ev.kind !== "trust.calibrated") throw new Error("unreachable");

    expect(ev.result.dryRun).toBe(true);
    expect(ev.result.persisted).toBe(false);
    expect(stack.calibration.points("procedure")).toEqual([]);
    // The honest numbers still travel: real corpus, real labels, real AUC.
    expect(ev.result.points).toBeGreaterThan(0);
    expect(ev.result.correct).toBeGreaterThan(0);
    expect(ev.result.wrong).toBeGreaterThan(0);
    // Partial separation, honestly reported: the T1-reference verifier decides
    // the corpus tasks whose answer is recomputable from their own prompt,
    // and the tasks nothing can decide draw no contributing vote at all and
    // land on the neutral score. So AUC sits well above the 0.5 of a verifier
    // set with no correctness signal, and strictly below 1 because most of
    // the corpus stays undecided — and the fit is finite, sitting above that
    // neutral mass.
    expect(ev.result.auc).not.toBeNull();
    expect(ev.result.auc as number).toBeGreaterThan(0.7);
    expect(ev.result.auc as number).toBeLessThan(1);
    expect(ev.result.thresholdIsInfinite).toBe(false);
    expect(ev.result.provenance).toContain("NOT model calls");
  });

  it("trust.calibrate with confirm persists the REAL labeled points", async () => {
    const { svc, stack } = service();
    const ev = await svc.handle({ kind: "trust.calibrate", confirm: true });
    if (ev.kind !== "trust.calibrated") throw new Error("unreachable");
    expect(ev.result.persisted).toBe(true);
    expect(ev.result.dryRun).toBe(false);
    expect(stack.calibration.points("procedure")).toHaveLength(ev.result.points);

    // A second stack over the SAME dataDir sees it — one shared calibration.
    const reopened = openTrustStack({ dataDir: stack.root!.replace(/\/trust$/, ""), env: noEnv, now: () => 5_000 });
    expect(reopened.calibration.points("procedure")).toHaveLength(ev.result.points);
  });

  it("refuses to invent labeled data for a non-procedure domain", async () => {
    const { svc } = service();
    const ev = await svc.handle({ kind: "trust.calibrate", confirm: true, domain: "memory" });
    expect(ev.kind).toBe("trust.error");
    if (ev.kind !== "trust.error") throw new Error("unreachable");
    expect(ev.message).toContain("cannot produce labeled data");
  });

  it("trust.budget reports the real chain, and flags a tampered one", async () => {
    const dataDir = tempDir();
    const stack = openTrustStack({ dataDir, env: noEnv, now: () => 5_000, epsilon: 0.2 });
    const { svc } = service(stack);

    const clean = await svc.handle({ kind: "trust.budget" });
    if (clean.kind !== "trust.budget") throw new Error("unreachable");
    expect(clean.budget.chainOk).toBe(true);
    expect(clean.budget.entries).toBe(0);
    expect(isTrustBudgetView(clean.budget)).toBe(true);

    // Real spend, then a hand-edit that breaks the hash chain.
    stack.budget!.spend({
      domain: "memory",
      taskId: "t",
      risk: 0.01,
      subjectSha256: "a".repeat(64),
      issuedAt: 5_000,
    });
    const budgetPath = join(trustRoot(dataDir), "budget.json");
    writeFileSync(budgetPath, '{"version":1,"genesis":"nope","windowStartedAt":0,"entries":[]}', "utf8");

    const tampered = await svc.handle({ kind: "trust.budget" });
    if (tampered.kind !== "trust.budget") throw new Error("unreachable");
    expect(tampered.budget.chainOk).toBe(false);
    // Fails SAFE — never reports a comfortable remaining balance.
    expect(tampered.budget.exhausted).toBe(true);
    expect(tampered.budget.remainingRisk).toBe(0);
  });

  it("turns a failure into a real trust.error, never silence", async () => {
    const svc = new TrustService({
      stack: () => {
        throw new Error("signing key is unreadable");
      },
      now: () => 5_000,
    });
    const ev = await svc.handle({ kind: "trust.status" });
    expect(ev.kind).toBe("trust.error");
    if (ev.kind !== "trust.error") throw new Error("unreachable");
    expect(ev.op).toBe("trust.status");
    expect(ev.message).toBe("signing key is unreadable");
    expect(isTrustEvent(ev)).toBe(true);
  });

  it("opens the stack LAZILY — constructing the service touches nothing", () => {
    let opened = 0;
    const stack = realStack();
    const svc = new TrustService({
      stack: () => {
        opened += 1;
        return stack;
      },
    });
    expect(opened).toBe(0);
    void svc;
  });
});

describe("Sidecar routing for the trust lane", () => {
  function harness(trust?: { handle(cmd: TrustCommand): Promise<TrustEvent> }): {
    sidecar: Sidecar;
    events: AppEvent[];
  } {
    const events: AppEvent[] = [];
    const sidecar = new Sidecar({
      emit: (e) => events.push(e),
      now: () => 9_000,
      factory: {
        create: () => {
          throw new Error("swarm not needed for this test");
        },
      } as unknown as ConstructorParameters<typeof Sidecar>[0]["factory"],
      trust,
    });
    return { sidecar, events };
  }

  it("routes every trust command to the handler and emits its event", async () => {
    const { svc } = service();
    const { sidecar, events } = harness(svc);

    for (const cmd of [
      { kind: "trust.status" },
      { kind: "trust.verifiers" },
      { kind: "trust.budget" },
    ] as TrustCommand[]) {
      await sidecar.handle(cmd);
    }
    expect(events.map((e) => e.kind)).toEqual(["trust.status", "trust.verifiers", "trust.budget"]);
    for (const e of events) expect(isAppEvent(e)).toBe(true);
  });

  it("emits an honest trust.error when no handler is configured — never a synthesized status", async () => {
    const { sidecar, events } = harness(undefined);
    await sidecar.handle({ kind: "trust.status" });
    expect(events).toHaveLength(1);
    const ev = events[0];
    expect(ev.kind).toBe("trust.error");
    if (ev.kind !== "trust.error") throw new Error("unreachable");
    expect(ev.message).toContain("not configured in this build");
    expect(ev.op).toBe("trust.status");
    // Crucially: no `trust.status` was emitted, so a renderer can never read
    // "unconfigured" as "the gate is healthy".
    expect(events.some((e) => e.kind === "trust.status")).toBe(false);
  });
});
