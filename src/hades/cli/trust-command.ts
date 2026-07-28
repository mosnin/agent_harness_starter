/**
 * `hades trust <sub>` — the terminal surface over the unified trust gate.
 *
 *   hades trust status [--json]
 *   hades trust verifiers [--domain D] [--json]
 *   hades trust calibrate [--from-eval] [--from <file.json>] [--domain D]
 *                         [--epsilon E] [--dry-run] [--json]
 *   hades trust admit --file <subject.json> [--json]
 *   hades trust budget [--verify] [--entries N] [--json]
 *   hades trust riskeval [--epsilon E] [--limit N] [--json]
 *   hades trust doctor [--json]
 *   hades trust help
 *
 * Terminal-free (returns `{ code, lines }`) so it unit-tests without a shell
 * or real stdout, matching the rest of `src/hades/cli/*`. Plain aligned
 * ASCII only — this product's front end is the terminal, never a browser.
 *
 * ## What this command will and will not claim
 *
 * Every number printed here is measured by real code on this machine:
 * verifier tiers/priors are read from the shipped calibration tables, fused
 * scores come from the real `WeakVerifierEnsemble`, thresholds from the real
 * split-conformal fit over REAL labeled points, certificates from a real
 * ed25519 signature, and the budget from a real hash-chained ledger that is
 * re-verified from its own bytes on every call.
 *
 * Correspondingly, this command never papers over a gate that cannot
 * certify. An uncalibrated domain is reported as uncalibrated. A calibration
 * fit whose points carry no correct-vs-wrong separation is reported with
 * that AUC and the plain-English verdict, and `doctor` FAILS on it, because
 * a threshold fitted on non-discriminating scores is a threshold that means
 * nothing. `riskeval` reports DEGENERATE, never PASS, for an abstain-all
 * run.
 */

import { existsSync, readFileSync } from "node:fs";

import type { CliResult } from "./cli";
import type { CalibrationPoint } from "../styx/gate";
import {
  openTrustStack,
  summarizeDiscrimination,
  collectEvalCalibration,
  trustDomainStatuses,
  domainCertifiability,
  TRUST_DOMAINS,
  DEFAULT_TRUST_EPSILON,
  type TrustStack,
  type TrustStackOptions,
} from "../trust/wiring";
import { formatTrustGateReport } from "../trust/unified-gate";
import { formatTrustBudgetReport } from "../trust/budget";
import { runRiskEval, formatRiskEvalReport } from "../trust/risk-eval";
import type { TrustDomain, TrustSubject } from "../trust/registry";
import { EVAL_TASKS } from "../bench/eval-suite";

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

export interface TrustCommandDeps {
  /** Lazily open the stack. A factory (not a value) so `hades help` never
   *  mints a signing key or touches `<dataDir>/trust`. */
  stack: () => TrustStack;
  /** Injected for tests; defaults to the real fs read. */
  readFile?: (path: string) => string;
  fileExists?: (path: string) => boolean;
}

export function defaultTrustDeps(
  env: Record<string, string | undefined> = process.env,
  overrides: TrustStackOptions = {},
): TrustCommandDeps {
  let cached: TrustStack | undefined;
  return {
    stack: () => {
      if (!cached) cached = openTrustStack({ env, ...overrides });
      return cached;
    },
  };
}

export const TRUST_USAGE: string[] = [
  "Usage: hades trust <command>",
  "",
  "Commands:",
  "  status [--json]                      Verifier set, per-domain calibration, budget, key",
  "  verifiers [--domain D] [--json]      Every registered verifier with its tier and prior",
  "  calibrate [--from-eval]              Fit per-domain conformal thresholds from REAL",
  "            [--from <file.json>]       labeled (score, correct) observations. --from-eval",
  "            [--domain D] [--epsilon E] derives them by fusing the real verifiers over the",
  "            [--dry-run] [--json]       real EVAL_TASKS corpus and labelling with each",
  "                                       task's own ground-truth grader.",
  "  admit --file <subject.json>          Run one real TrustSubject through the gate and print",
  "        [--json]                       the admission (+ certificate, when one is issued)",
  "  budget [--verify] [--entries N]      Trust-budget report + independent chain verification",
  "         [--json]",
  "  riskeval [--epsilon E] [--limit N]   Silent-wrong-rate checkpoint against the REAL gate",
  "           [--json]",
  "  doctor [--json]                      End-to-end wiring self-check (exit 0 iff healthy)",
  "  help                                 Show this help",
  "",
  "Domains: " + TRUST_DOMAINS.join(", "),
];

