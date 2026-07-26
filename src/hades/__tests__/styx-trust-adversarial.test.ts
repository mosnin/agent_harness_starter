/**
 * ADVERSARIAL VERIFICATION of the Styx S1 trust kernel — the three keyless
 * primitives that make the whole thesis ("silent-wrong rate is a *provable*,
 * tunable bound ε, not a hope") either true or theater:
 *
 *   - src/hades/styx/gate.ts        — conformal risk-controlled abstention gate
 *   - src/hades/styx/certificate.ts — ed25519 Verification Certificate
 *   - src/hades/styx/tiers.ts       — verifier-tier router + label-free ensemble
 *
 * These tests do NOT try to make the kernel look good. The mandate is EXTERNAL
 * VALIDITY: prove the guarantees are REAL. Where a guarantee holds, the attack
 * fails and the test passes; where it is broken, the assertion encodes the
 * CORRECT behaviour and is left to FAIL so the bug is reported, not hidden.
 *
 * Fully deterministic: all pseudo-randomness is a hash of an integer index
 * (splitmix-style avalanche). NO Math.random, NO Date.now/clock, NO network.
 * Cert verification is async (real ed25519); everything else is synchronous.
 */
import { describe, it, expect } from "vitest";
import {
  ConformalGate,
  conformalThreshold,
  type CalibrationPoint,
} from "../styx/gate";
import {
  CertificateAuthority,
  verifyCertificate,
  certifiesOutput,
  sha256Hex,
  generatePrivateKeyHex,
  type CertificatePayload,
  type VerificationCertificate,
} from "../styx/certificate";
import {
  routeTier,
  tierConfidenceFloor,
  WeakVerifierEnsemble,
  type VerifierVote,
} from "../styx/tiers";

// ===========================================================================
// Deterministic pseudo-randomness — hash of an integer, NO Math.random.
// ===========================================================================

/** 32-bit integer avalanche mixer (splitmix/murmur finalizer style). */
function mix32(n: number): number {
  let x = n | 0;
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
  x = (x ^ (x >>> 16)) >>> 0;
  return x;
}

/** Deterministic uniform in [0,1) keyed by an index and an independent salt. */
function rnd(i: number, salt: number): number {
  // i*2654435761 stays < 2^53 for our index ranges (exact); ^ salt keeps
  // streams for the same i independent after the avalanche.
  return mix32(((i * 2654435761) ^ (salt * 40503)) | 0) / 4294967296;
}

function sigmoid(z: number): number {
  return 1 / (1 + Math.exp(-z));
}

// ===========================================================================
// ATTACK 1 — THE CONFORMAL BOUND ACTUALLY HOLDS (the headline claim)
// ===========================================================================
//
// Build a LARGE synthetic population with a KNOWN score→P(correct) law:
//   score  ~ uniform(-6, 6)   (logit space)
//   correct = u < sigmoid(score)     (so P(correct|score) = sigmoid(score))
// Split cal/test. For each ε, calibrate on cal, then MEASURE the realized
// silent-wrong rate among EMITTED (score ≥ τ) items on the held-out TEST split.
// If that rate materially exceeds ε, the "provable bound" is FALSE.
//
// Finite-sample slack justification: the split-conformal guarantee is MARGINAL
// (over draws of the calibration set), so a single cal/test split realizes a
// rate that fluctuates around the true tail risk. With mSel emitted test items
// the binomial std is sqrt(ε(1-ε)/mSel); we allow a 3-sigma band plus a 1%
// floor for the cal-threshold estimation noise. This is a genuinely tight bar:
// because emitted items include many with score ≫ τ (near-certainly correct),
// a correctly-implemented gate should land COMFORTABLY BELOW ε, not just inside
// the slack.

interface Pop {
  score: number;
  correct: boolean;
}

