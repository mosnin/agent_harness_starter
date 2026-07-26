/**
 * `hades profile <sub>` — the Phase-5 dialectic user model from the terminal.
 *
 *   hades profile show [--json]            What the model currently believes (and abstains on)
 *   hades profile why <attribute> [--json] The full evidence trail behind one belief
 *   hades profile learn <session-id>       Extract belief assertions from a stored session
 *                 [--sync]                   (then optionally sync to guarded memory)
 *   hades profile sync [--json]            Route asserted beliefs through the STYX memory gate
 *   hades profile audit [--json]           Independent STYX re-audit of the model + ledger
 *   hades profile bench [--json]           The convergence benchmark (scripted fixture, real run)
 *   hades profile help
 *
 * Terminal-free (`{ code, lines }`) like the rest of `src/hades/cli/*`, so it
 * unit-tests without a shell. This module is central-integration glue: unlike
 * `memory-command.ts` (which keeps structural seams), it value-imports the
 * real Phase-5 engines directly — extraction, the independent auditor, and
 * the convergence bench — because wiring them to the product is exactly its
 * job. The mutable state (`UserModelStore`, `ProfileMemoryBridge`, the
 * session store) still arrives through {@link ProfileCommandDeps} so tests
 * control persistence paths and clocks.
 *
 * Honesty notes, enforced here:
 *  - `audit` exits non-zero when the audit fails — a failed independent
 *    verification must be visible to shell scripts, not just prose.
 *  - `bench` always labels its fixture as the deterministic scripted corpus
 *    it is; every number printed is measured by really running the pipeline
 *    in this process.
 *  - `show`/`why` never print the value of a contested/abstained belief as
 *    if it were asserted — status is always shown alongside.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CliResult } from "./cli";
import type { SessionStore } from "../memory/session-store";
import type { UserModelStore, ProfileMemoryBridge } from "../memory/user-model-store";
import type { UserBelief } from "../memory/user-model";
import { extractBeliefAssertions } from "../memory/belief-extraction";
import { auditUserModel } from "../memory/user-model-verifier";
import { runConvergenceBench } from "../memory/user-model-bench";

export interface ProfileCommandDeps {
  store: UserModelStore;
  bridge: ProfileMemoryBridge;
  sessions: SessionStore;
  /** Scratch directory factory for `profile bench` (a fresh temp dir per
   *  run by default — the bench writes its persisted model there). */
  benchWorkDir?: () => string;
  now?: () => number;
}

const USAGE = [
  "Usage: hades profile <command>",
  "",
  "Commands:",
  "  show [--json]              What the dialectic user model believes (and abstains on)",
  "  why <attribute> [--json]   Evidence trail behind one belief (tier, weight, polarity, cert)",
  "  learn <session-id>         Extract belief assertions from a stored session into the model",
  "        [--sync]               (then route asserted beliefs through the memory gate)",
  "  sync [--json]              Route asserted beliefs through the STYX guarded memory gate",
  "  audit [--json]             Independent STYX re-audit of the model + evidence ledger",
  "                               (exit code 1 when the audit fails)",
  "  bench [--json]             Convergence benchmark: scripted 9-session fixture, really run",
  "  help                       Show this help",
];

// ---------------------------------------------------------------------------
// small local formatting helpers (same conventions as memory-command.ts)
// ---------------------------------------------------------------------------

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

function renderTable(headers: string[], rows: string[][]): string[] {
  if (rows.length === 0) return [];
  const widths = headers.map((h, col) => Math.max(h.length, ...rows.map((r) => r[col].length)));
  const renderRow = (cols: string[]): string => cols.map((c, i) => pad(c, widths[i])).join("  ").trimEnd();
  return [renderRow(headers), ...rows.map(renderRow)];
}

