/**
 * THE phase checkpoint: run one real task with the air-gap genuinely
 * engaged, produce a real ed25519-signed verification certificate, and
 * report — never fabricate — whether the whole chain of custody actually
 * held.
 *
 * This module is pure composition of REAL modules, never a stand-in:
 *
 *  - `GovKeystore` / `GovIdentity` (Team 1) resolve the signing identity —
 *    a corrupt on-disk identity aborts loudly (the keystore's own discipline
 *    of never silently minting a replacement identity), never a fabricated
 *    "healed" run.
 *  - `CapabilityIssuer` / `CapabilityEnforcer` (Team 2) gate every
 *    `ctx.authorize()` call the task makes through a REAL macaroon-style
 *    capability chain, deliberately minted WITHOUT a `net:*` grant — a task
 *    that asks to authorize network egress is denied with a genuine, typed
 *    `CapabilityDenyCode`, not a hand-waved refusal.
 *  - `GovAuditChain` + `signCheckpoint` (Team 3) give the run a real,
 *    hash-chained, tamper-evident audit trail and a real signed Merkle
 *    checkpoint over it. A pre-existing chain that fails verification makes
 *    the run refuse to start outright — this module NEVER appends to audit
 *    history it cannot already trust.
 *  - `PolicyStore` / `PolicyEngine` (Team 4) gate every `ctx.authorize()`
 *    call a SECOND, independent way: `DEFAULT_GOV_POLICY`'s own
 *    `deny-net-egress-airgapped` rule denies network egress under an
 *    air-gapped request regardless of what any capability grants. A policy
 *    document that is present but fails to load `"ok"` (unsigned, forged,
 *    a rollback attempt, ...) fails CLOSED — every `authorize()` call is
 *    denied for the rest of the run, and the final result honestly reports
 *    `verified: false`. Only a genuinely ABSENT policy is auto-bootstrapped
 *    with `DEFAULT_GOV_POLICY` (first-run ergonomics); an existing-but-
 *    broken one is never silently "healed".
 *  - `engageAirgap` (this team) genuinely interdicts the process's real
 *    egress seams for the FULL lifetime of the task — every blocked or
 *    allowed attempt is recorded both in the returned `AirgapReport` and as
 *    its own entry in the durable audit chain.
 *  - The certificate is issued by the real `CertificateAuthority` and
 *    re-verified by the real `verifyCertificate` (ed25519, `@noble/ed25519`)
 *    — never synthesized. Its `ensembleScore`/`pCorrect` carry a T0
 *    DETERMINISTIC verdict (exactly 1 or exactly 0), because that is the
 *    only thing this run actually establishes: those fields are defined by
 *    ../styx/certificate as CALIBRATED quantities, and this run never
 *    touches the STYX verifier ensemble, so putting any uncalibrated
 *    statistic there would hand a consumer a fabricated probability. The
 *    run's real authorization allow-rate is reported separately, on
 *    `AirgappedRunResult.authorizeAllowRate`, under a name that says what
 *    it is. See the comment at the certificate-issuance site.
 *
 * `AirgappedRunResult.verified` is the single honest verdict: it is `true`
 * if and only if the task ran to completion, the certificate's signature
 * verifies, the audit chain verifies from its own bytes, the air-gap sealed
 * every requested seam, AND the policy that gated every authorization
 * decision actually loaded `"ok"`. Any one of those failing sets it `false`
 * — there is no path that reports a fabricated pass.
 */

import { join } from "node:path";

import { GovKeystore, govRoot } from "./keystore";
import type { GovIdentity } from "./identity";
import {
  CapabilityIssuer,
  CapabilityEnforcer,
  type CapabilityRequest,
  type CapabilityDecision,
} from "./capability";
import { GovAuditChain, type AppendInput, type AuditVerification } from "./audit-chain";
import type { SignedCheckpoint } from "./audit-proof";
import { PolicyStore } from "./policy-store";
import { DEFAULT_GOV_POLICY } from "./policy";
import { engageAirgap, AirgapViolationError, type AirgapPolicy, type AirgapReport, type EgressAttempt } from "./airgap";
import { CertificateAuthority, verifyCertificate, sha256Hex, type VerificationCertificate } from "../styx/certificate";

// Re-exported so a caller that only imports from this module still has the
// error type an intercepted egress attempt throws.
export { AirgapViolationError };

// ---------------------------------------------------------------------------
// Locked public types
// ---------------------------------------------------------------------------

export interface AirgappedRunOptions {
  dataDir: string;
  task: { id: string; prompt: string; run: (ctx: AirgappedTaskContext) => Promise<string> };
  policy?: AirgapPolicy;
  now?: () => number;
  identity?: GovIdentity;
  auditDir?: string;
}