function buildPopulation(n: number): Pop[] {
  const out: Pop[] = [];
  for (let i = 0; i < n; i++) {
    const score = -6 + 12 * rnd(i, 1);
    const p = sigmoid(score);
    const correct = rnd(i, 2) < p;
    out.push({ score, correct });
  }
  return out;
}

describe("Attack 1 — the conformal silent-wrong bound empirically holds", () => {
  const N = 6000;
  const pop = buildPopulation(N);
  const half = N / 2;
  const cal: CalibrationPoint[] = pop.slice(0, half);
  const test: Pop[] = pop.slice(half);

  const epsilons = [0.01, 0.05, 0.1, 0.2];
  const measured: {
    eps: number;
    tau: number;
    calCoverage: number;
    mSel: number;
    realizedWrong: number;
    slack: number;
  }[] = [];

  for (const eps of epsilons) {
    it(`ε=${eps}: emitted wrong-rate ≤ ε + finite-sample slack`, () => {
      const gate = new ConformalGate({ epsilon: eps, minCalibration: 10 });
      const stats = gate.calibrate(cal);
      const tau = stats.threshold;
      expect(Number.isFinite(tau)).toBe(true); // must find a feasible threshold

      let wrong = 0;
      let total = 0;
      for (const t of test) {
        if (t.score >= tau) {
          total += 1;
          if (!t.correct) wrong += 1;
        }
      }
      expect(total).toBeGreaterThan(30); // enough emitted to measure meaningfully
      const realizedWrong = wrong / total;
      const slack = 3 * Math.sqrt((eps * (1 - eps)) / total) + 0.01;

      measured.push({
        eps,
        tau,
        calCoverage: stats.coverageAtThreshold,
        mSel: total,
        realizedWrong,
        slack,
      });

      // THE HEADLINE ASSERTION: the realized silent-wrong rate on held-out data
      // does not materially exceed the configured ε.
      expect(realizedWrong).toBeLessThanOrEqual(eps + slack);
    });
  }

  it("coverage is monotone non-decreasing and threshold non-increasing in ε", () => {
    // Recompute cleanly in ascending-ε order (independent of test ordering).
    const rows = epsilons.map((eps) => {
      const g = new ConformalGate({ epsilon: eps, minCalibration: 10 });
      const s = g.calibrate(cal);
      return { eps, tau: s.threshold, cov: s.coverageAtThreshold };
    });
    for (let k = 1; k < rows.length; k++) {
      // Looser ε ⇒ smaller-or-equal threshold ⇒ more-or-equal coverage.
      expect(rows[k].tau).toBeLessThanOrEqual(rows[k - 1].tau + 1e-12);
      expect(rows[k].cov).toBeGreaterThanOrEqual(rows[k - 1].cov - 1e-12);
    }
    // eslint-disable-next-line no-console
    console.log(
      "[Attack1] measured:",
      JSON.stringify(
        rows.map((r) => ({ eps: r.eps, tau: +r.tau.toFixed(3), cov: +r.cov.toFixed(3) })),
      ),
    );
  });

  it("reports realized wrong-rate vs ε for every ε (must be ≤ ε + slack)", () => {
    // This runs after the per-ε its populated `measured`.
    expect(measured.length).toBe(epsilons.length);
    // eslint-disable-next-line no-console
    console.log(
      "[Attack1] wrong-rate vs epsilon:",
      JSON.stringify(
        measured.map((m) => ({
          eps: m.eps,
          realizedWrong: +m.realizedWrong.toFixed(4),
          budget: +(m.eps + m.slack).toFixed(4),
          emitted: m.mSel,
        })),
      ),
    );
    for (const m of measured) {
      expect(m.realizedWrong).toBeLessThanOrEqual(m.eps + m.slack);
    }
  });

  it("conformalThreshold is conservative: tiny selected sets cannot certify low risk", () => {
    // A single selected point can never certify below 1/(n+1) = 1/2.
    const pts: CalibrationPoint[] = [{ score: 10, correct: true }];
    // ε below 0.5 must be infeasible ⇒ abstain-all (+Infinity).
    expect(conformalThreshold(pts, 0.1)).toBe(Infinity);
    // ε = 0.6 ≥ 1/2 is feasible.
    expect(conformalThreshold(pts, 0.6)).toBe(10);
  });
});

