/**
 * `hades schedule <sub>` — the CLI surface for Phase 9 (scheduler + scheduled
 * delivery): create, inspect, fire, and remove cron-driven jobs whose output
 * is only ever delivered once the real STYX gate + ed25519 certificate say
 * it may be, and which honestly abstains (never fakes a "verified" badge)
 * otherwise.
 *
 *   hades schedule add --name <s> --cron "<5 fields>" [--tz <iana>]
 *                       [--task note:<text>]
 *                       [--deliver <platform>:<user>[:<channel>]]
 *                       [--misfire skip|fire-once|catch-up]
 *                       [--catch-up-limit <n>]
 *   hades schedule list
 *   hades schedule remove <id>
 *   hades schedule run <id>
 *   hades schedule status
 *
 * Every subcommand is a pure function of injected `ScheduleCommandDeps` —
 * no `process.exit`, no direct stdout writes, no `Date.now()` — so the whole
 * surface is exercised in tests through `runScheduleCommand` exactly the way
 * `HadesCli` will call it, with a `ManualClock` and an `InMemoryJobStore`
 * making every printed line (including ISO fire timestamps) an exact,
 * reproducible assertion.
 *
 * `add`, `list`, and `status` are read/compute-only against the injected
 * `JobStore`/`Clock`/cron helpers. `run` is the one subcommand that actually
 * *fires* a job: it builds a real `SchedulerRunner` from `deps` and calls
 * `runOnce`, so the executor and deliverer that run are the exact same real
 * ones any other caller of this package would get — this file never
 * reimplements gate verification, retries, or delivery formatting.
 */

import { join } from "node:path";

import type { CliResult } from "./cli";

import {
  JsonFileJobStore,
  type DeliverySpec,
  type JobStore,
  type JobTask,
  type MisfirePolicy,
  type NewJobInput,
  type ScheduledJob,
} from "../schedule/store";
import { systemClock, type Clock } from "../schedule/clock";
import { CronParseError, describeCron, nextFireTime, nextFireTimes, parseCron } from "../schedule/cron";
import {
  SchedulerRunner,
  type JobExecutionContext,
  type JobExecutionResult,
  type JobExecutor,
} from "../schedule/runner";
import { VerifiedDeliveryRouter, type DeliveryReceipt, type JobDeliverer } from "../schedule/delivery";
import { DeliveryReceiptLedger, LedgeredDeliverer, type ReceiptRecord } from "../schedule/receipt-ledger";

// ===========================================================================
// Locked public types
// ===========================================================================

export interface ScheduleCommandDeps {
  store: JobStore;
  clock: Clock;
  executor: JobExecutor;
  deliverer: JobDeliverer;
  env?: NodeJS.ProcessEnv;
  /** Path of the hash-chained delivery-receipt ledger
   *  (`../schedule/receipt-ledger`). When set, `run` appends every delivery
   *  receipt to it (through `LedgeredDeliverer` — the delivery outcome is
   *  never altered by ledger success/failure) and `receipts` reads/verifies
   *  it. Absent, `run` records nothing extra and `receipts` reports honestly
   *  that no ledger is configured. */
  receiptsPath?: string;
}

// ===========================================================================
// The builtin "note" task executor — the honest, no-pretending seam
// ===========================================================================

/**
 * The only executor `defaultScheduleDeps()` wires in. It handles exactly one
 * task kind, `"note"`: a deterministic echo of `task.input`, returned with
 * `ok: true` and — deliberately — NO `verification` evidence attached.
 *
 * Because `VerifiedDeliveryRouter` (`../schedule/delivery`) can only ever
 * label a delivery "verified" when it can independently re-derive that
 * badge from a real STYX gate decision + ed25519 certificate over the exact
 * output text, a result with no evidence at all can never be delivered as
 * verified. So by construction, every `note` job that has a delivery target
 * configured is delivered as an honest abstention notice (never the raw
 * output) until the central integration wires in the real STYX swarm engine
 * as the executor for richer task kinds. That is not a stub pretending to
 * produce trustworthy output — it is the correct, honestly-labeled behavior
 * for an executor that attaches no evidence.
 */
