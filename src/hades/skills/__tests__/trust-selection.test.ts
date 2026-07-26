/* ------------------------------------------------------------------ *
 * trust-selection.test.ts
 *
 * REAL-VS-MOCK POLICY: every fixture in this file is produced by the real
 * engines under test's own dependencies — SKILL.md fixtures are loaded
 * through a real `SkillLibrary`, and every track-record entry is produced
 * by a real `SkillTrackRecordStore.record()` call (real sha256 hash
 * chaining, real Brier/Wilson math). The only hand-rolled JSON in this
 * file is (a) the deliberately-adversarial corrupt/garbage bytes used in
 * the integrity tests, and (b) `skill-trust.json` fixtures, which are
 * always built via the real `serializeTrustStates` (de)serializer, never
 * a raw string literal. All fixtures share one in-memory `Map<string,
 * string>` "filesystem" keyed by path, exactly mirroring how the real
 * `hades skill trust` / `hades skill track` commands lay files out on disk
 * (`<dataDir>/skill-trust.json`, `<dataDir>/skill-track.json`).
 * ------------------------------------------------------------------ */
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  SkillTrustReader,
  resolveWithTrust,
  orderByTrust,
  type TrustReaderFs,
  type SkillTrustRow,
} from "../trust-selection";
import {
  serializeTrustStates,
  type SkillTrustState,
} from "../demotion";
import {
  SkillTrackRecordStore,
  brierScore,
  wilsonLowerBound,
  type TrackRecordFs,
} from "../track-record";
import { SkillLibrary, type LoadedSkill } from "../library";

// ===========================================================================
// shared fixtures / helpers
// ===========================================================================

const DATA_DIR = "/data";
const trustPath = join(DATA_DIR, "skill-trust.json");
const trackPath = join(DATA_DIR, "skill-track.json");

/** In-memory read-only `TrustReaderFs` view over a shared `Map`. */
function makeSharedFs(initial: Record<string, string> = {}): {
  fs: TrustReaderFs;
  files: Map<string, string>;
} {
  const files = new Map(Object.entries(initial));
  const fs: TrustReaderFs = {
    readFile(p) {
      return files.has(p) ? (files.get(p) as string) : null;
    },
  };
  return { fs, files };
}

/** Writable `TrackRecordFs` adapter over the same shared `Map`, used ONLY
 * to build fixtures (the reader under test never gets a writable fs). */
function makeTrackFsAdapter(files: Map<string, string>): TrackRecordFs {
  return {
    readFile(p) {
      return files.has(p) ? (files.get(p) as string) : null;
    },
    writeFile(p, c) {
      files.set(p, c);
    },
    mkdirp() {
      /* no-op: in-memory */
    },
  };
}

/** Records `n` real outcomes for `skillName`, `Math.round(n*successRate)` of
 * them successful (earliest first), through a real `SkillTrackRecordStore`. */
function seedOutcomes(
  files: Map<string, string>,
  skillName: string,
  n: number,
  successRate: number,
  startAt = 1000,
): void {
  const store = new SkillTrackRecordStore({
    path: trackPath,
    fs: makeTrackFsAdapter(files),
    now: () => startAt,
  });
  const nSuccess = Math.round(n * successRate);
  for (let i = 0; i < n; i++) {
    store.record({
      skillName,
      predictedP: successRate,
      success: i < nSuccess,
      at: startAt + i,
    });
  }
}

function seedTrustFile(files: Map<string, string>, states: Record<string, SkillTrustState>): void {
  files.set(trustPath, serializeTrustStates(new Map(Object.entries(states))));
}

function trustState(overrides: Partial<SkillTrustState> = {}): SkillTrustState {
  return {
    skillName: "unset",
    status: "active",
    since: 0,
    streak: 0,
    reasons: [],
    ...overrides,
  };
}

/** Minimal valid SKILL.md source for a given name/capabilities/tools. */
function skillMd(name: string, capabilities: string[] = [`cap-${name}`], tools: string[] = []): string {
  return [
    "---",
    `name: ${name}`,
    `description: test fixture skill ${name}`,
    `capabilities: ${JSON.stringify(capabilities)}`,
    `tools: ${JSON.stringify(tools)}`,
    "---",
    `# ${name}`,
    "",
    "Fixture instructions.",
    "",
  ].join("\n");
}

