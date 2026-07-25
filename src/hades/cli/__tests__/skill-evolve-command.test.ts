/* ------------------------------------------------------------------ *
 * skill-evolve-command.test.ts
 *
 * The Phase-10 end-to-end checkpoint: everything here goes through
 * `runSkillEvolveCommand` only — no engine module is imported and called
 * directly to "help" a scenario along, except where a test needs to build
 * a fixture the CLI itself would consume (a trajectory/certificate JSON
 * file, a use.json file) or to independently recompute an expected number
 * to assert against (never a fabricated one).
 *
 * REAL-VS-MOCK POLICY: crypto is always real — every certificate is issued
 * by a real `CertificateAuthority` (real ed25519 via @noble/ed25519, real
 * sha256 via node:crypto). The filesystem is a small in-memory double
 * (`InMemoryFs`) injected through `SkillEvolveOptions.fs`; the clock is a
 * manual counter injected through `opts.now`. No number a test asserts on
 * is invented — brier/wilson figures are either read back out of the
 * command's own printed output or independently recomputed with the real
 * `brierScore`/`wilsonLowerBound` functions.
 * ------------------------------------------------------------------ */
import { dirname, join } from "node:path";
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
  canonicalize,
  type CertificatePayload,
  type VerificationCertificate,
} from "../../styx/certificate";
import type { GoalTrajectory, TaskTrajectory, ToolEvent } from "../../research/recorder";
import {
  canonicalTrajectoryJson,
  extractProvenance,
  type VerifiedTrajectory,
} from "../../skills/synthesize";
import { brierScore, wilsonLowerBound } from "../../skills/track-record";
import { parseSkillFile, validateSkillManifest } from "../../skills/skill-file";
import { SkillLibrary } from "../../skills/library";
import type { VerifiedUse } from "../../skills/refine";

// ===========================================================================
// In-memory fs double
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

function skillsSnapshot(fs: InMemoryFs, dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of fs.files) {
    if (k.startsWith(`${dir}/`)) out[k] = v;
  }
  return out;
}

// ===========================================================================
// Trajectory / certificate fixtures (mirrors synthesize.test.ts conventions)
// ===========================================================================

function fixedRng(fill: number): (bytes: number) => Uint8Array {
  return (bytes: number) => new Uint8Array(bytes).fill(fill);
}

const ca = new CertificateAuthority(generatePrivateKeyHex(fixedRng(31)));

function tool(overrides: Partial<ToolEvent> = {}): ToolEvent {
  return { tool: "read_file", ok: true, summary: "Read the config file.", at: 1_000, ...overrides };
}

function task(overrides: Partial<TaskTrajectory> = {}): TaskTrajectory {
  return {
    taskId: "task-1",
    description: "Load configuration",
    capability: "filesystem",
    tools: [tool(), tool({ tool: "write_file", summary: "Persist the merged config." })],
    success: true,
    startedAt: 900,
    endedAt: 1_100,
    ...overrides,
  };
}

function goal(overrides: Partial<GoalTrajectory> = {}): GoalTrajectory {
  return {
    goalId: "goal-1",
    objective: "Configure the deploy pipeline",
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
    verifierTier: "T2-genrm",
    ensembleScore: 0.95,
    pCorrect: 0.99,
    epsilon: 0.02,
    traceSha256: sha256Hex(canonicalTrajectoryJson(trajectory)),
    verifierVersions: ["exec-oracle@1.0.0"],
    issuedAt: 1_700_000_000_000,
    ...overrides,
  };
}

async function verifiedFixture(
  trajectoryOverrides: Partial<GoalTrajectory> = {},
  payloadOverrides: Partial<CertificatePayload> = {}
): Promise<VerifiedTrajectory> {
  const trajectory = goal(trajectoryOverrides);
  const payload = payloadFor(trajectory, payloadOverrides);
  const certificate = await ca.issue(payload);
  return { trajectory, certificate };
}

