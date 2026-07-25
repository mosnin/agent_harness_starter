/**
 * The durability layer for `src/hades/schedule/**`: a versioned,
 * atomic, corruption-recovering store holding the full lifecycle record
 * of every scheduled job, plus an in-memory twin that implements the
 * exact same `JobStore` interface so the scheduler engine, the CLI, and
 * tests can all be written once against `JobStore` and only ever choose
 * *which* implementation to construct.
 *
 * `InMemoryJobStore` and `JsonFileJobStore` share every byte of mutation
 * logic (validation, revision bumping, history capping, misfire-count
 * bookkeeping) through the private `JobStoreCore` below — `JsonFileJobStore`
 * is just `JobStoreCore` plus "persist to disk after every successful
 * mutation" and "reload from disk on construct". That is what makes the
 * two provably interchangeable rather than two hand-maintained copies that
 * quietly drift apart.
 *
 * Persistence mirrors the proven `src/hades/tools/manager.ts` /
 * `src/hades/memory/user-model-store.ts` convention: `mkdir -p` the parent,
 * write a sibling `.tmp` file, then `renameSync` it over the target. A
 * crash between those two steps can only ever leave the untouched previous
 * file or an orphaned `.tmp` sibling behind — the target path itself is
 * never observed half-written. A pre-existing stale `.tmp` (e.g. left by a
 * process that died mid-write in some earlier run) is simply overwritten
 * by the next `writeFileSync`, since the tmp path is fixed rather than
 * unique-per-write.
 *
 * Loading is deliberately paranoid: a file that is missing is just an
 * empty store (nothing to recover). A file that exists but fails to parse,
 * isn't a JSON object, is the wrong `version`, or whose `jobs` array
 * contains a structurally malformed record is never crashed on and never
 * silently discarded — it is renamed aside to `<path>.corrupt-<epoch>`
 * (preserving the bad bytes for forensics) and the store starts empty,
 * with the event honestly reported via `loadReport()`. There is no load
 * path that throws out of the constructor.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { parseCron } from "./cron";
import type { Clock } from "./clock";

// ===========================================================================
// Locked public types
// ===========================================================================

export type MisfirePolicy = "skip" | "fire-once" | "catch-up";

export interface DeliverySpec {
  platform: string;
  user: string;
  channel?: string;
}

export interface JobTask {
  kind: string;
  input: string;
}

export type RunOutcome = "delivered" | "abstained" | "withheld" | "failed" | "skipped";

export interface JobRunRecord {
  firedAt: number;
  scheduledFor: number;
  outcome: RunOutcome;
  detail: string;
  durationMs: number;
}

export interface ScheduledJob {
  id: string;
  name: string;
  cron: string;
  timeZone: string;
  task: JobTask;
  delivery?: DeliverySpec;
  misfire: MisfirePolicy;
  catchUpLimit: number;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  lastFireAt?: number;
  runCount: number;
  failCount: number;
  abstainCount: number;
  history: JobRunRecord[];
  revision: number;
}

export interface NewJobInput {
  name: string;
  cron: string;
  timeZone?: string;
  task: JobTask;
  delivery?: DeliverySpec;
  misfire?: MisfirePolicy;
  catchUpLimit?: number;
  enabled?: boolean;
}

export interface JobStoreLoadReport {
  path?: string;
  recovered: boolean;
  warning?: string;
}

export interface JobStore {
  list(): ScheduledJob[];
  get(id: string): ScheduledJob | undefined;
  add(input: NewJobInput): ScheduledJob;
  update(
    id: string,
    patch: Partial<Omit<ScheduledJob, "id" | "createdAt" | "revision">>,
    expectedRevision?: number,
  ): ScheduledJob;
  remove(id: string): boolean;
  recordRun(id: string, run: JobRunRecord): ScheduledJob;
  loadReport(): JobStoreLoadReport;
}

// ===========================================================================
// Small local helpers (pure, no I/O)
// ===========================================================================

const MAX_HISTORY = 50;

const MISFIRE_POLICIES: ReadonlySet<MisfirePolicy> = new Set(["skip", "fire-once", "catch-up"]);
const RUN_OUTCOMES: ReadonlySet<RunOutcome> = new Set([
  "delivered",
  "abstained",
  "withheld",
  "failed",
  "skipped",
]);

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function assertValidName(name: unknown): asserts name is string {
  if (typeof name !== "string" || name.trim().length === 0) {
    throw new Error("ScheduledJob name must be a non-empty string");
  }
}

/** Probe an IANA time zone identifier the only honest way there is:
 *  ask `Intl` to build a formatter for it. Node throws `RangeError` for an
 *  unrecognized zone, which is exactly the signal this function turns into
 *  a clear, store-specific error message. */
