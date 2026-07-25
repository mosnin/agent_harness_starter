/**
 * `hades skill <synth|refine|track|trust>` — the Phase-10 skill-evolution
 * surface: it composes the four already-locked engines (synthesis,
 * refine-on-use, the hash-chained track record, and the demotion trust
 * policy) into one product-facing CLI command, over the real skills
 * directory and the real data directory.
 *
 *   hades skill synth <trajectory.json>
 *       Turn a GATE-VERIFIED trajectory (or a JSON array of them) into a new
 *       re-loadable SKILL.md. Verification runs BEFORE anything is written;
 *       a rejected trajectory never touches the skills directory.
 *
 *   hades skill refine <skill> <use.json>
 *       Fold GATE-VERIFIED use(s) of an existing skill (a VerifiedUse, or a
 *       JSON array of them) into it: learned caveats, tool corrections, a
 *       version bump — atomically rewritten only when something changed.
 *
 *   hades skill track <skill> --p <0..1> --success|--failure [--cert <sha>]
 *   hades skill track [skill]
 *       Record one observed (forecast, outcome) pair into the skill's
 *       hash-chained track record, or print calibration/reliability
 *       summaries (one skill, or every skill this CLI can see).
 *
 *   hades skill trust [--policy-file <path>]
 *       Evaluate every skill's trust status (active/probation/demoted)
 *       against its track record under a fixed policy, and persist the
 *       decision so the next invocation — even a brand-new process reading
 *       the same files — reports the same status.
 *
 * REAL-VS-MOCK POLICY: this file imports and calls the real engines
 * (`../skills/synthesize`, `../skills/refine`, `../skills/track-record`,
 * `../skills/demotion`, `../skills/library`, `../skills/skill-file`) — it
 * performs no synthesis, refinement, scoring, or trust-policy math of its
 * own. Every number this command prints (brier, wilsonLower, pCorrect,
 * epsilon, streaks, thresholds) is computed by one of those modules, never
 * fabricated here. Filesystem access is fully injectable (`opts.fs`) for
 * tests; the default is real `node:fs` with atomic tmp+rename writes (the
 * same pattern `track-record.ts` uses for its own persistence). The clock
 * is injectable (`opts.now`); this module never calls `Date.now()` itself
 * outside that default. Every subcommand runs under one top-level
 * try/catch so an unanticipated failure is always a one-line, actionable
 * message with exit code 1 — never a raw stack trace.
 *
 * This file deliberately does not import or touch `cli.ts`,
 * `skills-command.ts`, or any barrel: `runSkillEvolveCommand` is exported
 * for the central integrator to wire up once every team's contract has
 * landed.
 *
 * @module hades/cli/skill-evolve-command
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";

import {
  extractProvenance,
  synthesizeSkill,
  verifyTrajectoryForSynthesis,
  type VerifiedTrajectory,
} from "../skills/synthesize";
import {
  SkillTrackRecordStore,
  TrackRecordValidationError,
  brierScore,
  wilsonLowerBound,
  type SkillTrackSummary,
  type TrackRecordEntry,
  type TrackRecordFs,
} from "../skills/track-record";
import {
  applyOutcomeToStreak,
  defaultSkillTrustPolicy,
  evaluateSkillTrust,
  parseTrustStates,
  serializeTrustStates,
  type SkillTrustPolicy,
  type SkillTrustState,
} from "../skills/demotion";
import { refineSkill, type VerifiedUse } from "../skills/refine";
import { SkillLibrary } from "../skills/library";
import { parseSkillFile } from "../skills/skill-file";
import { SkillTrustReader } from "../skills/trust-selection";
import {
  applyHoldoutDecision,
  runHoldoutValidation,
  type HoldoutCase,
  type HoldoutRunResult,
  type HoldoutRunner,
} from "../skills/holdout";
import { GateTrackRecorder, type GatedSkillUse, type SkipReason } from "../skills/gate-track-hook";

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

/** Mirror of `SkillCommandResult` (skills-command.ts) — kept disjoint on purpose. */
export interface SkillEvolveResult {
  code: number;
  lines: string[];
}

/** Minimal, injectable filesystem surface this command needs. */
export interface SkillEvolveFs {
  /** Returns file contents, or null if the file does not exist. */
  readFile(p: string): string | null;
  /** Writes file contents. The default implementation does this atomically (tmp + rename). */
  writeFile(p: string, c: string): void;
  /** Recursively creates a directory if it does not already exist. */
  mkdirp(d: string): void;
  /** Lists entries directly inside a directory; [] if it does not exist. */
  readDir(d: string): string[];
  /** True if the given path exists (file or directory). */
  exists(p: string): boolean;
}

export interface SkillEvolveOptions {
  /** Skills dir; default $HADES_SKILLS_DIR else <HADES_DATA_DIR|.hades>/skills. */
  dir?: string;
  /** Data dir; default $HADES_DATA_DIR|.hades. */
  dataDir?: string;
  env?: Record<string, string | undefined>;
  now?: () => number;
  /** Injectable filesystem; defaults to real `node:fs` with atomic tmp+rename writes. */
  fs?: SkillEvolveFs;
}

// ---------------------------------------------------------------------------
// Default (real) filesystem — atomic tmp+rename writes, ENOENT -> null/[].
// ---------------------------------------------------------------------------