export class BuiltinNoteExecutor implements JobExecutor {
  async execute(job: ScheduledJob, _ctx: JobExecutionContext): Promise<JobExecutionResult> {
    if (job.task.kind !== "note") {
      return {
        ok: false,
        output: "",
        detail: `builtin executor registry has no handler for task kind "${job.task.kind}" (only "note" is registered; central integration wires in the swarm engine for richer task kinds)`,
      };
    }
    return {
      ok: true,
      output: job.task.input,
      detail: "note executed: deterministic echo of task.input, no verification evidence attached",
      // No `verification` field — see the class doc comment above for why
      // that is the honest thing to do here.
    };
  }
}

/**
 * Tracks which `VerifiedDeliveryRouter` instances `defaultScheduleDeps()`
 * itself constructed with zero senders, so `status` can report that
 * honestly without ever guessing at (or reflecting into) an arbitrary
 * injected `JobDeliverer`'s private sender wiring.
 */
const ZERO_SENDER_ROUTERS = new WeakSet<object>();

// ===========================================================================
// defaultScheduleDeps
// ===========================================================================

/**
 * Build the production `ScheduleCommandDeps`: a `JsonFileJobStore` at
 * `<HADES_DATA_DIR|.hades>/schedule.json` (the same data-dir convention
 * `hades skill`/`hades memory` already use), the real system clock, the
 * builtin `note`-only executor, and a `VerifiedDeliveryRouter` with zero
 * outbound senders registered — `status` reports that last fact honestly
 * rather than implying any platform is actually wired up. Central
 * integration attaches real gateway connectors as senders and a richer
 * executor; this factory's job is only to give the CLI something real and
 * safe to run against out of the box.
 */
export function defaultScheduleDeps(env: NodeJS.ProcessEnv = process.env): ScheduleCommandDeps {
  const dataDir = env.HADES_DATA_DIR ?? ".hades";
  const storePath = join(dataDir, "schedule.json");
  const clock: Clock = systemClock;
  const store: JobStore = new JsonFileJobStore(storePath, clock);
  const executor: JobExecutor = new BuiltinNoteExecutor();
  const deliverer = new VerifiedDeliveryRouter({ senders: [], clock });
  ZERO_SENDER_ROUTERS.add(deliverer);
  const receiptsPath = join(dataDir, "schedule-receipts.json");
  return { store, clock, executor, deliverer, env, receiptsPath };
}

// ===========================================================================
// Small local helpers
// ===========================================================================

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isoOrDash(epochMs: number | undefined): string {
  return epochMs === undefined ? "-" : new Date(epochMs).toISOString();
}

function formatDeliverySpec(delivery: DeliverySpec | undefined): string {
  if (!delivery) return "(none)";
  return `${delivery.platform}:${delivery.user}${delivery.channel ? `:${delivery.channel}` : ""}`;
}

/** Two-space-gapped, left-aligned table. Every line has trailing whitespace
 *  stripped so exact-string test assertions never have to guess padding on
 *  a table's ragged right edge. */
function renderTable(headers: readonly string[], rows: readonly string[][]): string[] {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const fmt = (cells: readonly string[]): string =>
    cells.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd();
  return [fmt(headers), ...rows.map(fmt)];
}

interface FlagParseResult {
  flags: Record<string, string>;
  error?: string;
}

/** Parses `--flag value` pairs from `args`, rejecting any token not present
 *  in `known` and any flag missing its value. Order-independent, each flag
 *  at most meaningfully used once (a repeat silently keeps the last value —
 *  no subcommand here relies on repeatable flags). */
function parseFlags(args: readonly string[], known: ReadonlySet<string>): FlagParseResult {
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (!known.has(token)) {
      return { flags, error: `Unknown flag "${token}".` };
    }
    const value = args[i + 1];
    if (value === undefined) {
      return { flags, error: `Flag ${token} requires a value.` };
    }
    flags[token] = value;
    i++;
  }
  return { flags };
}