function flipSignatureByte(sig: string): string {
  const byte = parseInt(sig.slice(0, 2), 16);
  const flipped = (byte ^ 0xff).toString(16).padStart(2, "0");
  return flipped + sig.slice(2);
}

// ===========================================================================
// Shared harness
// ===========================================================================

const DIR = "/skills";
const DATA = "/data";

function harness() {
  const fs = new InMemoryFs();
  let clock = 1_700_000_000_000;
  const now = () => (clock += 1);
  const opts = { fs, dir: DIR, dataDir: DATA, env: {}, now };
  return { fs, opts, tick: () => clock };
}

async function run(fs: InMemoryFs, extra: Record<string, unknown>, args: string[]): Promise<SkillEvolveResult> {
  return runSkillEvolveCommand(args, { fs, dir: DIR, dataDir: DATA, env: {}, ...extra });
}

// ===========================================================================
// help / dispatch
// ===========================================================================

describe("help and dispatch", () => {
  it("prints usage for no args, `help`, and unknown subcommands, and never writes anything", async () => {
    const { fs, opts } = harness();
    const noArgs = await runSkillEvolveCommand([], opts);
    const helpArgs = await runSkillEvolveCommand(["help"], opts);
    const unknown = await runSkillEvolveCommand(["bogus"], opts);

    expect(noArgs.code).toBe(0);
    expect(helpArgs.code).toBe(0);
    expect(unknown.code).toBe(1);
    expect(noArgs.lines).toEqual(helpArgs.lines);
    expect(unknown.lines).toEqual(noArgs.lines);
    expect(noArgs.lines[0]).toBe("Usage: hades skill <synth|refine|track|trust> ...");
    expect(fs.files.size).toBe(0);
  });
});

// ===========================================================================
// CHECKPOINT A — synth: verified trajectory -> green SKILL.md
// ===========================================================================

describe("CHECKPOINT A — synth produces a re-loadable, provenance-verified SKILL.md", () => {
  it("writes a skill whose provenance re-extracts the real cert hash and reloads with zero errors", async () => {
    const { fs, opts } = harness();
    const vt = await verifiedFixture();

    fs.files.set("/traj.json", JSON.stringify(vt));

    const result = await runSkillEvolveCommand(["synth", "/traj.json"], opts);

    expect(result.code).toBe(0);
    expect(result.lines[0]).toMatch(/^Synthesized skill "configure-the-deploy-pipeline" -> \/skills\/.*\.md$/);

    const target = `${DIR}/configure-the-deploy-pipeline.md`;
    const written = fs.files.get(target);
    expect(written).toBeTypeOf("string");

    // No step mocked: reload the exact bytes written through the real
    // SkillLibrary, exactly the way any worker would.
    const library = new SkillLibrary();
    const report = library.loadFiles([{ path: target, content: written as string }]);
    expect(report.errors).toEqual([]);
    expect(report.loaded).toHaveLength(1);

    const loaded = library.get("configure-the-deploy-pipeline");
    expect(loaded).toBeDefined();

    const provenance = extractProvenance(loaded!.manifest.instructions);
    expect(provenance).not.toBeNull();
    const expectedCertSha256 = sha256Hex(canonicalize(vt.certificate.payload));
    expect(provenance!.certSha256).toBe(expectedCertSha256);
    expect(provenance!.trajectoryGoalId).toBe(vt.trajectory.goalId);

    // The printed provenance line must carry the same hash.
    expect(result.lines[1]).toContain(`cert=${expectedCertSha256}`);
  });
});

// ===========================================================================
// CHECKPOINT B — track regression -> trust demotion, persisted across runs
// ===========================================================================

