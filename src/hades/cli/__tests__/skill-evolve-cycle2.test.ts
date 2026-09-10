/**
 * Cycle-2 central-integration tests for the new `hades skill` subcommands:
 *
 *   trust show    — read-only, fail-closed effective-trust report
 *   track-batch   — gate-verdict batch recording (GateTrackRecorder)
 *   holdout       — paired candidate-vs-incumbent exit gate over recorded runs
 *
 * Everything drives `runSkillEvolveCommand` end to end over an in-memory fs
 * (the same double skill-evolve-command.test.ts uses). REAL-VS-MOCK POLICY:
 * every metric asserted is recomputed with the real exported `brierScore`/
 * `wilsonLowerBound`, and every persisted fixture is built by the real
 * engines (`SkillTrackRecordStore` hash chaining, the command's own `trust`
 * evaluation) — never hand-forged store JSON.
 */
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import { runSkillEvolveCommand, type SkillEvolveFs } from "../skill-evolve-command";
import { SkillTrackRecordStore, wilsonLowerBound } from "../../skills/track-record";
import { skillTemplate } from "../../skills/skill-file";
import type { GatedSkillUse } from "../../skills/gate-track-hook";

// ---------------------------------------------------------------------------
// In-memory fs double (mirrors skill-evolve-command.test.ts)
// ---------------------------------------------------------------------------

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
    for (const f of this.files.keys()) if (f.startsWith(prefix)) return true;
    return false;
  }
}

const DIR = "/skills";
const DATA = "/data";

function opts(fs: InMemoryFs, now = 10_000): { dir: string; dataDir: string; fs: SkillEvolveFs; now: () => number } {
  let t = now;
  return { dir: DIR, dataDir: DATA, fs, now: () => t++ };
}

function fmt(n: number): string {
  return n.toFixed(4);
}

/** Seed a REAL hash-chained track record through the same in-memory fs the command reads. */
function seedTrack(
  fs: InMemoryFs,
  skillName: string,
  outcomes: Array<{ predictedP: number; success: boolean; cert?: string }>
): void {
  const store = new SkillTrackRecordStore({
    path: join(DATA, "skill-track.json"),
    fs: {
      readFile: (p) => fs.readFile(p),
      writeFile: (p, c) => fs.writeFile(p, c),
      mkdirp: (d) => fs.mkdirp(d),
    },
  });
  outcomes.forEach((o, i) =>
    store.record({
      skillName,
      predictedP: o.predictedP,
      success: o.success,
      at: 1000 + i,
      ...(o.cert !== undefined ? { certSha256: o.cert } : {}),
    })
  );
}

// ---------------------------------------------------------------------------
// trust show
// ---------------------------------------------------------------------------