export interface AirgappedTaskContext {
  authorize(req: CapabilityRequest): CapabilityDecision;
  audit(input: AppendInput): void;
  airgapped: true;
}

export interface AirgappedRunResult {
  ok: boolean;
  verified: boolean;
  output: string;
  certificate?: VerificationCertificate;
  certificateValid: boolean;
  airgap: AirgapReport;
  audit: AuditVerification;
  checkpoint: SignedCheckpoint;
  denials: CapabilityDecision[];
  egressAttempts: EgressAttempt[];
  /**
   * Fraction of this run's own `ctx.authorize()` calls that were allowed —
   * a real measured count over real decisions, and nothing more. It is NOT a
   * correctness probability, NOT calibrated, and deliberately does not go
   * into the certificate's `pCorrect`/`ensembleScore` fields (which the
   * certificate schema defines as calibrated quantities). Absent when the
   * task made no authorization calls, rather than defaulted to 1.
   */
  authorizeAllowRate?: number;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// runAirgappedTask
// ---------------------------------------------------------------------------

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export async function runAirgappedTask(opts: AirgappedRunOptions): Promise<AirgappedRunResult> {
  const now = opts.now ?? ((): number => Date.now());
  const startedAt = now();

  if (typeof opts.dataDir !== "string" || opts.dataDir.length === 0) {
    throw new RangeError("runAirgappedTask: opts.dataDir must be a non-empty path");
  }
  if (!opts.task || typeof opts.task.id !== "string" || opts.task.id.length === 0 || typeof opts.task.run !== "function") {
    throw new RangeError("runAirgappedTask: opts.task must be { id: non-empty string, prompt: string, run: fn }");
  }

  const govDir = govRoot(opts.dataDir);

  // --- identity: a corrupt keystore aborts loudly (GovKeystore's own discipline) --------
  let identity: GovIdentity;
  if (opts.identity) {
    identity = opts.identity;
  } else {
    const keystore = GovKeystore.open({ dir: govDir, now });
    identity = keystore.load().identity;
  }
  const subject = identity.agentId();

  // --- audit chain: refuse to start on a pre-existing tampered chain --------------------
  const auditBase = opts.auditDir ?? govDir;
  const chain = GovAuditChain.open({ dir: auditBase, now });
  const preflight = chain.verify();
  if (!preflight.ok) {
    const first = preflight.failures[0];
    throw new Error(
      `runAirgappedTask: refusing to start — the pre-existing audit chain at "${auditBase}" failed verification ` +
        `(${first?.code ?? "unknown"} at seq ${preflight.brokenAt ?? "?"}: ${first?.detail ?? "unknown failure"})`,
    );
  }

  chain.append({
    at: now(),
    actor: subject,
    action: "airgap.run.start",
    resource: opts.task.id,
    outcome: "info",
    payload: { prompt: opts.task.prompt },
  });

  // --- policy: fail CLOSED; auto-bootstrap ONLY a genuinely absent policy ---------------
  const policyDir = join(govDir, "policy");
  const policyStore = PolicyStore.open({ dir: policyDir, trustedSignerPublicKeys: [identity.publicKeyHex()], now });
  let policyResult = policyStore.load();
  if (policyResult.status === "absent") {
    policyStore.save(DEFAULT_GOV_POLICY, identity);
    policyResult = policyStore.load();
  }
  chain.append({
    at: now(),
    actor: subject,
    action: "policy.load",
    resource: policyDir,
    outcome: policyResult.status === "ok" ? "info" : "deny",
    code: policyResult.status,
    payload: { reason: policyResult.reason },
  });
  const policyEngine = policyResult.engine;

  // --- capability stack: a root token scoped WITHOUT any net:* grant --------------------
  const issuer = new CapabilityIssuer(identity, { now });
  const rootToken = issuer.mint({
    subject,
    // Action names deliberately mirror `DEFAULT_GOV_POLICY`'s own vocabulary
    // (`tool:invoke`, `fs:read`/`fs:write`, `memory:write`) — never `net:*` —
    // so a legitimate request can clear BOTH the capability layer and the
    // policy layer, while any `net:egress` request is structurally
    // ungranted at the capability layer alone, before policy is even asked.
    grants: [
      { resource: "tool:*", actions: ["tool:invoke"] },
      { resource: `fs:${opts.dataDir}/scratch/**`, actions: ["fs:read", "fs:write"] },
      { resource: "memory:*", actions: ["memory:write"] },
    ],
    caveats: [{ kind: "airgap-only", required: true }],
    ttlMs: 60 * 60 * 1000,
  });
  const enforcer = new CapabilityEnforcer({ trustedIssuerPublicKeys: [identity.publicKeyHex()], now });

  const denials: CapabilityDecision[] = [];
  const decisions: CapabilityDecision[] = [];
  const trace: Array<{ seq: number; kind: string; detail: string }> = [];
  let traceSeq = 0;
  const pushTrace = (kind: string, detail: string): void => {
    trace.push({ seq: traceSeq++, kind, detail });
  };
  pushTrace("run.start", opts.task.id);

  // --- air-gap: engaged BEFORE the task runs, released right after ----------------------
  const session = engageAirgap({
    policy: opts.policy,
    now,
    onAttempt: (a) => {
      chain.append({
        at: a.at,
        actor: subject,
        action: `airgap.egress.${a.blocked ? "blocked" : "allowed"}`,
        resource: `${a.seam}:${a.target}`,
        outcome: a.blocked ? "deny" : "info",
        code: a.seam,
        payload: { reason: a.reason },
      });
      pushTrace(`egress.${a.blocked ? "blocked" : "allowed"}`, `${a.seam} -> ${a.target}`);
    },
  });

  const ctx: AirgappedTaskContext = {
    airgapped: true,
    authorize: (req: CapabilityRequest): CapabilityDecision => {
      // This context is unconditionally air-gapped — the request always
      // reflects that truthfully, regardless of what the caller passed.
      const grounded: CapabilityRequest = { ...req, airgapped: true };
      const capDecision = enforcer.authorize([rootToken], grounded);
      let final = capDecision;
      if (capDecision.allow) {
        const policyDecision = policyEngine.evaluate({
          subject: grounded.subject,
          action: grounded.action,
          resource: grounded.resource,
          args: grounded.args,
          at: grounded.at,
          airgapped: true,
          capabilities: rootToken.grants.map((g) => g.resource),
        });
        if (policyDecision.effect === "deny") {
          final = {
            allow: false,
            code: "caveat-failed",
            reason: `policy denied: ${policyDecision.reason}`,
            tokenId: capDecision.tokenId,
            depth: capDecision.depth,
          };
        }
      }
      decisions.push(final);
      if (!final.allow) denials.push(final);
      chain.append({
        at: grounded.at,
        actor: grounded.subject,
        action: `authorize:${grounded.action}`,
        resource: grounded.resource,
        outcome: final.allow ? "allow" : "deny",
        code: final.code,
        payload: { reason: final.reason },
      });
      pushTrace(`authorize.${final.allow ? "allow" : "deny"}`, `${grounded.action} ${grounded.resource} [${final.code}]`);
      return final;
    },
    audit: (input: AppendInput): void => {
      chain.append(input);
      pushTrace("task.audit", `${input.action} ${input.resource} -> ${input.outcome}`);
    },
  };

  let output = "";
  let taskError: unknown;
  try {
    output = await opts.task.run(ctx);
  } catch (err) {
    taskError = err;
  }

  session.release();
  const airgapReport = session.report();
  const ok = taskError === undefined;

  chain.append({
    at: now(),
    actor: subject,
    action: "airgap.run.end",
    resource: opts.task.id,
    outcome: ok ? "info" : "error",
    payload: { ok, egressAttempts: airgapReport.attempts.length, blocked: airgapReport.attempts.filter((a) => a.blocked).length },
  });
  pushTrace("run.end", ok ? "ok" : `error: ${errMsg(taskError)}`);

  // --- certificate: real ed25519, issued only for a task that actually completed --------
  //
  // `CertificatePayload.pCorrect`/`ensembleScore` are DEFINED by
  // ../styx/certificate as a calibrated ensemble score and a calibrated
  // P(correct). This run never touches the STYX verifier ensemble and has no
  // calibration, so putting any uncalibrated statistic (an authorize()
  // allow-rate, a heuristic, a guess) into those fields would hand every
  // downstream consumer a fabricated probability under a name that promises
  // a measured one. What this run DOES have is a T0 deterministic execution
  // verdict — an exact boolean recomputed from real artifacts: the task
  // completed, the air-gap actually sealed every requested seam, the policy
  // bundle loaded and verified, and the audit chain re-verifies from its own
  // bytes. A deterministic checker's score is exactly 1 (passed) or 0
  // (failed) — no calibration is involved or implied — and `epsilon: 0`
  // records that no conformal bound was applied. The allow-rate is NOT
  // discarded: it is reported on the result as `authorizeAllowRate`, where
  // its name states what it is.
  //
  // The audit chain is verified HERE, before issuance, so the verdict the
  // certificate carries is the one that was true when it was signed; the
  // final `chain.verify()` below re-runs after the certificate.issue append
  // so the returned AuditVerification still covers the whole file.
  let certificate: VerificationCertificate | undefined;
  let certificateValid = false;
  const preCertAudit = chain.verify();
  const deterministicVerdict = ok && airgapReport.sealed && policyResult.status === "ok" && preCertAudit.ok;
  const allowedDecisions = decisions.filter((d) => d.allow).length;
  const authorizeAllowRate = decisions.length > 0 ? allowedDecisions / decisions.length : undefined;
  if (ok) {
    const ca = new CertificateAuthority(identity.privateKeyHex());
    const outputSha256 = sha256Hex(output);
    const traceSha256 = sha256Hex(JSON.stringify(trace));
    const t0Score = deterministicVerdict ? 1 : 0;
    certificate = await ca.issue({
      outputSha256,
      taskId: opts.task.id,
      verifierTier: "T0-execution",
      ensembleScore: t0Score,
      pCorrect: t0Score,
      epsilon: 0,
      traceSha256,
      verifierVersions: ["hades.gov.airgap-run.v1"],
      issuedAt: now(),
    });
    certificateValid = await verifyCertificate(certificate);
    chain.append({
      at: now(),
      actor: subject,
      action: "certificate.issue",
      resource: opts.task.id,
      outcome: certificateValid ? "info" : "error",
      payload: { outputSha256, traceSha256, certificateValid, deterministicVerdict },
    });
  }

  const checkpoint = chain.checkpoint(identity, now());
  const auditVerification = chain.verify();
  chain.close();

  const verified = ok && certificateValid && auditVerification.ok && airgapReport.sealed && policyResult.status === "ok";

  return {
    ok,
    verified,
    output,
    certificate,
    certificateValid,
    airgap: airgapReport,
    audit: auditVerification,
    checkpoint,
    denials,
    egressAttempts: airgapReport.attempts,
    ...(authorizeAllowRate !== undefined ? { authorizeAllowRate } : {}),
    durationMs: now() - startedAt,
  };
}

// ---------------------------------------------------------------------------
// formatAirgapRunReport — plain aligned ASCII, terminal only
// ---------------------------------------------------------------------------

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

/** Strips ASCII control characters (0x00-0x1F, 0x7F) from any string that
 *  originated outside this module before it is echoed into an output line —
 *  a deny reason embeds a token's own resource/audience strings, and an
 *  egress target is whatever the guarded call was pointed at, so either can
 *  carry a crafted escape sequence that would otherwise repaint the
 *  operator's terminal (e.g. forging a "VERIFIED" line). Same discipline as
 *  `sanitize` in src/hades/cli/backends-command.ts. */
function sanitize(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\x00-\x1F\x7F]/g, "");
}