function buildLibrary(specs: Array<{ name: string; capabilities?: string[]; tools?: string[] }>): SkillLibrary {
  const lib = new SkillLibrary();
  const files = specs.map((s) => ({
    path: `/skills/${s.name}.md`,
    content: skillMd(s.name, s.capabilities, s.tools),
  }));
  const report = lib.loadFiles(files);
  if (report.errors.length > 0) {
    throw new Error(`fixture library failed to load: ${JSON.stringify(report.errors)}`);
  }
  return lib;
}

const emptyTools = { get: (_name: string) => undefined };

// ===========================================================================
// SkillTrustReader — clean-slate behavior
// ===========================================================================

describe("SkillTrustReader — no persisted files at all", () => {
  it("reports any skill as unscored, with null metrics and empty allKnown()", () => {
    const { fs } = makeSharedFs();
    const reader = new SkillTrustReader({ dataDir: DATA_DIR, fs });

    const row = reader.row("ghost-skill");
    expect(row).toEqual<SkillTrustRow>({
      skillName: "ghost-skill",
      status: "unscored",
      wilsonLower: null,
      recentBrier: null,
      n: 0,
      verifiedN: 0,
      since: null,
      streak: 0,
      reasons: ['no track record and no persisted trust evaluation for "ghost-skill"'],
    });
    expect(reader.allKnown()).toEqual([]);
  });

  it("rows() maps a batch of names in the same order, independently", () => {
    const { fs } = makeSharedFs();
    const reader = new SkillTrustReader({ dataDir: DATA_DIR, fs });
    const rows = reader.rows(["a", "b", "c"]);
    expect(rows.map((r) => r.skillName)).toEqual(["a", "b", "c"]);
    expect(rows.every((r) => r.status === "unscored")).toBe(true);
  });
});

// ===========================================================================
// SkillTrustReader — the main mixed scenario (rule (e) both directions,
// numeric fidelity, allKnown())
// ===========================================================================