function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, Math.max(0, max - 1))}…` : clean;
}

function isoOf(ms: number | undefined): string {
  return typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : "-";
}

function extractBoolFlag(args: string[], flag: string): { present: boolean; rest: string[] } {
  const idx = args.indexOf(flag);
  if (idx === -1) return { present: false, rest: args };
  return { present: true, rest: [...args.slice(0, idx), ...args.slice(idx + 1)] };
}

function beliefRow(deps: ProfileCommandDeps, b: UserBelief, now: number): string[] {
  const decayed = deps.store.model.decayedConfidence(b, now);
  return [
    b.attribute,
    b.status === "asserted" ? b.value : `(${b.status})`,
    b.status,
    decayed.toFixed(3),
    String(b.evidence.length),
    String(b.revisions),
  ];
}

function beliefJson(deps: ProfileCommandDeps, b: UserBelief, now: number): Record<string, unknown> {
  return {
    attribute: b.attribute,
    // A contested/abstained/retracted value is deliberately withheld from the
    // headline field (same discipline as DialecticUserModel.describe()), but
    // remains inspectable under `heldValue` for tooling that needs it.
    value: b.status === "asserted" ? b.value : null,
    heldValue: b.value,
    status: b.status,
    confidence: b.confidence,
    decayedConfidence: deps.store.model.decayedConfidence(b, now),
    evidenceCount: b.evidence.length,
    revisions: b.revisions,
    supersededValues: b.supersededValues,
    createdAt: isoOf(b.createdAt),
    updatedAt: isoOf(b.updatedAt),
  };
}

// ---------------------------------------------------------------------------
// show
// ---------------------------------------------------------------------------

function cmdShow(deps: ProfileCommandDeps, args: string[]): CliResult {
  const jsonFlag = extractBoolFlag(args, "--json");
  if (jsonFlag.rest.length > 0) {
    return { code: 1, lines: [`Unexpected argument: ${jsonFlag.rest[0]}`, "Usage: hades profile show [--json]"] };
  }
  const now = deps.now ? deps.now() : Date.now();
  const beliefs = deps.store.model.all();

  if (jsonFlag.present) {
    const payload = {
      beliefs: beliefs.map((b) => beliefJson(deps, b, now)),
      ledgerRoot: deps.store.ledger.root(),
      loadIssues: deps.store.loadIssues(),
    };
    return { code: 0, lines: [JSON.stringify(payload, null, 2)] };
  }

  const lines: string[] = [deps.store.model.describe(now)];
  if (beliefs.length > 0) {
    lines.push("");
    lines.push(
      ...renderTable(
        ["ATTRIBUTE", "VALUE", "STATUS", "CONFIDENCE", "EVIDENCE", "REVISIONS"],
        beliefs.map((b) => beliefRow(deps, b, now)),
      ),
    );
  }
  const issues = deps.store.loadIssues();
  if (issues.length > 0) {
    lines.push("", "Load issues:");
    lines.push(...issues.map((i) => `  - ${i}`));
  }
  return { code: 0, lines };
}

// ---------------------------------------------------------------------------
// why
// ---------------------------------------------------------------------------

function cmdWhy(deps: ProfileCommandDeps, args: string[]): CliResult {
  const jsonFlag = extractBoolFlag(args, "--json");
  const attribute = jsonFlag.rest.join(" ").trim();
  if (!attribute) return { code: 1, lines: ["Usage: hades profile why <attribute> [--json]"] };

  let belief: UserBelief | undefined;
  try {
    belief = deps.store.model.get(attribute);
  } catch (err) {
    return { code: 1, lines: [err instanceof Error ? err.message : String(err)] };
  }
  if (!belief) {
    const known = deps.store.model.all().map((b) => b.attribute);
    return {
      code: 1,
      lines: [
        `No belief held for attribute: ${attribute}`,
        known.length > 0 ? `Known attributes: ${known.join(", ")}` : "The model holds no beliefs yet.",
      ],
    };
  }

  const now = deps.now ? deps.now() : Date.now();
  if (jsonFlag.present) {
    const payload = {
      ...beliefJson(deps, belief, now),
      evidence: belief.evidence.map((e) => ({
        id: e.id,
        at: isoOf(e.at),
        polarity: e.polarity,
        tier: e.tier,
        weight: e.weight,
        certificateValid: e.certificateValid === true,
        sessionId: e.sessionId ?? null,
        excerpt: e.excerpt,
      })),
    };
    return { code: 0, lines: [JSON.stringify(payload, null, 2)] };
  }

  const decayed = deps.store.model.decayedConfidence(belief, now);
  const lines: string[] = [
    `attribute:   ${belief.attribute}`,
    `value:       ${belief.status === "asserted" ? belief.value : `(${belief.status} — held value: ${belief.value})`}`,
    `status:      ${belief.status}`,
    `confidence:  ${belief.confidence.toFixed(3)} stored, ${decayed.toFixed(3)} decayed to now`,
    `revisions:   ${belief.revisions}${belief.supersededValues.length ? ` (superseded: ${belief.supersededValues.join(", ")})` : ""}`,
    `updated:     ${isoOf(belief.updatedAt)}`,
    "",
    "Evidence ledger (in belief order):",
    ...renderTable(
      ["AT", "POLARITY", "TIER", "WEIGHT", "CERT", "EXCERPT"],
      belief.evidence.map((e) => [
        isoOf(e.at),
        e.polarity,
        e.tier,
        e.weight.toFixed(3),
        e.certificateValid === true ? "valid" : "-",
        truncate(e.excerpt, 50),
      ]),
    ),
  ];
  return { code: 0, lines };
}

// ---------------------------------------------------------------------------
// learn
// ---------------------------------------------------------------------------

async function cmdLearn(deps: ProfileCommandDeps, args: string[]): Promise<CliResult> {
  const syncFlag = extractBoolFlag(args, "--sync");
  const id = syncFlag.rest[0];
  if (!id || syncFlag.rest.length > 1) {
    return { code: 1, lines: ["Usage: hades profile learn <session-id> [--sync]"] };
  }
  const session = deps.sessions.get(id);
  if (!session) return { code: 1, lines: [`No such session: ${id}`] };

  const now = deps.now;
  let assertions;
  try {
    assertions = await extractBeliefAssertions(session, now ? { now } : {});
  } catch (err) {
    return { code: 1, lines: [err instanceof Error ? err.message : String(err)] };
  }

  if (assertions.length === 0) {
    return { code: 0, lines: [`No belief assertions extracted from session ${id} (nothing matched the taxonomy in clean user turns).`] };
  }

  const lines: string[] = [`Extracted ${assertions.length} assertion(s) from session ${id}:`];
  const rows: string[][] = [];
  for (const a of assertions) {
    let decision: string;
    try {
      decision = deps.store.assertAndPersist(a);
    } catch (err) {
      decision = `error: ${err instanceof Error ? err.message : String(err)}`;
    }
    rows.push([a.attribute, truncate(a.value, 40), a.polarity ?? "supports", decision]);
  }
  lines.push(...renderTable(["ATTRIBUTE", "VALUE", "POLARITY", "DECISION"], rows));

  if (syncFlag.present) {
    lines.push("", ...formatSyncOutcomes(deps.bridge.syncAssertedBeliefs()));
  }
  return { code: 0, lines };
}

// ---------------------------------------------------------------------------
// sync
// ---------------------------------------------------------------------------

function formatSyncOutcomes(outcomes: ReturnType<ProfileMemoryBridge["syncAssertedBeliefs"]>): string[] {
  if (outcomes.length === 0) return ["Nothing to sync — the model holds no beliefs."];
  const written = outcomes.filter((o) => o.action === "written").length;
  const quarantined = outcomes.filter((o) => o.action === "quarantined").length;
  const skipped = outcomes.filter((o) => o.action === "skipped").length;
  return [
    `Sync: ${written} written, ${quarantined} quarantined, ${skipped} skipped.`,
    ...renderTable(
      ["ATTRIBUTE", "ACTION", "REASON"],
      outcomes.map((o) => [o.attribute, o.action, truncate(o.reason ?? "-", 70)]),
    ),
  ];
}

function cmdSync(deps: ProfileCommandDeps, args: string[]): CliResult {
  const jsonFlag = extractBoolFlag(args, "--json");
  if (jsonFlag.rest.length > 0) {
    return { code: 1, lines: [`Unexpected argument: ${jsonFlag.rest[0]}`, "Usage: hades profile sync [--json]"] };
  }
  const outcomes = deps.bridge.syncAssertedBeliefs();
  if (jsonFlag.present) {
    const payload = outcomes.map((o) => ({
      attribute: o.attribute,
      action: o.action,
      reason: o.reason ?? null,
      flagId: o.flagged?.id ?? null,
    }));
    return { code: 0, lines: [JSON.stringify(payload, null, 2)] };
  }
  return { code: 0, lines: formatSyncOutcomes(outcomes) };
}

// ---------------------------------------------------------------------------
// audit
// ---------------------------------------------------------------------------

async function cmdAudit(deps: ProfileCommandDeps, args: string[]): Promise<CliResult> {
  const jsonFlag = extractBoolFlag(args, "--json");
  if (jsonFlag.rest.length > 0) {
    return { code: 1, lines: [`Unexpected argument: ${jsonFlag.rest[0]}`, "Usage: hades profile audit [--json]"] };
  }

  const report = await auditUserModel(deps.store.model, { ledger: deps.store.ledger });
  const code = report.passed ? 0 : 1;

  if (jsonFlag.present) {
    return { code, lines: [JSON.stringify(report, null, 2)] };
  }

  const lines: string[] = [
    `verify.user-model — independent STYX re-audit`,
    `  passed:            ${report.passed}`,
    `  confidence:        ${report.confidence.toFixed(3)}`,
    `  beliefs audited:   ${report.beliefsAudited}`,
    `  evidence audited:  ${report.evidenceAudited}`,
    `  ledger root:       ${deps.store.ledger.root()}`,
  ];
  if (report.findings.length > 0) {
    lines.push("", `Findings (${report.findings.length}):`);
    for (const f of report.findings) {
      lines.push(`  [${f.kind}] ${f.attribute}: ${f.detail}`);
      lines.push(`    claimed ${f.claimed.toFixed(6)} vs supportable ${f.supportable.toFixed(6)}`);
    }
  } else {
    lines.push("", "No findings — every stored confidence is independently supported by its evidence.");
  }
  return { code, lines };
}

// ---------------------------------------------------------------------------
// bench
// ---------------------------------------------------------------------------

async function cmdBench(deps: ProfileCommandDeps, args: string[]): Promise<CliResult> {
  const jsonFlag = extractBoolFlag(args, "--json");
  if (jsonFlag.rest.length > 0) {
    return { code: 1, lines: [`Unexpected argument: ${jsonFlag.rest[0]}`, "Usage: hades profile bench [--json]"] };
  }

  const workDir = deps.benchWorkDir ? deps.benchWorkDir() : mkdtempSync(join(tmpdir(), "hades-profile-bench-"));
  let report;
  try {
    report = await runConvergenceBench({ workDir });
  } catch (err) {
    return { code: 1, lines: [err instanceof Error ? err.message : String(err)] };
  }

  if (jsonFlag.present) {
    return { code: report.converged && report.audit.passed ? 0 : 1, lines: [JSON.stringify(report, null, 2)] };
  }

  const lines: string[] = [
    "User-model convergence benchmark — deterministic scripted 9-session fixture (65 simulated days),",
    "really executed end-to-end this run: extraction -> dialectic model -> guarded memory -> STYX audit.",
    "",
    `  sessions run:          ${report.sessionsRun}`,
    `  assertions extracted:  ${report.assertionsExtracted}`,
    `  quarantines:           ${report.quarantines}`,
    `  converged:             ${report.converged}`,
    `  audit passed:          ${report.audit.passed} (${report.audit.findings.length} finding(s))`,
    `  duration:              ${report.durationMs.toFixed(1)}ms (measured this run)`,
    "",
    "Final beliefs:",
    ...renderTable(
      ["ATTRIBUTE", "VALUE", "STATUS", "CONFIDENCE", "EVIDENCE", "REVISIONS"],
      report.beliefs.map((b) => [
        b.attribute,
        truncate(b.value, 30),
        b.status,
        b.confidence.toFixed(3),
        String(b.evidenceCount),
        String(b.revisions),
      ]),
    ),
    "",
    "Corpus is a scripted fixture (labeled as such); every number above is measured by running",
    "the real pipeline in this process — nothing is precomputed or fabricated.",
  ];
  return { code: report.converged && report.audit.passed ? 0 : 1, lines };
}

// ---------------------------------------------------------------------------
// dispatcher
// ---------------------------------------------------------------------------

export async function runProfileCommand(deps: ProfileCommandDeps, args: string[]): Promise<CliResult> {
  const [sub, ...rest] = args;

  if (sub === undefined || sub === "help" || sub === "--help" || sub === "-h") {
    return { code: 0, lines: USAGE };
  }

  switch (sub) {
    case "show":
      return cmdShow(deps, rest);
    case "why":
      return cmdWhy(deps, rest);
    case "learn":
      return cmdLearn(deps, rest);
    case "sync":
      return cmdSync(deps, rest);
    case "audit":
      return cmdAudit(deps, rest);
    case "bench":
      return cmdBench(deps, rest);
    default:
      return { code: 1, lines: [`Unknown profile command: ${sub}`, "Run `hades profile help` for usage."] };
  }
}