describe("hades skill trust show", () => {
  it("reports honestly when there is nothing at all", async () => {
    const fs = new InMemoryFs();
    const res = await runSkillEvolveCommand(["trust", "show"], opts(fs));
    expect(res.code).toBe(0);
    expect(res.lines).toEqual(["No skills found and no trust or track records to report."]);
  });

  it("reads back the persisted decision with real store metrics, and unscored for history-less skills", async () => {
    const fs = new InMemoryFs();
    fs.writeFile(join(DIR, "beta.md"), skillTemplate("beta"));
    seedTrack(fs, "alpha", [
      { predictedP: 0.9, success: true, cert: "c1" },
      { predictedP: 0.9, success: true, cert: "c2" },
      { predictedP: 0.8, success: true, cert: "c3" },
    ]);

    // Persist a decision through the real evaluate-and-persist path first.
    const evaluated = await runSkillEvolveCommand(["trust"], opts(fs));
    expect(evaluated.code).toBe(0);

    const res = await runSkillEvolveCommand(["trust", "show"], opts(fs));
    expect(res.code).toBe(0);
    const alpha = res.lines.find((l) => l.startsWith("alpha "));
    const beta = res.lines.find((l) => l.startsWith("beta "));
    expect(alpha).toContain("status=active");
    expect(alpha).toContain(`wilson=${fmt(wilsonLowerBound(3, 3))}`);
    expect(alpha).toContain("n=3 verifiedN=3");
    expect(beta).toContain("status=unscored");
    expect(beta).toContain("wilson=- brier=- n=0 verifiedN=0");
  });

  it("is fail-closed: a corrupt track store reports integrity-error (exit 1), never unscored", async () => {
    const fs = new InMemoryFs();
    seedTrack(fs, "alpha", [{ predictedP: 0.9, success: true, cert: "c1" }]);
    fs.writeFile(join(DATA, "skill-track.json"), "{ definitely not json");

    // With nothing enumerable at all, the corruption itself is reported —
    // never "no skills found".
    const res = await runSkillEvolveCommand(["trust", "show"], opts(fs));
    expect(res.code).toBe(1);
    expect(res.lines.some((l) => l.startsWith("integrity-error:") && l.includes("skill-track.json"))).toBe(true);
    // And any skill visible via the skills dir reports integrity-error per row:
    const fs2 = new InMemoryFs();
    fs2.writeFile(join(DIR, "alpha.md"), skillTemplate("alpha"));
    fs2.writeFile(join(DATA, "skill-track.json"), "{ definitely not json");
    const res2 = await runSkillEvolveCommand(["trust", "show"], opts(fs2));
    expect(res2.code).toBe(1);
    expect(res2.lines.find((l) => l.startsWith("alpha "))).toContain("status=integrity-error");
  });

  it("rejects unknown flags", async () => {
    const fs = new InMemoryFs();
    const res = await runSkillEvolveCommand(["trust", "show", "--wat"], opts(fs));
    expect(res.code).toBe(1);
    expect(res.lines[0]).toContain("Unknown flag(s) for trust show");
  });
});

// ---------------------------------------------------------------------------
// track-batch
// ---------------------------------------------------------------------------

function use(overrides: Partial<GatedSkillUse>): GatedSkillUse {
  return {
    skillNames: ["alpha"],
    verdict: "accept",
    pCorrect: 0.9,
    taskId: "task-1",
    at: 5_000,
    ...overrides,
  };
}

