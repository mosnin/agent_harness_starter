/**
 * `hades market <sub>` — the terminal surface over the verified-work market.
 *
 *   hades market status [--json]
 *   hades market reputation [--participant P] [--bins N] [--json]
 *   hades market ledger [--participant P] [--entries N] [--verify] [--json]
 *   hades market book --orders <file.json> --offers <file.json> [--now MS]
 *                     [--dry-run] [--json]
 *   hades market explain --task T --offers <file.json> [--now MS] [--json]
 *   hades market simulate [--seed N] [--rounds N] [--tasks-per-round N] [--json]
 *   hades market doctor [--json]
 *   hades market help
 *
 * Terminal-free (returns `{ code, lines }`) so it unit-tests without a shell
 * or real stdout, matching the rest of `src/hades/cli/*`. Plain aligned
 * ASCII only — this product's front end is the terminal, never a browser.
 *
 * ## What this command will and will not claim
 *
 * `status` / `reputation` / `ledger` / `book` / `explain` report only numbers
 * the REAL engine computed on this machine from this install's own
 * `<dataDir>/market` state: real ed25519 certificate verification, the real
 * Brier settlement rule, the real Murphy-decomposed reputation kernel, the
 * real hash-chained ledger (re-verified from its own bytes on every open).
 *
 * `simulate` is the ONE subcommand that produces synthetic numbers, and it
 * says so in its own output on every single invocation (the model banner is
 * printed by the engine itself, from `MODEL_LABEL`) — a simulated cohort is
 * never mixed into the live market's state or its reported balances.
 *
 * A reputation score that is not yet MEASURABLE is reported as `n/a`, never
 * as `0.000`: until a participant's realized outcomes carry variance, a
 * Brier SKILL score is mathematically undefined, and printing a zero there
 * would read as "scored terribly" when the truth is "not scoreable yet".
 */

import { existsSync, readFileSync } from "node:fs";

import type { CliResult } from "./cli";
import {
  openMarket,
  marketStatus,
  type MarketStack,
  type MarketStackOptions,
  type MarketStatusView,
} from "../market/wiring";
import type { TaskOrder, WorkOffer } from "../market/exchange";
import {
  runMarketConvergence,
  formatMarketConvergenceReport,
  MODEL_LABEL,
} from "../market/convergence";

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

export interface MarketCommandDeps {
  /** Lazily open the stack. A factory (not a value) so `hades help` never
   *  touches `<dataDir>/market`. */
  stack: () => MarketStack;
  /** Injected for tests; defaults to the real fs reads. */
  readFile?: (path: string) => string;
  fileExists?: (path: string) => boolean;
}

export function defaultMarketDeps(
  env: Record<string, string | undefined> = process.env,
  overrides: MarketStackOptions = {},
): MarketCommandDeps {
  let cached: MarketStack | undefined;
  return {
    stack: () => {
      if (!cached) cached = openMarket({ env, ...overrides });
      return cached;
    },
  };
}