function assertValidTimeZone(timeZone: unknown): asserts timeZone is string {
  if (typeof timeZone !== "string" || timeZone.length === 0) {
    throw new Error(`ScheduledJob timeZone must be a non-empty string, got ${JSON.stringify(timeZone)}`);
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
  } catch (err) {
    throw new Error(`Invalid IANA time zone ${JSON.stringify(timeZone)}: ${errorMessage(err)}`);
  }
}

function assertValidTask(task: unknown): asserts task is JobTask {
  if (
    !task ||
    typeof task !== "object" ||
    typeof (task as JobTask).kind !== "string" ||
    (task as JobTask).kind.trim().length === 0 ||
    typeof (task as JobTask).input !== "string"
  ) {
    throw new Error("JobTask requires a non-empty 'kind' string and a string 'input'");
  }
}

function assertValidDelivery(delivery: DeliverySpec | undefined): void {
  if (delivery === undefined) return;
  if (
    !delivery ||
    typeof delivery !== "object" ||
    typeof delivery.platform !== "string" ||
    delivery.platform.trim().length === 0 ||
    typeof delivery.user !== "string" ||
    delivery.user.trim().length === 0
  ) {
    throw new Error("DeliverySpec requires non-empty 'platform' and 'user'");
  }
  if (delivery.channel !== undefined && typeof delivery.channel !== "string") {
    throw new Error("DeliverySpec.channel must be a string when provided");
  }
}

function assertValidMisfire(misfire: unknown): asserts misfire is MisfirePolicy {
  if (!MISFIRE_POLICIES.has(misfire as MisfirePolicy)) {
    throw new Error(`Invalid misfire policy: ${JSON.stringify(misfire)}`);
  }
}

function assertValidCatchUpLimit(catchUpLimit: unknown): asserts catchUpLimit is number {
  if (typeof catchUpLimit !== "number" || !Number.isInteger(catchUpLimit) || catchUpLimit < 0) {
    throw new Error(`catchUpLimit must be a non-negative integer, got ${JSON.stringify(catchUpLimit)}`);
  }
}

function assertValidRunOutcome(outcome: unknown): asserts outcome is RunOutcome {
  if (!RUN_OUTCOMES.has(outcome as RunOutcome)) {
    throw new Error(`Invalid run outcome: ${JSON.stringify(outcome)}`);
  }
}

function assertValidRunRecord(run: JobRunRecord): void {
  if (!run || typeof run !== "object") {
    throw new Error("JobRunRecord must be an object");
  }
  assertValidRunOutcome(run.outcome);
  if (typeof run.firedAt !== "number" || !Number.isFinite(run.firedAt)) {
    throw new Error(`JobRunRecord.firedAt must be a finite number, got ${JSON.stringify(run.firedAt)}`);
  }
  if (typeof run.scheduledFor !== "number" || !Number.isFinite(run.scheduledFor)) {
    throw new Error(`JobRunRecord.scheduledFor must be a finite number, got ${JSON.stringify(run.scheduledFor)}`);
  }
  if (typeof run.durationMs !== "number" || !Number.isFinite(run.durationMs) || run.durationMs < 0) {
    throw new Error(`JobRunRecord.durationMs must be a non-negative finite number, got ${JSON.stringify(run.durationMs)}`);
  }
  if (typeof run.detail !== "string") {
    throw new Error("JobRunRecord.detail must be a string");
  }
}

/** Validates the full "job shape" invariant that every stored job must
 *  satisfy at all times — used by both `add()` (against the freshly
 *  defaulted input) and `update()` (against the freshly merged record), so
 *  a job can never end up persisted in a state that `add()` itself would
 *  have refused. */