describe("CHECKPOINT B — track regression drives trust demotion, persisted across fresh invocations", () => {
  it("10 verified successes then 6 high-confidence failures -> demoted, and a brand-new invocation still reports demoted", async () => {
    const { fs, opts } = harness();
    const skill = "regression-skill";

    for (let i = 0; i < 10; i++) {
      const cert = sha256Hex(`good-use-${i}`);
      const rec = await runSkillEvolveCommand(
        ["track", skill, "--p", "0.9", "--success", "--cert", cert],
        opts
      );
      expect(rec.code).toBe(0);
    }
    for (let i = 0; i < 6; i++) {
      const cert = sha256Hex(`bad-use-${i}`);
      const rec = await runSkillEvolveCommand(
        ["track", skill, "--p", "0.9", "--failure", "--cert", cert],
        opts
      );
      expect(rec.code).toBe(0);
    }

    const first = await runSkillEvolveCommand(["trust"], opts);
    expect(first.code).toBe(0);
    expect(first.lines).toHaveLength(1);
    const line = first.lines[0];
    expect(line.startsWith(`${skill} status=demoted wilson=`)).toBe(true);
    expect(line).toContain("[changed]");
    expect(line).toMatch(/demote$/);
    // The reason line must cite the real, computed wilsonLower against the
    // real default threshold — not a fabricated number.
    expect(line).toContain("demoteBelowWilson=0.5000");

    // A brand-new invocation (new SkillTrackRecordStore + new trust-state
    // read) against the exact same fs must still report demoted — this is
    // persistence proven at the product surface, not in-process memory.
    const second = await runSkillEvolveCommand(["trust"], opts);
    expect(second.code).toBe(0);
    expect(second.lines).toHaveLength(1);
    expect(second.lines[0].startsWith(`${skill} status=demoted wilson=`)).toBe(true);
    // Nothing changed this run (status was already demoted and stays sticky
    // demoted with n unchanged) — no [changed] marker the second time.
    expect(second.lines[0]).not.toContain("[changed]");
  });
});

// ===========================================================================
// (c) tamper case — hand-edited skill-track.json is detected, not scored
// ===========================================================================

describe("tamper detection — a hand-edited skill-track.json entry is never scored as healthy", () => {
  it("flips a persisted entry's success flag and asserts trust reports the broken chain", async () => {
    const { fs, opts } = harness();
    const skill = "tamper-skill";

    for (let i = 0; i < 6; i++) {
      const rec = await runSkillEvolveCommand(
        ["track", skill, "--p", "0.8", "--success", "--cert", sha256Hex(`t-${i}`)],
        opts
      );
      expect(rec.code).toBe(0);
    }

    const trackPath = `${DATA}/skill-track.json`;
    const before = fs.files.get(trackPath);
    expect(before).toBeTypeOf("string");
    const envelope = JSON.parse(before as string) as {
      version: 1;
      chains: Record<string, Array<{ success: boolean }>>;
    };
    expect(envelope.chains[skill]).toBeDefined();
    // Hand-edit: flip one entry's `success` without recomputing its hash.
    envelope.chains[skill][2].success = !envelope.chains[skill][2].success;
    fs.files.set(trackPath, JSON.stringify(envelope));

    const result = await runSkillEvolveCommand(["trust"], opts);
    expect(result.code).toBe(1);
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]).toBe(
      `${skill} status=integrity-error — hash chain verification failed at seq=2; refusing to score as healthy.`
    );
  });

  it("refuses to append a new outcome on top of a tampered chain, leaving the bytes untouched", async () => {
    const { fs, opts } = harness();
    const skill = "tamper-append";

    for (let i = 0; i < 3; i++) {
      const rec = await runSkillEvolveCommand(["track", skill, "--p", "0.8", "--success"], opts);
      expect(rec.code).toBe(0);
    }

    const trackPath = `${DATA}/skill-track.json`;
    const envelope = JSON.parse(fs.files.get(trackPath) as string) as {
      version: 1;
      chains: Record<string, Array<{ success: boolean }>>;
    };
    envelope.chains[skill][1].success = !envelope.chains[skill][1].success;
    const tamperedBytes = JSON.stringify(envelope);
    fs.files.set(trackPath, tamperedBytes);

    const rec = await runSkillEvolveCommand(["track", skill, "--p", "0.8", "--success"], opts);
    expect(rec.code).toBe(1);
    expect(rec.lines[0]).toContain("failed integrity (tampered:");
    expect(rec.lines[0]).toContain("refusing to append");
    // The tampered file is preserved byte-for-byte for forensics — never
    // overwritten by a fresh append.
    expect(fs.files.get(trackPath)).toBe(tamperedBytes);
  });
});