describe("SkillTrustReader — a realistic mixed scenario", () => {
  function buildScenario() {
    const { fs, files } = makeSharedFs();

    // alpha: persisted active, strong real track record.
    seedOutcomes(files, "alpha", 30, 1.0);
    // alpha2: persisted active, weaker real track record (for ordering later).
    seedOutcomes(files, "alpha2", 15, 0.6);
    // beta: persisted probation, mediocre record.
    seedOutcomes(files, "beta", 10, 0.5);
    // gamma: persisted demoted, poor record.
    seedOutcomes(files, "gamma", 8, 0.3);
    // delta: real track record, but NEVER evaluated by `hades skill trust`.
    seedOutcomes(files, "delta", 4, 1.0);
    // epsilon: persisted active, but no track-record entries at all.
    // zeta: nothing anywhere.

    seedTrustFile(files, {
      alpha: trustState({ skillName: "alpha", status: "active", since: 1000, streak: 5, reasons: ["healthy"] }),
      alpha2: trustState({ skillName: "alpha2", status: "active", since: 900, streak: 2, reasons: [] }),
      beta: trustState({
        skillName: "beta",
        status: "probation",
        since: 800,
        streak: 1,
        reasons: ["wilsonLower=0.5000 < probationBelowWilson=0.7000: demote active -> probation"],
      }),
      gamma: trustState({
        skillName: "gamma",
        status: "demoted",
        since: 700,
        streak: 0,
        reasons: ["wilsonLower=0.1000 < demoteBelowWilson=0.5000: demote"],
      }),
      epsilon: trustState({ skillName: "epsilon", status: "active", since: 600, streak: 3, reasons: [] }),
    });

    return { fs, files };
  }

  it("copies a persisted status verbatim and carries its reasons through", () => {
    const { fs } = buildScenario();
    const reader = new SkillTrustReader({ dataDir: DATA_DIR, fs });

    const beta = reader.row("beta");
    expect(beta.status).toBe("probation");
    expect(beta.since).toBe(800);
    expect(beta.streak).toBe(1);
    expect(beta.reasons).toContain(
      "wilsonLower=0.5000 < probationBelowWilson=0.7000: demote active -> probation",
    );

    const gamma = reader.row("gamma");
    expect(gamma.status).toBe("demoted");
    expect(gamma.since).toBe(700);
  });

  it("cross-checks reported numbers against an independently computed Wilson bound", () => {
    const { fs } = buildScenario();
    const reader = new SkillTrustReader({ dataDir: DATA_DIR, fs });

    const alpha = reader.row("alpha");
    expect(alpha.n).toBe(30);
    expect(alpha.verifiedN).toBe(0); // no certSha256 attached by seedOutcomes
    // Independently recomputed from the same public formula, over the same
    // known successes/n this fixture seeded — not trusting the module's
    // own arithmetic circularly.
    expect(alpha.wilsonLower).not.toBeNull();
    // Default trailing window is 20, so the Wilson bound is over the most
    // recent 20 (all-success) entries, not the full n=30 history.
    expect(alpha.wilsonLower).toBeCloseTo(wilsonLowerBound(20, 20), 9);
    expect(alpha.recentBrier).toBeCloseTo(brierScore(Array(20).fill({ predictedP: 1.0, success: true })), 9);

    const beta = reader.row("beta");
    expect(beta.n).toBe(10);
    expect(beta.wilsonLower).toBeCloseTo(wilsonLowerBound(5, 10), 9);
  });

  it("rule (e), forward: trust state present, no track record -> persisted status wins, metrics null", () => {
    const { fs } = buildScenario();
    const reader = new SkillTrustReader({ dataDir: DATA_DIR, fs });

    const epsilon = reader.row("epsilon");
    expect(epsilon.status).toBe("active");
    expect(epsilon.since).toBe(600);
    expect(epsilon.streak).toBe(3);
    expect(epsilon.wilsonLower).toBeNull();
    expect(epsilon.recentBrier).toBeNull();
    expect(epsilon.n).toBe(0);
    expect(epsilon.verifiedN).toBe(0);
    expect(epsilon.reasons.some((r) => r.includes("no current track-record entries"))).toBe(true);
  });

  it("rule (e), reverse: track record present, no trust state -> unscored, metrics non-null", () => {
    const { fs } = buildScenario();
    const reader = new SkillTrustReader({ dataDir: DATA_DIR, fs });

    const delta = reader.row("delta");
    expect(delta.status).toBe("unscored");
    expect(delta.since).toBeNull();
    expect(delta.streak).toBe(0);
    expect(delta.n).toBe(4);
    expect(delta.wilsonLower).not.toBeNull();
    expect(delta.reasons.some((r) => r.includes("no persisted trust evaluation"))).toBe(true);
  });

  it("a name absent from both files is unscored with null metrics", () => {
    const { fs } = buildScenario();
    const reader = new SkillTrustReader({ dataDir: DATA_DIR, fs });
    const zeta = reader.row("zeta");
    expect(zeta.status).toBe("unscored");
    expect(zeta.n).toBe(0);
    expect(zeta.wilsonLower).toBeNull();
    expect(zeta.since).toBeNull();
  });

  it("allKnown() is exactly the union of names in either readable file, sorted, excluding never-mentioned names", () => {
    const { fs } = buildScenario();
    const reader = new SkillTrustReader({ dataDir: DATA_DIR, fs });
    expect(reader.allKnown()).toEqual(["alpha", "alpha2", "beta", "delta", "epsilon", "gamma"]);
  });
});

// ===========================================================================
// Determinism
// ===========================================================================