const realFs: SkillEvolveFs = {
  readFile(p: string): string | null {
    try {
      return readFileSync(p, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return null;
      throw err;
    }
  },
  writeFile(p: string, content: string): void {
    mkdirSync(dirname(p), { recursive: true });
    const tmp = `${p}.${randomBytes(8).toString("hex")}.tmp`;
    writeFileSync(tmp, content, "utf8");
    renameSync(tmp, p);
  },
  mkdirp(d: string): void {
    mkdirSync(d, { recursive: true });
  },
  readDir(d: string): string[] {
    try {
      return readdirSync(d);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return [];
      throw err;
    }
  },
  exists(p: string): boolean {
    return existsSync(p);
  },
};

// ---------------------------------------------------------------------------
// Internal context + small shared helpers
// ---------------------------------------------------------------------------

interface Ctx {
  fs: SkillEvolveFs;
  now: () => number;
  dataDir: string;
  dir: string;
}

function fail1(msg: string): SkillEvolveResult {
  return { code: 1, lines: [msg] };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Fixed-precision rendering for every printed metric — deterministic, never fabricated. */
function fmt(n: number): string {
  return Number.isFinite(n) ? n.toFixed(4) : String(n);
}

function trackFsAdapter(fs: SkillEvolveFs): TrackRecordFs {
  // Wrapped in arrow functions (rather than destructured method
  // references) so a class-based `fs` double keeps its `this` binding —
  // `{ readFile: fs.readFile, ... }` would silently detach the methods
  // from their instance.
  return {
    readFile: (p: string) => fs.readFile(p),
    writeFile: (p: string, c: string) => fs.writeFile(p, c),
    mkdirp: (d: string) => fs.mkdirp(d),
  };
}

function openTrackStore(ctx: Ctx): SkillTrackRecordStore {
  return new SkillTrackRecordStore({
    path: join(ctx.dataDir, "skill-track.json"),
    now: ctx.now,
    fs: trackFsAdapter(ctx.fs),
  });
}

function trustStatePath(ctx: Ctx): string {
  return join(ctx.dataDir, "skill-trust.json");
}

/**
 * Integrity probe over the persisted track-record bytes. `load()` on the real
 * store distinguishes two failure modes and this helper preserves that
 * distinction for the command layer:
 *
 *  - "unreadable" — the envelope itself did not parse (garbage JSON, wrong
 *    version, malformed entries). The store resets to empty-but-usable, which
 *    is fine for the engine but NOT something this CLI may silently paper
 *    over: recording would atomically overwrite (destroy) the corrupt file,
 *    and a summary would misreport real history as "no track record".
 *  - "tampered" — structurally valid data whose hash chain no longer
 *    verifies. The data stays loaded so `verifyChain` can pinpoint the exact
 *    break; summaries/trust surface it per-skill as integrity=BROKEN /
 *    integrity-error. Appending on top of a broken chain is still refused.
 */
function trackStoreIssue(store: SkillTrackRecordStore): { kind: "unreadable" | "tampered"; error: string } | null {
  const res = store.load();
  if (res.ok) return null;
  const kind = store.summaries().length > 0 ? "tampered" : "unreadable";
  return { kind, error: res.error ?? "unknown load failure" };
}

/** `.md` skill names (basename minus extension) visible in the skills dir, sorted. */
function discoverSkillNames(ctx: Ctx): string[] {
  if (!ctx.fs.exists(ctx.dir)) return [];
  return ctx.fs
    .readDir(ctx.dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.slice(0, -3))
    .sort();
}

function formatTrackSummaryLine(s: SkillTrackSummary, chainOk: boolean): string {
  return (
    `${s.skillName}  n=${s.n} verifiedN=${s.verifiedN} ` +
    `successRate=${fmt(s.successRate)} recentSuccessRate=${fmt(s.recentSuccessRate)} ` +
    `brier=${fmt(s.brier)} recentBrier=${fmt(s.recentBrier)} wilsonLower=${fmt(s.wilsonLower)} ` +
    `window=${s.window} lastAt=${s.lastAt} integrity=${chainOk ? "ok" : "BROKEN"}`
  );
}

function closeEnough(a: number, b: number): boolean {
  if (Number.isNaN(a) && Number.isNaN(b)) return true;
  return Math.abs(a - b) < 1e-9;
}

/**
 * Structural invariant check: independently recompute a skill's summary
 * metrics straight from its raw ledger entries using the exported pure
 * `brierScore`/`wilsonLowerBound` functions, and require them to agree
 * with what `SkillTrackRecordStore.summary()` reports. This can only ever
 * diverge if the store's own accounting is wrong — it is a second,
 * independent call path over the same real math, not a mock, and it keeps
 * this command from ever printing (or feeding into a trust decision) a
 * number nothing in the real engine actually computed.
 */
function metricsAgreeWithStore(store: SkillTrackRecordStore, name: string, summary: SkillTrackSummary): boolean {
  const entries = store.entries(name);
  const recent = entries.slice(-summary.window);
  const recentSuccesses = recent.reduce((acc, e) => acc + (e.success ? 1 : 0), 0);
  return (
    closeEnough(brierScore(entries), summary.brier) &&
    closeEnough(brierScore(recent), summary.recentBrier) &&
    closeEnough(wilsonLowerBound(recentSuccesses, recent.length), summary.wilsonLower)
  );
}

/**
 * Fold a skill's full outcome history through `applyOutcomeToStreak` to get
 * its *current* consecutive-verified-success streak. Recomputed fresh from
 * the ledger on every `trust` run (rather than trusting a persisted
 * counter) so the streak a trust decision is based on can never drift from
 * the actual recorded history.
 */
function computeStreak(entries: readonly TrackRecordEntry[]): number {
  let state: SkillTrustState = { skillName: "", status: "active", since: 0, streak: 0, reasons: [] };
  for (const e of entries) {
    state = applyOutcomeToStreak(state, { success: e.success, verified: e.certSha256 !== undefined });
  }
  return state.streak;
}

function validatePolicy(parsed: unknown): { ok: true; policy: SkillTrustPolicy } | { ok: false; error: string } {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: "policy file must contain a JSON object." };
  }
  const p = parsed as Record<string, unknown>;
  const numericFields: Array<keyof SkillTrustPolicy> = [
    "minSamples",
    "demoteBelowWilson",
    "probationBelowWilson",
    "brierCeiling",
    "recoverAboveWilson",
    "recoveryStreak",
    "hysteresis",
  ];
  for (const field of numericFields) {
    const v = p[field];
    if (typeof v !== "number" || !Number.isFinite(v)) {
      return { ok: false, error: `field "${field}" must be a finite number.` };
    }
  }
  const policy: SkillTrustPolicy = {
    minSamples: p.minSamples as number,
    demoteBelowWilson: p.demoteBelowWilson as number,
    probationBelowWilson: p.probationBelowWilson as number,
    brierCeiling: p.brierCeiling as number,
    recoverAboveWilson: p.recoverAboveWilson as number,
    recoveryStreak: p.recoveryStreak as number,
    hysteresis: p.hysteresis as number,
  };
  if (!Number.isInteger(policy.minSamples) || policy.minSamples < 0) {
    return { ok: false, error: "minSamples must be a non-negative integer." };
  }
  if (!Number.isInteger(policy.recoveryStreak) || policy.recoveryStreak < 0) {
    return { ok: false, error: "recoveryStreak must be a non-negative integer." };
  }
  return { ok: true, policy };
}