export function formatAirgapRunReport(r: AirgappedRunResult): string[] {
  const lines: string[] = [];
  lines.push("AIR-GAPPED TASK RUN");
  lines.push("=".repeat(72));
  lines.push(`${pad("result", 20)}${r.ok ? "COMPLETED" : "FAILED"}`);
  lines.push(`${pad("verified", 20)}${r.verified ? "YES" : "NO"}`);
  lines.push(`${pad("air-gap sealed", 20)}${r.airgap.sealed ? "YES" : "NO"}`);
  lines.push(
    `${pad("egress attempts", 20)}${r.egressAttempts.length} total, ${r.egressAttempts.filter((a) => a.blocked).length} blocked`,
  );
  lines.push(`${pad("capability denials", 20)}${r.denials.length}`);
  if (r.authorizeAllowRate !== undefined) {
    lines.push(`${pad("allow-rate", 20)}${(r.authorizeAllowRate * 100).toFixed(1)}% (measured over this run's own authorize() calls — not a correctness probability)`);
  }
  lines.push(`${pad("audit chain", 20)}${r.audit.ok ? "VERIFIED" : "FAILED"} (${r.audit.entries} entries)`);
  lines.push(`${pad("checkpoint", 20)}treeSize=${r.checkpoint.treeSize} root=${r.checkpoint.root.slice(0, 16)}...`);
  if (r.certificate) {
    lines.push(`${pad("certificate", 20)}${r.certificateValid ? "VALID" : "INVALID"} sig=${r.certificate.signature.slice(0, 16)}...`);
  } else {
    lines.push(`${pad("certificate", 20)}none (task did not complete)`);
  }
  lines.push(`${pad("duration", 20)}${r.durationMs}ms`);

  if (r.denials.length > 0) {
    lines.push("");
    lines.push("DENIALS");
    for (const d of r.denials) lines.push(`  [${d.code}] ${sanitize(d.reason)}`);
  }
  if (r.airgap.unverifiableSeams.length > 0) {
    lines.push("");
    lines.push(`UNVERIFIABLE SEAMS: ${r.airgap.unverifiableSeams.join(", ")}`);
  }
  return lines;
}