describe("SkillTrustReader — determinism", () => {
  it("two readers over byte-identical files produce deeply-equal rows and allKnown()", () => {
    const { files } = makeSharedFs();
    seedOutcomes(files, "alpha", 12, 0.75);
    seedTrustFile(files, {
      alpha: trustState({ skillName: "alpha", status: "probation", since: 55, streak: 2, reasons: ["r1"] }),
    });

    const filesA = new Map(files);
    const filesB = new Map(files);
    const fsA: TrustReaderFs = { readFile: (p) => (filesA.has(p) ? (filesA.get(p) as string) : null) };
    const fsB: TrustReaderFs = { readFile: (p) => (filesB.has(p) ? (filesB.get(p) as string) : null) };

    const readerA = new SkillTrustReader({ dataDir: DATA_DIR, fs: fsA });
    const readerB = new SkillTrustReader({ dataDir: DATA_DIR, fs: fsB });

    expect(readerA.allKnown()).toEqual(readerB.allKnown());
    const names = [...readerA.allKnown(), "never-mentioned"];
    expect(readerA.rows(names)).toEqual(readerB.rows(names));
  });
});

// ===========================================================================
// Adversarial — fail-closed integrity behavior (>=5 required; 6 here)
// ===========================================================================

describe("SkillTrustReader — adversarial: fail-closed on integrity failure", () => {
  it("(1) garbage JSON in skill-track.json never reports a skill as unscored", () => {
    const { fs } = makeSharedFs({ [trackPath]: "{not valid json" });
    const reader = new SkillTrustReader({ dataDir: DATA_DIR, fs });
    const row = reader.row("anything");
    expect(row.status).toBe("integrity-error");
    expect(row.status).not.toBe("unscored");
    expect(row.reasons.some((r) => r.includes("skill-track.json is corrupt"))).toBe(true);
  });

  it("(2) garbage JSON in skill-trust.json marks even a perfectly healthy tracked skill integrity-error", () => {
    const { fs, files } = makeSharedFs();
    seedOutcomes(files, "healthy", 5, 1.0);
    files.set(trustPath, "{garbage");

    const reader = new SkillTrustReader({ dataDir: DATA_DIR, fs });
    const row = reader.row("healthy");
    expect(row.status).toBe("integrity-error");
    expect(row.reasons.some((r) => r.includes("skill-trust.json is corrupt"))).toBe(true);
    // Numbers are still copied verbatim from the (real, healthy) track
    // summary — trust-file corruption does not fabricate or null out
    // metrics that genuinely exist on disk.
    expect(row.n).toBe(5);
    expect(row.wilsonLower).not.toBeNull();
  });

  it("(3) a byte-tampered hash-chain entry is integrity-error, without affecting a sibling skill's chain", () => {
    const { fs, files } = makeSharedFs();
    seedOutcomes(files, "tamper-skill", 6, 1.0);
    seedOutcomes(files, "clean-skill", 6, 1.0);

    const envelope = JSON.parse(files.get(trackPath) as string);
    // Flip a field without recomputing the hash chain from that point on.
    envelope.chains["tamper-skill"][2].success = false;
    files.set(trackPath, JSON.stringify(envelope));

    const reader = new SkillTrustReader({ dataDir: DATA_DIR, fs });

    const tampered = reader.row("tamper-skill");
    expect(tampered.status).toBe("integrity-error");
    expect(
      tampered.reasons.some((r) => r.includes("hash-chain integrity check failed") && r.includes("seq=2")),
    ).toBe(true);

    const clean = reader.row("clean-skill");
    expect(clean.status).not.toBe("integrity-error");
    expect(clean.n).toBe(6);
  });

  it("(4) structurally malformed track-record entries reset the whole store, and every queried skill becomes integrity-error", () => {
    const { fs, files } = makeSharedFs();
    seedOutcomes(files, "victim-skill", 3, 1.0);
    seedOutcomes(files, "other-victim", 3, 1.0);

    const envelope = JSON.parse(files.get(trackPath) as string);
    delete envelope.chains["victim-skill"][0].hash; // required field missing
    files.set(trackPath, JSON.stringify(envelope));

    const reader = new SkillTrustReader({ dataDir: DATA_DIR, fs });
    const victim = reader.row("victim-skill");
    expect(victim.status).toBe("integrity-error");
    expect(victim.n).toBe(0); // whole store reset to empty — nothing readable survives
    const other = reader.row("other-victim");
    expect(other.status).toBe("integrity-error"); // globally affected too
    expect(other.n).toBe(0);
  });

  it("(5) an unsupported skill-trust.json envelope version is treated as corrupt, not empty", () => {
    const { fs } = makeSharedFs({ [trustPath]: JSON.stringify({ version: 2, states: {} }) });
    const reader = new SkillTrustReader({ dataDir: DATA_DIR, fs });
    const row = reader.row("whatever");
    expect(row.status).toBe("integrity-error");
    expect(row.reasons.some((r) => r.includes("skill-trust.json is corrupt"))).toBe(true);
  });

  it("(6) a filesystem that throws on read (not ENOENT) is treated as an integrity failure, never a crash", () => {
    const fs: TrustReaderFs = {
      readFile() {
        throw new Error("EACCES: permission denied");
      },
    };
    expect(() => new SkillTrustReader({ dataDir: DATA_DIR, fs })).not.toThrow();
    const reader = new SkillTrustReader({ dataDir: DATA_DIR, fs });
    expect(() => reader.row("x")).not.toThrow();
    expect(reader.row("x").status).toBe("integrity-error");
  });

  it("independent brier/wilson recomputation does not spuriously fire on real, untampered data", () => {
    // Positive-control companion to the adversarial cases above: across a
    // reasonably large, varied real track record, the cross-check must
    // never itself produce a false positive.
    const { fs, files } = makeSharedFs();
    seedOutcomes(files, "solid", 47, 0.83);
    const reader = new SkillTrustReader({ dataDir: DATA_DIR, fs });
    const row = reader.row("solid");
    expect(row.status).not.toBe("integrity-error");
    expect(row.n).toBe(47);
  });
});

