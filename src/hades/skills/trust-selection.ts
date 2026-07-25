/**
 * trust-selection — a read-side trust layer over the persisted skill-trust
 * and skill-track stores, and a trust-aware wrapper around {@link
 * SkillLibrary.resolve}.
 *
 * This module owns no evaluation logic: it never decides whether a skill
 * *should* be demoted (that is `demotion.ts`'s job, run by `hades skill
 * trust`) and never computes calibration/reliability metrics from scratch
 * (that is `track-record.ts`'s job). What it owns is turning the two files
 * those engines already write — `<dataDir>/skill-trust.json` (via {@link
 * parseTrustStates}) and `<dataDir>/skill-track.json` (via a real {@link
 * SkillTrackRecordStore}) — into one coherent, fail-closed read: a single
 * {@link EffectiveTrustStatus} per skill, and a trust-aware view of {@link
 * SkillLibrary.resolve} that the brain's skill-binding path, `hades skill
 * list`, and the MCP skills surface can all consult without each
 * re-implementing "what does trust status X mean for selection".
 *
 * FAIL-CLOSED, BY CONSTRUCTION:
 *  - A `skill-trust.json` or `skill-track.json` that fails to parse (bad
 *    JSON, wrong envelope version, structurally malformed entries) never
 *    degrades a skill to "unscored" — "unscored" means "genuinely never
 *    evaluated", not "we couldn't tell". A corrupt file instead marks every
 *    skill it could have covered `"integrity-error"`, with the parse error
 *    recorded in `reasons`.
 *  - A skill whose hash chain fails {@link SkillTrackRecordStore.verifyChain}
 *    is `"integrity-error"` even if every *other* skill's chain in the same
 *    file is fine.
 *  - As a second, independent line of defense (the same cross-check
 *    `skill-evolve-command.ts` runs before it will ever print a trust
 *    decision), every summary this module reads is re-derived from
 *    `store.entries()` via the exported `brierScore`/`wilsonLowerBound`
 *    and compared back against `SkillTrackRecordStore.summary()`; a
 *    mismatch is treated as `"integrity-error"`, not silently trusted.
 *  - `"integrity-error"` can never be overridden by a caller. `includeDemoted`
 *    only ever restores a `"demoted"` skill to the resolved set (with the
 *    override made explicit in `deprioritized`) — it has no effect on
 *    `"integrity-error"`, which stays excluded unconditionally.
 *
 * REAL-VS-MOCK POLICY: this module imports and calls the real engines —
 * `parseTrustStates` from `./demotion`; `SkillTrackRecordStore`,
 * `brierScore`, `wilsonLowerBound` from `./track-record`; `SkillLibrary` /
 * `LoadedSkill` from `./library` — and delegates all skill resolution to
 * the real `library.resolve()`. It performs no threshold math of its own
 * (no re-implementation of the active/probation/demoted policy in
 * `demotion.ts`): every status this module reports for a skill that *does*
 * have a persisted trust decision is copied verbatim from that decision.
 * The only computation this module does itself is the integrity
 * cross-check described above (itself just re-calling the real, exported
 * `brierScore`/`wilsonLowerBound`) and the trust-driven exclude/deprioritize
 * partitioning. This module never writes a file: the injected {@link
 * TrustReaderFs} exposes only `readFile`, and the internal adapter handed
 * to `SkillTrackRecordStore` deliberately throws if its `writeFile`/`mkdirp`
 * are ever invoked (they should never be reachable, since this module never
 * calls `SkillTrackRecordStore.record()`).
 *
 * @module hades/skills/trust-selection
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parseTrustStates, type SkillTrustState } from "./demotion";
import {
  SkillTrackRecordStore,
  brierScore,
  wilsonLowerBound,
  type SkillTrackSummary,
  type TrackRecordFs,
} from "./track-record";
import { SkillLibrary, type LoadedSkill } from "./library";

// ---------------------------------------------------------------------------
// Types (locked contract)
// ---------------------------------------------------------------------------

export type EffectiveTrustStatus =
  | "active"
  | "probation"
  | "demoted"
  | "unscored"
  | "integrity-error";

export interface SkillTrustRow {
  skillName: string;
  status: EffectiveTrustStatus;
  wilsonLower: number | null;
  recentBrier: number | null;
  n: number;
  verifiedN: number;
  since: number | null;
  streak: number;
  reasons: string[];
}

export interface TrustReaderFs {
  readFile(p: string): string | null;
}

export interface TrustAwareResolution {
  skills: ReturnType<typeof SkillLibrary.prototype.resolve>["skills"];
  capabilities: string[];
  missingTools: string[];
  unknownSkills: string[];
  excluded: Array<{ name: string; status: EffectiveTrustStatus; reasons: string[] }>;
  deprioritized: Array<{ name: string; reasons: string[] }>;
  trust: SkillTrustRow[];
}

// ---------------------------------------------------------------------------
// Default (real) filesystem — ENOENT -> null, read-only.
// ---------------------------------------------------------------------------

const realFs: TrustReaderFs = {
  readFile(p: string): string | null {
    try {
      return readFileSync(p, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return null;
      throw err;
    }
  },
};

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function closeEnough(a: number, b: number): boolean {
  if (Number.isNaN(a) && Number.isNaN(b)) return true;
  return Math.abs(a - b) < 1e-9;
}

const READ_ONLY_WRITE_ERROR =
  "SkillTrustReader is read-only: refusing to write to the skill-track store.";

// ---------------------------------------------------------------------------
// SkillTrustReader
// ---------------------------------------------------------------------------

interface TrustFileParse {
  ok: boolean;
  states: Map<string, SkillTrustState>;
  error?: string;
}

/**
 * A read-only view over `<dataDir>/skill-trust.json` and
 * `<dataDir>/skill-track.json`, resolved once at construction time into a
 * per-skill {@link SkillTrustRow}. Two readers constructed over identical
 * bytes always produce deeply-equal rows (see the determinism tests) — all
 * state is computed eagerly in the constructor, nothing is re-read or
 * re-derived lazily on each call.
 */
