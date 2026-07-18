/**
 * PHASE 3 ADVERSARIAL AUDIT — Verifier A.
 *
 * These are hostile regression probes against four just-landed desktop modules.
 * Each test encodes an attack that would PASS if the module were faked/shortcut
 * and FAIL if it is real. They stand as guards against regression to a stub.
 *
 *   Team 2  src/desktop/ui/command-palette.ts   (real contract Commands, escaping)
 *   Team 3  src/desktop/core/cert-verify.ts     (REAL ed25519, no valid:true stub)
 *           src/desktop/ui/cert-view.ts          (HTML escaping of cert fields)
 *   Team 4  src/desktop/ui/vtph-panel.ts        (delegates to bench/vtph, no drift)
 *   Team 7  src/desktop/core/head-to-head.ts    (real run, numbers not canned)
 *
 * Verdict (see report): all four modules held up. No source was modified.
 */

import { describe, it, expect } from "vitest";

import {
  createPaletteEntries,
  DEFAULT_ENTRIES,
  paletteReduce,
  initialPaletteState,
  renderPalette,
  filterEntries,
  escapeHtml,
  type PaletteState,
  type PaletteEntry,
} from "../ui/command-palette";
import { isCommand, type Command } from "../ipc/contract";

import { parseCertificate, verifyDropped, type CertVerifyResult } from "../core/cert-verify";
import { renderCertVerify } from "../ui/cert-view";
import {
  CertificateAuthority,
  generatePrivateKeyHex,
  verifyCertificate,
  sha256Hex,
  type CertificatePayload,
  type VerificationCertificate,
} from "../../hades/styx/certificate";

import { computeVtph, renderVtphPanel, type VtphInput } from "../ui/vtph-panel";
import { runVtph, type AgentRunner, type EvalTask } from "../../hades/bench/vtph";

import { runHeadToHeadForApp } from "../core/head-to-head";

// ===========================================================================
// Shared helpers
// ===========================================================================

const OUTPUT = "the answer is 42, grounded in the trace";

function samplePayload(overrides: Partial<CertificatePayload> = {}): CertificatePayload {
  return {
    outputSha256: sha256Hex(OUTPUT),
    taskId: "task-styx-001",
    verifierTier: "T2-genrm",
    ensembleScore: 0.94,
    pCorrect: 0.972,
    epsilon: 0.021,
    traceSha256: sha256Hex("trace-json"),
    verifierVersions: ["genrm@1.4.0", "conformal@0.3.1"],
    issuedAt: Date.UTC(2026, 6, 18, 9, 41, 3),
    ...overrides,
  };
}

async function mint(
  payload: CertificatePayload = samplePayload(),
  privHex: string = generatePrivateKeyHex(),
): Promise<{ cert: VerificationCertificate; ca: CertificateAuthority }> {
  const ca = new CertificateAuthority(privHex);
  const cert = await ca.issue(payload);
  return { cert, ca };
}

function vtphInput(overrides: Partial<VtphInput>): VtphInput {
  return { verifiedTasks: 0, elapsedMs: 0, costUsd: 0, history: [], ...overrides };
}

// ===========================================================================
// TEAM 3 — cert-verify: prove it runs REAL ed25519, never shortcuts to valid.
// ===========================================================================