// ===========================================================================
// Default (real) filesystem
// ===========================================================================

describe("SkillTrustReader — default real node:fs", () => {
  it("reads real persisted files from a real temp directory, and treats a missing file as unscored (not an error)", () => {
    const dir = mkdtempSync(join(tmpdir(), "trust-selection-test-"));
    try {
      mkdirSync(dir, { recursive: true });
      // Build a real skill-track.json via the real store, over the real fs.
      const realStore = new SkillTrackRecordStore({ path: join(dir, "x"), now: () => 1000 });
      for (let i = 0; i < 5; i++) {
        realStore.record({ skillName: "real-skill", predictedP: 1, success: true, at: 1000 + i });
      }
      // No skill-trust.json written at all.

      const reader = new SkillTrustReader({ dataDir: dir });
      const row = reader.row("real-skill");
      expect(row.status).toBe("unscored");
      expect(row.n).toBe(5);
      expect(row.wilsonLower).not.toBeNull();

      const missing = reader.row("never-existed");
      expect(missing.status).toBe("unscored");
      expect(missing.n).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a garbage real skill-trust.json on disk is read as corrupt, not silently ignored", () => {
    const dir = mkdtempSync(join(tmpdir(), "trust-selection-test-"));
    try {
      writeFileSync(join(dir, "skill-trust.json"), "definitely not json", "utf8");
      const reader = new SkillTrustReader({ dataDir: dir });
      expect(reader.row("anything").status).toBe("integrity-error");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
// resolveWithTrust
// ===========================================================================

describe("resolveWithTrust", () => {
  function buildResolveScenario() {
    const { fs, files } = makeSharedFs();
    seedOutcomes(files, "alpha", 20, 0.95);
    seedOutcomes(files, "beta", 10, 0.5);
    seedOutcomes(files, "gamma", 8, 0.2);

    seedTrustFile(files, {
      alpha: trustState({ skillName: "alpha", status: "active", since: 1, streak: 5, reasons: [] }),
      beta: trustState({ skillName: "beta", status: "probation", since: 2, streak: 1, reasons: ["on watch"] }),
      gamma: trustState({ skillName: "gamma", status: "demoted", since: 3, streak: 0, reasons: ["too many failures"] }),
    });

    const library = buildLibrary([
      { name: "alpha", capabilities: ["alpha-cap"], tools: ["missingToolX"] },
      { name: "beta", capabilities: ["beta-cap"], tools: [] },
      { name: "gamma", capabilities: ["gamma-cap"], tools: ["gammaTool"] },
    ]);
    const tools = { get: (name: string) => (name === "gammaTool" ? { name: "gammaTool" } : undefined) };

    const reader = new SkillTrustReader({ dataDir: DATA_DIR, fs });
    return { library, tools, reader };
  }

  it("excludes a demoted skill by default: its capabilities/tools never leak into the resolution", () => {
    const { library, tools, reader } = buildResolveScenario();
    const res = resolveWithTrust(library, ["alpha", "beta", "gamma", "notinlibrary"], tools, reader);

    expect(res.skills.map((s) => s.name).sort()).toEqual(["alpha", "beta"]);
    expect(res.capabilities).toContain("beta-cap");
    expect(res.capabilities).not.toContain("gamma-cap");
    expect(res.missingTools).toEqual(["missingToolX"]); // gamma's tool never even considered
    expect(res.unknownSkills).toEqual(["notinlibrary"]); // rule (h): unknown flows through unchanged

    expect(res.excluded).toHaveLength(1);
    expect(res.excluded[0].name).toBe("gamma");
    expect(res.excluded[0].status).toBe("demoted");
    expect(res.excluded[0].reasons.some((r) => r.includes("status=demoted"))).toBe(true);

    expect(res.deprioritized).toHaveLength(1);
    expect(res.deprioritized[0].name).toBe("beta");
    expect(res.deprioritized[0].reasons.some((r) => r.includes("status=probation"))).toBe(true);

    // Labeling never hides state: gamma's TRUE status is still reported.
    expect(res.trust.find((r) => r.skillName === "gamma")?.status).toBe("demoted");
    expect(res.trust.map((r) => r.skillName)).toEqual(["alpha", "beta", "gamma", "notinlibrary"]);
  });

  it("includeDemoted:true restores the demoted skill but still labels the override explicitly", () => {
    const { library, tools, reader } = buildResolveScenario();
    const res = resolveWithTrust(library, ["alpha", "beta", "gamma"], tools, reader, { includeDemoted: true });

    expect(res.skills.map((s) => s.name).sort()).toEqual(["alpha", "beta", "gamma"]);
    expect(res.capabilities).toContain("gamma-cap");
    expect(res.excluded).toEqual([]);

    expect(res.deprioritized.map((d) => d.name).sort()).toEqual(["beta", "gamma"]);
    const gammaOverride = res.deprioritized.find((d) => d.name === "gamma")!;
    expect(gammaOverride.reasons.some((r) => r.includes("includeDemoted override"))).toBe(true);
    // Override never hides state: trust[] still reports the true status.
    expect(res.trust.find((r) => r.skillName === "gamma")?.status).toBe("demoted");
  });

  it("never includes an integrity-error skill, even with includeDemoted:true", () => {
    const { fs } = makeSharedFs({ [trustPath]: "not json at all" });
    const library = buildLibrary([{ name: "broken-skill" }]);
    const reader = new SkillTrustReader({ dataDir: DATA_DIR, fs });

    const res = resolveWithTrust(library, ["broken-skill"], emptyTools, reader, { includeDemoted: true });
    expect(res.skills).toEqual([]);
    expect(res.deprioritized).toEqual([]);
    expect(res.excluded).toHaveLength(1);
    expect(res.excluded[0]).toMatchObject({ name: "broken-skill", status: "integrity-error" });
  });

  it("an active skill is included with no exclude/deprioritize entry", () => {
    const { library, tools, reader } = buildResolveScenario();
    const res = resolveWithTrust(library, ["alpha"], tools, reader);
    expect(res.skills.map((s) => s.name)).toEqual(["alpha"]);
    expect(res.excluded).toEqual([]);
    expect(res.deprioritized).toEqual([]);
  });
});

// ===========================================================================
// orderByTrust
// ===========================================================================

describe("orderByTrust", () => {
  it("orders active (by wilsonLower desc) > unscored > probation > demoted, tie-broken by name", () => {
    const { fs, files } = makeSharedFs();
    seedOutcomes(files, "alpha", 30, 1.0); // strong active
    seedOutcomes(files, "alpha2", 15, 0.6); // weaker active
    seedOutcomes(files, "beta", 10, 0.5); // probation
    seedOutcomes(files, "gamma", 8, 0.3); // demoted
    seedOutcomes(files, "delta", 4, 1.0); // unscored (has data, no trust entry)
    // zeta: unscored, no data anywhere.
    // epsilon: active, no track data (null wilsonLower -> bottom of active group).

    seedTrustFile(files, {
      alpha: trustState({ skillName: "alpha", status: "active" }),
      alpha2: trustState({ skillName: "alpha2", status: "active" }),
      beta: trustState({ skillName: "beta", status: "probation" }),
      gamma: trustState({ skillName: "gamma", status: "demoted" }),
      epsilon: trustState({ skillName: "epsilon", status: "active" }),
    });

    const library = buildLibrary(
      ["alpha", "alpha2", "beta", "gamma", "delta", "epsilon", "zeta"].map((name) => ({ name })),
    );
    const reader = new SkillTrustReader({ dataDir: DATA_DIR, fs });
    const loaded: LoadedSkill[] = library.list();

    const ordered = orderByTrust(loaded, reader);
    expect(ordered.map((o) => o.skill.manifest.name)).toEqual([
      "alpha",
      "alpha2",
      "epsilon",
      "delta",
      "zeta",
      "beta",
      "gamma",
    ]);
    // Sanity: the wilson values actually driving the active-group order.
    const alphaRow = ordered.find((o) => o.skill.manifest.name === "alpha")!.trust;
    const alpha2Row = ordered.find((o) => o.skill.manifest.name === "alpha2")!.trust;
    expect(alphaRow.wilsonLower!).toBeGreaterThan(alpha2Row.wilsonLower!);
  });

  it("never drops a skill: demoted and integrity-error skills are listed last, not removed", () => {
    const { fs, files } = makeSharedFs();
    seedOutcomes(files, "healthy", 10, 1.0);
    seedOutcomes(files, "banned", 5, 0.1);
    seedOutcomes(files, "corrupted", 5, 1.0);

    seedTrustFile(files, {
      healthy: trustState({ skillName: "healthy", status: "active" }),
      banned: trustState({ skillName: "banned", status: "demoted" }),
    });

    // Tamper "corrupted"'s chain -> integrity-error, independent of any
    // trust-file entry (it has none).
    const envelope = JSON.parse(files.get(trackPath) as string);
    envelope.chains["corrupted"][1].predictedP = 0.01;
    files.set(trackPath, JSON.stringify(envelope));

    const library = buildLibrary(["healthy", "banned", "corrupted"].map((name) => ({ name })));
    const reader = new SkillTrustReader({ dataDir: DATA_DIR, fs });
    const ordered = orderByTrust(library.list(), reader);

    expect(ordered).toHaveLength(3);
    expect(ordered.map((o) => o.skill.manifest.name)).toEqual(["healthy", "banned", "corrupted"]);
    expect(ordered.find((o) => o.skill.manifest.name === "corrupted")!.trust.status).toBe("integrity-error");
    expect(ordered.find((o) => o.skill.manifest.name === "banned")!.trust.status).toBe("demoted");
  });

  it("is stable and tie-broken by name for skills sharing the same non-active status", () => {
    const { fs, files } = makeSharedFs();
    seedOutcomes(files, "zed-probation", 10, 0.5);
    seedOutcomes(files, "aardvark-probation", 10, 0.5);
    seedTrustFile(files, {
      "zed-probation": trustState({ skillName: "zed-probation", status: "probation" }),
      "aardvark-probation": trustState({ skillName: "aardvark-probation", status: "probation" }),
    });
    const library = buildLibrary([{ name: "zed-probation" }, { name: "aardvark-probation" }]);
    const reader = new SkillTrustReader({ dataDir: DATA_DIR, fs });
    const ordered = orderByTrust(library.list(), reader);
    expect(ordered.map((o) => o.skill.manifest.name)).toEqual(["aardvark-probation", "zed-probation"]);
  });
});