export class SkillTrustReader {
  private readonly trustParse: TrustFileParse;
  private readonly store: SkillTrackRecordStore;
  /** True only when skill-track.json itself failed to parse/load — the
   * store was reset to empty and nothing per-skill can be trusted. A
   * hash-chain break in one skill's chain (data otherwise loaded fine)
   * does NOT set this; that is handled per-skill via `verifyChain`. */
  private readonly trackGlobalFailure: boolean;
  private readonly trackGlobalError: string | undefined;

  constructor(opts: { dataDir: string; fs?: TrustReaderFs }) {
    const fs = opts.fs ?? realFs;
    const trustPath = join(opts.dataDir, "skill-trust.json");
    const trackPath = join(opts.dataDir, "skill-track.json");

    this.trustParse = SkillTrustReader.loadTrustFile(fs, trustPath);

    const trackFsAdapter: TrackRecordFs = {
      readFile: (p: string) => fs.readFile(p),
      writeFile: () => {
        throw new Error(READ_ONLY_WRITE_ERROR);
      },
      mkdirp: () => {
        throw new Error(READ_ONLY_WRITE_ERROR);
      },
    };

    this.store = new SkillTrackRecordStore({
      path: trackPath,
      fs: trackFsAdapter,
      now: () => 0,
    });
    // The constructor above already ran `load()` once internally; call it
    // again (a second, deterministic, read-only pass over the same bytes)
    // purely to capture the {ok, error} result it does not otherwise
    // expose. This never mutates `this.store`'s already-loaded state in a
    // way that could disagree with the first pass, since both reads see
    // the same injected `fs`.
    const loadResult = this.store.load();
    this.trackGlobalFailure = !loadResult.ok && this.store.summaries().length === 0;
    this.trackGlobalError = loadResult.ok ? undefined : loadResult.error;
  }

  private static loadTrustFile(fs: TrustReaderFs, trustPath: string): TrustFileParse {
    let raw: string | null;
    try {
      raw = fs.readFile(trustPath);
    } catch (err) {
      return {
        ok: false,
        states: new Map(),
        error: `failed to read skill-trust.json: ${errMsg(err)}`,
      };
    }
    if (raw === null) {
      // No trust-state file yet: every skill is simply un-evaluated, not an
      // integrity failure.
      return { ok: true, states: new Map() };
    }
    const parsed = parseTrustStates(raw);
    if (!parsed.ok) {
      return { ok: false, states: new Map(), error: parsed.error ?? "unknown parse failure" };
    }
    return parsed;
  }