describe("unreadable-envelope detection — a corrupt skill-track.json is never presented as empty history", () => {
  const GARBAGE = "{ not json ]";

  it("track record refuses to append (which would atomically destroy the corrupt file)", async () => {
    const { fs, opts } = harness();
    const trackPath = `${DATA}/skill-track.json`;
    fs.files.set(trackPath, GARBAGE);

    const rec = await runSkillEvolveCommand(["track", "any-skill", "--p", "0.5", "--success"], opts);
    expect(rec.code).toBe(1);
    expect(rec.lines[0]).toContain("failed integrity (unreadable:");
    expect(fs.files.get(trackPath)).toBe(GARBAGE);
  });

  it("track summaries (all and single) refuse to report the corrupt store as empty", async () => {
    const { fs, opts } = harness();
    fs.files.set(`${DATA}/skill-track.json`, GARBAGE);

    const all = await runSkillEvolveCommand(["track"], opts);
    expect(all.code).toBe(1);
    expect(all.lines[0]).toContain("Track-record store is unreadable");

    const one = await runSkillEvolveCommand(["track", "any-skill"], opts);
    expect(one.code).toBe(1);
    expect(one.lines[0]).toContain("Track-record store is unreadable");
  });

  it("trust refuses to evaluate over the silently-emptied view", async () => {
    const { fs, opts } = harness();
    fs.files.set(`${DATA}/skill-track.json`, GARBAGE);

    const result = await runSkillEvolveCommand(["trust"], opts);
    expect(result.code).toBe(1);
    expect(result.lines[0]).toContain("Track-record store is unreadable");
    // No trust-state file is persisted off the back of a refused evaluation.
    expect(fs.files.has(`${DATA}/skill-trust.json`)).toBe(false);
  });
});

// ===========================================================================
// (d) rejection paths — exit 1 with the exact code, never a write
// ===========================================================================

describe("synth rejection paths — exact rejection code, skills dir left untouched", () => {
  it("rejects a trajectory tampered after signing with hash-mismatch", async () => {
    const { fs, opts } = harness();
    const vt = await verifiedFixture();
    const before = skillsSnapshot(fs, DIR);

    const tampered = {
      trajectory: { ...vt.trajectory, objective: "Something else entirely" },
      certificate: vt.certificate,
    };
    fs.files.set("/traj-tampered.json", JSON.stringify(tampered));

    const result = await runSkillEvolveCommand(["synth", "/traj-tampered.json"], opts);
    expect(result.code).toBe(1);
    expect(result.lines[0]).toBe("Rejected: hash-mismatch");
    expect(skillsSnapshot(fs, DIR)).toEqual(before);
  });

  it("rejects a certificate whose signature does not verify with bad-signature", async () => {
    const { fs, opts } = harness();
    const vt = await verifiedFixture();
    const before = skillsSnapshot(fs, DIR);

    const forged: VerifiedTrajectory = {
      trajectory: vt.trajectory,
      certificate: { ...vt.certificate, signature: flipSignatureByte(vt.certificate.signature) },
    };
    fs.files.set("/traj-forged.json", JSON.stringify(forged));

    const result = await runSkillEvolveCommand(["synth", "/traj-forged.json"], opts);
    expect(result.code).toBe(1);
    expect(result.lines[0]).toBe("Rejected: bad-signature");
    expect(skillsSnapshot(fs, DIR)).toEqual(before);
  });

  it("rejects a success:false trajectory with failed-trajectory", async () => {
    const { fs, opts } = harness();
    const vt = await verifiedFixture({ success: false });
    const before = skillsSnapshot(fs, DIR);

    fs.files.set("/traj-failed.json", JSON.stringify(vt));

    const result = await runSkillEvolveCommand(["synth", "/traj-failed.json"], opts);
    expect(result.code).toBe(1);
    expect(result.lines[0]).toBe("Rejected: failed-trajectory");
    expect(skillsSnapshot(fs, DIR)).toEqual(before);
  });
});