// ===========================================================================
// Usage text
// ===========================================================================

const ADD_USAGE_LINE =
  'hades schedule add --name <s> --cron "<5 fields>" [--tz <iana>] [--task note:<text>] [--deliver <platform>:<user>[:<channel>]] [--misfire skip|fire-once|catch-up] [--catch-up-limit <n>]';

const USAGE: string[] = [
  "Usage: hades schedule <command>",
  "",
  "Commands:",
  `  add     ${ADD_USAGE_LINE}`,
  "  list                  List scheduled jobs",
  "  remove <id>           Remove a job by full id or unambiguous id prefix",
  "  run <id>              Fire a job immediately through the real runner + deliverer",
  "  status                Show store path, per-job counters, and executor/sender wiring",
  "  receipts [--job <id>] [--limit <n>]   Show + independently re-verify the hash-chained delivery receipt ledger",
];

// ===========================================================================
// add
// ===========================================================================

const KNOWN_ADD_FLAGS: ReadonlySet<string> = new Set([
  "--name",
  "--cron",
  "--tz",
  "--task",
  "--deliver",
  "--misfire",
  "--catch-up-limit",
]);

function parseTaskFlag(raw: string): { task?: JobTask; error?: string } {
  const idx = raw.indexOf(":");
  if (idx <= 0) {
    return { error: `Invalid --task value ${JSON.stringify(raw)}: expected <kind>:<text>, e.g. note:remember to check logs` };
  }
  return { task: { kind: raw.slice(0, idx), input: raw.slice(idx + 1) } };
}

function parseDeliverFlag(raw: string): { delivery?: DeliverySpec; error?: string } {
  const parts = raw.split(":");
  if (parts.length !== 2 && parts.length !== 3) {
    return { error: `Invalid --deliver value ${JSON.stringify(raw)}: expected <platform>:<user>[:<channel>]` };
  }
  const [platform, user, channel] = parts;
  if (platform.trim().length === 0 || user.trim().length === 0) {
    return { error: `Invalid --deliver value ${JSON.stringify(raw)}: expected <platform>:<user>[:<channel>]` };
  }
  const delivery: DeliverySpec = channel !== undefined ? { platform, user, channel } : { platform, user };
  return { delivery };
}

function handleAdd(args: readonly string[], deps: ScheduleCommandDeps): CliResult {
  const { flags, error } = parseFlags(args, KNOWN_ADD_FLAGS);
  if (error) {
    return { code: 1, lines: [error, "", `Usage: ${ADD_USAGE_LINE}`] };
  }

  const name = flags["--name"];
  const cron = flags["--cron"];
  if (!name || !cron) {
    return { code: 1, lines: [`Usage: ${ADD_USAGE_LINE}`] };
  }

  let task: JobTask;
  if (flags["--task"] !== undefined) {
    const parsed = parseTaskFlag(flags["--task"]);
    if (parsed.error) return { code: 1, lines: [parsed.error] };
    task = parsed.task as JobTask;
  } else {
    task = { kind: "note", input: name };
  }

  let delivery: DeliverySpec | undefined;
  if (flags["--deliver"] !== undefined) {
    const parsed = parseDeliverFlag(flags["--deliver"]);
    if (parsed.error) return { code: 1, lines: [parsed.error] };
    delivery = parsed.delivery;
  }

  const input: NewJobInput = {
    name,
    cron,
    task,
    ...(flags["--tz"] !== undefined ? { timeZone: flags["--tz"] } : {}),
    ...(delivery ? { delivery } : {}),
    ...(flags["--misfire"] !== undefined ? { misfire: flags["--misfire"] as MisfirePolicy } : {}),
    ...(flags["--catch-up-limit"] !== undefined ? { catchUpLimit: Number(flags["--catch-up-limit"]) } : {}),
  };

  let job: ScheduledJob;
  try {
    job = deps.store.add(input);
  } catch (err) {
    // CronParseError and every other store-side validation error (bad tz,
    // bad misfire, bad catchUpLimit) throw BEFORE any mutation happens (see
    // store.ts's assertValidJobShape ordering) — nothing is ever persisted
    // on this path.
    return { code: 1, lines: [err instanceof CronParseError ? err.message : errorMessage(err)] };
  }

  const schedule = parseCron(job.cron);
  const next = nextFireTimes(schedule, deps.clock.now(), job.timeZone, 3);

  return {
    code: 0,
    lines: [
      `Added job ${job.id} "${job.name}"`,
      `  cron:      ${job.cron}  (${describeCron(schedule)})`,
      `  timezone:  ${job.timeZone}`,
      `  task:      ${job.task.kind}:${job.task.input}`,
      `  delivery:  ${formatDeliverySpec(job.delivery)}`,
      `  misfire:   ${job.misfire}${job.misfire === "catch-up" ? ` (catch-up limit ${job.catchUpLimit})` : ""}`,
      "  next fires:",
      ...(next.length > 0 ? next.map((t) => `    ${new Date(t).toISOString()}`) : ["    (none)"]),
    ],
  };
}

