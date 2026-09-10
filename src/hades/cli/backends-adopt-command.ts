/**
 * `hades backends reconcile --adopt` — the terminal front-end for
 * {@link restoreWithAdoption} (`../backends/adoption.ts`): the command that
 * turns "restored" (reported) into "resurrected" (re-attached to the live
 * registry, so `status`/`hibernate`/`wake`/`terminate` work again for it).
 *
 *   hades backends reconcile              # dry run (default): what WOULD adopt
 *   hades backends reconcile --dry-run    # same as above, explicit
 *   hades backends reconcile --adopt      # actually adopt
 *   hades backends reconcile [...] --json # machine-readable report
 *
 * Terminal-free (`{ code, lines }`), matching the house shape (see
 * `../cli/backends-command.ts`'s own `cmdReconcile` — this module is its
 * `--adopt`-capable sibling, deliberately kept separate: wiring THIS module's
 * exported `runReconcileAdoptCommand` into `hades backends reconcile`'s
 * dispatch — so `--adopt` is recognized at all — is central integration's
 * job, not this file's; this file never touches `cli.ts`, `backends-command.ts`,
 * any barrel, or `ipc/contract.ts`).
 *
 * Dry run (no `--adopt`, or an explicit `--dry-run`) is proven side-effect
 * free by construction, not by convention: it runs the exact same
 * {@link restoreWithAdoption} path against a wrapping "shadow" port (see
 * {@link makeDryRunPort}) whose `adopt()` never calls the REAL port's
 * `adopt` — the real registry is never mutated, and no `LifecycleMachine` is
 * passed through even if the caller configured one, so nothing is re-tracked
 * either.
 */
import type { CliResult } from "./cli";
import type { HandleStore } from "../backends/handle-store";
import type { LifecycleMachine } from "../backends/lifecycle";
import type { RemoteHandle } from "../backends/backend";
import { restoreWithAdoption, type AdoptionReport, type RegistryAdoptionPort } from "../backends/adoption";

export interface AdoptCommandDeps {
  /** Crash-consistent fleet persistence to adopt from. Absent -> the command
   *  honestly reports there is nothing persisted to adopt (code 1), matching
   *  `backends-command.ts`'s existing `reconcile` subcommand's message style. */
  store?: HandleStore;
  /** The live registry (satisfying the additive `RegistryAdoptionPort` seam)
   *  every trustworthy persisted handle gets re-attached to on `--adopt`. */
  registry: RegistryAdoptionPort;
  /** Optional: when present, every ADOPTED handle is re-tracked in it at its
   *  probed state (never invoked at all on a dry run). */
  machine?: LifecycleMachine;
  now?: () => number;
}

const USAGE = [
  "Usage: hades backends reconcile [--adopt] [--dry-run] [--json]",
  "",
  "  (no flags)   Dry run: report what WOULD be adopted; nothing is mutated.",
  "  --dry-run    Same as the default — explicit, for scripting clarity.",
  "  --adopt      Actually re-attach every adoptable persisted handle into",
  "               the live registry (and re-track it if a lifecycle machine",
  "               is configured). --adopt and --dry-run are mutually exclusive.",
  "  --json       Emit the report as JSON instead of tables.",
];

// ---------------------------------------------------------------------------
// small local helpers (own copies — see file header: this module never
// imports another CLI command module's internals, matching the house
// convention `backends-command.ts` itself documents)
// ---------------------------------------------------------------------------

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Strips ASCII control characters before a user-supplied string is echoed
 *  into an output line, so a crafted workerId/backend/reason can never
 *  inject control sequences into the CLI's output stream. */
function sanitize(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\x00-\x1F\x7F]/g, "");
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

function renderTable(headers: string[], rows: string[][]): string[] {
  if (rows.length === 0) return [];
  const widths = headers.map((h, col) => Math.max(h.length, ...rows.map((r) => r[col].length)));
  const renderRow = (cols: string[]): string => cols.map((c, i) => pad(c, widths[i])).join("  ").trimEnd();
  return [renderRow(headers), ...rows.map(renderRow)];
}

/** Pulls a boolean `--flag` out of `args`, removing every occurrence. */
function extractBoolFlag(args: string[], flag: string): { present: boolean; rest: string[] } {
  let present = false;
  const rest: string[] = [];
  for (const a of args) {
    if (a === flag) {
      present = true;
      continue;
    }
    rest.push(a);
  }
  return { present, rest };
}

// ---------------------------------------------------------------------------
// dry-run port: wraps a REAL RegistryAdoptionPort so `adopt()` never reaches
// it — reads (`get`/`handle`/`list`) delegate straight through (so an
// already-live worker is still correctly reported as a conflict), but every
// "insertion" lives only in a local shadow map that is thrown away with the
// wrapper itself once the command returns.
// ---------------------------------------------------------------------------