function assertValidJobShape(candidate: {
  name: string;
  cron: string;
  timeZone: string;
  task: JobTask;
  delivery?: DeliverySpec;
  misfire: MisfirePolicy;
  catchUpLimit: number;
}): void {
  assertValidName(candidate.name);
  if (typeof candidate.cron !== "string" || candidate.cron.trim().length === 0) {
    throw new Error("ScheduledJob cron must be a non-empty string");
  }
  // Validate BEFORE anything is persisted. Thrown CronParseError (with its
  // `.field`) propagates to the caller completely unwrapped.
  parseCron(candidate.cron);
  assertValidTimeZone(candidate.timeZone);
  assertValidTask(candidate.task);
  assertValidDelivery(candidate.delivery);
  assertValidMisfire(candidate.misfire);
  assertValidCatchUpLimit(candidate.catchUpLimit);
}

function cloneRun(run: JobRunRecord): JobRunRecord {
  return { ...run };
}

/** Deep-enough clone so that values handed out by `list()`/`get()`/etc. can
 *  never be mutated by a caller to silently corrupt the store's own state
 *  (or, for `JsonFileJobStore`, drift from what was last persisted). */
function cloneJob(job: ScheduledJob): ScheduledJob {
  return {
    ...job,
    task: { ...job.task },
    delivery: job.delivery ? { ...job.delivery } : undefined,
    history: job.history.map(cloneRun),
  };
}

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Light structural validation for a job record loaded off disk. Deep
 *  enough to catch the corruption scenarios this store is contracted to
 *  recover from (garbage entries inside an otherwise well-formed `jobs`
 *  array) without re-implementing full schema validation. */
function isValidStoredJob(v: unknown): v is ScheduledJob {
  if (!isPlainRecord(v)) return false;
  if (typeof v.id !== "string" || v.id.length === 0) return false;
  if (typeof v.name !== "string") return false;
  if (typeof v.cron !== "string") return false;
  if (typeof v.timeZone !== "string") return false;
  if (!isPlainRecord(v.task) || typeof v.task.kind !== "string" || typeof v.task.input !== "string") return false;
  if (typeof v.misfire !== "string" || !MISFIRE_POLICIES.has(v.misfire as MisfirePolicy)) return false;
  if (typeof v.catchUpLimit !== "number") return false;
  if (typeof v.enabled !== "boolean") return false;
  if (typeof v.createdAt !== "number") return false;
  if (typeof v.updatedAt !== "number") return false;
  if (typeof v.runCount !== "number") return false;
  if (typeof v.failCount !== "number") return false;
  if (typeof v.abstainCount !== "number") return false;
  if (!Array.isArray(v.history)) return false;
  if (typeof v.revision !== "number") return false;
  return true;
}

function buildScheduledJob(input: NewJobInput, clock: Clock, idFn: () => string): ScheduledJob {
  if (!input || typeof input !== "object") {
    throw new TypeError("NewJobInput must be an object");
  }

  const timeZone = input.timeZone ?? "UTC";
  const misfire = input.misfire ?? "skip";
  const catchUpLimit = input.catchUpLimit ?? 5;
  const enabled = input.enabled ?? true;

  assertValidJobShape({
    name: input.name,
    cron: input.cron,
    timeZone,
    task: input.task,
    delivery: input.delivery,
    misfire,
    catchUpLimit,
  });

  const now = clock.now();
  const job: ScheduledJob = {
    id: idFn(),
    name: input.name,
    cron: input.cron,
    timeZone,
    task: { kind: input.task.kind, input: input.task.input },
    misfire,
    catchUpLimit,
    enabled,
    createdAt: now,
    updatedAt: now,
    runCount: 0,
    failCount: 0,
    abstainCount: 0,
    history: [],
    revision: 1,
  };
  if (input.delivery) job.delivery = { ...input.delivery };
  return job;
}

// ===========================================================================
// JobStoreCore — the one place mutation logic lives
// ===========================================================================

/**
 * Not exported. Holds the actual `Map<id, ScheduledJob>` and every piece of
 * mutation/validation logic. `InMemoryJobStore` is a thin pass-through to
 * this; `JsonFileJobStore` is this plus "persist after every successful
 * mutation" and "load from disk on construct" wrapped around the same
 * calls — see the note at the top of the file for why that is deliberate.
 */
