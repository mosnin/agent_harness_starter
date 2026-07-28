/* ------------------------------------------------------------------ *
 * skill-forge-command.test.ts — `hades skill forge`, end to end.
 *
 * Everything here goes through `runSkillEvolveCommand` only. Fixtures (a
 * journal file, a holdout suite, recorded holdout results) are built the way
 * the CLI itself would consume them; no engine is called directly to help a
 * scenario along.
 *
 * The suite's spine is the PROMOTION CHAIN, because that is where the
 * difference between this product and a "distil whatever the model liked"
 * loop actually shows up on disk:
 *
 *   forge  -> writes a CANDIDATE, never the skills dir
 *   holdout-> the only thing that can install it, and only on held-out
 *             VERIFIED performance
 *
 * `forge writes a candidate that the holdout gate then REFUSES to promote`
 * and its accepting twin are the two tests that prove the gate was not
 * bypassed.
 *
 * REAL-VS-MOCK POLICY: real ed25519 / sha256 crypto via a real
 * `CertificateAuthority`. The filesystem is an in-memory double injected
 * through `SkillEvolveOptions.fs`; the clock is a counter. No network, no
 * API key. Every asserted number is either printed by the command itself or
 * independently recomputed with the real `wilsonLowerBound`.
 * ------------------------------------------------------------------ */
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";

import {
  runSkillEvolveCommand,
  type SkillEvolveFs,
  type SkillEvolveResult,
} from "../skill-evolve-command";
import {
  CertificateAuthority,
  generatePrivateKeyHex,
  sha256Hex,
  type CertificatePayload,
} from "../../styx/certificate";
import type { GoalTrajectory, TaskTrajectory, ToolEvent } from "../../research/recorder";
import { attestGateVerdict, JOURNAL_PATH_ENV, type JournaledRun } from "../../research/gate-journal";
import { canonicalTrajectoryJson } from "../../skills/synthesize";
import { parseSkillFile, validateSkillManifest } from "../../skills/skill-file";
import { wilsonLowerBound } from "../../skills/track-record";
import type { HoldoutCase, HoldoutRunResult } from "../../skills/holdout";

// ===========================================================================
// In-memory fs double (mirrors skill-evolve-command.test.ts)
// ===========================================================================

class InMemoryFs implements SkillEvolveFs {
  readonly files = new Map<string, string>();
  private readonly dirs = new Set<string>(["/"]);