describe("Attack 1b — the MARGINAL conformal bound (mean over many splits)", () => {
  // The single-split test above allows finite-sample slack because the
  // split-conformal guarantee is MARGINAL: it bounds E[wrong-rate] over draws
  // of the calibration set, not any one realized split. The gate picks the
  // SMALLEST feasible τ (coverage-maximizing), which sits right at the ε
  // boundary, so a single split scatters ±around ε — landing above it roughly
  // half the time is CORRECT, not a violation. The honest test of the headline
  // claim is therefore the MEAN realized wrong-rate across independent splits:
  // it must equal ε to within Monte-Carlo error, and be TIGHT (not vacuously
  // conservative), with exceedances split ~evenly above/below ε.
  const epsilons = [0.05, 0.1, 0.2];
  for (const eps of epsilons) {
    it(`ε=${eps}: mean emitted wrong-rate over 40 splits ≈ ε (marginal bound)`, () => {
      const splits = 40;
      let sum = 0;
      let above = 0;
      for (let s = 0; s < splits; s++) {
        const cal: CalibrationPoint[] = [];
        const test: Pop[] = [];
        for (let i = 0; i < 2500; i++) {
          const sc = -6 + 12 * rnd(i, 1000 + s * 2);
          cal.push({ score: sc, correct: rnd(i, 1001 + s * 2) < sigmoid(sc) });
        }
        for (let i = 0; i < 2500; i++) {
          const sc = -6 + 12 * rnd(i, 20000 + s * 2);
          test.push({ score: sc, correct: rnd(i, 20001 + s * 2) < sigmoid(sc) });
        }
        const gate = new ConformalGate({ epsilon: eps, minCalibration: 10 });
        const tau = gate.calibrate(cal).threshold;
        let wrong = 0;
        let total = 0;
        for (const t of test) {
          if (t.score >= tau) {
            total += 1;
            if (!t.correct) wrong += 1;
          }
        }
        const r = total > 0 ? wrong / total : 0;
        sum += r;
        if (r > eps) above += 1;
      }
      const mean = sum / splits;
      // eslint-disable-next-line no-console
      console.log(
        `[Attack1b] eps=${eps} meanWrong=${mean.toFixed(4)} splitsAboveEps=${above}/${splits}`,
      );
      // Bound HOLDS: mean does not exceed ε beyond Monte-Carlo error.
      expect(mean).toBeLessThanOrEqual(eps + 0.01);
      // Bound is TIGHT (not vacuous abstention): mean is genuinely near ε.
      expect(mean).toBeGreaterThan(eps - 0.03);
      // Scatter is symmetric — neither systematically violated nor conservative.
      expect(above).toBeGreaterThan(splits * 0.2);
      expect(above).toBeLessThan(splits * 0.8);
    });
  }
});

// ===========================================================================
// ATTACK 2 — GATE CAN'T BE GAMED BY SCALE
// ===========================================================================
//
// The Scaling-Flaws failure mode (2502.00271): a verifier-guided gate whose
// realized error DRIFTS UP as more items flow through it. Calibrate ONCE, then
// measure the emitted wrong-rate over growing test volumes; it must stay ≤ ε
// (within finite-sample slack) and not trend upward with N.