  /** The effective trust row for one skill. Never throws; always returns a row. */
  row(skillName: string): SkillTrustRow {
    const reasons: string[] = [];

    if (!this.trustParse.ok) {
      reasons.push(`skill-trust.json is corrupt: ${this.trustParse.error}`);
    }
    if (this.trackGlobalFailure) {
      reasons.push(`skill-track.json is corrupt: ${this.trackGlobalError}`);
    }

    let summary: SkillTrackSummary | null = null;
    let chainBroken = false;
    let metricsDiverge = false;

    if (!this.trackGlobalFailure) {
      const chainCheck = this.store.verifyChain(skillName);
      if (!chainCheck.ok) {
        chainBroken = true;
        reasons.push(
          `hash-chain integrity check failed for "${skillName}" at seq=${chainCheck.brokenAt?.seq ?? "?"}; refusing to score as healthy`,
        );
      } else {
        summary = this.store.summary(skillName);
        if (summary) {
          const entries = this.store.entries(skillName);
          const recent = entries.slice(-summary.window);
          const recentSuccesses = recent.reduce((acc, e) => acc + (e.success ? 1 : 0), 0);
          const agree =
            closeEnough(brierScore(entries), summary.brier) &&
            closeEnough(brierScore(recent), summary.recentBrier) &&
            closeEnough(wilsonLowerBound(recentSuccesses, recent.length), summary.wilsonLower);
          if (!agree) {
            metricsDiverge = true;
            reasons.push(
              `recomputed brier/wilson metrics diverge from the stored summary for "${skillName}"; refusing to score as healthy`,
            );
          }
        }
      }
    }

    const trustEntry = this.trustParse.ok ? this.trustParse.states.get(skillName) : undefined;
    const integrityError =
      !this.trustParse.ok || this.trackGlobalFailure || chainBroken || metricsDiverge;

    let status: EffectiveTrustStatus;
    if (integrityError) {
      status = "integrity-error";
    } else if (trustEntry) {
      status = trustEntry.status;
      if (trustEntry.reasons.length > 0) reasons.push(...trustEntry.reasons);
      if (!summary) {
        reasons.push(
          `"${skillName}" has a persisted trust status but no current track-record entries`,
        );
      }
    } else if (summary) {
      status = "unscored";
      reasons.push(
        `"${skillName}" has track-record history but no persisted trust evaluation (run \`hades skill trust\`)`,
      );
    } else {
      status = "unscored";
      reasons.push(`no track record and no persisted trust evaluation for "${skillName}"`);
    }

    return {
      skillName,
      status,
      wilsonLower: summary ? summary.wilsonLower : null,
      recentBrier: summary ? summary.recentBrier : null,
      n: summary ? summary.n : 0,
      verifiedN: summary ? summary.verifiedN : 0,
      since: trustEntry ? trustEntry.since : null,
      streak: trustEntry ? trustEntry.streak : 0,
      reasons,
    };
  }

  /** Rows for a batch of skill names, in the same order. */
  rows(names: readonly string[]): SkillTrustRow[] {
    return names.map((n) => this.row(n));
  }

  /**
   * Store-level (not per-skill) integrity problems: a corrupt
   * `skill-trust.json`, or a globally unreadable `skill-track.json`. Empty
   * when both files are readable or genuinely absent. Callers that enumerate
   * skills via {@link allKnown} must consult this too — a globally corrupt
   * store enumerates nothing, and reporting that as "no skills" would be
   * exactly the fail-open "we couldn't tell" -> "never evaluated" confusion
   * this module exists to prevent.
   */
  globalIntegrityErrors(): string[] {
    const errs: string[] = [];
    if (!this.trustParse.ok) {
      errs.push(`skill-trust.json is corrupt: ${this.trustParse.error}`);
    }
    if (this.trackGlobalFailure) {
      errs.push(`skill-track.json is corrupt: ${this.trackGlobalError}`);
    }
    return errs;
  }

  /**
   * Every skill name this reader has *any* readable data for: the union of
   * names in a parseable skill-trust.json and names with at least one
   * track-record entry in a loadable skill-track.json, sorted. A globally
   * corrupt file contributes no names here (there is nothing readable to
   * enumerate) even though `row()` will still correctly report
   * `"integrity-error"` for any name explicitly asked about.
   */
  allKnown(): string[] {
    const names = new Set<string>();
    if (this.trustParse.ok) {
      for (const name of this.trustParse.states.keys()) names.add(name);
    }
    if (!this.trackGlobalFailure) {
      for (const s of this.store.summaries()) names.add(s.skillName);
    }
    return [...names].sort();
  }
}

// ---------------------------------------------------------------------------
// resolveWithTrust
// ---------------------------------------------------------------------------