// ---------------------------------------------------------------------------
// synth
// ---------------------------------------------------------------------------

async function cmdSynth(rest: string[], ctx: Ctx): Promise<SkillEvolveResult> {
  const file = rest[0];
  if (!file) return fail1("Usage: hades skill synth <trajectory.json>");

  const raw = ctx.fs.readFile(file);
  if (raw === null) return fail1(`Trajectory file not found: ${file}`);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return fail1(`Malformed JSON in trajectory file ${file}: ${errMsg(err)}`);
  }

  const sources = (Array.isArray(parsed) ? parsed : [parsed]) as VerifiedTrajectory[];
  if (sources.length === 0) {
    return fail1(`Trajectory file ${file} contains no trajectory sources.`);
  }

  // Verify the primary (first) source directly so a rejected trajectory
  // reports its exact rejection code and — critically — the skills dir is
  // never touched before this check has passed.
  const primaryVerdict = await verifyTrajectoryForSynthesis(sources[0]);
  if (!primaryVerdict.ok) {
    return {
      code: 1,
      lines: [`Rejected: ${primaryVerdict.rejection.code}`, primaryVerdict.rejection.detail],
    };
  }

  const result = await synthesizeSkill(sources, { now: ctx.now() });
  if (!result.ok || !result.manifest || !result.content || !result.provenance) {
    const lines = ["Synthesis rejected:"];
    for (const r of result.rejections) lines.push(`  [${r.code}] ${r.detail}`);
    if (result.rejections.length === 0) lines.push("  synthesis produced no usable output.");
    return { code: 1, lines };
  }

  // Self-check: the provenance we are about to persist must extract back
  // out of the content we are about to write. Never persist a skill whose
  // own provenance fence we could not re-verify.
  const roundTripProvenance = extractProvenance(result.manifest.instructions);
  if (!roundTripProvenance || roundTripProvenance.certSha256 !== result.provenance.certSha256) {
    return {
      code: 1,
      lines: ["Synthesis produced content whose embedded provenance failed to round-trip; refusing to write."],
    };
  }

  const target = join(ctx.dir, `${result.manifest.name}.md`);

  // Preflight: prove the exact bytes about to be persisted load cleanly
  // through the same SkillLibrary any worker will use, before they ever
  // touch disk.
  const preflight = new SkillLibrary();
  const preflightReport = preflight.loadFiles([{ path: target, content: result.content }]);
  if (preflightReport.errors.length > 0 || !preflight.get(result.manifest.name)) {
    return {
      code: 1,
      lines: [
        "Synthesized SKILL.md failed a SkillLibrary preflight load; refusing to write.",
        ...preflightReport.errors.map((e) => `  ${e.path}: ${e.error}`),
      ],
    };
  }

  ctx.fs.mkdirp(ctx.dir);
  ctx.fs.writeFile(target, result.content);

  const p = result.provenance;
  const lines = [
    `Synthesized skill "${result.manifest.name}" -> ${target}`,
    `provenance: cert=${p.certSha256} goal=${p.trajectoryGoalId} pCorrect=${fmt(p.pCorrect)} epsilon=${fmt(
      p.epsilon
    )} sources=${p.sourceCount} synthesizedAt=${p.synthesizedAt}`,
    `objective: ${p.objective}`,
  ];
  if (result.rejections.length > 0) {
    lines.push(`${result.rejections.length} source(s) rejected:`);
    for (const r of result.rejections) lines.push(`  [${r.code}] ${r.detail}`);
  }
  return { code: 0, lines };
}

// ---------------------------------------------------------------------------
// refine
// ---------------------------------------------------------------------------

async function cmdRefine(rest: string[], ctx: Ctx): Promise<SkillEvolveResult> {
  const [skillName, useFile] = rest;
  if (!skillName || !useFile) return fail1("Usage: hades skill refine <skill> <use.json>");

  const target = join(ctx.dir, `${skillName}.md`);
  const current = ctx.fs.readFile(target);
  if (current === null) return fail1(`No skill named "${skillName}" in ${ctx.dir}.`);

  try {
    const parsedCurrent = parseSkillFile(current);
    if (parsedCurrent.manifest.name !== skillName) {
      return fail1(
        `Skill file ${target} declares name "${parsedCurrent.manifest.name}", which does not match requested skill "${skillName}".`
      );
    }
  } catch (err) {
    return fail1(`Skill file ${target} is not a valid SKILL.md: ${errMsg(err)}`);
  }

  const raw = ctx.fs.readFile(useFile);
  if (raw === null) return fail1(`Use file not found: ${useFile}`);

  let parsedUse: unknown;
  try {
    parsedUse = JSON.parse(raw);
  } catch (err) {
    return fail1(`Malformed JSON in use file ${useFile}: ${errMsg(err)}`);
  }

  const uses = (Array.isArray(parsedUse) ? parsedUse : [parsedUse]) as VerifiedUse[];
  if (uses.length === 0) return fail1(`Use file ${useFile} contains no verified uses.`);

  const result = await refineSkill(current, uses, { now: ctx.now() });

  if (!result.ok) {
    return { code: 1, lines: ["Refinement rejected:", ...result.rejected.map((r) => `  ${r.reason}`)] };
  }

  if (!result.changed || !result.content) {
    const lines = ["no changes"];
    if (result.rejected.length > 0) {
      lines.push(`${result.rejected.length} use(s) contributed nothing:`);
      for (const r of result.rejected) lines.push(`  ${r.reason}`);
    }
    return { code: 0, lines };
  }

  ctx.fs.mkdirp(ctx.dir);
  ctx.fs.writeFile(target, result.content);

  const lines = [`Refined skill "${skillName}" -> ${target}`, "", "Changelog:", ...result.changelog.split("\n")];
  if (result.rejected.length > 0) {
    lines.push("", `${result.rejected.length} use(s) contributed nothing:`);
    for (const r of result.rejected) lines.push(`  ${r.reason}`);
  }
  return { code: 0, lines };
}