// ===========================================================================
// list
// ===========================================================================

function handleList(deps: ScheduleCommandDeps): CliResult {
  const jobs = deps.store.list();
  if (jobs.length === 0) {
    return { code: 0, lines: ["No scheduled jobs."] };
  }

  const headers = ["ID", "NAME", "CRON", "TZ", "ENABLED", "LAST FIRE", "NEXT FIRE"];
  const rows = jobs.map((job) => {
    let nextFire = "-";
    try {
      const schedule = parseCron(job.cron);
      const next = nextFireTime(schedule, deps.clock.now(), job.timeZone);
      nextFire = next === undefined ? "-" : new Date(next).toISOString();
    } catch {
      nextFire = "invalid-cron";
    }
    return [
      job.id.slice(0, 8),
      job.name,
      job.cron,
      job.timeZone,
      String(job.enabled),
      isoOrDash(job.lastFireAt),
      nextFire,
    ];
  });

  return { code: 0, lines: renderTable(headers, rows) };
}

// ===========================================================================
// remove
// ===========================================================================

function handleRemove(args: readonly string[], deps: ScheduleCommandDeps): CliResult {
  const idArg = args[0];
  if (!idArg) {
    return { code: 1, lines: ["Usage: hades schedule remove <id>"] };
  }

  const jobs = deps.store.list();

  const exact = jobs.find((j) => j.id === idArg);
  if (exact) {
    deps.store.remove(exact.id);
    return { code: 0, lines: [`Removed job ${exact.id} "${exact.name}"`] };
  }

  const matches = jobs.filter((j) => j.id.startsWith(idArg));
  if (matches.length === 0) {
    return { code: 1, lines: [`No job matches id/prefix "${idArg}".`] };
  }
  if (matches.length > 1) {
    return {
      code: 1,
      lines: [
        `Ambiguous id/prefix "${idArg}" matches ${matches.length} jobs:`,
        ...matches.map((m) => `  ${m.id}  ${m.name}`),
      ],
    };
  }

  const job = matches[0];
  deps.store.remove(job.id);
  return { code: 0, lines: [`Removed job ${job.id} "${job.name}"`] };
}

// ===========================================================================
// run
// ===========================================================================