class JobStoreCore {
  private readonly jobs = new Map<string, ScheduledJob>();

  constructor(
    private readonly clock: Clock,
    private readonly idFn: () => string,
  ) {}

  /** Replace the entire in-memory contents (used only by `JsonFileJobStore`
   *  right after a successful load). Records are cloned in, never aliased. */
  replaceAll(records: readonly ScheduledJob[]): void {
    this.jobs.clear();
    for (const record of records) this.jobs.set(record.id, cloneJob(record));
  }

  list(): ScheduledJob[] {
    return [...this.jobs.values()].map(cloneJob);
  }

  get(id: string): ScheduledJob | undefined {
    const job = this.jobs.get(id);
    return job ? cloneJob(job) : undefined;
  }

  add(input: NewJobInput): ScheduledJob {
    const job = buildScheduledJob(input, this.clock, this.idFn);
    // Nothing above this line touched `this.jobs` — an invalid input throws
    // out of `buildScheduledJob` before any mutation happens.
    this.jobs.set(job.id, job);
    return cloneJob(job);
  }

  update(
    id: string,
    patch: Partial<Omit<ScheduledJob, "id" | "createdAt" | "revision">>,
    expectedRevision?: number,
  ): ScheduledJob {
    const existing = this.jobs.get(id);
    if (!existing) {
      throw new Error(`ScheduledJob "${id}" not found`);
    }
    if (expectedRevision !== undefined && expectedRevision !== existing.revision) {
      throw new Error(
        `ScheduledJob "${id}" revision conflict: expected revision ${expectedRevision}, actual revision ${existing.revision}`,
      );
    }

    const merged: ScheduledJob = {
      ...existing,
      ...patch,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: this.clock.now(),
      revision: existing.revision + 1,
    };
    merged.task = { ...merged.task };
    merged.delivery = merged.delivery ? { ...merged.delivery } : undefined;
    merged.history = merged.history.map(cloneRun);

    assertValidJobShape(merged);

    this.jobs.set(id, merged);
    return cloneJob(merged);
  }

  remove(id: string): boolean {
    return this.jobs.delete(id);
  }

  recordRun(id: string, run: JobRunRecord): ScheduledJob {
    const existing = this.jobs.get(id);
    if (!existing) {
      throw new Error(`ScheduledJob "${id}" not found`);
    }
    assertValidRunRecord(run);

    const history = [...existing.history, cloneRun(run)];
    while (history.length > MAX_HISTORY) history.shift();

    const merged: ScheduledJob = {
      ...existing,
      history,
      runCount: existing.runCount + 1,
      failCount: existing.failCount + (run.outcome === "failed" ? 1 : 0),
      abstainCount: existing.abstainCount + (run.outcome === "abstained" || run.outcome === "withheld" ? 1 : 0),
      lastFireAt: run.firedAt,
      updatedAt: this.clock.now(),
      revision: existing.revision + 1,
    };

    this.jobs.set(id, merged);
    return cloneJob(merged);
  }
}

// ===========================================================================
// InMemoryJobStore
// ===========================================================================

export class InMemoryJobStore implements JobStore {
  private readonly core: JobStoreCore;

  constructor(clock: Clock, idFn: () => string = randomUUID) {
    this.core = new JobStoreCore(clock, idFn);
  }

  list(): ScheduledJob[] {
    return this.core.list();
  }

  get(id: string): ScheduledJob | undefined {
    return this.core.get(id);
  }

  add(input: NewJobInput): ScheduledJob {
    return this.core.add(input);
  }

  update(
    id: string,
    patch: Partial<Omit<ScheduledJob, "id" | "createdAt" | "revision">>,
    expectedRevision?: number,
  ): ScheduledJob {
    return this.core.update(id, patch, expectedRevision);
  }

  remove(id: string): boolean {
    return this.core.remove(id);
  }

  recordRun(id: string, run: JobRunRecord): ScheduledJob {
    return this.core.recordRun(id, run);
  }

  /** There is no file, so there is nothing to ever recover from. */
  loadReport(): JobStoreLoadReport {
    return { recovered: false };
  }
}

// ===========================================================================
// JsonFileJobStore
// ===========================================================================