function makeDryRunPort(real: RegistryAdoptionPort): RegistryAdoptionPort {
  const shadow = new Map<string, RemoteHandle>();
  return {
    adopt(handle: RemoteHandle): void {
      if (shadow.has(handle.workerId) || real.handle(handle.workerId)) {
        throw new Error(`duplicate workerId: ${handle.workerId}`);
      }
      shadow.set(handle.workerId, handle);
    },
    handle(workerId: string): RemoteHandle | undefined {
      return real.handle(workerId) ?? shadow.get(workerId);
    },
    get(name: string) {
      return real.get(name);
    },
    list(): RemoteHandle[] {
      return [...real.list(), ...shadow.values()];
    },
  };
}

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

function renderReport(report: AdoptionReport, dryRun: boolean): string[] {
  const verb = dryRun ? "would be adopted" : "adopted";
  const lines: string[] = [
    dryRun
      ? `Dry run — ${report.adopted.length} handle(s) would be adopted; nothing was mutated.`
      : `Adopted ${report.adopted.length} handle(s).`,
    `${verb}:   ${report.adopted.length}`,
    `corrected: ${report.corrected.length}`,
    `conflicts: ${report.conflicts.length}`,
    `dropped:   ${report.dropped.length}`,
  ];

  const adoptedTable = renderTable(
    ["WORKERID", "BACKEND", "PROBED STATE"],
    report.adopted.map((h) => [sanitize(h.workerId), sanitize(h.backend), h.state]),
  );
  if (adoptedTable.length > 0) {
    lines.push("", dryRun ? "Would adopt:" : "Adopted:", ...adoptedTable);
  }

  const correctedTable = renderTable(
    ["WORKERID", "STORED", "PROBED"],
    report.corrected.map((c) => [sanitize(c.workerId), c.stored, c.probed]),
  );
  if (correctedTable.length > 0) {
    lines.push("", "Corrected (stored state disagreed with the live probe):", ...correctedTable);
  }

  const conflictsTable = renderTable(
    ["WORKERID", "REASON"],
    report.conflicts.map((c) => [sanitize(c.workerId), sanitize(c.reason)]),
  );
  if (conflictsTable.length > 0) {
    lines.push("", "Conflicts (already live in the registry — left untouched):", ...conflictsTable);
  }

  const droppedTable = renderTable(
    ["WORKERID", "REASON"],
    report.dropped.map((d) => [sanitize(d.workerId), sanitize(d.reason)]),
  );
  if (droppedTable.length > 0) {
    lines.push("", "Dropped:", ...droppedTable);
  }

  return lines;
}

// ---------------------------------------------------------------------------
// dispatcher
// ---------------------------------------------------------------------------

/**
 * Implements `[--adopt] [--dry-run] [--json]` on top of {@link
 * restoreWithAdoption}. No `deps.store` configured -> `{ code: 1 }` with the
 * same honest "nothing is persisted" message style as
 * `backends-command.ts`'s existing `reconcile` subcommand. Nothing ever
 * persisted yet (`store.load()` -> `undefined`) -> `{ code: 0 }` reporting
 * that honestly, matching the same subcommand's precedent. Every other
 * failure is caught and reported as `{ code: 1 }` — this command never
 * throws uncaught.
 */
export async function runReconcileAdoptCommand(args: string[], deps: AdoptCommandDeps): Promise<CliResult> {
  const adoptFlag = extractBoolFlag(args, "--adopt");
  let rest = adoptFlag.rest;
  const dryRunFlag = extractBoolFlag(rest, "--dry-run");
  rest = dryRunFlag.rest;
  const jsonFlag = extractBoolFlag(rest, "--json");
  rest = jsonFlag.rest;

  if (rest.length > 0) {
    return { code: 1, lines: [`Unexpected argument: ${sanitize(rest[0])}`, ...USAGE] };
  }
  if (adoptFlag.present && dryRunFlag.present) {
    return { code: 1, lines: ["--adopt and --dry-run are mutually exclusive.", ...USAGE] };
  }

  if (!deps.store) {
    return { code: 1, lines: ["No fleet store configured for this build (nothing is persisted to adopt)."] };
  }

  const dryRun = !adoptFlag.present;
  const now = deps.now ?? (() => Date.now());

  try {
    const registryForRun = dryRun ? makeDryRunPort(deps.registry) : deps.registry;
    const machineForRun = dryRun ? undefined : deps.machine;

    const result = await restoreWithAdoption({
      store: deps.store,
      registry: registryForRun,
      machine: machineForRun,
      now,
    });

    if (!result) {
      return { code: 0, lines: ["No persisted fleet found (nothing saved yet, or the file was quarantined)."] };
    }

    if (jsonFlag.present) {
      return { code: 0, lines: [JSON.stringify({ dryRun, adoption: result.adoption }, null, 2)] };
    }

    return { code: 0, lines: renderReport(result.adoption, dryRun) };
  } catch (err) {
    return { code: 1, lines: [`adopt failed: ${errMsg(err)}`] };
  }
}