describe("hades skill track-batch", () => {
  it("records accept/reject, surfaces abstain, and the summary matches independent recomputation", async () => {
    const fs = new InMemoryFs();
    const uses: GatedSkillUse[] = [
      use({ taskId: "t1", at: 5_000, certSha256: "cert-a" }),
      use({ taskId: "t2", at: 5_001, verdict: "reject", pCorrect: 0.7 }),
      use({ taskId: "t3", at: 5_002, verdict: "abstain" }),
    ];
    fs.writeFile("/in/uses.json", JSON.stringify(uses));

    const res = await runSkillEvolveCommand(["track-batch", "/in/uses.json"], opts(fs));
    expect(res.code).toBe(0);
    expect(res.lines[0]).toBe("Recorded 2 outcome(s), skipped 1.");
    expect(res.lines).toContain("  + alpha cert=cert-a");
    expect(res.lines.some((l) => l.startsWith("  - alpha [abstain]"))).toBe(true);
    // 1 success out of 2 recorded outcomes — real Wilson, recomputed here.
    const summary = res.lines.find((l) => l.startsWith("alpha  n=2"));
    expect(summary).toContain(`wilsonLower=${fmt(wilsonLowerBound(1, 2))}`);
    expect(summary).toContain("integrity=ok");
  });

  it("is idempotent for certificate-backed uses across separate invocations", async () => {
    const fs = new InMemoryFs();
    fs.writeFile("/in/one.json", JSON.stringify([use({ certSha256: "cert-a" })]));

    const first = await runSkillEvolveCommand(["track-batch", "/in/one.json"], opts(fs));
    expect(first.code).toBe(0);
    expect(first.lines[0]).toBe("Recorded 1 outcome(s), skipped 0.");

    const second = await runSkillEvolveCommand(["track-batch", "/in/one.json"], opts(fs));
    expect(second.code).toBe(0);
    expect(second.lines[0]).toBe("Recorded 0 outcome(s), skipped 1.");
    expect(second.lines.some((l) => l.includes("[duplicate]"))).toBe(true);
  });

  it("skips invalid forecasts without clamping and exits nonzero", async () => {
    const fs = new InMemoryFs();
    fs.writeFile("/in/bad.json", JSON.stringify([use({ pCorrect: 1.5 })]));
    const res = await runSkillEvolveCommand(["track-batch", "/in/bad.json"], opts(fs));
    expect(res.code).toBe(1);
    expect(res.lines.some((l) => l.includes("[invalid-p]") && l.includes("refusing to clamp"))).toBe(true);
  });

  it("refuses to write over a corrupt store (store-integrity) and leaves the bytes untouched", async () => {
    const fs = new InMemoryFs();
    fs.writeFile(join(DATA, "skill-track.json"), "{ garbage");
    fs.writeFile("/in/uses.json", JSON.stringify([use({ certSha256: "cert-a" })]));
    const before = fs.readFile(join(DATA, "skill-track.json"));

    const res = await runSkillEvolveCommand(["track-batch", "/in/uses.json"], opts(fs));
    expect(res.code).toBe(1);
    expect(res.lines.some((l) => l.includes("[store-integrity]"))).toBe(true);
    expect(fs.readFile(join(DATA, "skill-track.json"))).toBe(before);
  });

  it("rejects a missing or malformed uses file", async () => {
    const fs = new InMemoryFs();
    expect((await runSkillEvolveCommand(["track-batch"], opts(fs))).code).toBe(1);
    expect((await runSkillEvolveCommand(["track-batch", "/nope.json"], opts(fs))).code).toBe(1);
    fs.writeFile("/in/bad.json", "not json");
    expect((await runSkillEvolveCommand(["track-batch", "/in/bad.json"], opts(fs))).code).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// holdout
// ---------------------------------------------------------------------------

function suite(n: number): Array<{ id: string; objective: string }> {
  return Array.from({ length: n }, (_, i) => ({ id: `c${i + 1}`, objective: `do thing ${i + 1}` }));
}

function results(
  n: number,
  make: (i: number) => { success: boolean; verified: boolean; predictedP: number; certSha256?: string }
): Array<Record<string, unknown>> {
  return Array.from({ length: n }, (_, i) => ({ caseId: `c${i + 1}`, ...make(i) }));
}

const verifiedSuccess = (): { success: boolean; verified: boolean; predictedP: number; certSha256: string } => ({
  success: true,
  verified: true,
  predictedP: 0.9,
  certSha256: "cafebabe",
});

describe("hades skill holdout", () => {
  it("requires the skill name and the three evidence flags", async () => {
    const fs = new InMemoryFs();
    expect((await runSkillEvolveCommand(["holdout"], opts(fs))).code).toBe(1);
    fs.writeFile("/in/cand.md", skillTemplate("newskill"));
    const res = await runSkillEvolveCommand(["holdout", "newskill", "--candidate", "/in/cand.md"], opts(fs));
    expect(res.code).toBe(1);
    expect(res.lines[0]).toContain("--suite");
  });

  it("no incumbent: accepts on real verified evidence clearing the floor, and --apply installs the candidate", async () => {
    const fs = new InMemoryFs();
    const candidate = skillTemplate("newskill");
    fs.writeFile("/in/cand.md", candidate);
    fs.writeFile("/in/suite.json", JSON.stringify(suite(5)));
    fs.writeFile("/in/res.json", JSON.stringify(results(5, verifiedSuccess)));

    const res = await runSkillEvolveCommand(
      ["holdout", "newskill", "--candidate", "/in/cand.md", "--suite", "/in/suite.json", "--results", "/in/res.json", "--min-wilson", "0.5", "--apply"],
      opts(fs)
    );
    expect(res.code).toBe(0);
    expect(res.lines[0]).toBe('Holdout verdict for "newskill": accept');
    expect(res.lines.some((l) => l.includes(`wilsonLower=${fmt(wilsonLowerBound(5, 5))}`))).toBe(true);
    expect(res.lines).toContain("applied: candidate (/skills/newskill.md)");
    expect(fs.readFile(join(DIR, "newskill.md"))).toBe(candidate);
  });

  it("no incumbent: unverified successes count for nothing under requireVerified, and rollback-with-nothing refuses to write", async () => {
    const fs = new InMemoryFs();
    fs.writeFile("/in/cand.md", skillTemplate("newskill"));
    fs.writeFile("/in/suite.json", JSON.stringify(suite(5)));
    fs.writeFile(
      "/in/res.json",
      JSON.stringify(results(5, () => ({ success: true, verified: false, predictedP: 0.9 })))
    );

    const res = await runSkillEvolveCommand(
      ["holdout", "newskill", "--candidate", "/in/cand.md", "--suite", "/in/suite.json", "--results", "/in/res.json", "--apply"],
      opts(fs)
    );
    expect(res.code).toBe(1);
    expect(res.lines[0]).toBe('Holdout verdict for "newskill": rollback');
    expect(res.lines.some((l) => l.includes(`wilsonLower=${fmt(wilsonLowerBound(0, 5))}`))).toBe(true);
    expect(res.lines).toContain("applied: none (/skills/newskill.md)");
    expect(fs.readFile(join(DIR, "newskill.md"))).toBeNull();
  });

  it("paired: a candidate that does not beat the incumbent by minLift rolls back and --apply restores the incumbent bytes", async () => {
    const fs = new InMemoryFs();
    const incumbent = skillTemplate("pair");
    const candidate = `${incumbent}\nExtra learned caveat.\n`;
    fs.writeFile(join(DIR, "pair.md"), incumbent);
    fs.writeFile("/in/cand.md", candidate);
    fs.writeFile("/in/suite.json", JSON.stringify(suite(5)));
    fs.writeFile("/in/cand-res.json", JSON.stringify(results(5, (i) => (i < 3 ? verifiedSuccess() : { success: false, verified: false, predictedP: 0.6 }))));
    fs.writeFile("/in/inc-res.json", JSON.stringify(results(5, verifiedSuccess)));

    const res = await runSkillEvolveCommand(
      [
        "holdout", "pair",
        "--candidate", "/in/cand.md",
        "--suite", "/in/suite.json",
        "--results", "/in/cand-res.json",
        "--incumbent-results", "/in/inc-res.json",
        "--apply",
      ],
      opts(fs)
    );
    expect(res.code).toBe(1);
    expect(res.lines[0]).toBe('Holdout verdict for "pair": rollback');
    expect(res.lines.some((l) => l.startsWith("candidate:") && l.includes(`wilsonLower=${fmt(wilsonLowerBound(3, 5))}`))).toBe(true);
    expect(res.lines.some((l) => l.startsWith("incumbent:") && l.includes(`wilsonLower=${fmt(wilsonLowerBound(5, 5))}`))).toBe(true);
    expect(res.lines).toContain("applied: incumbent (/skills/pair.md)");
    expect(fs.readFile(join(DIR, "pair.md"))).toBe(incumbent);
  });

  it("paired: an installed incumbent without --incumbent-results is refused outright", async () => {
    const fs = new InMemoryFs();
    fs.writeFile(join(DIR, "pair.md"), skillTemplate("pair"));
    fs.writeFile("/in/cand.md", `${skillTemplate("pair")}\nMore.\n`);
    fs.writeFile("/in/suite.json", JSON.stringify(suite(5)));
    fs.writeFile("/in/res.json", JSON.stringify(results(5, verifiedSuccess)));

    const res = await runSkillEvolveCommand(
      ["holdout", "pair", "--candidate", "/in/cand.md", "--suite", "/in/suite.json", "--results", "/in/res.json"],
      opts(fs)
    );
    expect(res.code).toBe(1);
    expect(res.lines[0]).toContain("--incumbent-results");
  });

  it("abstains on a suite thinner than minCases (dry run touches nothing)", async () => {
    const fs = new InMemoryFs();
    fs.writeFile("/in/cand.md", skillTemplate("newskill"));
    fs.writeFile("/in/suite.json", JSON.stringify(suite(3)));
    fs.writeFile("/in/res.json", JSON.stringify(results(3, verifiedSuccess)));

    const res = await runSkillEvolveCommand(
      ["holdout", "newskill", "--candidate", "/in/cand.md", "--suite", "/in/suite.json", "--results", "/in/res.json"],
      opts(fs)
    );
    expect(res.code).toBe(1);
    expect(res.lines[0]).toBe('Holdout verdict for "newskill": abstain');
    expect(res.lines.some((l) => l.includes("dry run"))).toBe(true);
    expect(fs.readFile(join(DIR, "newskill.md"))).toBeNull();
  });

  it("a case missing from the results file weakens the arm (thrown -> excluded from usable n), it never helps", async () => {
    const fs = new InMemoryFs();
    fs.writeFile("/in/cand.md", skillTemplate("newskill"));
    fs.writeFile("/in/suite.json", JSON.stringify(suite(5)));
    // Only 4 of 5 cases have recorded results -> usable n=4 < minCases=5 -> abstain.
    fs.writeFile("/in/res.json", JSON.stringify(results(4, verifiedSuccess)));

    const res = await runSkillEvolveCommand(
      ["holdout", "newskill", "--candidate", "/in/cand.md", "--suite", "/in/suite.json", "--results", "/in/res.json"],
      opts(fs)
    );
    expect(res.code).toBe(1);
    expect(res.lines[0]).toBe('Holdout verdict for "newskill": abstain');
    expect(res.lines.some((l) => l.includes("candidate runner threw on 1/5 case(s) (c5)"))).toBe(true);
    expect(res.lines.some((l) => l.includes("candidate usable n=4 < minCases=5"))).toBe(true);
  });

  it("rejects duplicate caseIds in a results file — recorded evidence must be unambiguous", async () => {
    const fs = new InMemoryFs();
    fs.writeFile("/in/cand.md", skillTemplate("newskill"));
    fs.writeFile("/in/suite.json", JSON.stringify(suite(5)));
    const dup = results(5, verifiedSuccess);
    dup.push({ caseId: "c1", ...verifiedSuccess() });
    fs.writeFile("/in/res.json", JSON.stringify(dup));

    const res = await runSkillEvolveCommand(
      ["holdout", "newskill", "--candidate", "/in/cand.md", "--suite", "/in/suite.json", "--results", "/in/res.json"],
      opts(fs)
    );
    expect(res.code).toBe(1);
    expect(res.lines[0]).toContain('two results for case "c1"');
  });

  it("refuses a candidate byte-identical to the installed skill", async () => {
    const fs = new InMemoryFs();
    const content = skillTemplate("pair");
    fs.writeFile(join(DIR, "pair.md"), content);
    fs.writeFile("/in/cand.md", content);
    fs.writeFile("/in/suite.json", JSON.stringify(suite(5)));
    fs.writeFile("/in/res.json", JSON.stringify(results(5, verifiedSuccess)));

    const res = await runSkillEvolveCommand(
      ["holdout", "pair", "--candidate", "/in/cand.md", "--suite", "/in/suite.json", "--results", "/in/res.json"],
      opts(fs)
    );
    expect(res.code).toBe(1);
    expect(res.lines[0]).toContain("byte-identical");
  });
});