// ===========================================================================
// (e) refine path
// ===========================================================================

describe("refine path — a verified use adds a caveat; a repeat use is a no-op", () => {
  it("applies a new caveat, re-validates, and prints 'no changes' the second time", async () => {
    const { fs, opts } = harness();
    const vt = await verifiedFixture();

    fs.files.set("/traj.json", JSON.stringify(vt));
    const synth = await runSkillEvolveCommand(["synth", "/traj.json"], opts);
    expect(synth.code).toBe(0);
    const skillName = "configure-the-deploy-pipeline";
    const target = `${DIR}/${skillName}.md`;
    const before = fs.files.get(target) as string;

    const useTrajectory = goal({
      goalId: "goal-2",
      objective: "Configure the deploy pipeline again",
      tasks: [
        task({
          taskId: "task-2",
          tools: [tool({ tool: "flaky_tool", ok: false, summary: "Timed out talking to the registry." })],
        }),
      ],
    });
    const useCert = await ca.issue(payloadFor(useTrajectory, { pCorrect: 0.9, epsilon: 0.05 }));
    const use: VerifiedUse = {
      skillName,
      trajectory: useTrajectory,
      certificate: useCert,
      at: 1,
    };
    fs.files.set("/use.json", JSON.stringify(use));

    const refined = await runSkillEvolveCommand(["refine", skillName, "/use.json"], opts);
    expect(refined.code).toBe(0);
    expect(refined.lines[0]).toBe(`Refined skill "${skillName}" -> ${target}`);
    expect(refined.lines).toContain("Changelog:");
    expect(refined.lines.some((l) => l.includes("[add-caveat]"))).toBe(true);
    expect(refined.lines.some((l) => l.includes("[bump-version]"))).toBe(true);

    const after = fs.files.get(target) as string;
    expect(after).not.toBe(before);

    // Output re-validates through the real parser/validator.
    const reparsed = parseSkillFile(after);
    expect(validateSkillManifest(reparsed.manifest).valid).toBe(true);
    expect(reparsed.manifest.name).toBe(skillName);

    const again = await runSkillEvolveCommand(["refine", skillName, "/use.json"], opts);
    expect(again.code).toBe(0);
    expect(again.lines[0]).toBe("no changes");
    expect(fs.files.get(target)).toBe(after);
  });
});

// ===========================================================================
// (f) arg-parsing hardening — never a stack trace
// ===========================================================================