async function handleRun(args: readonly string[], deps: ScheduleCommandDeps): Promise<CliResult> {
  const id = args[0];
  if (!id) {
    return { code: 1, lines: ["Usage: hades schedule run <id>"] };
  }

  const job = deps.store.get(id);
  if (!job) {
    return { code: 1, lines: [`No scheduled job with id "${id}".`] };
  }

  // When a receipts ledger is configured, interpose the REAL
  // `LedgeredDeliverer` around the real deliverer: the receipt is appended
  // to the hash-chained ledger and returned untouched (by reference); a
  // ledger failure never alters the delivery outcome — it is reported as a
  // warning line instead.
  let ledgerWarning: string | undefined;
  const innerDeliverer: JobDeliverer = deps.receiptsPath
    ? new LedgeredDeliverer(
        deps.deliverer,
        new DeliveryReceiptLedger({ path: deps.receiptsPath, clock: deps.clock }),
        (message) => {
          ledgerWarning = `warning: receipt ledger append failed (delivery outcome unaffected): ${message}`;
        },
      )
    : deps.deliverer;

  // A thin observer, not a reimplementation: every delivery decision (badge
  // derivation, retries, formatting) still happens inside the REAL
  // `deps.deliverer`. This wrapper only captures the receipt it already
  // returns so `run`'s output can show badge/reason — `SchedulerRunner`
  // itself only ever hands `runOnce`'s caller back a `JobRunRecord`, which
  // doesn't carry the badge.
  let lastReceipt: DeliveryReceipt | undefined;
  const observingDeliverer: JobDeliverer = {
    deliver: async (j, result, ctx) => {
      const receipt = await innerDeliverer.deliver(j, result, ctx);
      lastReceipt = receipt;
      return receipt;
    },
  };

  const runner = new SchedulerRunner({
    store: deps.store,
    clock: deps.clock,
    executor: deps.executor,
    deliverer: observingDeliverer,
  });

  const record = await runner.runOnce(job.id);

  return {
    code: 0,
    lines: [
      `Ran job ${job.id} "${job.name}"`,
      `  outcome:      ${record.outcome}`,
      `  scheduledFor: ${new Date(record.scheduledFor).toISOString()}`,
      `  firedAt:      ${new Date(record.firedAt).toISOString()}`,
      `  durationMs:   ${record.durationMs}`,
      `  detail:       ${record.detail}`,
      `  badge:        ${lastReceipt ? lastReceipt.badge : "(no delivery target configured)"}`,
      `  reason:       ${lastReceipt ? lastReceipt.reason : "(no delivery target configured)"}`,
      ...(ledgerWarning ? [`  ${ledgerWarning}`] : []),
    ],
  };
}

// ===========================================================================
// receipts
// ===========================================================================

const KNOWN_RECEIPTS_FLAGS: ReadonlySet<string> = new Set(["--job", "--limit"]);

function formatReceiptLine(r: ReceiptRecord): string {
  const target = r.platform !== null ? `${r.platform}:${r.user ?? "?"}` : "(no target)";
  const cert = r.certFingerprint !== null ? ` cert=${r.certFingerprint.slice(0, 16)}…` : "";
  return `  #${r.seq}  ${new Date(r.at).toISOString()}  ${r.jobName}  ${r.outcome}  badge=${r.badge}  ${target}  attempts=${r.attempts}${cert}`;
}

/**
 * `hades schedule receipts [--job <id>] [--limit <n>]` — read the
 * hash-chained delivery-receipt ledger and INDEPENDENTLY re-verify the whole
 * chain (every hash recomputed from the persisted bytes — never trusting the
 * stored values). A file that failed to load/verify at construction was
 * quarantined by the ledger itself and is reported honestly via its load
 * report; it is never silently accepted or discarded.
 */