// ---------------------------------------------------------------------------
// track
// ---------------------------------------------------------------------------

function renderAllTrackSummaries(ctx: Ctx): SkillEvolveResult {
  const store = openTrackStore(ctx);
  const issue = trackStoreIssue(store);
  if (issue?.kind === "unreadable") {
    return fail1(`Track-record store is unreadable (${issue.error}); refusing to report history as empty.`);
  }
  const trackedNames = new Set(store.summaries().map((s) => s.skillName));
  const discovered = discoverSkillNames(ctx);
  const allNames = [...new Set([...discovered, ...trackedNames])].sort();

  if (allNames.length === 0) {
    return { code: 0, lines: ["No skills found and no track records recorded."] };
  }

  const lines: string[] = [];
  for (const name of allNames) {
    const summary = store.summary(name);
    if (!summary) {
      lines.push(`${name}  (no track record)`);
      continue;
    }
    lines.push(formatTrackSummaryLine(summary, store.verifyChain(name).ok));
  }
  return { code: 0, lines };
}

function renderOneTrackSummary(ctx: Ctx, skillName: string): SkillEvolveResult {
  const store = openTrackStore(ctx);
  const issue = trackStoreIssue(store);
  if (issue?.kind === "unreadable") {
    return fail1(`Track-record store is unreadable (${issue.error}); refusing to report history as empty.`);
  }
  const summary = store.summary(skillName);
  if (!summary) return fail1(`No track record for skill "${skillName}".`);
  return { code: 0, lines: [formatTrackSummaryLine(summary, store.verifyChain(skillName).ok)] };
}

function cmdTrack(rest: string[], ctx: Ctx): SkillEvolveResult {
  if (rest.length === 0) return renderAllTrackSummaries(ctx);

  const [skillName, ...flagArgs] = rest;
  if (skillName.startsWith("--")) {
    return fail1(
      "Usage: hades skill track [skill] | hades skill track <skill> --p <0..1> --success|--failure [--cert <sha256>]"
    );
  }
  if (flagArgs.length === 0) return renderOneTrackSummary(ctx, skillName);

  let p: number | undefined;
  let success: boolean | undefined;
  let cert: string | undefined;
  const unknown: string[] = [];

  for (let i = 0; i < flagArgs.length; i++) {
    const a = flagArgs[i];
    if (a === "--p") {
      const v = flagArgs[++i];
      if (v === undefined) return fail1("--p requires a value in [0,1].");
      p = Number(v);
    } else if (a === "--success") {
      if (success !== undefined) return fail1("Specify only one of --success or --failure.");
      success = true;
    } else if (a === "--failure") {
      if (success !== undefined) return fail1("Specify only one of --success or --failure.");
      success = false;
    } else if (a === "--cert") {
      const v = flagArgs[++i];
      if (v === undefined || v.trim() === "") return fail1("--cert requires a value.");
      cert = v;
    } else {
      unknown.push(a);
    }
  }

  if (unknown.length > 0) return fail1(`Unknown flag(s): ${unknown.join(", ")}`);
  if (p === undefined || !Number.isFinite(p)) {
    return fail1("Missing or invalid --p <0..1> (a finite number is required).");
  }
  if (p < 0 || p > 1) return fail1(`--p must be within [0,1], got ${p}.`);
  if (success === undefined) return fail1("Specify exactly one of --success or --failure.");

  const store = openTrackStore(ctx);
  const issue = trackStoreIssue(store);
  if (issue) {
    // Never append to (or atomically overwrite) a store whose persisted bytes
    // failed integrity — recording onto an unreadable envelope would destroy
    // whatever history the corrupt file still holds, and recording onto a
    // tampered chain would bury the break under fresh entries.
    return fail1(`Track-record store failed integrity (${issue.kind}: ${issue.error}); refusing to append.`);
  }
  try {
    store.record({
      skillName,
      predictedP: p,
      success,
      at: ctx.now(),
      ...(cert !== undefined ? { certSha256: cert } : {}),
    });
  } catch (err) {
    if (err instanceof TrackRecordValidationError) {
      return fail1(`Could not record outcome: ${err.message}`);
    }
    throw err;
  }

  const summary = store.summary(skillName);
  if (!summary) {
    // Unreachable in practice — record() above always creates one entry —
    // kept as an honest failure rather than a non-null assertion.
    return fail1(`Recorded outcome for "${skillName}" but no summary is available.`);
  }

  return {
    code: 0,
    lines: [
      `Recorded ${skillName}: success=${success} predictedP=${fmt(p)}${cert !== undefined ? ` cert=${cert}` : ""}`,
      formatTrackSummaryLine(summary, store.verifyChain(skillName).ok),
    ],
  };
}

// ---------------------------------------------------------------------------
// trust
// ---------------------------------------------------------------------------