describe("arg-parsing hardening", () => {
  function assertClean(r: SkillEvolveResult): void {
    expect(r.code).toBe(1);
    expect(r.lines.length).toBeGreaterThan(0);
    for (const line of r.lines) {
      expect(line).not.toMatch(/\bat \S+\(.*:\d+:\d+\)/);
      expect(line).not.toContain("TypeError");
      expect(line).not.toContain("ReferenceError");
    }
  }

  it("synth: missing file, malformed JSON", async () => {
    const { fs, opts } = harness();
    assertClean(await runSkillEvolveCommand(["synth"], opts));
    assertClean(await runSkillEvolveCommand(["synth", "/nope.json"], opts));
    fs.files.set("/bad.json", "{ not json");
    assertClean(await runSkillEvolveCommand(["synth", "/bad.json"], opts));
  });

  it("refine: missing args, missing skill, missing use file, malformed JSON", async () => {
    const { fs, opts } = harness();
    assertClean(await runSkillEvolveCommand(["refine"], opts));
    assertClean(await runSkillEvolveCommand(["refine", "only-one-arg"], opts));
    assertClean(await runSkillEvolveCommand(["refine", "ghost-skill", "/use.json"], opts));

    const vt = await verifiedFixture();
    fs.files.set("/traj.json", JSON.stringify(vt));
    await runSkillEvolveCommand(["synth", "/traj.json"], opts);
    assertClean(
      await runSkillEvolveCommand(["refine", "configure-the-deploy-pipeline", "/missing-use.json"], opts)
    );
    fs.files.set("/bad-use.json", "not json at all");
    assertClean(
      await runSkillEvolveCommand(["refine", "configure-the-deploy-pipeline", "/bad-use.json"], opts)
    );
  });

  it("track: p out of range, missing --p, conflicting/missing success flags, unknown flags", async () => {
    const { opts } = harness();
    assertClean(await runSkillEvolveCommand(["track", "s", "--p", "1.5", "--success"], opts));
    assertClean(await runSkillEvolveCommand(["track", "s", "--p", "-0.1", "--success"], opts));
    assertClean(await runSkillEvolveCommand(["track", "s", "--p", "not-a-number", "--success"], opts));
    assertClean(await runSkillEvolveCommand(["track", "s", "--success"], opts));
    assertClean(await runSkillEvolveCommand(["track", "s", "--p", "0.5"], opts));
    assertClean(await runSkillEvolveCommand(["track", "s", "--p", "0.5", "--success", "--failure"], opts));
    assertClean(await runSkillEvolveCommand(["track", "s", "--p", "0.5", "--bogus", "--success"], opts));
    assertClean(await runSkillEvolveCommand(["track", "nonexistent-skill"], opts));
  });

  it("trust: unknown flags, missing/bad policy file", async () => {
    const { fs, opts } = harness();
    assertClean(await runSkillEvolveCommand(["trust", "--bogus"], opts));
    assertClean(await runSkillEvolveCommand(["trust", "--policy-file", "/nope.json"], opts));
    fs.files.set("/bad-policy.json", "{ not json");
    assertClean(await runSkillEvolveCommand(["trust", "--policy-file", "/bad-policy.json"], opts));
    fs.files.set("/incomplete-policy.json", JSON.stringify({ minSamples: 5 }));
    assertClean(await runSkillEvolveCommand(["trust", "--policy-file", "/incomplete-policy.json"], opts));
  });
});

// ===========================================================================
// (g) exact output format, line-by-line, for every subcommand
// ===========================================================================