describe("Attack 2 — emitted wrong-rate does not drift up with scale", () => {
  it("wrong-rate among emitted stays bounded as test volume grows", () => {
    const eps = 0.1;
    const cal = buildPopulation(3000);
    const gate = new ConformalGate({ epsilon: eps, minCalibration: 10 });
    const tau = gate.calibrate(cal).threshold;
    expect(Number.isFinite(tau)).toBe(true);

    // Fresh, disjoint population for the test stream (different salt space).
    const sizes = [500, 1000, 2000, 4000, 8000];
    const rates: { n: number; rate: number; emitted: number }[] = [];
    for (const n of sizes) {
      let wrong = 0;
      let total = 0;
      for (let i = 0; i < n; i++) {
        const score = -6 + 12 * rnd(i, 101);
        const correct = rnd(i, 102) < sigmoid(score);
        if (score >= tau) {
          total += 1;
          if (!correct) wrong += 1;
        }
      }
      const rate = total > 0 ? wrong / total : 0;
      rates.push({ n, rate, emitted: total });
      const slack = 3 * Math.sqrt((eps * (1 - eps)) / Math.max(total, 1)) + 0.01;
      expect(rate).toBeLessThanOrEqual(eps + slack);
    }
    // eslint-disable-next-line no-console
    console.log(
      "[Attack2] wrong-rate by volume:",
      JSON.stringify(rates.map((r) => ({ n: r.n, rate: +r.rate.toFixed(4) }))),
    );
    // The largest-volume realized rate must not exceed the smallest-volume rate
    // by more than sampling noise — no systematic upward drift.
    const first = rates[0].rate;
    const last = rates[rates.length - 1].rate;
    expect(last).toBeLessThanOrEqual(Math.max(first, eps) + 0.03);
  });
});

// ===========================================================================
// ATTACK 3 — CERTIFICATE IS REAL, UNFORGEABLE ed25519 CRYPTO
// ===========================================================================

function detBytes(n: number, seed: number): Uint8Array {
  const a = new Uint8Array(n);
  for (let i = 0; i < n; i++) a[i] = mix32((seed * 7919 + i) | 0) & 0xff;
  return a;
}

function flipHexChar(s: string): string {
  if (s.length === 0) return "a";
  const c = s[0].toLowerCase();
  const nc = c === "0" ? "1" : "0";
  return nc + s.slice(1);
}

function basePayload(output: string): CertificatePayload {
  return {
    outputSha256: sha256Hex(output),
    taskId: "task-styx-001",
    verifierTier: "T2-genrm",
    ensembleScore: 0.87,
    pCorrect: 0.83,
    epsilon: 0.05,
    traceSha256: sha256Hex("trace:{steps:[a,b,c]}"),
    verifierVersions: ["exec@1.2.0", "genrm@0.4.1"],
    issuedAt: 1_700_000_000_000,
  };
}