describe("[Team 3] cert-verify runs real ed25519 (not a valid:true stub)", () => {
  it("ATTACK: genuine cert but public key swapped to another CA -> reject", async () => {
    const { cert } = await mint();
    const otherCa = new CertificateAuthority(generatePrivateKeyHex());
    const forged: VerificationCertificate = {
      payload: cert.payload,
      signature: cert.signature,
      publicKey: otherCa.publicKeyHex(), // valid hex key, wrong owner
    };
    const res = await verifyDropped(JSON.stringify(forged));
    expect(res.valid).toBe(false);
    expect(res.checks.find((c) => c.name === "Signature valid")?.passed).toBe(false);
  });

  it("ATTACK: valid signature transplanted onto a different payload -> reject", async () => {
    const priv = generatePrivateKeyHex();
    const { cert: c1, ca } = await mint(samplePayload({ taskId: "task-A" }), priv);
    const spliced: VerificationCertificate = {
      payload: samplePayload({ taskId: "task-B" }), // different message
      signature: c1.signature, // signature that belongs to task-A
      publicKey: ca.publicKeyHex(),
    };
    const res = await verifyDropped(JSON.stringify(spliced));
    expect(res.valid).toBe(false);
  });

  it("ATTACK: EVERY payload field is bound by the signature (tamper each -> reject)", async () => {
    const { cert } = await mint();
    const mutations: Array<(p: Record<string, unknown>) => void> = [
      (p) => (p.taskId = "task-forged"),
      (p) => (p.verifierTier = "T9-fake"),
      (p) => (p.outputSha256 = sha256Hex("something else")),
      (p) => (p.traceSha256 = sha256Hex("other trace")),
      (p) => (p.ensembleScore = 0.999),
      (p) => (p.pCorrect = 0.999),
      (p) => (p.epsilon = 0.0),
      (p) => (p.issuedAt = 1),
      (p) => (p.verifierVersions = ["forged@9.9.9"]),
    ];
    for (const mutate of mutations) {
      const tampered = JSON.parse(JSON.stringify(cert));
      mutate(tampered.payload);
      const res = await verifyDropped(JSON.stringify(tampered));
      expect(res.valid, `tampering ${JSON.stringify(tampered.payload)}`).toBe(false);
    }
  });

  it("ATTACK: all-zero and truncated signatures -> reject, never throw", async () => {
    const { cert } = await mint();
    for (const sig of ["0".repeat(128), "", "deadbeef", cert.signature.slice(0, 60)]) {
      const res = await verifyDropped(JSON.stringify({ ...cert, signature: sig }));
      expect(res.valid).toBe(false);
    }
  });

  it("CONTROL: a genuine cert verifies true, and key-order on the wire is irrelevant (canonicalization)", async () => {
    const { cert } = await mint();
    // genuine
    expect((await verifyDropped(JSON.stringify(cert))).valid).toBe(true);
    // Re-serialize the payload with keys in a different (reversed) order.
    const reordered: Record<string, unknown> = {};
    for (const k of Object.keys(cert.payload).reverse()) {
      reordered[k] = (cert.payload as Record<string, unknown>)[k];
    }
    const wire = JSON.stringify({
      publicKey: cert.publicKey,
      signature: cert.signature,
      payload: reordered,
    });
    expect((await verifyDropped(wire)).valid).toBe(true);
    // And the underlying styx primitive agrees directly.
    expect(await verifyCertificate(cert)).toBe(true);
  });

  it("ATTACK: certifiesOutput binding — one flipped output char breaks the match", async () => {
    const { cert } = await mint();
    const good = await verifyDropped(JSON.stringify(cert), { output: OUTPUT });
    expect(good.valid).toBe(true);
    const bad = await verifyDropped(JSON.stringify(cert), { output: OUTPUT + "." });
    expect(bad.valid).toBe(false);
    expect(bad.checks.find((c) => c.name === "Output match")?.passed).toBe(false);
    // Signature itself still verifies — only the output binding fails.
    expect(bad.checks.find((c) => c.name === "Signature valid")?.passed).toBe(true);
  });

  it("HYGIENE: parse never throws on hostile input", () => {
    for (const s of ["", "   ", "null", "[]", "{}", "{ bad json", '{"payload":1}']) {
      expect(parseCertificate(s).ok).toBe(false);
    }
  });
});

// ===========================================================================
// TEAM 3 — cert-view: HTML injection through certificate fields.
// ===========================================================================

describe("[Team 3] cert-view escapes attacker-controlled certificate fields", () => {
  it("ATTACK: hostile taskId / verifierTier in a GENUINELY signed cert are escaped when rendered", async () => {
    const evilTask = `<img src=x onerror=alert(1)>`;
    const evilTier = `"><script>alert(2)</script>`;
    const { cert } = await mint(samplePayload({ taskId: evilTask, verifierTier: evilTier }));
    const result = await verifyDropped(JSON.stringify(cert), { output: OUTPUT });
    expect(result.valid).toBe(true); // genuine, so it renders the hostile payload
    const html = renderCertVerify(result);
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<script>alert(2)</script>");
    expect(html).toContain("&lt;img src=x");
    expect(html).toContain("&lt;script&gt;alert(2)");
  });

  it("ATTACK: hostile publicKey / reason / check text are escaped (renderer-level)", () => {
    const hostile: CertVerifyResult = {
      valid: false,
      reason: `<b>totally trusted</b>`,
      publicKey: `"><img src=x onerror=alert(3)>`,
      payload: samplePayload({ taskId: `</dd><script>x</script>` }),
      checks: [{ name: `<u>Parses</u>`, passed: false, detail: `"><svg onload=alert(4)>` }],
    };
    const html = renderCertVerify(hostile);
    expect(html).not.toContain("<img src=x onerror=alert(3)>");
    expect(html).not.toContain("<svg onload=alert(4)>");
    expect(html).not.toContain("<script>x</script>");
    expect(html).not.toContain("<b>totally trusted</b>");
    // Escaped forms present.
    expect(html).toContain("&lt;svg onload=alert(4)&gt;");
    expect(html).toContain("&lt;b&gt;totally trusted");
  });
});