// ---------------------------------------------------------------------------
// Small local helpers (own copies — see memory-command.ts's note)
// ---------------------------------------------------------------------------

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

function table(headers: string[], rows: string[][]): string[] {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const out = [headers.map((h, i) => pad(h, widths[i])).join("  ")];
  out.push(widths.map((w) => "-".repeat(w)).join("  "));
  for (const row of rows) out.push(row.map((c, i) => pad(c ?? "", widths[i])).join("  "));
  return out;
}

function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0 || i + 1 >= args.length) return undefined;
  return args[i + 1];
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function numberFlag(args: string[], name: string): { value?: number; error?: string } {
  const raw = flagValue(args, name);
  if (raw === undefined) return {};
  const value = Number(raw);
  if (!Number.isFinite(value)) return { error: `${name} must be a finite number; got ${JSON.stringify(raw)}` };
  return { value };
}

function domainFlag(args: string[]): { value?: TrustDomain; error?: string } {
  const raw = flagValue(args, "--domain");
  if (raw === undefined) return {};
  if (!(TRUST_DOMAINS as readonly string[]).includes(raw)) {
    return { error: `unknown domain ${JSON.stringify(raw)}; expected one of: ${TRUST_DOMAINS.join(", ")}` };
  }
  return { value: raw as TrustDomain };
}

function jsonResult(value: unknown, code = 0): CliResult {
  return { code, lines: JSON.stringify(value, null, 2).split("\n") };
}