  readFile(p: string): string | null {
    return this.files.has(p) ? (this.files.get(p) as string) : null;
  }
  writeFile(p: string, c: string): void {
    this.files.set(p, c);
    this.dirs.add(dirname(p));
  }
  mkdirp(d: string): void {
    this.dirs.add(d);
  }
  readDir(d: string): string[] {
    if (!this.exists(d)) return [];
    const prefix = d.endsWith("/") ? d : `${d}/`;
    const names = new Set<string>();
    for (const p of this.files.keys()) {
      if (!p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      if (rest.length > 0 && !rest.includes("/")) names.add(rest);
    }
    return [...names].sort();
  }
  exists(p: string): boolean {
    if (this.files.has(p) || this.dirs.has(p)) return true;
    const prefix = p.endsWith("/") ? p : `${p}/`;
    for (const f of this.files.keys()) {
      if (f.startsWith(prefix)) return true;
    }
    return false;
  }
}

// ===========================================================================
// Fixtures
// ===========================================================================

const ca = new CertificateAuthority(generatePrivateKeyHex((n: number) => new Uint8Array(n).fill(41)));

function tool(overrides: Partial<ToolEvent> = {}): ToolEvent {
  return { tool: "read_file", ok: true, summary: "Read the migration plan.", at: 1_000, ...overrides };
}

function task(overrides: Partial<TaskTrajectory> = {}): TaskTrajectory {
  return {
    taskId: "task-1",
    description: "Apply the migration plan",
    capability: "filesystem",
    tools: [tool(), tool({ tool: "write_file", summary: "Write the migrated schema." })],
    success: true,
    startedAt: 900,
    endedAt: 1_100,
    ...overrides,
  };
}

function goal(overrides: Partial<GoalTrajectory> = {}): GoalTrajectory {
  return {
    goalId: "goal-1",
    objective: "Migrate the staging schema",
    model: "test-model",
    tasks: [task()],
    success: true,
    startedAt: 800,
    endedAt: 1_200,
    ...overrides,
  };
}

function payloadFor(trajectory: GoalTrajectory, overrides: Partial<CertificatePayload> = {}): CertificatePayload {
  return {
    outputSha256: sha256Hex("delivered output text"),
    taskId: trajectory.tasks[0]?.taskId ?? "task-1",
    verifierTier: "T1-reference",
    ensembleScore: 0.96,
    pCorrect: 0.99,
    epsilon: 0.02,
    traceSha256: sha256Hex(canonicalTrajectoryJson(trajectory)),
    verifierVersions: ["verify.reference-recompute@1.0.0"],
    issuedAt: 1_700_000_000_000,
    ...overrides,
  };
}

const RAW = { verified: "accept", declined: "revise", refuted: "reject" } as const;

async function journalEntry(
  outcome: keyof typeof RAW,
  trajectory: GoalTrajectory = goal()
): Promise<JournaledRun> {
  return {
    trajectory,
    gate: attestGateVerdict({
      verdict: RAW[outcome],
      score: 0.94,
      reasons: ["deterministic grounding checks passed"],
      certificate: await ca.issue(payloadFor(trajectory)),
      taskId: "task-1",
      at: 1_700_000_000_500,
    }),
  };
}

// ===========================================================================
// Harness
// ===========================================================================

const DIR = "/skills";
const DATA = "/data";
const JOURNAL = "/data/journal.json";

function harness() {
  const fs = new InMemoryFs();
  let clock = 1_700_000_000_000;
  return { fs, now: () => (clock += 1) };
}

async function run(
  fs: InMemoryFs,
  args: string[],
  extra: Record<string, unknown> = {}
): Promise<SkillEvolveResult> {
  return runSkillEvolveCommand(args, { fs, dir: DIR, dataDir: DATA, env: {}, ...extra });
}

/** Everything currently installed in the skills dir. */
function installed(fs: InMemoryFs): string[] {
  return [...fs.files.keys()].filter((k) => k.startsWith(`${DIR}/`)).sort();
}

function joined(result: SkillEvolveResult): string {
  return result.lines.join("\n");
}

// ===========================================================================
// Source resolution — capture is opt-in
// ===========================================================================

describe("hades skill forge — journal resolution", () => {
  it("exits 1 naming $HADES_TRAJECTORY_JOURNAL when capture was never opted into", async () => {
    const { fs, now } = harness();
    const result = await run(fs, ["forge"], { now });

    expect(result.code).toBe(1);
    expect(joined(result)).toContain(`$${JOURNAL_PATH_ENV}`);
    expect(joined(result)).toContain("unmet requirement");
    expect(fs.files.size).toBe(0);
  });

  it("reports an env-sourced journal by VARIABLE NAME, never by value", async () => {
    const { fs, now } = harness();
    fs.writeFile("/secret/place/journal.json", JSON.stringify([await journalEntry("verified")]));

    const result = await run(fs, ["forge", "--name", "migrate-schema"], {
      now,
      env: { [JOURNAL_PATH_ENV]: "/secret/place/journal.json" },
    });

    expect(result.code).toBe(0);
    expect(result.lines[0]).toBe(`journal: $${JOURNAL_PATH_ENV}`);
    expect(joined(result)).not.toContain("/secret/place/journal.json");
  });

  it("exits 1 for a missing journal and for an empty one, without inventing a skill", async () => {
    const { fs, now } = harness();
    const missing = await run(fs, ["forge", "--from-verified", JOURNAL], { now });
    expect(missing.code).toBe(1);
    expect(joined(missing)).toContain("not found");

    fs.writeFile(JOURNAL, "[]");
    const empty = await run(fs, ["forge", "--from-verified", JOURNAL], { now });
    expect(empty.code).toBe(1);
    expect(joined(empty)).toContain("no run has been captured yet");
    expect(installed(fs)).toEqual([]);
  });

  it("surfaces a tampered journal entry instead of laundering it into a skill", async () => {
    const { fs, now } = harness();
    const refuted = await journalEntry("refuted");
    const tampered = JSON.parse(JSON.stringify(refuted)) as Record<string, unknown>;
    (tampered.gate as Record<string, unknown>).outcome = "verified";
    fs.writeFile(JOURNAL, JSON.stringify([tampered]));

    const result = await run(fs, ["forge", "--from-verified", JOURNAL], { now });

    expect(result.code).toBe(1);
    expect(joined(result)).toContain("verdict-mismatch");
    expect(installed(fs)).toEqual([]);
  });
});

// ===========================================================================
// The refusal, at the product surface
// ===========================================================================

describe("hades skill forge — refuses uncertified trajectories, loudly", () => {
  it("refuses a journal of only DECLINED and REFUTED runs and names both verdicts", async () => {
    const { fs, now } = harness();
    fs.writeFile(
      JOURNAL,
      JSON.stringify([
        await journalEntry("declined", goal({ goalId: "declined-run" })),
        await journalEntry("refuted", goal({ goalId: "refuted-run" })),
      ])
    );

    const result = await run(fs, ["forge", "--from-verified", JOURNAL], { now });
    const text = joined(result);

    expect(result.code).toBe(1);
    expect(text).toContain("[declined-by-gate] declined-run");
    expect(text).toContain("[refuted-by-gate] refuted-run");
    expect(text).toContain('"declined"');
    expect(text).toContain('"revise"');
    expect(text).toContain('"refuted"');
    expect(text).toContain('"reject"');
    expect(text).toContain("This is the intended behaviour");
    // Nothing written anywhere — not the skills dir, not the candidates dir.
    expect(fs.files.size).toBe(1);
    expect([...fs.files.keys()]).toEqual([JOURNAL]);
  });

  it("prints an honest eligible-vs-refused tally in a mixed journal", async () => {
    const { fs, now } = harness();
    fs.writeFile(
      JOURNAL,
      JSON.stringify([
        await journalEntry("declined", goal({ goalId: "d1" })),
        await journalEntry("verified", goal({ goalId: "v1" })),
        await journalEntry("refuted", goal({ goalId: "r1" })),
        await journalEntry("declined", goal({ goalId: "d2" })),
      ])
    );

    const result = await run(fs, ["forge", "--from-verified", JOURNAL, "--name", "migrate-schema"], { now });

    expect(result.code).toBe(0);
    expect(joined(result)).toContain(
      "forge: considered=4 eligible=1 used=1 refused=3 [verified=1 declined=2 refuted=1 no-verdict=0]"
    );
  });
});

// ===========================================================================
// Forging writes a CANDIDATE, never an installed skill
// ===========================================================================

describe("hades skill forge — forging is not promoting", () => {
  it("writes a valid candidate SKILL.md and leaves the skills dir untouched", async () => {
    const { fs, now } = harness();
    fs.writeFile(JOURNAL, JSON.stringify([await journalEntry("verified")]));

    const result = await run(fs, ["forge", "--from-verified", JOURNAL, "--name", "migrate-schema"], { now });

    expect(result.code).toBe(0);
    const candidatePath = `${DATA}/candidates/migrate-schema.md`;
    const content = fs.readFile(candidatePath);
    expect(content).not.toBeNull();

    const parsed = parseSkillFile(content as string);
    expect(validateSkillManifest(parsed.manifest).valid).toBe(true);
    expect(parsed.manifest.name).toBe("migrate-schema");
    expect(parsed.manifest.tools).toEqual(["read_file", "write_file"]);

    // The whole point: forging installed nothing.
    expect(installed(fs)).toEqual([]);
    const text = joined(result);
    expect(text).toContain("Forged CANDIDATE skill");
    expect(text).toContain("NOT installed");
    expect(text).toContain(`hades skill holdout migrate-schema --candidate ${candidatePath}`);
  });

  it("refuses an --out that would drop the candidate straight into the skills dir", async () => {
    const { fs, now } = harness();
    fs.writeFile(JOURNAL, JSON.stringify([await journalEntry("verified")]));

    const result = await run(
      fs,
      ["forge", "--from-verified", JOURNAL, "--name", "migrate-schema", "--out", `${DIR}/migrate-schema.md`],
      { now }
    );

    expect(result.code).toBe(1);
    expect(joined(result)).toContain("without a holdout decision");
    expect(installed(fs)).toEqual([]);
  });

  it("refuses an --out that reaches the skills dir through `..` — the guard is not lexical", async () => {
    // This walked straight through the old purely-lexical guard: the command
    // printed "NOT installed." over a skill that WAS installed and immediately
    // listed by `hades skill list`. A guard that only stops the obvious spelling
    // of a path is not a guard, and the false statement in the output is worse
    // than the missing check.
    const { fs, now } = harness();
    fs.writeFile(JOURNAL, JSON.stringify([await journalEntry("verified")]));

    const result = await run(
      fs,
      [
        "forge",
        "--from-verified",
        JOURNAL,
        "--name",
        "migrate-schema",
        "--out",
        `/candidates/..${DIR}/pwned.md`,
      ],
      { now }
    );

    expect(result.code).toBe(1);
    expect(joined(result)).toContain("without a holdout decision");
    expect(joined(result)).not.toContain("NOT installed");
    expect(installed(fs)).toEqual([]);
  });

  it("refuses a `.`-padded and multiply-nested traversal too", async () => {
    const { fs, now } = harness();
    fs.writeFile(JOURNAL, JSON.stringify([await journalEntry("verified")]));
    for (const out of [`/a/b/c/../../..${DIR}/x.md`, `/./${DIR.slice(1)}/./y.md`, `${DIR}/../skills/z.md`]) {
      const result = await run(
        fs,
        ["forge", "--from-verified", JOURNAL, "--name", "migrate-schema", "--out", out],
        { now }
      );
      expect(result.code).toBe(1);
      expect(joined(result)).toContain("without a holdout decision");
    }
    expect(installed(fs)).toEqual([]);
  });

  it("says WHERE the candidate went, so \"NOT installed\" is checkable rather than trusted", async () => {
    const { fs, now } = harness();
    fs.writeFile(JOURNAL, JSON.stringify([await journalEntry("verified")]));
    const result = await run(
      fs,
      ["forge", "--from-verified", JOURNAL, "--name", "migrate-schema", "--out", "/elsewhere/c.md"],
      { now }
    );
    expect(result.code).toBe(0);
    expect(joined(result)).toContain(`NOT installed — written outside the skills dir (${DIR})`);
    expect(installed(fs)).toEqual([]);
  });

  it("is not reachable through `skill synth` semantics — forge never touches the skills dir on any path", async () => {
    const { fs, now } = harness();
    fs.writeFile(JOURNAL, JSON.stringify([await journalEntry("verified")]));
    await run(fs, ["forge", "--from-verified", JOURNAL, "--name", "migrate-schema"], { now });
    await run(fs, ["forge", "--from-verified", JOURNAL, "--name", "migrate-schema", "--out", "/tmp/c.md"], { now });
    expect(installed(fs)).toEqual([]);
  });
});

// ===========================================================================
// THE PROMOTION CHAIN — the holdout gate is still the only way in
// ===========================================================================

function suite(n: number): HoldoutCase[] {
  return Array.from({ length: n }, (_, i) => ({ id: `case-${i}`, objective: `held-out objective ${i}` }));
}

function results(n: number, verifiedSuccesses: number): HoldoutRunResult[] {
  return Array.from({ length: n }, (_, i) => {
    const good = i < verifiedSuccesses;
    return {
      caseId: `case-${i}`,
      success: good,
      verified: good,
      predictedP: good ? 0.9 : 0.2,
      ...(good ? { certSha256: sha256Hex(`cert-${i}`) } : {}),
      detail: good ? "verified success" : "verified check failed",
    };
  });
}

describe("hades skill forge -> holdout — a forged skill is promoted only by held-out verified performance", () => {
  async function forgeCandidate(fs: InMemoryFs, now: () => number): Promise<string> {
    fs.writeFile(JOURNAL, JSON.stringify([await journalEntry("verified")]));
    const forged = await run(fs, ["forge", "--from-verified", JOURNAL, "--name", "migrate-schema"], { now });
    expect(forged.code).toBe(0);
    return `${DATA}/candidates/migrate-schema.md`;
  }

  it("REFUSES to promote a forged candidate that does not clear the holdout bar", async () => {
    const { fs, now } = harness();
    const candidate = await forgeCandidate(fs, now);

    fs.writeFile("/data/suite.json", JSON.stringify(suite(8)));
    fs.writeFile("/data/weak.json", JSON.stringify(results(8, 2)));

    const decision = await run(
      fs,
      [
        "holdout",
        "migrate-schema",
        "--candidate",
        candidate,
        "--suite",
        "/data/suite.json",
        "--results",
        "/data/weak.json",
        "--apply",
      ],
      { now }
    );

    // Independently recomputed, never read off the command's own output.
    expect(wilsonLowerBound(2, 8)).toBeLessThan(0.6);

    expect(decision.code).toBe(1);
    expect(joined(decision)).toContain('Holdout verdict for "migrate-schema": rollback');
    // Even with --apply, a rejected candidate is never installed.
    expect(installed(fs)).toEqual([]);
    expect(fs.readFile(`${DIR}/migrate-schema.md`)).toBeNull();
  });

  it("promotes a forged candidate ONLY once it clears the holdout bar", async () => {
    const { fs, now } = harness();
    const candidate = await forgeCandidate(fs, now);
    const candidateContent = fs.readFile(candidate) as string;

    fs.writeFile("/data/suite.json", JSON.stringify(suite(8)));
    fs.writeFile("/data/strong.json", JSON.stringify(results(8, 8)));

    // Dry run first: a decision without --apply must change nothing.
    const dry = await run(
      fs,
      ["holdout", "migrate-schema", "--candidate", candidate, "--suite", "/data/suite.json", "--results", "/data/strong.json"],
      { now }
    );
    expect(dry.code).toBe(0);
    expect(joined(dry)).toContain("dry run");
    expect(installed(fs)).toEqual([]);

    const applied = await run(
      fs,
      [
        "holdout",
        "migrate-schema",
        "--candidate",
        candidate,
        "--suite",
        "/data/suite.json",
        "--results",
        "/data/strong.json",
        "--apply",
      ],
      { now }
    );

    expect(wilsonLowerBound(8, 8)).toBeGreaterThanOrEqual(0.6);
    expect(applied.code).toBe(0);
    expect(joined(applied)).toContain('Holdout verdict for "migrate-schema": accept');
    expect(installed(fs)).toEqual([`${DIR}/migrate-schema.md`]);
    // What got installed is exactly the forged bytes — nothing was re-derived.
    expect(fs.readFile(`${DIR}/migrate-schema.md`)).toBe(candidateContent);
  });

  it("keeps the promoted skill inside the existing track/trust surface", async () => {
    const { fs, now } = harness();
    const candidate = await forgeCandidate(fs, now);
    fs.writeFile("/data/suite.json", JSON.stringify(suite(8)));
    fs.writeFile("/data/strong.json", JSON.stringify(results(8, 8)));
    await run(
      fs,
      ["holdout", "migrate-schema", "--candidate", candidate, "--suite", "/data/suite.json", "--results", "/data/strong.json", "--apply"],
      { now }
    );

    // A promoted skill with no recorded outcomes yet must report as unscored,
    // never as trusted — the demotion/trust surface is not bypassed by forging.
    const trust = await run(fs, ["trust", "show"], { now });
    expect(trust.lines.join("\n")).toContain("migrate-schema");
  });
});

// ===========================================================================
// Help
// ===========================================================================

describe("hades skill help", () => {
  it("documents forge, including that it writes a candidate only", async () => {
    const { fs, now } = harness();
    const help = await run(fs, ["help"], { now });
    const text = joined(help);
    expect(help.code).toBe(0);
    expect(text).toContain("forge [--from-verified <journal.json>]");
    expect(text).toContain("skill holdout");
    expect(text).toContain(`$${JOURNAL_PATH_ENV}`);
  });
});