interface PersistedJobFile {
  version: 1;
  jobs: ScheduledJob[];
}

export class JsonFileJobStore implements JobStore {
  private readonly filePath: string;
  private readonly clock: Clock;
  private readonly core: JobStoreCore;
  private readonly report: JobStoreLoadReport;

  constructor(filePath: string, clock: Clock, idFn: () => string = randomUUID) {
    if (typeof filePath !== "string" || filePath.length === 0) {
      throw new TypeError("JsonFileJobStore: filePath must be a non-empty string");
    }
    this.filePath = filePath;
    this.clock = clock;
    this.core = new JobStoreCore(clock, idFn);
    this.report = this.loadFromDisk();
  }

  private loadFromDisk(): JobStoreLoadReport {
    if (!existsSync(this.filePath)) {
      return { path: this.filePath, recovered: false };
    }

    let raw: string;
    try {
      raw = readFileSync(this.filePath, "utf8");
    } catch (err) {
      return this.quarantine(`unreadable job store file: ${errorMessage(err)}`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      return this.quarantine(`invalid JSON in job store file: ${errorMessage(err)}`);
    }

    if (!isPlainRecord(parsed)) {
      return this.quarantine("job store file did not contain a JSON object");
    }
    if (parsed.version !== 1) {
      return this.quarantine(`unsupported job store version: ${JSON.stringify(parsed.version)}`);
    }
    if (!Array.isArray(parsed.jobs)) {
      return this.quarantine('job store file\'s "jobs" field is not an array');
    }
    for (const candidate of parsed.jobs) {
      if (!isValidStoredJob(candidate)) {
        return this.quarantine("job store file contains a malformed job record");
      }
    }

    this.core.replaceAll(parsed.jobs as ScheduledJob[]);
    return { path: this.filePath, recovered: false };
  }

  /** Never lets a corrupt/unrecognized file crash construction: the file is
   *  renamed aside to `<path>.corrupt-<epoch>` (never silently deleted) so
   *  the bad bytes are preserved for forensics, and the store starts empty.
   *  If even the rename fails, that failure is folded into the warning and
   *  the store still starts empty in memory rather than throwing. */
  private quarantine(reason: string): JobStoreLoadReport {
    const ts = this.clock.now();
    let target = `${this.filePath}.corrupt-${ts}`;
    let suffix = 0;
    while (existsSync(target)) {
      suffix += 1;
      target = `${this.filePath}.corrupt-${ts}-${suffix}`;
    }
    try {
      renameSync(this.filePath, target);
      return { path: this.filePath, recovered: true, warning: `${reason}; quarantined to ${target}` };
    } catch (renameErr) {
      return {
        path: this.filePath,
        recovered: true,
        warning: `${reason}; could not quarantine (${errorMessage(renameErr)}), starting empty in memory`,
      };
    }
  }

  /** Atomic write: mkdir -p the parent, write the fixed `.tmp` sibling, then
   *  renameSync it over the target. The tmp path is fixed (not unique per
   *  write) so a stale tmp left behind by an earlier crash is simply
   *  overwritten by the next write rather than accumulating forever. */
  private persist(): void {
    const payload: PersistedJobFile = { version: 1, jobs: this.core.list() };
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(payload, null, 2), "utf8");
    renameSync(tmpPath, this.filePath);
  }

  list(): ScheduledJob[] {
    return this.core.list();
  }

  get(id: string): ScheduledJob | undefined {
    return this.core.get(id);
  }

  add(input: NewJobInput): ScheduledJob {
    const job = this.core.add(input);
    this.persist();
    return job;
  }

  update(
    id: string,
    patch: Partial<Omit<ScheduledJob, "id" | "createdAt" | "revision">>,
    expectedRevision?: number,
  ): ScheduledJob {
    const job = this.core.update(id, patch, expectedRevision);
    this.persist();
    return job;
  }

  remove(id: string): boolean {
    const removed = this.core.remove(id);
    if (removed) this.persist();
    return removed;
  }

  recordRun(id: string, run: JobRunRecord): ScheduledJob {
    const job = this.core.recordRun(id, run);
    this.persist();
    return job;
  }

  loadReport(): JobStoreLoadReport {
    return this.report;
  }
}