async function cmdTrust(rest: string[], ctx: Ctx): Promise<SkillEvolveResult> {
  let policyFile: string | undefined;
  const unknown: string[] = [];

  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--policy-file") {
      const v = rest[++i];
      if (v === undefined) return fail1("--policy-file requires a value.");
      policyFile = v;
    } else {
      unknown.push(a);
    }
  }
  if (unknown.length > 0) return fail1(`Unknown flag(s): ${unknown.join(", ")}`);

  let policy = defaultSkillTrustPolicy();
  if (policyFile !== undefined) {
    const raw = ctx.fs.readFile(policyFile);
    if (raw === null) return fail1(`Policy file not found: ${policyFile}`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      return fail1(`Malformed JSON in policy file ${policyFile}: ${errMsg(err)}`);
    }
    const validated = validatePolicy(parsed);
    if (!validated.ok) return fail1(`Invalid trust policy in ${policyFile}: ${validated.error}`);
    policy = validated.policy;
  }

  const store = openTrackStore(ctx);
  const issue = trackStoreIssue(store);
  if (issue?.kind === "unreadable") {
    // A tampered-but-parseable chain falls through to the per-skill
    // integrity-error reporting below (which pinpoints the exact seq); an
    // unreadable envelope has nothing per-skill to report against, so
    // refusing outright is the only honest option.
    return fail1(`Track-record store is unreadable (${issue.error}); refusing to evaluate trust over an empty view.`);
  }
  const trackedNames = store.summaries().map((s) => s.skillName);
  const discovered = discoverSkillNames(ctx);
  const allNames = [...new Set([...discovered, ...trackedNames])].sort();

  const trustPath = trustStatePath(ctx);
  const rawTrust = ctx.fs.readFile(trustPath);
  let states = new Map<string, SkillTrustState>();
  if (rawTrust !== null) {
    const parsedTrust = parseTrustStates(rawTrust);
    if (!parsedTrust.ok) {
      return fail1(`Corrupt trust-state store ${trustPath}: ${parsedTrust.error}`);
    }
    states = parsedTrust.states;
  }

  if (allNames.length === 0) {
    return { code: 0, lines: ["No skills found and no track records to evaluate."] };
  }

  const lines: string[] = [];
  let anyIntegrityFailure = false;
  const now = ctx.now();

  for (const name of allNames) {
    const summary = store.summary(name);
    if (!summary) {
      lines.push(`${name} status=unscored — no track record.`);
      continue;
    }

    const chainCheck = store.verifyChain(name);
    if (!chainCheck.ok) {
      anyIntegrityFailure = true;
      lines.push(
        `${name} status=integrity-error — hash chain verification failed at seq=${
          chainCheck.brokenAt?.seq ?? "?"
        }; refusing to score as healthy.`
      );
      continue;
    }

    if (!metricsAgreeWithStore(store, name, summary)) {
      anyIntegrityFailure = true;
      lines.push(
        `${name} status=integrity-error — recomputed brier/wilson metrics diverge from the stored summary; refusing to score as healthy.`
      );
      continue;
    }

    const streak = computeStreak(store.entries(name));
    const previous = states.get(name);
    const baseState: SkillTrustState = previous
      ? { ...previous, streak }
      : { skillName: name, status: "active", since: now, streak, reasons: [] };

    const { state: nextState, decision } = evaluateSkillTrust(baseState, summary, policy, now);
    states.set(name, nextState);

    const marker = decision.changed ? " [changed]" : "";
    const reasonsText = decision.reasons.length > 0 ? decision.reasons.join(" | ") : "(no policy thresholds triggered)";
    lines.push(
      `${name} status=${nextState.status} wilson=${fmt(summary.wilsonLower)} brier=${fmt(
        summary.recentBrier
      )}${marker} — ${reasonsText}`
    );
  }

  ctx.fs.mkdirp(ctx.dataDir);
  ctx.fs.writeFile(trustPath, serializeTrustStates(states));

  return { code: anyIntegrityFailure ? 1 : 0, lines };
}

// ---------------------------------------------------------------------------
// trust show — read-only effective-trust report (SkillTrustReader, no writes)
// ---------------------------------------------------------------------------

/**
 * `hades skill trust show` — the READ side of the trust lifecycle: report the
 * effective (fail-closed) trust status of every visible skill via the real
 * {@link SkillTrustReader}, without re-evaluating or persisting anything.
 * `hades skill trust` (no `show`) remains the write side that runs the
 * demotion policy and persists decisions.
 */
function cmdTrustShow(rest: string[], ctx: Ctx): SkillEvolveResult {
  if (rest.length > 0) return fail1(`Unknown flag(s) for trust show: ${rest.join(", ")}`);

  const reader = new SkillTrustReader({
    dataDir: ctx.dataDir,
    fs: { readFile: (p: string) => ctx.fs.readFile(p) },
  });
  const names = [...new Set([...discoverSkillNames(ctx), ...reader.allKnown()])].sort();
  if (names.length === 0) {
    // Fail-closed even with nothing enumerable: a globally corrupt store
    // enumerates no names, and "no skills found" would misreport corruption
    // as absence.
    const globalErrors = reader.globalIntegrityErrors();
    if (globalErrors.length > 0) {
      return { code: 1, lines: globalErrors.map((e) => `integrity-error: ${e}`) };
    }
    return { code: 0, lines: ["No skills found and no trust or track records to report."] };
  }

  const lines: string[] = [];
  let anyIntegrityError = false;
  for (const row of reader.rows(names)) {
    if (row.status === "integrity-error") anyIntegrityError = true;
    const wilson = row.wilsonLower === null ? "-" : fmt(row.wilsonLower);
    const brier = row.recentBrier === null ? "-" : fmt(row.recentBrier);
    lines.push(
      `${row.skillName} status=${row.status} wilson=${wilson} brier=${brier} n=${row.n} verifiedN=${row.verifiedN}` +
        `${row.since !== null ? ` since=${row.since}` : ""} streak=${row.streak}`
    );
    for (const reason of row.reasons) lines.push(`  - ${reason}`);
  }
  return { code: anyIntegrityError ? 1 : 0, lines };
}

// ---------------------------------------------------------------------------
// track-batch — gate-verdict -> track-record machine path (GateTrackRecorder)
// ---------------------------------------------------------------------------

/** Skip reasons that indicate an error (vs. a normal, expected skip). */
const ERRORISH_SKIPS: ReadonlySet<SkipReason> = new Set<SkipReason>([
  "invalid-use",
  "invalid-p",
  "store-integrity",
]);