describe("Attack 3 — certificate is real unforgeable ed25519", () => {
  const privA = generatePrivateKeyHex((n) => detBytes(n, 1));
  const privB = generatePrivateKeyHex((n) => detBytes(n, 2));
  const caA = new CertificateAuthority(privA);
  const caB = new CertificateAuthority(privB);
  const output = "The 100th prime is 541.";

  it("a freshly issued certificate verifies true", async () => {
    const cert = await caA.issue(basePayload(output));
    await expect(verifyCertificate(cert)).resolves.toBe(true);
  });

  it("is ed25519, not HMAC: 64-byte (128-hex) signature, 32-byte (64-hex) key", async () => {
    const cert = await caA.issue(basePayload(output));
    expect(cert.signature).toMatch(/^[0-9a-f]{128}$/); // 64-byte sig ⇒ ed25519, not 32-byte HMAC
    expect(cert.publicKey).toMatch(/^[0-9a-f]{64}$/); // 32-byte ed25519 public key
    expect(caA.publicKeyHex()).toBe(cert.publicKey);
  });

  it("(a) flipping ONE field in the payload breaks verification — every field", async () => {
    const cert = await caA.issue(basePayload(output));
    const p = cert.payload;
    const mutations: CertificatePayload[] = [
      { ...p, outputSha256: flipHexChar(p.outputSha256) },
      { ...p, taskId: p.taskId + "!" },
      { ...p, verifierTier: "T0-execution" },
      { ...p, ensembleScore: p.ensembleScore + 0.01 },
      { ...p, pCorrect: p.pCorrect + 0.01 },
      { ...p, epsilon: p.epsilon + 0.001 },
      { ...p, traceSha256: flipHexChar(p.traceSha256) },
      { ...p, verifierVersions: [...p.verifierVersions, "smuggled@9.9.9"] },
      { ...p, issuedAt: p.issuedAt + 1 },
    ];
    // Every single-field tamper must be rejected — the signature is over the
    // WHOLE canonical payload.
    for (const payload of mutations) {
      const tampered: VerificationCertificate = { ...cert, payload };
      await expect(verifyCertificate(tampered)).resolves.toBe(false);
    }
    // Sanity: an untouched copy still verifies (mutation was the only cause).
    await expect(verifyCertificate({ ...cert })).resolves.toBe(true);
  });

  it("(b) swapping in a different CA's public key breaks verification", async () => {
    const cert = await caA.issue(basePayload(output));
    const swapped: VerificationCertificate = { ...cert, publicKey: caB.publicKeyHex() };
    await expect(verifyCertificate(swapped)).resolves.toBe(false);
  });

  it("(c) re-attaching payload A's signature onto payload B is rejected", async () => {
    const certA = await caA.issue(basePayload(output));
    const payloadB = { ...basePayload(output), taskId: "task-styx-999", pCorrect: 0.99 };
    const forged: VerificationCertificate = {
      payload: payloadB,
      signature: certA.signature, // A's signature over A's payload
      publicKey: caA.publicKeyHex(),
    };
    await expect(verifyCertificate(forged)).resolves.toBe(false);
  });

  it("(d) truncated / empty / garbage signatures verify false WITHOUT throwing", async () => {
    const cert = await caA.issue(basePayload(output));
    const badSigs = [
      "", // empty
      "abcd", // too short
      cert.signature.slice(0, 126), // truncated to 63 bytes
      cert.signature + "00", // too long
      "zz".repeat(64), // right length, non-hex garbage
      "00".repeat(64), // right length, valid hex, wrong bytes
    ];
    for (const signature of badSigs) {
      // If any of these threw instead of returning false, the await rejects and
      // the test fails — which is exactly the "no throw" guarantee under attack.
      await expect(
        verifyCertificate({ ...cert, signature }),
      ).resolves.toBe(false);
    }
  });

  it("(e) certifiesOutput returns false for a different output text", async () => {
    const cert = await caA.issue(basePayload(output));
    await expect(certifiesOutput(cert, output)).resolves.toBe(true);
    await expect(certifiesOutput(cert, "The 100th prime is 542.")).resolves.toBe(false);
  });

  it("(f) a second CA cannot forge a cert that verifies under the first CA's key", async () => {
    // caB signs its own payload, then claims caA as issuer.
    const certB = await caB.issue(basePayload(output));
    await expect(verifyCertificate(certB)).resolves.toBe(true); // valid under B
    const impersonating: VerificationCertificate = {
      ...certB,
      publicKey: caA.publicKeyHex(), // claim to be A
    };
    await expect(verifyCertificate(impersonating)).resolves.toBe(false);
    // And B's signature is not accepted for A's key even with A's own payload.
    const certA = await caA.issue(basePayload(output));
    await expect(
      verifyCertificate({ ...certA, signature: certB.signature }),
    ).resolves.toBe(false);
  });
});

// ===========================================================================
// ATTACK 4 — TAMPER-EVIDENCE END-TO-END (provenance integrity)
// ===========================================================================
//
// Build a cert for a REAL output + gate decision (pCorrect 0.6), then simulate
// an attacker inflating the delivered pCorrect to 0.999 in the payload. The
// certificate must catch it. Provenance (integrity leg) holds even though the
// number the attacker wants is "better".