function handleReceipts(args: readonly string[], deps: ScheduleCommandDeps): CliResult {
  if (!deps.receiptsPath) {
    return {
      code: 1,
      lines: ["No receipt ledger configured (deps.receiptsPath is not set)."],
    };
  }

  const { flags, error } = parseFlags(args, KNOWN_RECEIPTS_FLAGS);
  if (error) {
    return { code: 1, lines: [error, "", "Usage: hades schedule receipts [--job <id>] [--limit <n>]"] };
  }

  let limit = 20;
  if (flags["--limit"] !== undefined) {
    limit = Number(flags["--limit"]);
    if (!Number.isInteger(limit) || limit < 0) {
      return { code: 1, lines: [`Invalid --limit value ${JSON.stringify(flags["--limit"])}: expected a non-negative integer.`] };
    }
  }

  let ledger: DeliveryReceiptLedger;
  try {
    ledger = new DeliveryReceiptLedger({ path: deps.receiptsPath, clock: deps.clock });
  } catch (err) {
    return { code: 1, lines: [`Failed to open receipt ledger at ${deps.receiptsPath}: ${errorMessage(err)}`] };
  }

  const report = ledger.loadReport();
  const verification = ledger.verifyChain();
  const tally = ledger.tally();
  const jobId = flags["--job"];
  const records = ledger.records({ ...(jobId !== undefined ? { jobId } : {}), limit });
  const total = ledger.records().length;

  const lines: string[] = [`Receipt ledger: ${deps.receiptsPath}`];
  if (report.recovered) {
    lines.push(`  warning: ${report.warning ?? "ledger recovered from a corrupt file"}`);
  }
  lines.push(
    verification.ok
      ? `Chain: verified OK (${verification.length} record(s), every hash recomputed independently)`
      : `Chain: BROKEN at seq ${String(verification.brokenAtSeq)}: ${verification.reason}`,
  );
  lines.push(`Tally: delivered=${tally.delivered} abstained=${tally.abstained} withheld=${tally.withheld} failed=${tally.failed}`);

  if (total === 0) {
    lines.push("No receipts recorded yet.");
  } else if (records.length === 0) {
    lines.push(jobId !== undefined ? `No receipts match job id "${jobId}".` : "No receipts within the requested limit.");
  } else {
    lines.push(
      jobId !== undefined
        ? `Last ${records.length} receipt(s) for job ${jobId} (of ${total} total):`
        : `Last ${records.length} receipt(s) (of ${total} total):`,
    );
    for (const r of records) lines.push(formatReceiptLine(r));
  }

  return { code: verification.ok ? 0 : 1, lines };
}

// ===========================================================================
// status
// ===========================================================================

function handleStatus(deps: ScheduleCommandDeps): CliResult {
  const report = deps.store.loadReport();
  const jobs = deps.store.list();

  const lines: string[] = [];
  lines.push(`Job store: ${report.path ?? "in-memory (not persisted)"}`);
  if (report.recovered) {
    lines.push(`  warning: ${report.warning ?? "store recovered from a corrupt file"}`);
  }

  lines.push(`Jobs: ${jobs.length}`);
  if (jobs.length === 0) {
    lines.push("  (none)");
  } else {
    for (const job of jobs) {
      lines.push(
        `  ${job.id.slice(0, 8)}  ${job.name}  runs=${job.runCount} fails=${job.failCount} abstains=${job.abstainCount}`,
      );
    }
  }

  lines.push("");
  if (deps.executor instanceof BuiltinNoteExecutor) {
    lines.push(
      'Executor: builtin "note" task executor — deterministic echo of task.input, ok:true, NO verification evidence attached. It delivers only as an honest abstention until the swarm engine is wired centrally.',
    );
  } else {
    const ctorName = (deps.executor as { constructor?: { name?: string } }).constructor?.name ?? "unknown";
    lines.push(`Executor: custom executor (${ctorName}) injected by the caller.`);
  }

  if (ZERO_SENDER_ROUTERS.has(deps.deliverer as object)) {
    lines.push("Senders: no outbound senders configured — central integration attaches gateway connectors.");
  } else if (deps.deliverer instanceof VerifiedDeliveryRouter) {
    lines.push("Senders: VerifiedDeliveryRouter with senders injected by the caller (see the deps used to construct this CLI).");
  } else {
    const ctorName = (deps.deliverer as { constructor?: { name?: string } }).constructor?.name ?? "unknown";
    lines.push(`Senders: custom deliverer (${ctorName}) injected by the caller.`);
  }

  return { code: 0, lines };
}

// ===========================================================================
// runScheduleCommand
// ===========================================================================

export async function runScheduleCommand(args: string[], deps: ScheduleCommandDeps = defaultScheduleDeps()): Promise<CliResult> {
  const [sub, ...rest] = args;

  switch (sub) {
    case "add":
      return handleAdd(rest, deps);
    case "list":
      return handleList(deps);
    case "remove":
      return handleRemove(rest, deps);
    case "run":
      return handleRun(rest, deps);
    case "status":
      return handleStatus(deps);
    case "receipts":
      return handleReceipts(rest, deps);
    default:
      return { code: 1, lines: USAGE };
  }
}