/**
 * `hades skill track-batch <uses.json>` — record a batch of already-gated,
 * skill-attributed verdicts (`GatedSkillUse` or a JSON array of them, e.g.
 * exported from a swarm run's verification log) into the hash-chained track
 * record via the real {@link GateTrackRecorder}: abstentions are surfaced
 * (never recorded as outcomes), duplicate certificates are idempotent, and
 * nothing is ever appended onto a store that fails integrity.
 */
function cmdTrackBatch(rest: string[], ctx: Ctx): SkillEvolveResult {
  const file = rest[0];
  if (!file) return fail1("Usage: hades skill track-batch <uses.json>");
  if (rest.length > 1) return fail1(`Unknown argument(s): ${rest.slice(1).join(", ")}`);

  const raw = ctx.fs.readFile(file);
  if (raw === null) return fail1(`Uses file not found: ${file}`);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return fail1(`Malformed JSON in uses file ${file}: ${errMsg(err)}`);
  }

  const uses = (Array.isArray(parsed) ? parsed : [parsed]) as GatedSkillUse[];
  if (uses.length === 0) return fail1(`Uses file ${file} contains no gated uses.`);

  const store = openTrackStore(ctx);
  const recorder = new GateTrackRecorder({ store });
  const report = recorder.recordAll(uses);

  const lines: string[] = [
    `Recorded ${report.recorded.length} outcome(s), skipped ${report.skipped.length}.`,
  ];
  for (const r of report.recorded) {
    lines.push(`  + ${r.skillName}${r.certSha256 !== undefined ? ` cert=${r.certSha256}` : ""}`);
  }
  for (const s of report.skipped) {
    lines.push(`  - ${s.skillName || "(no skill)"} [${s.reason}] ${s.detail}`);
  }

  // Fresh summaries for every skill actually written, straight from the store.
  const touched = [...new Set(report.recorded.map((r) => r.skillName))].sort();
  for (const name of touched) {
    const summary = store.summary(name);
    if (summary) lines.push(formatTrackSummaryLine(summary, store.verifyChain(name).ok));
  }

  const anyError = report.skipped.some((s) => ERRORISH_SKIPS.has(s.reason));
  return { code: anyError ? 1 : 0, lines };
}

// ---------------------------------------------------------------------------
// holdout — paired candidate-vs-incumbent exit gate over recorded real runs
// ---------------------------------------------------------------------------

interface HoldoutFlags {
  candidate?: string;
  suite?: string;
  results?: string;
  incumbentResults?: string;
  minCases?: number;
  minLift?: number;
  minWilson?: number;
  includeUnverified: boolean;
  apply: boolean;
}

function parseHoldoutFlags(args: string[]): { ok: true; flags: HoldoutFlags } | { ok: false; error: string } {
  const flags: HoldoutFlags = { includeUnverified: false, apply: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const nextValue = (): string | undefined => {
      const v = args[++i];
      return v === undefined || v.startsWith("--") ? undefined : v;
    };
    if (a === "--candidate") {
      const v = nextValue();
      if (v === undefined) return { ok: false, error: "--candidate requires a path." };
      flags.candidate = v;
    } else if (a === "--suite") {
      const v = nextValue();
      if (v === undefined) return { ok: false, error: "--suite requires a path." };
      flags.suite = v;
    } else if (a === "--results") {
      const v = nextValue();
      if (v === undefined) return { ok: false, error: "--results requires a path." };
      flags.results = v;
    } else if (a === "--incumbent-results") {
      const v = nextValue();
      if (v === undefined) return { ok: false, error: "--incumbent-results requires a path." };
      flags.incumbentResults = v;
    } else if (a === "--min-cases") {
      const v = Number(nextValue());
      if (!Number.isInteger(v) || v < 1) return { ok: false, error: "--min-cases must be a positive integer." };
      flags.minCases = v;
    } else if (a === "--min-lift") {
      const v = Number(nextValue());
      if (!Number.isFinite(v)) return { ok: false, error: "--min-lift must be a finite number." };
      flags.minLift = v;
    } else if (a === "--min-wilson") {
      const v = Number(nextValue());
      if (!Number.isFinite(v)) return { ok: false, error: "--min-wilson must be a finite number." };
      flags.minWilson = v;
    } else if (a === "--include-unverified") {
      flags.includeUnverified = true;
    } else if (a === "--apply") {
      flags.apply = true;
    } else {
      return { ok: false, error: `Unknown flag: ${a}` };
    }
  }
  return { ok: true, flags };
}

function parseJsonArrayFile<T>(
  ctx: Ctx,
  path: string,
  label: string
): { ok: true; items: T[] } | { ok: false; error: string } {
  const raw = ctx.fs.readFile(path);
  if (raw === null) return { ok: false, error: `${label} file not found: ${path}` };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, error: `Malformed JSON in ${label} file ${path}: ${errMsg(err)}` };
  }
  const items = Array.isArray(parsed) ? parsed : [parsed];
  return { ok: true, items: items as T[] };
}

function validateSuite(items: unknown[]): { ok: true; suite: HoldoutCase[] } | { ok: false; error: string } {
  const suite: HoldoutCase[] = [];
  for (const [i, item] of items.entries()) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      return { ok: false, error: `suite entry ${i} is not an object.` };
    }
    const c = item as Record<string, unknown>;
    if (typeof c.id !== "string" || c.id.length === 0) {
      return { ok: false, error: `suite entry ${i} is missing a non-empty string "id".` };
    }
    if (typeof c.objective !== "string" || c.objective.length === 0) {
      return { ok: false, error: `suite entry ${i} ("${c.id}") is missing a non-empty string "objective".` };
    }
    suite.push({ id: c.id, objective: c.objective, ...(c.input !== undefined ? { input: c.input } : {}) });
  }
  return { ok: true, suite };
}