describe("Attack 4 — end-to-end tamper evidence", () => {
  it("inflating pCorrect 0.6 → 0.999 in the delivered payload is caught", async () => {
    // Real gate decision feeding the correctness leg.
    const cal: CalibrationPoint[] = [];
    for (let i = 0; i < 400; i++) {
      const s = rnd(i, 201);
      cal.push({ score: s, correct: rnd(i, 202) < s });
    }
    const gate = new ConformalGate({ epsilon: 0.2, minCalibration: 10 });
    gate.calibrate(cal);
    const decision = gate.decide(0.62);

    const output = "Refund policy: 30 days, receipt required.";
    const priv = generatePrivateKeyHex((n) => detBytes(n, 7));
    const ca = new CertificateAuthority(priv);
    const payload: CertificatePayload = {
      outputSha256: sha256Hex(output),
      taskId: "refund-policy",
      verifierTier: "T1-reference",
      ensembleScore: decision.score,
      pCorrect: 0.6,
      epsilon: 0.2,
      traceSha256: sha256Hex("trace:refund"),
      verifierVersions: ["ref@2.0.0"],
      issuedAt: 1_700_000_000_001,
    };
    const cert = await ca.issue(payload);
    await expect(verifyCertificate(cert)).resolves.toBe(true);

    // Attacker rewrites the delivered payload's pCorrect to look near-certain.
    const attacked: VerificationCertificate = {
      ...cert,
      payload: { ...cert.payload, pCorrect: 0.999 },
    };
    await expect(verifyCertificate(attacked)).resolves.toBe(false);
    // The honest output still certifies; provenance integrity holds.
    await expect(certifiesOutput(cert, output)).resolves.toBe(true);
  });
});

// ===========================================================================
// ATTACK 5 — LABEL-FREE ENSEMBLE CALIBRATION ISN'T VACUOUS
// ===========================================================================
//
// 200 items, 3 reliable verifiers (~0.85 acc) + 1 ADVERSARIAL verifier that
// votes OPPOSITE the truth (~0.1 acc). With NO labels, the ensemble must:
//   (i) give the liar a LOWER reliability weight than each good verifier,
//  (ii) achieve item-accuracy > the liar's raw accuracy AND ≥ unweighted
//       majority. If a liar earns equal/high weight, label-free calibration
//       is broken — report it.

function verifierVote(itemCorrect: boolean, targetAcc: number, i: number, salt: number): boolean {
  const accurate = rnd(i, salt) < targetAcc;
  // passed == "this verifier believes item is correct"
  return accurate ? itemCorrect : !itemCorrect;
}

describe("Attack 5 — ensemble down-weights an adversarial (lying) verifier", () => {
  const M = 200;
  const truth: boolean[] = [];
  const votes: VerifierVote[][] = [];
  for (let i = 0; i < M; i++) {
    const itemCorrect = rnd(i, 300) < 0.5;
    truth.push(itemCorrect);
    votes.push([
      { verifierId: "good_1", passed: verifierVote(itemCorrect, 0.85, i, 311) },
      { verifierId: "good_2", passed: verifierVote(itemCorrect, 0.85, i, 312) },
      { verifierId: "good_3", passed: verifierVote(itemCorrect, 0.85, i, 313) },
      { verifierId: "liar", passed: verifierVote(itemCorrect, 0.1, i, 314) },
    ]);
  }

  const ens = new WeakVerifierEnsemble({ maxIters: 50, tolerance: 1e-9 });
  const results = ens.fitPredict(votes);
  const rel = ens.reliabilities();

  it("liar's learned reliability is below every good verifier's", () => {
    // eslint-disable-next-line no-console
    console.log("[Attack5] reliabilities:", JSON.stringify(
      Object.fromEntries(Object.entries(rel).map(([k, v]) => [k, +v.toFixed(3)])),
    ));
    expect(rel.liar).toBeLessThan(rel.good_1);
    expect(rel.liar).toBeLessThan(rel.good_2);
    expect(rel.liar).toBeLessThan(rel.good_3);
    // The liar should collapse toward ~0, the good ones toward ~0.85.
    expect(rel.liar).toBeLessThan(0.3);
    expect(rel.good_1).toBeGreaterThan(0.7);
  });

  it("ensemble item-accuracy beats the liar's raw accuracy and unweighted majority", () => {
    let ensCorrect = 0;
    let liarCorrect = 0;
    let majCorrect = 0;
    for (let i = 0; i < M; i++) {
      const predEns = results[i].score >= 0.5; // ensemble "item is correct"
      if (predEns === truth[i]) ensCorrect += 1;

      const liarVote = votes[i].find((v) => v.verifierId === "liar")!.passed;
      if (liarVote === truth[i]) liarCorrect += 1;

      const passCount = votes[i].filter((v) => v.passed).length;
      const majPass = passCount * 2 >= votes[i].length; // tie → pass (matches module)
      if (majPass === truth[i]) majCorrect += 1;
    }
    const ensAcc = ensCorrect / M;
    const liarAcc = liarCorrect / M;
    const majAcc = majCorrect / M;
    // eslint-disable-next-line no-console
    console.log(
      "[Attack5] acc:",
      JSON.stringify({ ens: +ensAcc.toFixed(3), majority: +majAcc.toFixed(3), liar: +liarAcc.toFixed(3) }),
    );
    expect(ensAcc).toBeGreaterThan(liarAcc); // label-free fusion beats the liar
    expect(ensAcc).toBeGreaterThanOrEqual(majAcc - 1e-12); // and is no worse than plain majority
  });
});