describe("output format is stable and asserted line-by-line", () => {
  it("track <skill> --p --success prints the exact recorded + summary lines", async () => {
    const { opts } = harness();
    const result = await runSkillEvolveCommand(
      ["track", "fmt-skill", "--p", "0.8", "--success", "--cert", "abc123"],
      opts
    );
    expect(result.code).toBe(0);

    const expectedBrier = brierScore([{ predictedP: 0.8, success: true }]);
    const expectedWilson = wilsonLowerBound(1, 1);
    expect(result.lines).toEqual([
      "Recorded fmt-skill: success=true predictedP=0.8000 cert=abc123",
      `fmt-skill  n=1 verifiedN=1 successRate=1.0000 recentSuccessRate=1.0000 ` +
        `brier=${expectedBrier.toFixed(4)} recentBrier=${expectedBrier.toFixed(4)} ` +
        `wilsonLower=${expectedWilson.toFixed(4)} window=20 lastAt=${(opts.now as () => number).call(null) - 1} integrity=ok`,
    ]);
  });

  it("bare track lists every discovered/tracked skill, sorted", async () => {
    const { fs, opts } = harness();
    // A skill file exists on disk with no track record at all.
    fs.files.set(`${DIR}/untracked-skill.md`, "---\nname: untracked-skill\ndescription: x\n---\nbody\n");
    await runSkillEvolveCommand(["track", "b-skill", "--p", "0.5", "--success"], opts);
    await runSkillEvolveCommand(["track", "a-skill", "--p", "0.5", "--failure"], opts);

    const result = await runSkillEvolveCommand(["track"], opts);
    expect(result.code).toBe(0);
    expect(result.lines).toHaveLength(3);
    expect(result.lines[0].startsWith("a-skill  n=1")).toBe(true);
    expect(result.lines[1].startsWith("b-skill  n=1")).toBe(true);
    expect(result.lines[2]).toBe("untracked-skill  (no track record)");
  });

  it("trust reports n<minSamples skills as held, with the exact reason text", async () => {
    const { opts } = harness();
    await runSkillEvolveCommand(["track", "new-skill", "--p", "0.9", "--success"], opts);
    const result = await runSkillEvolveCommand(["trust"], opts);
    expect(result.code).toBe(0);
    const expectedWilson = wilsonLowerBound(1, 1).toFixed(4);
    const expectedBrier = brierScore([{ predictedP: 0.9, success: true }]).toFixed(4);
    expect(result.lines).toEqual([
      `new-skill status=active wilson=${expectedWilson} brier=${expectedBrier} — n=1 < minSamples=5: insufficient samples, status held at "active"`,
    ]);
  });

  it("trust with no tracked skills and empty dir reports the exact empty-state line", async () => {
    const { opts } = harness();
    const result = await runSkillEvolveCommand(["trust"], opts);
    expect(result.code).toBe(0);
    expect(result.lines).toEqual(["No skills found and no track records to evaluate."]);
  });

  it("track show for an unknown skill reports the exact not-found line", async () => {
    const { opts } = harness();
    const result = await runSkillEvolveCommand(["track", "ghost"], opts);
    expect(result.code).toBe(1);
    expect(result.lines).toEqual(['No track record for skill "ghost".']);
  });
});

// ===========================================================================
// trust honors a custom policy file
// ===========================================================================

describe("trust --policy-file", () => {
  it("uses the custom thresholds instead of the defaults", async () => {
    const { fs, opts } = harness();
    // With the default policy this skill (successRate 0.7, n=10) stays
    // active or probation; a strict custom policy demanding wilsonLower
    // >= 0.99 to avoid probation must push it to probation instead.
    for (let i = 0; i < 7; i++) {
      await runSkillEvolveCommand(["track", "policy-skill", "--p", "0.8", "--success"], opts);
    }
    for (let i = 0; i < 3; i++) {
      await runSkillEvolveCommand(["track", "policy-skill", "--p", "0.8", "--failure"], opts);
    }

    const strictPolicy = {
      minSamples: 1,
      demoteBelowWilson: 0.01,
      probationBelowWilson: 0.99,
      brierCeiling: 0.35,
      recoverAboveWilson: 0.999,
      recoveryStreak: 3,
      hysteresis: 0.001,
    };
    fs.files.set("/strict-policy.json", JSON.stringify(strictPolicy));

    const result = await runSkillEvolveCommand(["trust", "--policy-file", "/strict-policy.json"], opts);
    expect(result.code).toBe(0);
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]).toContain("status=probation");
  });
});

// ===========================================================================
// synth accepts an array of sources
// ===========================================================================

describe("synth with multiple sources", () => {
  it("accepts a JSON array of VerifiedTrajectory and reports aggregated provenance sourceCount", async () => {
    const { fs, opts } = harness();
    const vt1 = await verifiedFixture({ goalId: "multi-1", objective: "Multi source objective" });
    const vt2 = await verifiedFixture({ goalId: "multi-2", objective: "Multi source objective" });
    fs.files.set("/multi.json", JSON.stringify([vt1, vt2]));

    const result = await runSkillEvolveCommand(["synth", "/multi.json"], opts);
    expect(result.code).toBe(0);
    expect(result.lines[1]).toContain("sources=2");
  });
});