/**
 * A trust-aware wrapper around `library.resolve()`. Partitions the
 * requested `names` by their {@link SkillTrustRow.status} BEFORE calling
 * `library.resolve()`, so `capabilities`/`missingTools` never reflect a
 * skill this call excluded:
 *
 *  - `"integrity-error"` — always excluded. Never overridable.
 *  - `"demoted"` — excluded by default; included (and listed in
 *    `deprioritized` with an explicit override reason) when
 *    `opts.includeDemoted` is true.
 *  - `"probation"` — always included, and always listed in `deprioritized`
 *    (probation skills are deprioritized, never excluded).
 *  - `"active"` / `"unscored"` — included normally, no special listing.
 *
 * Names the library does not recognize flow through unchanged (they carry
 * an `"unscored"` trust row, so they are never pre-filtered) and are
 * reported via `unknownSkills`, exactly as `library.resolve()` reports
 * them today.
 */
export function resolveWithTrust(
  library: SkillLibrary,
  names: string[],
  tools: { get(name: string): unknown },
  reader: SkillTrustReader,
  opts?: { includeDemoted?: boolean },
): TrustAwareResolution {
  const includeDemoted = opts?.includeDemoted ?? false;
  const trust = reader.rows(names);
  const rowByName = new Map(trust.map((r) => [r.skillName, r]));

  const excluded: Array<{ name: string; status: EffectiveTrustStatus; reasons: string[] }> = [];
  const deprioritized: Array<{ name: string; reasons: string[] }> = [];
  const includedNames: string[] = [];

  for (const name of names) {
    const row = rowByName.get(name)!;
    if (row.status === "integrity-error") {
      excluded.push({
        name,
        status: row.status,
        reasons: [...row.reasons, `excluded from skill resolution: status=${row.status}`],
      });
      continue;
    }
    if (row.status === "demoted") {
      if (includeDemoted) {
        includedNames.push(name);
        deprioritized.push({
          name,
          reasons: [
            ...row.reasons,
            `included despite status=demoted: includeDemoted override requested`,
          ],
        });
      } else {
        excluded.push({
          name,
          status: row.status,
          reasons: [...row.reasons, `excluded from skill resolution: status=${row.status}`],
        });
      }
      continue;
    }
    includedNames.push(name);
    if (row.status === "probation") {
      deprioritized.push({
        name,
        reasons: [...row.reasons, `deprioritized: status=probation`],
      });
    }
  }

  const resolved = library.resolve(includedNames, tools);

  return {
    skills: resolved.skills,
    capabilities: resolved.capabilities,
    missingTools: resolved.missingTools,
    unknownSkills: resolved.unknownSkills,
    excluded,
    deprioritized,
    trust,
  };
}

// ---------------------------------------------------------------------------
// orderByTrust
// ---------------------------------------------------------------------------

const GROUP_ORDER: Record<EffectiveTrustStatus, number> = {
  active: 0,
  unscored: 1,
  probation: 2,
  demoted: 3,
  "integrity-error": 4,
};

/**
 * Orders a set of already-loaded skills for listing surfaces
 * (`hades skill list`, the MCP skills surface): `active` skills first,
 * sorted by `wilsonLower` descending (a skill with no track record inside
 * the `active` group — which can happen if a persisted `active` status
 * outlives its track-record entries — sorts to the bottom of that group,
 * never above a skill with real evidence); then `unscored`; then
 * `probation`; then `demoted` and `integrity-error` last. Every group other
 * than `active`'s wilson-sort is a stable, deterministic tie-break by skill
 * name. This never removes a skill from the list — listing surfaces label,
 * they do not hide (that is `resolveWithTrust`'s job).
 */
export function orderByTrust(
  loaded: LoadedSkill[],
  reader: SkillTrustReader,
): Array<{ skill: LoadedSkill; trust: SkillTrustRow }> {
  const rows = reader.rows(loaded.map((s) => s.manifest.name));
  const rowByName = new Map(rows.map((r) => [r.skillName, r]));
  const paired = loaded.map((skill) => ({
    skill,
    trust: rowByName.get(skill.manifest.name)!,
  }));

  paired.sort((a, b) => {
    const ga = GROUP_ORDER[a.trust.status];
    const gb = GROUP_ORDER[b.trust.status];
    if (ga !== gb) return ga - gb;
    if (ga === GROUP_ORDER.active) {
      const wa = a.trust.wilsonLower ?? -Infinity;
      const wb = b.trust.wilsonLower ?? -Infinity;
      if (wa !== wb) return wb - wa;
    }
    const an = a.skill.manifest.name;
    const bn = b.skill.manifest.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });

  return paired;
}