// ===========================================================================
// ATTACK 6 — THE KNOWN LIMITATION IS REAL, NOT HIDDEN (correlated bias)
// ===========================================================================
//
// The exchangeability failure: ALL verifiers share the SAME bias (all wrong on
// the SAME 30% of items). Inter-agreement carries NO signal about a CORRELATED
// error, so the ensemble is CONFIDENTLY WRONG on the shared blind spot. This is
// EXPECTED and DOCUMENTED (module doc for tiers.ts + design constraint #3):
// it is exactly what the S3 isomorphic-perturbation harness must catch. This
// test documents the limitation — it is NOT labelled a bug.

describe("Attack 6 — correlated shared-bias blind spot (documented limitation)", () => {
  const M = 100;
  const blindspotCount = 30; // 30% shared blind spot
  const truth: boolean[] = [];
  const votes: VerifierVote[][] = [];
  const verifierIds = ["v1", "v2", "v3", "v4"];

  for (let i = 0; i < M; i++) {
    const inBlindspot = i < blindspotCount;
    // In the blind spot the item is actually WRONG but every verifier PASSES it
    // (the shared bias). Outside it, verifiers vote the ground truth correctly.
    const itemCorrect = inBlindspot ? false : rnd(i, 400) < 0.5;
    truth.push(itemCorrect);
    const passed = inBlindspot ? true : itemCorrect;
    votes.push(verifierIds.map((verifierId) => ({ verifierId, passed })));
  }

  const ens = new WeakVerifierEnsemble({ maxIters: 50, tolerance: 1e-9 });
  const results = ens.fitPredict(votes);

  it("ensemble is confidently WRONG across the shared blind spot (expected)", () => {
    let confidentlyWrong = 0;
    for (let i = 0; i < blindspotCount; i++) {
      const r = results[i];
      // High agreement (all verifiers pass) and a high calibrated score...
      expect(r.agreement).toBe(1);
      expect(r.score).toBeGreaterThanOrEqual(0.9);
      // ...but the item is actually wrong. This SHOULD NOT be caught here.
      if (r.score >= 0.9 && truth[i] === false) confidentlyWrong += 1;
    }
    // EXPECTED/DOCUMENTED: agreement cannot detect a correlated error. This is
    // the known limitation S3 (perturbation) must address — NOT a bug in S1.
    expect(confidentlyWrong).toBe(blindspotCount);
    // eslint-disable-next-line no-console
    console.log(
      "[Attack6] shared-bias blind spot: ensemble confidently wrong on",
      confidentlyWrong,
      "of",
      blindspotCount,
      "items (documented limitation — perturbation harness S3 must catch it)",
    );
  });
});