function fail(message: string): CliResult {
  return { code: 1, lines: [`trust: ${message}`] };
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export async function runTrustCommand(args: string[], deps: TrustCommandDeps): Promise<CliResult> {
  const [sub, ...rest] = args;
  switch (sub) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      return { code: 0, lines: TRUST_USAGE };
    case "status":
      return status(rest, deps);
    case "verifiers":
      return verifiers(rest, deps);
    case "calibrate":
      return calibrate(rest, deps);
    case "admit":
      return admit(rest, deps);
    case "budget":
      return budget(rest, deps);
    case "riskeval":
      return riskeval(rest, deps);
    case "doctor":
      return doctor(rest, deps);
    default:
      return { code: 1, lines: [`Unknown trust command: ${sub}`, "", ...TRUST_USAGE] };
  }
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

function status(args: string[], deps: TrustCommandDeps): CliResult {
  const stack = deps.stack();
  const statuses = trustDomainStatuses(stack);
  const registered = stack.registry.list();
  const budgetReport = stack.budget ? stack.budget.report() : null;
  const chain = stack.budget ? stack.budget.verifyChain() : null;

  if (hasFlag(args, "--json")) {
    return jsonResult({
      root: stack.root,
      epsilon: stack.epsilon,
      key: { source: stack.key.source, publicKeyHex: stack.key.publicKeyHex },
      verifiers: registered.length,
      domains: statuses,
      budget: budgetReport,
      chain,
      calibrationLoadError: stack.calibration.loadError,
    });
  }

  const lines: string[] = [];
  lines.push("UNIFIED TRUST GATE");
  lines.push("=".repeat(72));
  lines.push(`root            ${stack.root ?? "(in-memory)"}`);
  lines.push(`epsilon         ${stack.epsilon}`);
  lines.push(`signing key     ${stack.key.source}  pub=${stack.key.publicKeyHex.slice(0, 16)}...`);
  if (stack.key.source === "ephemeral") {
    lines.push("                WARNING: ephemeral key — certificates will not verify in a later process.");
  }
  lines.push(`verifiers       ${registered.length} registered`);
  if (stack.calibration.loadError) {
    lines.push(`calibration     UNREADABLE: ${stack.calibration.loadError}`);
  }
  lines.push("");

  lines.push("PER-DOMAIN");
  lines.push(
    ...table(
      ["DOMAIN", "VERIFIERS", "CALIBRATED", "POINTS", "THRESHOLD", "EPSILON", "NOTE"],
      statuses.map((s) => {
        const n = stack.registry.list(s.domain).length;
        const threshold =
          s.stats === null ? "-" : Number.isFinite(s.stats.threshold) ? s.stats.threshold.toFixed(4) : "+Inf";
        const note = s.error
          ? `error: ${s.error}`
          : s.stats !== null && !Number.isFinite(s.stats.threshold)
            ? "abstains on everything (no score clears the bound)"
            : s.calibrated
              ? ""
              : "uncalibrated — gate abstains";
        return [
          s.domain,
          String(n),
          s.calibrated ? "yes" : "no",
          String(s.points),
          threshold,
          s.stats === null ? "-" : s.stats.epsilon.toFixed(4),
          note,
        ];
      }),
    ),
  );
  lines.push("");

  lines.push("THIS SESSION");
  lines.push(formatTrustGateReport(stack.gate.report()));

  if (budgetReport && chain) {
    lines.push("");
    lines.push(formatTrustBudgetReport(budgetReport));
    lines.push("");
    lines.push(
      chain.ok
        ? `chain         VERIFIED (${chain.length} entr${chain.length === 1 ? "y" : "ies"})`
        : `chain         FAILED: ${chain.reason} at seq ${chain.firstBadSeq ?? "?"} — spending refused`,
    );
  }
  return { code: 0, lines };
}

// ---------------------------------------------------------------------------
// verifiers
// ---------------------------------------------------------------------------

function verifiers(args: string[], deps: TrustCommandDeps): CliResult {
  const domain = domainFlag(args);
  if (domain.error) return fail(domain.error);
  const stack = deps.stack();
  const list = stack.registry.list(domain.value);

  if (hasFlag(args, "--json")) {
    return jsonResult(
      list.map((v) => ({ id: v.id, version: v.version, domain: v.domain, tier: v.tier, prior: v.prior })),
    );
  }
  if (list.length === 0) {
    return { code: 0, lines: [`No verifiers registered${domain.value ? ` for domain "${domain.value}"` : ""}.`] };
  }
  return {
    code: 0,
    lines: [
      `REGISTERED VERIFIERS (${list.length})`,
      "",
      ...table(
        ["ID", "VERSION", "DOMAIN", "TIER", "PRIOR"],
        list.map((v) => [v.id, v.version, v.domain, v.tier, v.prior.toFixed(2)]),
      ),
      "",
      "prior is a HARD ceiling: no verdict from a verifier may exceed it, and the fused tier",
      "is always the WEAKEST tier that actually voted — a strong tier never leaks upward.",
    ],
  };
}

// ---------------------------------------------------------------------------
// calibrate
// ---------------------------------------------------------------------------

function parseCalibrationFile(raw: string): { points?: CalibrationPoint[]; error?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { error: `calibration file is not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  const arr = Array.isArray(parsed) ? parsed : (parsed as { points?: unknown })?.points;
  if (!Array.isArray(arr)) {
    return { error: "calibration file must be a JSON array of {score, correct}, or {points: [...]}." };
  }
  const points: CalibrationPoint[] = [];
  for (let i = 0; i < arr.length; i++) {
    const p = arr[i] as { score?: unknown; correct?: unknown };
    if (p === null || typeof p !== "object" || typeof p.score !== "number" || !Number.isFinite(p.score)) {
      return { error: `calibration point ${i} has a missing or non-finite "score"` };
    }
    if (typeof p.correct !== "boolean") {
      return { error: `calibration point ${i} has a missing or non-boolean "correct" label` };
    }
    points.push({ score: p.score, correct: p.correct });
  }
  return { points };
}

async function calibrate(args: string[], deps: TrustCommandDeps): Promise<CliResult> {
  const fromEval = hasFlag(args, "--from-eval");
  const fromFile = flagValue(args, "--from");
  if (fromEval && fromFile !== undefined) {
    return fail("pass either --from-eval or --from <file>, not both.");
  }
  if (!fromEval && fromFile === undefined) {
    return fail("nothing to calibrate from. Pass --from-eval, or --from <file.json> with real labeled points.");
  }
  const domain = domainFlag(args);
  if (domain.error) return fail(domain.error);
  const eps = numberFlag(args, "--epsilon");
  if (eps.error) return fail(eps.error);
  const dryRun = hasFlag(args, "--dry-run");

  const stack = deps.stack();
  const epsilon = eps.value ?? stack.epsilon;
  if (epsilon <= 0 || epsilon >= 1) return fail(`--epsilon must be strictly inside (0,1); got ${epsilon}`);

  let targetDomain: TrustDomain;
  let points: CalibrationPoint[];
  let provenance: string;
  let solverErrors: { taskId: string; solverId: string; message: string }[] = [];

  if (fromEval) {
    if (domain.value !== undefined && domain.value !== "procedure") {
      return fail(
        `--from-eval derives "procedure"-domain observations from the eval corpus; ` +
          `it cannot produce labeled data for domain "${domain.value}". Use --from <file.json> for that.`,
      );
    }
    const result = await collectEvalCalibration({ registry: stack.registry });
    targetDomain = result.domain;
    points = result.points;
    provenance = result.provenance;
    solverErrors = result.solverErrors;
  } else {
    if (domain.value === undefined) {
      return fail("--from <file> needs --domain <" + TRUST_DOMAINS.join("|") + "> so the points land in one domain.");
    }
    const exists = deps.fileExists ?? existsSync;
    const read = deps.readFile ?? ((p: string) => readFileSync(p, "utf8"));
    if (!exists(fromFile as string)) return fail(`calibration file not found: ${fromFile}`);
    let raw: string;
    try {
      raw = read(fromFile as string);
    } catch (err) {
      return fail(`cannot read ${fromFile}: ${err instanceof Error ? err.message : String(err)}`);
    }
    const parsedFile = parseCalibrationFile(raw);
    if (parsedFile.error) return fail(parsedFile.error);
    targetDomain = domain.value;
    points = parsedFile.points as CalibrationPoint[];
    provenance = `operator-supplied labeled observations from ${fromFile}`;
  }

  const discrimination = summarizeDiscrimination(points);

  // Fit BEFORE persisting: a set that the real ConformalGate refuses (too
  // few points) must never be written as though it had been accepted.
  let stats: ReturnType<TrustStack["gate"]["calibrate"]> | null = null;
  let fitError: string | null = null;
  try {
    stats = stack.gate.calibrate(targetDomain, points);
  } catch (err) {
    fitError = err instanceof Error ? err.message : String(err);
  }

  let persisted = false;
  if (!dryRun && fitError === null) {
    stack.calibration.record(targetDomain, points, provenance);
    persisted = true;
  }

  if (hasFlag(args, "--json")) {
    return jsonResult(
      {
        domain: targetDomain,
        points: points.length,
        discrimination,
        stats,
        fitError,
        persisted,
        dryRun,
        provenance,
        solverErrors,
      },
      fitError === null ? 0 : 1,
    );
  }

  const lines: string[] = [];
  lines.push(`TRUST CALIBRATION — domain "${targetDomain}"`);
  lines.push("=".repeat(72));
  lines.push(`labeled points        ${discrimination.points} (${discrimination.correct} correct / ${discrimination.wrong} wrong)`);
  lines.push(`mean score  correct   ${discrimination.meanScoreCorrect.toFixed(6)}`);
  lines.push(`mean score  wrong     ${discrimination.meanScoreWrong.toFixed(6)}`);
  lines.push(`AUC (correct > wrong) ${discrimination.auc === null ? "undefined" : discrimination.auc.toFixed(4)}`);
  lines.push(`separation            ${discrimination.verdict}`);
  lines.push("");
  if (solverErrors.length > 0) {
    lines.push(`solver/grader errors  ${solverErrors.length} observation(s) dropped (never labelled "correct"):`);
    for (const e of solverErrors.slice(0, 5)) lines.push(`  ${e.solverId} on ${e.taskId}: ${e.message}`);
    if (solverErrors.length > 5) lines.push(`  ... and ${solverErrors.length - 5} more`);
    lines.push("");
  }
  if (fitError !== null) {
    lines.push(`FIT REFUSED: ${fitError}`);
    lines.push("Nothing was persisted; the domain stays uncalibrated and the gate keeps abstaining.");
    return { code: 1, lines };
  }
  lines.push(
    `threshold             ${Number.isFinite(stats!.threshold) ? stats!.threshold.toFixed(6) : "+Infinity"}`,
  );
  lines.push(`epsilon               ${stats!.epsilon}`);
  lines.push(`calibration size      ${stats!.calibrationSize}`);
  lines.push("");
  if (!Number.isFinite(stats!.threshold)) {
    lines.push("THRESHOLD IS +INFINITY: no score in this sample clears the bound, so the gate will");
    lines.push("abstain on every subject in this domain. That is the honest conformal answer when the");
    lines.push("verifier set cannot separate correct from wrong across the WHOLE sample — not a wiring");
    lines.push("bug to work around. Partial separation is not enough: if any subject the verifiers");
    lines.push("cannot decide scores as high as a verified-correct one, no finite threshold can");
    lines.push("exclude it at this epsilon. Calibrate a narrower slice, or widen verifier coverage.");
    lines.push("");
  }
  lines.push(persisted ? `persisted to          ${stack.root ?? "(in-memory)"}` : "DRY RUN — nothing persisted.");
  lines.push(`provenance            ${provenance}`);
  return { code: 0, lines };
}

// ---------------------------------------------------------------------------
// admit
// ---------------------------------------------------------------------------

function parseSubject(raw: string): { subject?: TrustSubject; error?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { error: `subject file is not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (parsed === null || typeof parsed !== "object") return { error: "subject file must contain a JSON object." };
  const s = parsed as Record<string, unknown>;
  if (!(TRUST_DOMAINS as readonly string[]).includes(s.domain as string)) {
    return { error: `subject.domain must be one of: ${TRUST_DOMAINS.join(", ")}` };
  }
  for (const field of ["subjectId", "taskId", "input", "output"]) {
    if (typeof s[field] !== "string") return { error: `subject.${field} must be a string.` };
  }
  const trace = Array.isArray(s.trace) ? s.trace : [];
  for (const step of trace) {
    const t = step as { seq?: unknown; kind?: unknown; detail?: unknown };
    if (t === null || typeof t !== "object" || typeof t.seq !== "number" || typeof t.kind !== "string" || typeof t.detail !== "string") {
      return { error: "every subject.trace step must be { seq: number, kind: string, detail: string }." };
    }
  }
  const evidence = s.evidence !== null && typeof s.evidence === "object" ? (s.evidence as Record<string, unknown>) : {};
  return {
    subject: {
      domain: s.domain as TrustDomain,
      subjectId: s.subjectId as string,
      taskId: s.taskId as string,
      input: s.input as string,
      output: s.output as string,
      evidence,
      trace: trace as TrustSubject["trace"],
    },
  };
}

async function admit(args: string[], deps: TrustCommandDeps): Promise<CliResult> {
  const file = flagValue(args, "--file");
  if (file === undefined) return fail("admit needs --file <subject.json>.");
  const exists = deps.fileExists ?? existsSync;
  const read = deps.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  if (!exists(file)) return fail(`subject file not found: ${file}`);
  let raw: string;
  try {
    raw = read(file);
  } catch (err) {
    return fail(`cannot read ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const parsed = parseSubject(raw);
  if (parsed.error) return fail(parsed.error);

  const stack = deps.stack();
  const admission = await stack.gate.admit(parsed.subject as TrustSubject);
  const fused = await stack.registry.verify(parsed.subject as TrustSubject);

  if (hasFlag(args, "--json")) {
    return jsonResult(
      { admission, verdicts: fused.verdicts, selected: fused.verifierVersions },
      admission.accepted ? 0 : 2,
    );
  }

  const lines: string[] = [];
  lines.push(`TRUST ADMISSION — ${admission.domain}/${admission.subjectId}`);
  lines.push("=".repeat(72));
  lines.push(`decision      ${admission.accepted ? "ACCEPTED" : "ABSTAINED"}`);
  lines.push(`fused score   ${admission.score.toFixed(6)}`);
  lines.push(`threshold     ${Number.isFinite(admission.threshold) ? admission.threshold.toFixed(6) : "+Infinity"}`);
  lines.push(`tier          ${admission.tier}  (weakest contributing)`);
  lines.push(`P(correct)    ${admission.pCorrect.toFixed(6)}   epsilon ${admission.epsilon}`);
  lines.push(`output sha256 ${admission.subjectSha256}`);
  if (!admission.accepted && admission.abstention) {
    lines.push(`abstention    ${admission.abstention.code}`);
    lines.push(`              ${admission.abstention.message}`);
    if (admission.abstention.escalateTo) {
      lines.push(`escalate to   ${admission.abstention.escalateTo} evidence to clear this bar`);
    }
  }
  if (admission.certificate) {
    lines.push(`certificate   ed25519 sig=${admission.certificate.signature.slice(0, 24)}...`);
    lines.push(`              pub=${admission.certificate.publicKey.slice(0, 24)}...`);
    lines.push(`              risk spent ${admission.spentRisk.toFixed(6)}`);
  } else {
    lines.push("certificate   none (abstained subjects never receive one)");
  }
  lines.push("");
  lines.push("VERDICTS");
  if (fused.verdicts.length === 0) {
    lines.push("  (no verifier applied to this subject)");
  } else {
    lines.push(
      ...table(
        ["VERIFIER", "TIER", "VOTE", "CONF", "REASONS"],
        fused.verdicts.map((v) => [
          `${v.verifierId}@${v.version}`,
          v.tier,
          v.abstained ? "abstain" : v.passed ? "pass" : "fail",
          v.confidence.toFixed(3),
          v.reasons.join(",") || "-",
        ]),
      ),
    );
  }
  return { code: admission.accepted ? 0 : 2, lines };
}

// ---------------------------------------------------------------------------
// budget
// ---------------------------------------------------------------------------

function budget(args: string[], deps: TrustCommandDeps): CliResult {
  const stack = deps.stack();
  if (stack.budget === null) {
    return { code: 1, lines: ["trust: this stack was built with no budget ledger (noBudget)."] };
  }
  const report = stack.budget.report();
  const chain = stack.budget.verifyChain();
  const nFlag = numberFlag(args, "--entries");
  if (nFlag.error) return fail(nFlag.error);
  const showEntries = nFlag.value !== undefined ? Math.max(0, Math.floor(nFlag.value)) : 0;
  const entries = showEntries > 0 ? stack.budget.entries().slice(-showEntries) : [];

  if (hasFlag(args, "--json")) {
    return jsonResult({ report, chain, entries }, chain.ok ? 0 : 1);
  }

  const lines = formatTrustBudgetReport(report).split("\n");
  lines.push("");
  lines.push(
    chain.ok
      ? `chain verification  OK (${chain.length} entr${chain.length === 1 ? "y" : "ies"} recomputed from scratch)`
      : `chain verification  FAILED: ${chain.reason} at seq ${chain.firstBadSeq ?? "?"}`,
  );
  if (!chain.ok) {
    lines.push("Spending is refused until an operator resolves this. The ledger will NOT reset itself.");
  }
  if (entries.length > 0) {
    lines.push("");
    lines.push(`LAST ${entries.length} ENTR${entries.length === 1 ? "Y" : "IES"}`);
    lines.push(
      ...table(
        ["SEQ", "DOMAIN", "TASK", "RISK", "ISSUED", "ENTRY-SHA256"],
        entries.map((e) => [
          String(e.seq),
          e.domain,
          e.taskId,
          e.risk.toFixed(6),
          String(e.issuedAt),
          e.entrySha256.slice(0, 16) + "...",
        ]),
      ),
    );
  }
  return { code: chain.ok ? 0 : 1, lines };
}

// ---------------------------------------------------------------------------
// riskeval
// ---------------------------------------------------------------------------

async function riskeval(args: string[], deps: TrustCommandDeps): Promise<CliResult> {
  const eps = numberFlag(args, "--epsilon");
  if (eps.error) return fail(eps.error);
  const limit = numberFlag(args, "--limit");
  if (limit.error) return fail(limit.error);

  const stack = deps.stack();
  const epsilon = eps.value ?? stack.epsilon ?? DEFAULT_TRUST_EPSILON;
  if (epsilon <= 0 || epsilon >= 1) return fail(`--epsilon must be strictly inside (0,1); got ${epsilon}`);

  const tasks =
    limit.value !== undefined && limit.value > 0 ? EVAL_TASKS.slice(0, Math.floor(limit.value)) : EVAL_TASKS;

  // The admission port is the REAL gate. `runRiskEval` mirrors the
  // TrustSubject/Admission shapes structurally rather than importing them,
  // so the cast here is the one place the two shapes are joined — and it is
  // joined to the real object, never to a stand-in.
  const report = await runRiskEval({
    tasks,
    epsilon,
    admit: async (subject) => {
      const admission = await stack.gate.admit(subject as unknown as TrustSubject);
      return admission as unknown as Awaited<ReturnType<Parameters<typeof runRiskEval>[0]["admit"]>>;
    },
  });

  if (hasFlag(args, "--json")) {
    return jsonResult(report, report.accepted === 0 ? 3 : report.withinBound ? 0 : 1);
  }
  const lines = formatRiskEvalReport(report).split("\n");
  lines.push("");
  lines.push("ADMISSION PORT: the REAL UnifiedTrustGate from this install (openTrustStack), not a stand-in.");
  return { code: report.accepted === 0 ? 3 : report.withinBound ? 0 : 1, lines };
}

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

async function doctor(args: string[], deps: TrustCommandDeps): Promise<CliResult> {
  const checks: DoctorCheck[] = [];
  let stack: TrustStack;
  try {
    stack = deps.stack();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const failed = [{ name: "open trust stack", ok: false, detail }];
    return hasFlag(args, "--json")
      ? jsonResult({ ok: false, checks: failed }, 1)
      : { code: 1, lines: ["TRUST DOCTOR", "=".repeat(72), `[FAIL] open trust stack: ${detail}`] };
  }

  const registered = stack.registry.list();
  checks.push({
    name: "verifiers registered",
    ok: registered.length > 0,
    detail: `${registered.length} verifier(s) across ${new Set(registered.map((v) => v.domain)).size} domain(s)`,
  });

  const domainsWithVerifiers = TRUST_DOMAINS.filter((d) => stack.registry.list(d).length > 0);
  checks.push({
    name: "every domain has a verifier",
    ok: domainsWithVerifiers.length === TRUST_DOMAINS.length,
    detail:
      domainsWithVerifiers.length === TRUST_DOMAINS.length
        ? "tool, procedure, memory, message all covered"
        : `missing: ${TRUST_DOMAINS.filter((d) => !domainsWithVerifiers.includes(d)).join(", ")}`,
  });

  // Having ONE verifier is not the same as being able to certify. A lone
  // voter is always "degraded-evidence", so a single-verifier domain can
  // never accept a subject however it is calibrated. Report that as a
  // FAILURE, per domain, rather than letting an operator calibrate a domain
  // that is structurally inert.
  for (const c of domainCertifiability(stack)) {
    checks.push({ name: `domain "${c.domain}" can certify`, ok: c.canEverCertify, detail: c.detail });
  }

  checks.push({
    name: "signing identity is durable",
    ok: stack.key.source !== "ephemeral",
    detail:
      stack.key.source === "ephemeral"
        ? "ephemeral key — certificates cannot be re-verified by a later process"
        : `${stack.key.source} key, pub=${stack.key.publicKeyHex.slice(0, 16)}...`,
  });

  checks.push({
    name: "calibration file readable",
    ok: stack.calibration.loadError === null,
    detail: stack.calibration.loadError ?? "ok",
  });

  const statuses = trustDomainStatuses(stack);
  const calibrated = statuses.filter((s) => s.calibrated);
  checks.push({
    name: "at least one domain calibrated",
    ok: calibrated.length > 0,
    detail:
      calibrated.length > 0
        ? `calibrated: ${calibrated.map((s) => s.domain).join(", ")}`
        : "no domain is calibrated — the gate abstains on everything. Run `hades trust calibrate --from-eval`.",
  });

  for (const s of calibrated) {
    const disc = summarizeDiscrimination(stack.calibration.points(s.domain));
    checks.push({
      name: `domain "${s.domain}" separation`,
      // A threshold fitted on scores that do not separate correct from wrong
      // is a threshold that means nothing. Report it as a FAILURE, not a
      // detail, so nobody reads "calibrated" as "working".
      ok: disc.auc !== null && disc.auc > 0.55,
      detail: `AUC ${disc.auc === null ? "undefined" : disc.auc.toFixed(4)} — ${disc.verdict}`,
    });
  }

  if (stack.budget) {
    const chain = stack.budget.verifyChain();
    checks.push({
      name: "budget chain verifies",
      ok: chain.ok,
      detail: chain.ok ? `${chain.length} entr${chain.length === 1 ? "y" : "ies"} recomputed clean` : `${chain.reason} at seq ${chain.firstBadSeq ?? "?"}`,
    });
    const report = stack.budget.report();
    checks.push({
      name: "budget has headroom",
      ok: !report.exhausted,
      detail: `${report.remainingRisk.toFixed(6)} of ${report.totalRisk.toFixed(6)} risk remaining`,
    });
  }

  // End-to-end proof: issue a certificate through the real CA and re-verify
  // it independently. This is the only check that exercises signing, and it
  // never touches the gate's counters or the budget.
  try {
    const { verifyCertificate, certifiesOutput, sha256Hex } = await import("../styx/certificate");
    const probeText = "hades.trust.doctor.probe";
    const cert = await stack.issuer.issue({
      outputSha256: sha256Hex(probeText),
      taskId: "trust-doctor-probe",
      verifierTier: "T4-consistency",
      ensembleScore: 0,
      pCorrect: 0,
      epsilon: stack.epsilon,
      traceSha256: sha256Hex("[]"),
      verifierVersions: [],
      issuedAt: 0,
    });
    const sigOk = await verifyCertificate(cert);
    const boundOk = await certifiesOutput(cert, probeText);
    const wrongRejected = !(await certifiesOutput(cert, `${probeText}!`));
    checks.push({
      name: "certificate round-trip",
      ok: sigOk && boundOk && wrongRejected,
      detail: `signature=${sigOk} binds-own-output=${boundOk} rejects-other-output=${wrongRejected}`,
    });
  } catch (err) {
    checks.push({
      name: "certificate round-trip",
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  const ok = checks.every((c) => c.ok);
  if (hasFlag(args, "--json")) return jsonResult({ ok, checks }, ok ? 0 : 1);

  const lines = ["TRUST DOCTOR", "=".repeat(72)];
  for (const c of checks) lines.push(`[${c.ok ? "PASS" : "FAIL"}] ${pad(c.name, 34)} ${c.detail}`);
  lines.push("");
  lines.push(ok ? "RESULT: healthy" : "RESULT: NOT healthy — see the FAIL lines above");
  return { code: ok ? 0 : 1, lines };
}