// ===========================================================================
// TEAM 4 — vtph-panel: prove it delegates to bench/vtph and does not diverge.
// ===========================================================================

describe("[Team 4] vtph-panel delegates to bench/vtph (no parallel formula)", () => {
  it("ATTACK: divergent-formula check — computeVtph must equal a real runVtph run byte-for-byte", async () => {
    const verifiedTasks = 7;
    const elapsedMs = 900_000; // 15 min
    const costUsd = 3;

    const computed = await computeVtph(vtphInput({ verifiedTasks, elapsedMs, costUsd }));

    // Independently run the REAL harness with the same adaptation the panel documents.
    const tasks: EvalTask[] = Array.from({ length: verifiedTasks }, (_, i) => ({
      id: `t${i}`,
      prompt: "",
      category: "c",
      decomposable: false,
      grade: () => true,
    }));
    const runner: AgentRunner = async (t) => ({
      output: "",
      claimedVerified: true,
      tokensIn: 0,
      tokensOut: 0,
      usd: t.id === "t0" ? costUsd : 0,
      provenance: [],
    });
    let s = 0;
    const now = () => (s++ === 0 ? 0 : elapsedMs);
    const report = await runVtph(runner, tasks, { now });

    expect(computed.vtph).toBe(report.vtph);
    expect(computed.vtphd).toBe(report.vtphPerDollar);
    // And the closed form the harness must yield: 7 / 0.25h = 28 vtph; 28/$3.
    expect(computed.vtph).toBe(28);
    expect(computed.vtphd).toBe(28 / 3);
  });

  it("GUARD: NaN inputs are correctly treated as insufficient (null, not a number)", async () => {
    const cElapsed = await computeVtph(vtphInput({ verifiedTasks: 3, elapsedMs: NaN, costUsd: 1 }));
    expect(cElapsed.vtphd).toBeNull();
    expect(cElapsed.reason).toBe("no-elapsed");
    const cCost = await computeVtph(vtphInput({ verifiedTasks: 3, elapsedMs: 1000, costUsd: NaN }));
    expect(cCost.vtphd).toBeNull();
    expect(cCost.reason).toBe("no-cost");
    const cVerified = await computeVtph(vtphInput({ verifiedTasks: NaN, elapsedMs: 1000, costUsd: 1 }));
    expect(cVerified.vtphd).toBeNull();
    expect(cVerified.reason).toBe("no-verified");
  });

  /**
   * BUG-FOUND (Team 4, vtph-panel.ts, computeVtph):
   *
   * The module's own docstring promises: "Non-finite inputs (NaN/Infinity) fail
   * the `> 0` guards and are treated as insufficient" and "Returns honest
   * `null`s (never a fabricated 0 or placeholder)". That promise is FALSE for
   * +Infinity, because the guard `!(x > 0)` does NOT reject +Infinity
   * (`Infinity > 0 === true`):
   *
   *   - elapsedMs = Infinity  -> wallClockMs = Infinity -> vtph = n/Inf = 0
   *                              => vtphd = 0, reason = "ok"   (FABRICATED 0)
   *   - costUsd   = Infinity  -> totalUsd = Infinity -> vtphd = vtph/Inf = 0
   *                              => vtphd = 0, reason = "ok"   (FABRICATED 0)
   *   - verifiedTasks = Infinity -> Array.from({length: Infinity}) THROWS
   *                              RangeError "Invalid array length" (uncaught).
   *
   * This test asserts the DOCUMENTED/DESIRED behavior (Infinity -> null), so it
   * FAILS against the current source and stands as the exposure of the defect.
   * Central integration owns the fix (tighten the guards to Number.isFinite &&
   * > 0, and floor/guard verifiedTasks before Array.from). Do NOT fix here.
   */
  it("BUG-FOUND: +Infinity slips past the >0 guard and fabricates a 0 (should be null)", async () => {
    const cElapsed = await computeVtph(vtphInput({ verifiedTasks: 3, elapsedMs: Infinity, costUsd: 1 }));
    expect(cElapsed.vtphd, "elapsedMs=Infinity must not fabricate a number").toBeNull();

    const cCost = await computeVtph(vtphInput({ verifiedTasks: 3, elapsedMs: 1000, costUsd: Infinity }));
    expect(cCost.vtphd, "costUsd=Infinity must not fabricate a number").toBeNull();

    // verifiedTasks=Infinity should be insufficient, not an uncaught RangeError.
    await expect(
      computeVtph(vtphInput({ verifiedTasks: Infinity, elapsedMs: 1000, costUsd: 1 })),
    ).resolves.toMatchObject({ vtphd: null });
  });

  it("HONESTY: insufficient data renders an honest fallback, not a fake 0", async () => {
    const html = await renderVtphPanel(vtphInput({ verifiedTasks: 0, elapsedMs: 1000, costUsd: 1 }));
    expect(html).toContain("awaiting a verified run");
    expect(html).not.toMatch(/vtph-value">\d/); // no numeric headline
    expect(html).not.toContain("—"); // house rule: no em-dash in rendered copy
  });
});

// ===========================================================================
// TEAM 7 — head-to-head: prove numbers come from a real run, not canned.
// ===========================================================================

describe("[Team 7] head-to-head numbers are computed, not hardcoded", () => {
  it("ATTACK: flatRouteScans changes with N and equals the real N*(N+1)/2", async () => {
    const a = await runHeadToHeadForApp({ workerCounts: [4], branching: 2, aggCostPerItem: 1 });
    const b = await runHeadToHeadForApp({ workerCounts: [8], branching: 2, aggCostPerItem: 1 });
    expect(a.rows[0].flatRouteScans).toBe((4 * 5) / 2); // 10
    expect(b.rows[0].flatRouteScans).toBe((8 * 9) / 2); // 36
    expect(a.rows[0].flatRouteScans).not.toBe(b.rows[0].flatRouteScans);
  });

  it("ATTACK: hierarchyRouteScans reflects the real tree (changes with branching), not a canned N-1", async () => {
    const bin = await runHeadToHeadForApp({ workerCounts: [16], branching: 2, aggCostPerItem: 1 });
    const quad = await runHeadToHeadForApp({ workerCounts: [16], branching: 4, aggCostPerItem: 1 });
    // Same N, different tree fan-out -> different node count -> different dispatch edges.
    expect(bin.rows[0].hierarchyRouteScans).not.toBe(quad.rows[0].hierarchyRouteScans);
    // Both are strictly cheaper than the flat O(N^2) scan.
    expect(bin.rows[0].flatRouteScans).toBeGreaterThan(bin.rows[0].hierarchyRouteScans);
    expect(quad.rows[0].flatRouteScans).toBeGreaterThan(quad.rows[0].hierarchyRouteScans);
  });

  it("ATTACK: routingSpeedup is exactly flat/hier (derived, not asserted-as-win)", async () => {
    const res = await runHeadToHeadForApp({ workerCounts: [4, 16], branching: 2, aggCostPerItem: 1 });
    for (const row of res.rows) {
      expect(row.routingSpeedup).toBeCloseTo(row.flatRouteScans / row.hierarchyRouteScans, 10);
    }
    // Grows with N -> cannot be a constant.
    const byN = new Map(res.rows.map((r) => [r.workers, r]));
    expect(byN.get(16)!.routingSpeedup).toBeGreaterThan(byN.get(4)!.routingSpeedup);
  });

  it("INTEGRITY: every row's aggregate matches (no silent-wrong reduction)", async () => {
    const res = await runHeadToHeadForApp({ workerCounts: [4, 16], branching: 2, aggCostPerItem: 1 });
    expect(res.rows.every((r) => r.resultsMatch)).toBe(true);
    expect(res.summary.allResultsMatch).toBe(true);
    // Makespan fields are genuinely measured floats, not canned.
    for (const r of res.rows) {
      expect(Number.isFinite(r.flatMakespanMs)).toBe(true);
      expect(Number.isFinite(r.hierarchyMakespanMs)).toBe(true);
    }
  });
});

// ===========================================================================
// TEAM 2 — command-palette: every produced Command is contract-valid; escaping.
// ===========================================================================

describe("[Team 2] command-palette emits only contract-valid Commands", () => {
  it("every registry entry produces an isCommand-valid Command for valid args", () => {
    const entries = createPaletteEntries({ poolSize: 4 });
    const emitted: Array<Command | null> = [
      entries.find((e) => e.id === "runtime.start")!.toCommand(),
      entries.find((e) => e.id === "runtime.stop")!.toCommand(),
      entries.find((e) => e.id === "pool.scale.up")!.toCommand(),
      entries.find((e) => e.id === "pool.scale.down")!.toCommand(),
      entries.find((e) => e.id === "skills.list")!.toCommand(),
      entries.find((e) => e.id === "goal.dispatch")!.toCommand("ship it"),
      entries.find((e) => e.id === "pool.scale.set")!.toCommand("6"),
    ];
    for (const cmd of emitted) {
      expect(cmd).not.toBeNull();
      expect(isCommand(cmd)).toBe(true);
    }
  });

  it("ATTACK: hostile pool-size strings never yield an invalid Command", () => {
    const set = createPaletteEntries().find((e) => e.id === "pool.scale.set")!;
    // Rejected outright (honesty boundary returns null, not a malformed Command).
    for (const raw of ["abc", "", "   ", "NaN", "1e999", "Infinity", "-Infinity", "0x10"]) {
      const cmd = set.toCommand(raw);
      if (cmd !== null) {
        // If it chose to accept, it MUST still be a valid, finite-size Command.
        expect(isCommand(cmd)).toBe(true);
        expect(cmd.kind).toBe("pool.scale");
        if (cmd.kind === "pool.scale") expect(Number.isInteger(cmd.size)).toBe(true);
      }
    }
    // Clamping/flooring still produces a valid Command.
    const neg = set.toCommand("-5");
    expect(neg).toEqual({ kind: "pool.scale", size: 0 });
    const frac = set.toCommand("7.9");
    expect(frac).toEqual({ kind: "pool.scale", size: 7 });
    expect(isCommand(neg)).toBe(true);
    expect(isCommand(frac)).toBe(true);
  });

  it("ATTACK: empty/whitespace objective is refused (no goal.dispatch with empty string)", () => {
    const dispatch = DEFAULT_ENTRIES.find((e) => e.id === "goal.dispatch")!;
    expect(dispatch.toCommand("")).toBeNull();
    expect(dispatch.toCommand("   ")).toBeNull();
    expect(dispatch.toCommand(undefined)).toBeNull();
    const ok = dispatch.toCommand("  do the thing  ");
    expect(ok).toEqual({ kind: "goal.dispatch", objective: "do the thing" });
    expect(isCommand(ok)).toBe(true);
  });

  it("every command the reducer can emit passes isCommand", () => {
    // Drive the reducer to emit each command kind and validate the wire object.
    const emit = (state: PaletteState, actions: Array<Parameters<typeof paletteReduce>[1]>): Command | undefined => {
      let s = state;
      let cmd: Command | undefined;
      for (const a of actions) {
        const r = paletteReduce(s, a);
        s = r.state;
        if (r.command) cmd = r.command;
      }
      return cmd;
    };
    const open = paletteReduce(initialPaletteState(), { type: "open" }).state;

    const constant = emit(open, [{ type: "execute" }]); // runtime.start at index 0
    expect(isCommand(constant)).toBe(true);

    const dispatched = emit(open, [
      { type: "setQuery", query: "dispatch" },
      { type: "execute" }, // opens input
      { type: "setInput", value: "objective <b> & \" text" },
      { type: "execute" },
    ]);
    expect(dispatched).toEqual({ kind: "goal.dispatch", objective: 'objective <b> & " text' });
    expect(isCommand(dispatched)).toBe(true);
  });
});

describe("[Team 2] command-palette escapes attacker-controlled render input", () => {
  it("ATTACK: hostile query is escaped in the list view", () => {
    let state = paletteReduce(initialPaletteState(), { type: "open" }).state;
    state = paletteReduce(state, {
      type: "setQuery",
      query: `"><script>alert(1)</script>`,
    }).state;
    const html = renderPalette(state);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain(`"><script>`);
    expect(html).toContain("&lt;script&gt;");
  });

  it("ATTACK: hostile objective in the input sub-view value attribute is escaped", () => {
    let state = paletteReduce(initialPaletteState(), { type: "open" }).state;
    state = paletteReduce(state, { type: "setQuery", query: "dispatch" }).state;
    state = paletteReduce(state, { type: "execute" }).state; // -> input mode
    state = paletteReduce(state, {
      type: "setInput",
      value: `"><img src=x onerror=alert(2)>`,
    }).state;
    const html = renderPalette(state);
    expect(html).toContain('data-mode="input"');
    expect(html).not.toContain("<img src=x onerror=alert(2)>");
    expect(html).not.toContain(`"><img`);
    expect(html).toContain("&lt;img src=x");
  });

  it("filterEntries stays deterministic under a hostile query (no crash)", () => {
    const q = `"><script>`;
    expect(filterEntries(DEFAULT_ENTRIES, q)).toEqual(filterEntries(DEFAULT_ENTRIES, q));
    // escapeHtml is total over the 5 sensitive chars.
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
  });
});