export const MARKET_USAGE: string[] = [
  "Usage: hades market <command>",
  "",
  "Commands:",
  "  status [--json]                      Trusted issuer, treasury, every participant's",
  "                                       balance/escrow/standing/reputation, chain verdict",
  "  reputation [--participant P]         Brier decomposition + calibration curve, measured",
  "             [--bins N] [--json]       from the real hash-chained ledger",
  "  ledger [--participant P]             Raw hash-chain entries; --verify re-walks the chain",
  "         [--entries N] [--verify] [--json]",
  "  book --orders <f.json>               Clear a trust-gated second-price round: rank offers",
  "       --offers <f.json> [--now MS]    by REPUTATION-ADJUSTED expected verified value per",
  "       [--dry-run] [--json]            dollar. --dry-run does not persist the result.",
  "  explain --task T                     Deterministic ranking table for one task, showing",
  "          --offers <f.json> [--json]   claimed vs shrunk confidence side by side",
  "  simulate [--seed N] [--rounds N]     LABELLED SIMULATION (never live numbers): does rank",
  "           [--tasks-per-round N]       order converge on true reliability?",
  "           [--json]",
  "  doctor [--json]                      End-to-end wiring self-check (exit 0 iff healthy)",
  "  help                                 Show this help",
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

function jsonResult(value: unknown, code = 0): CliResult {
  return { code, lines: JSON.stringify(value, null, 2).split("\n") };
}

function fail(message: string): CliResult {
  return { code: 1, lines: [`market: ${message}`] };
}

/** `n/a` rather than a fabricated `0.000` — see the module header. */
function num(value: number | null | undefined, digits = 4): string {
  return value === null || value === undefined || !Number.isFinite(value) ? "n/a" : value.toFixed(digits);
}

function shortKey(hex: string): string {
  if (hex.length === 0) return "(none)";
  return hex.length <= 20 ? hex : `${hex.slice(0, 12)}…${hex.slice(-4)}`;
}

function readJsonFile(
  deps: MarketCommandDeps,
  path: string | undefined,
  flagName: string,
): { value?: unknown; error?: string } {
  if (path === undefined) return { error: `${flagName} <file.json> is required` };
  const exists = deps.fileExists ?? ((p: string): boolean => existsSync(p));
  if (!exists(path)) return { error: `no such file: ${path}` };
  const read = deps.readFile ?? ((p: string): string => readFileSync(p, "utf8"));
  let raw: string;
  try {
    raw = read(path);
  } catch (err) {
    return { error: `could not read ${path}: ${err instanceof Error ? err.message : String(err)}` };
  }
  try {
    return { value: JSON.parse(raw) };
  } catch (err) {
    return { error: `${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export async function runMarketCommand(args: string[], deps: MarketCommandDeps): Promise<CliResult> {
  const [sub, ...rest] = args;
  switch (sub) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      return { code: 0, lines: MARKET_USAGE };
    case "status":
      return status(rest, deps);
    case "reputation":
      return reputation(rest, deps);
    case "ledger":
      return ledger(rest, deps);
    case "book":
      return book(rest, deps);
    case "explain":
      return explain(rest, deps);
    case "simulate":
      return simulate(rest);
    case "doctor":
      return doctor(rest, deps);
    default:
      return { code: 1, lines: [`Unknown market command: ${sub}`, "", ...MARKET_USAGE] };
  }
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

function renderStatus(view: MarketStatusView): string[] {
  const lines: string[] = [];
  lines.push("MARKET — the verified-work economy");
  lines.push(`  root                ${view.root ?? "(in-memory)"}`);
  lines.push(`  trusted issuer      ${shortKey(view.issuerPublicKeyHex)} (${view.issuerKeySource})`);
  lines.push(`  trusted issuers     ${view.trustedIssuers.length}`);
  lines.push(`  accepted tiers      ${view.acceptedTiers.join(", ")}`);
  lines.push(`  max epsilon         ${view.maxEpsilon}`);
  lines.push(`  trace binding       ${view.requireTraceBinding ? "REQUIRED" : "not required"}`);
  lines.push(`  treasury            ${view.treasury.toFixed(4)}`);
  lines.push(`  total tokens        ${view.totalTokens.toFixed(4)}`);
  lines.push(`  open awards         ${view.openAwards}`);
  lines.push(`  settlements         ${view.settlements} (${view.fabrications} fabrication(s))`);
  lines.push(`  certificates spent  ${view.certificatesSpent}`);
  lines.push(`  reputation chain    ${view.chainOk ? "VERIFIED" : "BROKEN — persisted ledger refused"}`);

  if (view.issuerPublicKeyHex.length === 0) {
    lines.push("");
    lines.push("  NOTE: this install has no trust-gate signing identity yet, so NO issuer is");
    lines.push("        trusted and every certificate will adjudicate as untrusted-issuer.");
    lines.push("        Run `hades trust status` once to mint one.");
  }

  lines.push("");
  if (view.participants.length === 0) {
    lines.push("  (no participants registered)");
  } else {
    lines.push(
      ...table(
        ["PARTICIPANT", "KIND", "STANDING", "BALANCE", "ESCROW", "N", "SCORE", "PASS", "BRIER", "FAB"],
        view.participants.map((p) => [
          p.id,
          p.kind,
          p.standing,
          p.balance.toFixed(2),
          p.escrowed.toFixed(2),
          String(p.n),
          p.scoreDefined ? num(p.score, 3) : "n/a",
          num(p.passRate, 3),
          num(p.brier, 3),
          String(p.fabricatedN),
        ]),
      ).map((l) => `  ${l}`),
    );
    lines.push("");
    lines.push("  SCORE is a Brier SKILL score; `n/a` means this participant's realized outcomes");
    lines.push("  carry no variance yet, so it is undefined — not zero.");
  }

  for (const e of view.loadErrors) {
    lines.push("");
    lines.push(`  LOAD ERROR (${e.artifact}): ${e.message}`);
  }
  return lines;
}

function status(args: string[], deps: MarketCommandDeps): CliResult {
  const view = marketStatus(deps.stack());
  if (hasFlag(args, "--json")) return jsonResult(view);
  return { code: 0, lines: renderStatus(view) };
}

// ---------------------------------------------------------------------------
// reputation
// ---------------------------------------------------------------------------

function reputation(args: string[], deps: MarketCommandDeps): CliResult {
  const stack = deps.stack();
  const who = flagValue(args, "--participant");
  const bins = numberFlag(args, "--bins");
  if (bins.error) return fail(bins.error);
  const binCount = bins.value === undefined ? 10 : Math.trunc(bins.value);
  if (binCount <= 0) return fail(`--bins must be a positive integer; got ${binCount}`);

  const states = who === undefined ? stack.reputation.states() : [stack.reputation.state(who)].filter((s) => s !== null);
  if (states.length === 0) {
    return who === undefined
      ? { code: 0, lines: ["market reputation: no participant has any recorded events yet"] }
      : fail(`no recorded reputation events for participant ${JSON.stringify(who)}`);
  }

  if (hasFlag(args, "--json")) {
    return jsonResult(
      states.map((s) => ({
        ...s,
        scoreDefined: s.fabricatedN > 0 || s.decomposition.uncertainty > 1e-9,
        calibration: stack.reputation.calibrationCurve(s.participantId, binCount),
      })),
    );
  }

  const lines: string[] = [];
  for (const s of states) {
    const defined = s.fabricatedN > 0 || s.decomposition.uncertainty > 1e-9;
    lines.push(`REPUTATION — ${s.participantId} (${s.kind})`);
    lines.push(`  events              ${s.n} (${s.verifiedN} certified, ${s.fabricatedN} fabricated)`);
    lines.push(`  score               ${defined ? num(s.score, 6) : "n/a (skill score undefined — no outcome variance yet)"}`);
    lines.push(`  standing hint       ${s.standingHint} (advisory; the economy owns the real transition)`);
    lines.push(`  brier               ${num(s.brier, 6)}   decayed ${num(s.decayedBrier, 6)}`);
    lines.push(
      `  murphy              reliability ${num(s.decomposition.reliability, 6)} - resolution ${num(
        s.decomposition.resolution,
        6,
      )} + uncertainty ${num(s.decomposition.uncertainty, 6)}`,
    );
    lines.push(`  pass rate           ${num(s.passRate, 6)} (Wilson lower ${num(s.wilsonLower, 6)})`);
    lines.push(`  mean claim          ${num(s.meanClaim, 6)}   calibration gap ${num(s.calibrationGap, 6)}`);
    lines.push("");
    const curve = stack.reputation.calibrationCurve(s.participantId, binCount);
    lines.push(
      ...table(
        ["BIN", "N", "MEAN CLAIM", "OBSERVED"],
        curve.map((b) => [
          `[${b.lo.toFixed(2)},${b.hi.toFixed(2)})`,
          String(b.n),
          b.n === 0 ? "n/a" : b.meanClaim.toFixed(4),
          b.n === 0 ? "n/a" : b.observedRate.toFixed(4),
        ]),
      ).map((l) => `  ${l}`),
    );
    lines.push("");
  }
  return { code: 0, lines: lines.slice(0, -1) };
}

// ---------------------------------------------------------------------------
// ledger
// ---------------------------------------------------------------------------

function ledger(args: string[], deps: MarketCommandDeps): CliResult {
  const stack = deps.stack();
  const who = flagValue(args, "--participant");
  const limitFlag = numberFlag(args, "--entries");
  if (limitFlag.error) return fail(limitFlag.error);
  const limit = limitFlag.value === undefined ? 20 : Math.trunc(limitFlag.value);
  if (limit <= 0) return fail(`--entries must be a positive integer; got ${limit}`);

  const all = stack.reputation.entries(who);
  const shown = all.slice(-limit);
  const verdict = hasFlag(args, "--verify") ? stack.reputation.verifyChain(who) : null;

  if (hasFlag(args, "--json")) {
    return jsonResult(
      { participant: who ?? null, total: all.length, shown: shown.length, entries: shown, chain: verdict },
      verdict && !verdict.ok ? 1 : 0,
    );
  }

  const lines = [
    `MARKET LEDGER — ${who ?? "all participants"} (${all.length} entr${all.length === 1 ? "y" : "ies"}, showing last ${shown.length})`,
    "",
  ];
  if (shown.length === 0) {
    lines.push("  (no entries)");
  } else {
    lines.push(
      ...table(
        ["SEQ", "PARTICIPANT", "TASK", "CLAIM", "OUT", "CERT", "FAB", "HASH"],
        shown.map((e) => [
          String(e.seq),
          e.participantId,
          e.taskId,
          e.claimedP.toFixed(4),
          String(e.outcome),
          e.certified ? "yes" : "no",
          e.fabricated ? "YES" : "no",
          `${e.hash.slice(0, 12)}…`,
        ]),
      ).map((l) => `  ${l}`),
    );
  }
  if (verdict) {
    lines.push("");
    lines.push(
      verdict.ok
        ? "  CHAIN VERIFIED — every entry hash recomputed from its own fields"
        : `  CHAIN BROKEN at participant "${verdict.brokenAt?.participantId}" seq ${verdict.brokenAt?.seq}`,
    );
  }
  return { code: verdict && !verdict.ok ? 1 : 0, lines };
}

// ---------------------------------------------------------------------------
// book / explain
// ---------------------------------------------------------------------------

function book(args: string[], deps: MarketCommandDeps): CliResult {
  const orders = readJsonFile(deps, flagValue(args, "--orders"), "--orders");
  if (orders.error) return fail(orders.error);
  const offers = readJsonFile(deps, flagValue(args, "--offers"), "--offers");
  if (offers.error) return fail(offers.error);
  if (!Array.isArray(orders.value)) return fail("--orders must contain a JSON array of TaskOrder objects");
  if (!Array.isArray(offers.value)) return fail("--offers must contain a JSON array of WorkOffer objects");

  const nowFlag = numberFlag(args, "--now");
  if (nowFlag.error) return fail(nowFlag.error);
  const now = nowFlag.value ?? Date.now();

  const stack = deps.stack();
  const result = stack.exchange.clear(orders.value as TaskOrder[], offers.value as WorkOffer[], now);

  if (hasFlag(args, "--json")) return jsonResult({ now, dryRun: hasFlag(args, "--dry-run"), ...result });

  const lines: string[] = [];
  lines.push(`MARKET BOOK — cleared ${(orders.value as TaskOrder[]).length} order(s) against ${(offers.value as WorkOffer[]).length} offer(s) at now=${now}`);
  lines.push("");
  if (result.matches.length === 0) {
    lines.push("  (no matches)");
  } else {
    lines.push(
      ...table(
        ["TASK", "WINNER", "ASK", "CLEARS AT", "CLAIMED", "ADJUSTED", "VALUE/$", "REP", "RUNNER-UP"],
        result.matches.map((m) => [
          m.taskId,
          m.participantId,
          m.offerPrice.toFixed(2),
          m.clearingPrice.toFixed(2),
          m.claimedPCorrect.toFixed(3),
          m.adjustedPCorrect.toFixed(3),
          m.expectedVerifiedValue.toFixed(5),
          m.reputationScore.toFixed(3),
          m.runnerUp ? m.runnerUp.participantId : "(none)",
        ]),
      ).map((l) => `  ${l}`),
    );
    lines.push("");
    lines.push("  ADJUSTED is the claim after reputation shrinkage; a winner is paid the");
    lines.push("  second price (the runner-up's breakeven), never their own ask.");
  }
  if (result.unmatched.length > 0) {
    lines.push("");
    lines.push(...table(["UNMATCHED TASK", "REASON"], result.unmatched.map((u) => [u.taskId, u.reason])).map((l) => `  ${l}`));
  }
  if (result.rejected.length > 0) {
    lines.push("");
    lines.push(
      ...table(
        ["REJECTED OFFER", "TASK", "REASON", "DETAIL"],
        result.rejected.map((r) => [
          String((r.offer as { participantId?: unknown })?.participantId ?? "(malformed)"),
          String((r.offer as { taskId?: unknown })?.taskId ?? "(malformed)"),
          r.reason,
          r.detail,
        ]),
      ).map((l) => `  ${l}`),
    );
  }
  return { code: 0, lines };
}

function explain(args: string[], deps: MarketCommandDeps): CliResult {
  const taskId = flagValue(args, "--task");
  if (taskId === undefined || taskId.length === 0) return fail("--task <taskId> is required");
  const offers = readJsonFile(deps, flagValue(args, "--offers"), "--offers");
  if (offers.error) return fail(offers.error);
  if (!Array.isArray(offers.value)) return fail("--offers must contain a JSON array of WorkOffer objects");

  const nowFlag = numberFlag(args, "--now");
  if (nowFlag.error) return fail(nowFlag.error);
  const now = nowFlag.value ?? Date.now();

  const text = deps.stack().exchange.explain(taskId, offers.value as WorkOffer[], now);
  if (hasFlag(args, "--json")) return jsonResult({ taskId, now, explanation: text.split("\n") });
  return { code: 0, lines: text.split("\n") };
}

// ---------------------------------------------------------------------------
// simulate — the ONE synthetic subcommand, labelled on every invocation
// ---------------------------------------------------------------------------

async function simulate(args: string[]): Promise<CliResult> {
  const seed = numberFlag(args, "--seed");
  if (seed.error) return fail(seed.error);
  const rounds = numberFlag(args, "--rounds");
  if (rounds.error) return fail(rounds.error);
  const perRound = numberFlag(args, "--tasks-per-round");
  if (perRound.error) return fail(perRound.error);

  try {
    const report = await runMarketConvergence({
      seed: seed.value === undefined ? 5 : Math.trunc(seed.value),
      rounds: rounds.value === undefined ? 40 : Math.trunc(rounds.value),
      tasksPerRound: perRound.value === undefined ? 4 : Math.trunc(perRound.value),
    });
    if (hasFlag(args, "--json")) return jsonResult({ ...report, modelLabel: MODEL_LABEL });
    return { code: 0, lines: formatMarketConvergenceReport(report).split("\n") };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

async function doctor(args: string[], deps: MarketCommandDeps): Promise<CliResult> {
  const checks: DoctorCheck[] = [];
  let stack: MarketStack | null = null;
  try {
    stack = deps.stack();
    checks.push({ name: "stack opens", ok: true, detail: `root=${stack.root ?? "(in-memory)"}` });
  } catch (err) {
    checks.push({ name: "stack opens", ok: false, detail: err instanceof Error ? err.message : String(err) });
  }

  if (stack) {
    const view = marketStatus(stack);
    checks.push({
      name: "trusted issuer present",
      ok: view.issuerPublicKeyHex.length > 0,
      detail:
        view.issuerPublicKeyHex.length > 0
          ? `${shortKey(view.issuerPublicKeyHex)} (${view.issuerKeySource})`
          : "no trust-gate signing identity — every certificate would be rejected as untrusted-issuer; run `hades trust status` once",
    });
    const chain = stack.reputation.verifyChain();
    checks.push({
      name: "reputation chain verifies",
      ok: view.chainOk && chain.ok,
      detail: chain.ok
        ? `${stack.reputation.entries().length} entr(ies) re-hashed from their own fields`
        : `broken at participant "${chain.brokenAt?.participantId}" seq ${chain.brokenAt?.seq}`,
    });
    const total = stack.economy.totalTokens();
    const bucketed =
      stack.economy.treasury() + stack.economy.accounts().reduce((acc, a) => acc + a.balance + a.escrowed, 0);
    checks.push({
      name: "token conservation",
      ok: Math.abs(total - bucketed) < 1e-9 && stack.economy.treasury() >= 0,
      detail: `total=${total.toFixed(4)} treasury=${stack.economy.treasury().toFixed(4)}`,
    });
    checks.push({
      name: "no artifact load errors",
      ok: view.loadErrors.length === 0,
      detail: view.loadErrors.length === 0 ? "every persisted artifact loaded cleanly" : view.loadErrors.map((e) => `${e.artifact}: ${e.message}`).join("; "),
    });
    // A REAL end-to-end adjudication: an unsigned claim must come back
    // "unverified" (honest abstention), never "verified".
    try {
      const probe = await stack.adjudicator.adjudicate(
        {
          taskId: "__doctor__",
          participantId: "__doctor__",
          outputText: "doctor probe",
          claimedPCorrect: 0.5,
          submittedAt: 0,
        },
        0,
      );
      checks.push({
        name: "adjudicator refuses an uncertified claim",
        ok: probe.status === "unverified" && probe.score === 0 && !probe.fabricated,
        detail: `status=${probe.status} score=${probe.score} codes=[${probe.codes.join(",")}]`,
      });
    } catch (err) {
      checks.push({
        name: "adjudicator refuses an uncertified claim",
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const ok = checks.every((c) => c.ok);
  if (hasFlag(args, "--json")) return jsonResult({ ok, checks }, ok ? 0 : 1);
  const lines = ["MARKET DOCTOR", ""];
  lines.push(...table(["CHECK", "RESULT", "DETAIL"], checks.map((c) => [c.name, c.ok ? "PASS" : "FAIL", c.detail])).map((l) => `  ${l}`));
  lines.push("");
  lines.push(ok ? "  market wiring is healthy" : "  market wiring has problems (see FAIL rows above)");
  return { code: ok ? 0 : 1, lines };
}