function validateResults(
  items: unknown[],
  label: string
): { ok: true; byCase: Map<string, HoldoutRunResult> } | { ok: false; error: string } {
  const byCase = new Map<string, HoldoutRunResult>();
  for (const [i, item] of items.entries()) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      return { ok: false, error: `${label} entry ${i} is not an object.` };
    }
    const r = item as Record<string, unknown>;
    if (typeof r.caseId !== "string" || r.caseId.length === 0) {
      return { ok: false, error: `${label} entry ${i} is missing a non-empty string "caseId".` };
    }
    if (typeof r.success !== "boolean") {
      return { ok: false, error: `${label} entry ${i} ("${r.caseId}") must have a boolean "success".` };
    }
    if (typeof r.verified !== "boolean") {
      return { ok: false, error: `${label} entry ${i} ("${r.caseId}") must have a boolean "verified".` };
    }
    if (typeof r.predictedP !== "number") {
      return { ok: false, error: `${label} entry ${i} ("${r.caseId}") must have a numeric "predictedP".` };
    }
    if (r.certSha256 !== undefined && (typeof r.certSha256 !== "string" || r.certSha256.length === 0)) {
      return { ok: false, error: `${label} entry ${i} ("${r.caseId}"): "certSha256", when present, must be a non-empty string.` };
    }
    if (r.detail !== undefined && typeof r.detail !== "string") {
      return { ok: false, error: `${label} entry ${i} ("${r.caseId}"): "detail", when present, must be a string.` };
    }
    if (byCase.has(r.caseId)) {
      return { ok: false, error: `${label} contains two results for case "${r.caseId}"; recorded evidence must be unambiguous.` };
    }
    byCase.set(r.caseId, {
      caseId: r.caseId,
      success: r.success,
      verified: r.verified,
      predictedP: r.predictedP,
      ...(r.certSha256 !== undefined ? { certSha256: r.certSha256 as string } : {}),
      ...(r.detail !== undefined ? { detail: r.detail as string } : {}),
    });
  }
  return { ok: true, byCase };
}

function formatArmStats(label: string, stats: { n: number; successes: number; verifiedSuccesses: number; wilsonLower: number; brier: number }): string {
  return (
    `${label}: n=${stats.n} successes=${stats.successes} verifiedSuccesses=${stats.verifiedSuccesses} ` +
    `wilsonLower=${fmt(stats.wilsonLower)} brier=${fmt(stats.brier)}`
  );
}

/**
 * `hades skill holdout <skill> --candidate <candidate.md> --suite <suite.json>
 *   --results <candidate-results.json> [--incumbent-results <file>] [--apply]`
 *
 * The Phase-10 exit gate, driven from recorded evidence: the suite and the
 * per-arm results files come from REAL runs (the same discipline as
 * `skill synth <trajectory.json>` / `skill refine <use.json>` — this CLI
 * replays recorded outcomes through the real `runHoldoutValidation` engine,
 * it never invents one). A case with no recorded result for its arm is
 * counted by the engine as a thrown/failed case and excluded from usable n —
 * missing evidence weakens the candidate, it never helps it. With `--apply`,
 * the decision is applied atomically via `applyHoldoutDecision` (accept
 * writes the candidate; rollback restores the incumbent bytes the incumbent
 * arm was actually scored against; abstain writes nothing).
 */
async function cmdHoldout(rest: string[], ctx: Ctx): Promise<SkillEvolveResult> {
  const [skillName, ...flagArgs] = rest;
  if (!skillName || skillName.startsWith("--")) {
    return fail1(
      "Usage: hades skill holdout <skill> --candidate <candidate.md> --suite <suite.json> --results <candidate-results.json> [--incumbent-results <file>] [--min-cases <n>] [--min-lift <x>] [--min-wilson <x>] [--include-unverified] [--apply]"
    );
  }
  const parsedFlags = parseHoldoutFlags(flagArgs);
  if (!parsedFlags.ok) return fail1(parsedFlags.error);
  const flags = parsedFlags.flags;
  if (!flags.candidate) return fail1("--candidate <candidate.md> is required.");
  if (!flags.suite) return fail1("--suite <suite.json> is required.");
  if (!flags.results) return fail1("--results <candidate-results.json> is required.");

  const candidateContent = ctx.fs.readFile(flags.candidate);
  if (candidateContent === null) return fail1(`Candidate file not found: ${flags.candidate}`);

  const skillPath = join(ctx.dir, `${skillName}.md`);
  const incumbentContent = ctx.fs.readFile(skillPath);

  if (incumbentContent !== null && candidateContent === incumbentContent) {
    return fail1(
      `Candidate ${flags.candidate} is byte-identical to the installed skill ${skillPath}; there is nothing to decide.`
    );
  }
  if (incumbentContent !== null && !flags.incumbentResults) {
    return fail1(
      `Skill "${skillName}" already exists at ${skillPath}: a paired comparison needs --incumbent-results <file> with the incumbent arm's recorded runs over the same suite.`
    );
  }

  const suiteRead = parseJsonArrayFile<unknown>(ctx, flags.suite, "suite");
  if (!suiteRead.ok) return fail1(suiteRead.error);
  const suiteChecked = validateSuite(suiteRead.items);
  if (!suiteChecked.ok) return fail1(suiteChecked.error);

  const candidateRead = parseJsonArrayFile<unknown>(ctx, flags.results, "candidate results");
  if (!candidateRead.ok) return fail1(candidateRead.error);
  const candidateResults = validateResults(candidateRead.items, "candidate results");
  if (!candidateResults.ok) return fail1(candidateResults.error);

  let incumbentResults: Map<string, HoldoutRunResult> | null = null;
  if (incumbentContent !== null && flags.incumbentResults) {
    const incumbentRead = parseJsonArrayFile<unknown>(ctx, flags.incumbentResults, "incumbent results");
    if (!incumbentRead.ok) return fail1(incumbentRead.error);
    const checked = validateResults(incumbentRead.items, "incumbent results");
    if (!checked.ok) return fail1(checked.error);
    incumbentResults = checked.byCase;
  }

  // Replay runner: each arm's recorded results, keyed by case id. A case
  // with no recorded result THROWS — runHoldoutValidation counts that as a
  // failure and excludes it from usable n, so missing evidence can only ever
  // hurt an arm, never help it.
  const runner: HoldoutRunner = async (skillContent, c) => {
    const arm = skillContent === candidateContent ? "candidate" : "incumbent";
    const table = arm === "candidate" ? candidateResults.byCase : incumbentResults;
    const result = table?.get(c.id);
    if (!result) throw new Error(`no recorded ${arm} result for case "${c.id}"`);
    return result;
  };

  const decision = await runHoldoutValidation(candidateContent, incumbentContent, suiteChecked.suite, runner, {
    ...(flags.minCases !== undefined ? { minCases: flags.minCases } : {}),
    ...(flags.minLift !== undefined ? { minLift: flags.minLift } : {}),
    ...(flags.minWilson !== undefined ? { minAbsoluteWilson: flags.minWilson } : {}),
    requireVerified: !flags.includeUnverified,
    now: ctx.now,
  });

  const lines: string[] = [
    `Holdout verdict for "${skillName}": ${decision.verdict}`,
    formatArmStats("candidate", decision.candidate),
  ];
  if (decision.incumbent) lines.push(formatArmStats("incumbent", decision.incumbent));
  else lines.push("incumbent: (none installed)");
  lines.push(
    `thresholds: minCases=${decision.minCases} minLift=${fmt(decision.minLift)} minAbsoluteWilson=${fmt(decision.minAbsoluteWilson)} requireVerified=${!flags.includeUnverified}`
  );
  for (const reason of decision.reasons) lines.push(`  - ${reason}`);

  if (flags.apply) {
    const applied = applyHoldoutDecision(decision, {
      skillPath,
      candidateContent,
      incumbentContent,
      fs: {
        readFile: (p: string) => ctx.fs.readFile(p),
        writeFile: (p: string, c: string) => ctx.fs.writeFile(p, c),
        exists: (p: string) => ctx.fs.exists(p),
      },
    });
    lines.push(`applied: ${applied.applied} (${applied.path})`);
    lines.push(`  ${applied.reasons[0]}`);
  } else {
    lines.push("(dry run — pass --apply to write the decision to the skills dir)");
  }

  return { code: decision.verdict === "accept" ? 0 : 1, lines };
}