// ===========================================================================
// ATTACK 7 — COMPOSITION: tier actually changes the emit/abstain outcome
// ===========================================================================
//
// route task signals → tier → confidence floor → ensemble score → gate.
// Emit iff score ≥ max(τ, tierFloor). With the SAME score and SAME τ, an
// executable task (T0, low floor) must EMIT while a consistency-only task (T4,
// high floor) must ABSTAIN. If the tier doesn't flip the outcome, the tier
// router is decorative.

describe("Attack 7 — tier composition flips emit vs abstain at equal score", () => {
  it("T0 emits and T4 abstains on the SAME calibrated score", () => {
    const baseEpsilon = 0.1;

    // --- routing ---
    const execTier = routeTier({ executable: true });
    const consistencyTier = routeTier({}); // no signals ⇒ weakest fallback
    expect(execTier).toBe("T0-execution");
    expect(consistencyTier).toBe("T4-consistency");

    const floorT0 = tierConfidenceFloor(execTier, baseEpsilon);
    const floorT4 = tierConfidenceFloor(consistencyTier, baseEpsilon);
    expect(floorT0).toBeLessThan(floorT4); // weaker tier ⇒ higher bar
    expect(floorT0).toBeCloseTo(0.9, 6);
    expect(floorT4).toBeCloseTo(0.998, 6);

    // --- ensemble score for one "decent" answer ---
    // Fit 14 reliable verifiers so learned weights are high & ~equal.
    const fitVotes: VerifierVote[][] = [];
    const vids = Array.from({ length: 14 }, (_, k) => `w${k}`);
    for (let i = 0; i < 80; i++) {
      const itemCorrect = rnd(i, 500) < 0.5;
      fitVotes.push(
        vids.map((verifierId, k) => ({
          verifierId,
          passed: verifierVote(itemCorrect, 0.9, i, 510 + k),
        })),
      );
    }
    const ens = new WeakVerifierEnsemble({ maxIters: 50, tolerance: 1e-9 });
    ens.fitPredict(fitVotes);
    // Query item: 13 of 14 pass ⇒ weighted score ≈ 0.93 (decent, not certain).
    const queryItem: VerifierVote[] = vids.map((verifierId, k) => ({
      verifierId,
      passed: k !== 0,
    }));
    const score = ens.scoreItem(queryItem);
    expect(score).toBeGreaterThan(floorT0); // above the strong-tier bar
    expect(score).toBeLessThan(floorT4); // below the weak-tier bar

    // --- gate threshold on well-calibrated [0,1] scores ---
    const cal: CalibrationPoint[] = [];
    for (let i = 0; i < 2000; i++) {
      const s = rnd(i, 600);
      cal.push({ score: s, correct: rnd(i, 601) < s });
    }
    const gate = new ConformalGate({ epsilon: 0.15, minCalibration: 10 });
    const tau = gate.calibrate(cal).threshold;
    expect(Number.isFinite(tau)).toBe(true);

    // --- composition: emit iff score ≥ max(τ, tierFloor) ---
    const emit = (s: number, floor: number) => s >= Math.max(tau, floor);
    const emitT0 = emit(score, floorT0);
    const emitT4 = emit(score, floorT4);

    // eslint-disable-next-line no-console
    console.log(
      "[Attack7] compose:",
      JSON.stringify({
        score: +score.toFixed(3),
        tau: +tau.toFixed(3),
        floorT0: +floorT0.toFixed(3),
        floorT4: +floorT4.toFixed(3),
        emitT0,
        emitT4,
      }),
    );

    // THE COMPOSITION CLAIM: the tier — nothing else — flips the outcome.
    expect(emitT0).toBe(true);
    expect(emitT4).toBe(false);
  });
});