// ---------------------------------------------------------------------------
// help / dispatch
// ---------------------------------------------------------------------------

const USAGE: string[] = [
  "Usage: hades skill <synth|refine|track|track-batch|trust|holdout> ...",
  "",
  "Commands:",
  "  synth <trajectory.json>",
  "      Synthesize a new SKILL.md from a GATE-VERIFIED trajectory (or a JSON",
  "      array of trajectories). Never writes a file for a rejected trajectory.",
  "",
  "  refine <skill> <use.json>",
  "      Apply GATE-VERIFIED use(s) (a VerifiedUse, or a JSON array of them) to",
  "      an existing skill: learns caveats, may add/drop tools, bumps version.",
  "",
  "  track <skill> --p <0..1> --success|--failure [--cert <sha256>]",
  "      Record one observed outcome (a forecast + what happened) into the",
  "      skill's hash-chained track record.",
  "  track [skill]",
  "      Print calibration/reliability summaries (all skills, or just one).",
  "",
  "  trust [--policy-file <path>]",
  "      Evaluate every tracked skill's trust status (active/probation/demoted)",
  "      against its track record and persist the decision.",
  "  trust show",
  "      Read-only report of every skill's EFFECTIVE trust status (fail-closed:",
  "      corrupt stores and broken hash chains report integrity-error, never",
  "      unscored). Persists nothing.",
  "",
  "  track-batch <uses.json>",
  "      Record a batch of already-gated verdicts (GatedSkillUse JSON, or an",
  "      array) into the hash-chained track record: abstentions surfaced (never",
  "      recorded), duplicate certificates idempotent, integrity-guarded.",
  "",
  "  holdout <skill> --candidate <candidate.md> --suite <suite.json>",
  "          --results <candidate-results.json> [--incumbent-results <file>]",
  "          [--min-cases <n>] [--min-lift <x>] [--min-wilson <x>]",
  "          [--include-unverified] [--apply]",
  "      Paired holdout exit gate over recorded real runs: accept iff the",
  "      candidate's Wilson lower bound beats the incumbent's by --min-lift",
  "      (or clears --min-wilson with no incumbent); --apply writes the",
  "      accept/rollback decision atomically. Exit 0 only on accept.",
  "",
  "  help    Show this help",
  "",
  "Skills dir: $HADES_SKILLS_DIR (default <HADES_DATA_DIR|.hades>/skills).",
  "Data dir:   $HADES_DATA_DIR (default .hades) — track-record and trust state live here.",
];

export async function runSkillEvolveCommand(args: string[], opts: SkillEvolveOptions = {}): Promise<SkillEvolveResult> {
  try {
    const env = opts.env ?? process.env;
    const fs = opts.fs ?? realFs;
    const now = opts.now ?? (() => Date.now());
    const dataDir = opts.dataDir ?? env.HADES_DATA_DIR ?? ".hades";
    const dir = opts.dir ?? env.HADES_SKILLS_DIR ?? join(dataDir, "skills");
    const ctx: Ctx = { fs, now, dataDir, dir };

    const [sub, ...rest] = args;

    if (sub === undefined || sub === "help" || sub === "--help" || sub === "-h") {
      return { code: 0, lines: USAGE };
    }

    switch (sub) {
      case "synth":
        return await cmdSynth(rest, ctx);
      case "refine":
        return await cmdRefine(rest, ctx);
      case "track":
        return cmdTrack(rest, ctx);
      case "track-batch":
        return cmdTrackBatch(rest, ctx);
      case "trust":
        // `trust show` is the read-only effective-trust report; bare `trust`
        // remains the evaluate-and-persist path.
        if (rest[0] === "show") return cmdTrustShow(rest.slice(1), ctx);
        return await cmdTrust(rest, ctx);
      case "holdout":
        return await cmdHoldout(rest, ctx);
      default:
        return { code: 1, lines: USAGE };
    }
  } catch (err) {
    return { code: 1, lines: [`Unexpected error: ${errMsg(err)}`] };
  }
}
