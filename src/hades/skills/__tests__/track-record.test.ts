/* ------------------------------------------------------------------ *
 * track-record.test.ts
 *
 * REAL-VS-MOCK POLICY: most tests use an injected in-memory `TrackRecordFs`
 * (a plain `Map<string,string>` behind the three-method interface) so
 * cross-instance persistence and on-disk tamper simulation are exact and
 * fast. A handful of tests exercise the REAL default filesystem against a
 * real `mkdtemp`'d directory (never `/tmp` directly), including the
 * atomicity test, which follows the same `vi.doMock("node:fs", ...)`
 * pattern used by `schedule/__tests__/receipt-ledger.test.ts` — Vitest's
 * ESM module namespace is not `vi.spyOn`-configurable, so instrumenting
 * `writeFileSync`/`renameSync` requires a dynamically-imported, freshly
 * mocked instance of the module under test.
 * ------------------------------------------------------------------ */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  SkillTrackRecordStore,
  TrackRecordValidationError,
  brierScore,
  wilsonLowerBound,
  type TrackRecordFs,
} from "../track-record";

// ===========================================================================
// helpers
// ===========================================================================

/** An in-memory `TrackRecordFs` whose backing `Map` can be shared across
 * multiple store instances (to test cross-process-style persistence) and
 * hand-edited between loads (to simulate on-disk tampering). */
function makeSharedFs(): { fs: TrackRecordFs; files: Map<string, string>; log: string[] } {
  const files = new Map<string, string>();
  const log: string[] = [];
  const fs: TrackRecordFs = {
    readFile(p) {
      log.push(`read:${p}`);
      return files.has(p) ? (files.get(p) as string) : null;
    },
    writeFile(p, c) {
      log.push(`write:${p}`);
      files.set(p, c);
    },
    mkdirp(d) {
      log.push(`mkdirp:${d}`);
    },
  };
  return { fs, files, log };
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "track-record-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ===========================================================================
// brierScore — hand-computed fixtures
// ===========================================================================

describe("brierScore", () => {
  it("is exactly 0 for perfectly-calibrated, always-correct forecasts", () => {
    expect(
      brierScore([
        { predictedP: 1, success: true },
        { predictedP: 0, success: false },
        { predictedP: 1, success: true },
      ]),
    ).toBe(0);
  });

  it("is exactly 1 for maximally-wrong forecasts", () => {
    // predicting certain success but it fails: (1-0)^2 = 1
    // predicting certain failure but it succeeds: (0-1)^2 = 1
    expect(
      brierScore([
        { predictedP: 1, success: false },
        { predictedP: 0, success: true },
      ]),
    ).toBe(1);
  });

  it("is exactly 0.25 for a maximally-uninformative 0.5 forecast regardless of outcome", () => {
    // (0.5-1)^2 = 0.25 and (0.5-0)^2 = 0.25 either way
    expect(
      brierScore([
        { predictedP: 0.5, success: true },
        { predictedP: 0.5, success: false },
        { predictedP: 0.5, success: true },
        { predictedP: 0.5, success: false },
      ]),
    ).toBeCloseTo(0.25, 12);
  });

  it("matches a hand-computed mixed fixture", () => {
    // errors: (0.9-1)^2=0.01, (0.2-0)^2=0.04, (0.6-1)^2=0.16 -> sum=0.21, mean=0.07
    const score = brierScore([
      { predictedP: 0.9, success: true },
      { predictedP: 0.2, success: false },
      { predictedP: 0.6, success: true },
    ]);
    expect(score).toBeCloseTo(0.07, 10);
  });

  it("returns NaN for an empty set (mean of nothing is undefined)", () => {
    expect(Number.isNaN(brierScore([]))).toBe(true);
  });
});

// ===========================================================================
// wilsonLowerBound — published reference values + monotonicity
// ===========================================================================

describe("wilsonLowerBound", () => {
  it("is exactly 0 at n=0 (no information)", () => {
    expect(wilsonLowerBound(0, 0)).toBe(0);
  });

  it("matches the published 8/10 @ z=1.96 reference value (~0.4901)", () => {
    expect(wilsonLowerBound(8, 10, 1.96)).toBeCloseTo(0.4901, 3);
  });

  it("is (mathematically) exactly 0 when successes=0 for any n, up to float rounding", () => {
    // centre = z^2/(2n), margin = z * z/(2n) = z^2/(2n) -> centre - margin = 0
    expect(wilsonLowerBound(0, 10)).toBeCloseTo(0, 9);
    expect(wilsonLowerBound(0, 1000)).toBeCloseTo(0, 9);
  });

  it("is strictly monotonically increasing in n for a fixed success proportion, approaching p", () => {
    const n10 = wilsonLowerBound(8, 10);
    const n100 = wilsonLowerBound(80, 100);
    const n1000 = wilsonLowerBound(800, 1000);
    const n100000 = wilsonLowerBound(80_000, 100_000);
    expect(n10).toBeLessThan(n100);
    expect(n100).toBeLessThan(n1000);
    expect(n1000).toBeLessThan(n100000);
    expect(n100000).toBeLessThan(0.8);
    expect(n100000).toBeGreaterThan(0.79);
  });

  it("defaults z to 1.96 (explicit and implicit z agree)", () => {
    expect(wilsonLowerBound(8, 10)).toBe(wilsonLowerBound(8, 10, 1.96));
  });

  it("a wider z (more confidence) produces a lower (more conservative) bound", () => {
    expect(wilsonLowerBound(8, 10, 2.58)).toBeLessThan(wilsonLowerBound(8, 10, 1.96));
  });
});

// ===========================================================================
// record() input validation — typed errors, never persisted
// ===========================================================================

describe("SkillTrackRecordStore.record — validation", () => {
  function freshStore() {
    const { fs } = makeSharedFs();
    return new SkillTrackRecordStore({ path: "/virtual/store/x", fs, now: () => 0 });
  }

  it("rejects NaN predictedP with a typed error and persists nothing", () => {
    const store = freshStore();
    expect(() => store.record({ skillName: "s", predictedP: NaN, success: true, at: 1 })).toThrow(
      TrackRecordValidationError,
    );
    expect(store.entries("s")).toHaveLength(0);
  });

  it("rejects +Infinity and -Infinity predictedP", () => {
    const store = freshStore();
    expect(() => store.record({ skillName: "s", predictedP: Infinity, success: true, at: 1 })).toThrow(
      TrackRecordValidationError,
    );
    expect(() => store.record({ skillName: "s", predictedP: -Infinity, success: true, at: 1 })).toThrow(
      TrackRecordValidationError,
    );
  });

  it("rejects out-of-[0,1] predictedP just outside the boundary", () => {
    const store = freshStore();
    expect(() => store.record({ skillName: "s", predictedP: -0.0001, success: true, at: 1 })).toThrow(
      TrackRecordValidationError,
    );
    expect(() => store.record({ skillName: "s", predictedP: 1.0001, success: true, at: 1 })).toThrow(
      TrackRecordValidationError,
    );
  });

  it("accepts predictedP exactly at the 0 and 1 boundaries", () => {
    const store = freshStore();
    expect(() => store.record({ skillName: "s", predictedP: 0, success: false, at: 1 })).not.toThrow();
    expect(() => store.record({ skillName: "s", predictedP: 1, success: true, at: 2 })).not.toThrow();
    expect(store.entries("s")).toHaveLength(2);
  });

  it("rejects an empty or whitespace-only skillName", () => {
    const store = freshStore();
    expect(() => store.record({ skillName: "", predictedP: 0.5, success: true, at: 1 })).toThrow(
      TrackRecordValidationError,
    );
    expect(() => store.record({ skillName: "   ", predictedP: 0.5, success: true, at: 1 })).toThrow(
      TrackRecordValidationError,
    );
  });

  it("rejects a non-finite at (NaN, Infinity)", () => {
    const store = freshStore();
    expect(() => store.record({ skillName: "s", predictedP: 0.5, success: true, at: NaN })).toThrow(
      TrackRecordValidationError,
    );
    expect(() => store.record({ skillName: "s", predictedP: 0.5, success: true, at: Infinity })).toThrow(
      TrackRecordValidationError,
    );
  });

  it("rejects a non-monotonic (earlier) timestamp within the same skill's chain, leaving the chain unchanged", () => {
    const store = freshStore();
    store.record({ skillName: "s", predictedP: 0.5, success: true, at: 100 });
    expect(() => store.record({ skillName: "s", predictedP: 0.5, success: true, at: 50 })).toThrow(
      TrackRecordValidationError,
    );
    expect(store.entries("s")).toHaveLength(1);
  });

  it("allows equal (non-decreasing) timestamps and independent chains per skill", () => {
    const store = freshStore();
    store.record({ skillName: "s", predictedP: 0.5, success: true, at: 100 });
    expect(() => store.record({ skillName: "s", predictedP: 0.5, success: true, at: 100 })).not.toThrow();
    // a different skill is unaffected by "s"'s timestamps
    expect(() => store.record({ skillName: "other", predictedP: 0.5, success: true, at: 1 })).not.toThrow();
    expect(store.entries("s")).toHaveLength(2);
    expect(store.entries("other")).toHaveLength(1);
  });

  it("throws TrackRecordValidationError for a non-positive or non-integer window at construction", () => {
    const { fs } = makeSharedFs();
    expect(() => new SkillTrackRecordStore({ path: "/v/x", fs, window: 0 })).toThrow(TrackRecordValidationError);
    expect(() => new SkillTrackRecordStore({ path: "/v/x", fs, window: -5 })).toThrow(TrackRecordValidationError);
    expect(() => new SkillTrackRecordStore({ path: "/v/x", fs, window: 2.5 })).toThrow(TrackRecordValidationError);
  });
});

// ===========================================================================
// Hash chain correctness + verifyChain
// ===========================================================================

describe("SkillTrackRecordStore — hash chain", () => {
  it("chains entries with sequential seq and prevHash === previous entry's hash", () => {
    const { fs } = makeSharedFs();
    const store = new SkillTrackRecordStore({ path: "/v/x", fs, now: () => 0 });
    const e1 = store.record({ skillName: "s", predictedP: 0.5, success: true, at: 1 });
    const e2 = store.record({ skillName: "s", predictedP: 0.4, success: false, at: 2 });
    const e3 = store.record({ skillName: "s", predictedP: 0.6, success: true, at: 3 });

    expect(e1.seq).toBe(0);
    expect(e2.seq).toBe(1);
    expect(e3.seq).toBe(2);
    expect(e2.prevHash).toBe(e1.hash);
    expect(e3.prevHash).toBe(e2.hash);
    expect(e1.hash).not.toBe(e2.hash);

    expect(store.verifyChain("s")).toEqual({ ok: true });
    expect(store.verifyChain()).toEqual({ ok: true });
  });

  it("gives independent skills independent genesis hashes (different prevHash at seq 0)", () => {
    const { fs } = makeSharedFs();
    const store = new SkillTrackRecordStore({ path: "/v/x", fs, now: () => 0 });
    const a = store.record({ skillName: "alpha", predictedP: 0.5, success: true, at: 1 });
    const b = store.record({ skillName: "beta", predictedP: 0.5, success: true, at: 1 });
    expect(a.prevHash).not.toBe(b.prevHash);
    expect(a.hash).not.toBe(b.hash);
  });

  it("verifyChain on an unknown/empty skill is trivially ok", () => {
    const { fs } = makeSharedFs();
    const store = new SkillTrackRecordStore({ path: "/v/x", fs });
    expect(store.verifyChain("nope")).toEqual({ ok: true });
  });
});

// ===========================================================================
// (a) Cross-process (cross-instance, shared-fs) persistence
// ===========================================================================

describe("SkillTrackRecordStore — cross-instance persistence", () => {
  it("a fresh store constructed on the same injected fs sees identical summaries and entries", () => {
    const { fs } = makeSharedFs();
    const storeA = new SkillTrackRecordStore({ path: "/v/dir/anything", fs, now: () => 1 });
    storeA.record({ skillName: "alpha", predictedP: 0.9, success: true, at: 1, certSha256: "cafe" });
    storeA.record({ skillName: "alpha", predictedP: 0.2, success: false, at: 2 });
    storeA.record({ skillName: "beta", predictedP: 0.5, success: true, at: 1, runId: "r1" });

    const storeB = new SkillTrackRecordStore({ path: "/v/dir/anything", fs, now: () => 999 });

    expect(storeB.summaries()).toEqual(storeA.summaries());
    expect(storeB.entries("alpha")).toEqual(storeA.entries("alpha"));
    expect(storeB.entries("beta")).toEqual(storeA.entries("beta"));
    expect(storeB.verifyChain().ok).toBe(true);
  });

  it("resolves the store file to <dirname(path)>/skill-track.json, independent of the path's basename", () => {
    const { fs, files } = makeSharedFs();
    const store = new SkillTrackRecordStore({ path: "/v/some/nested/dir/whatever-file-name", fs });
    store.record({ skillName: "s", predictedP: 0.5, success: true, at: 1 });
    expect(files.has("/v/some/nested/dir/skill-track.json")).toBe(true);
  });

  it("uses the real filesystem and a real skill-track.json under the given directory by default", () => {
    const store = new SkillTrackRecordStore({ path: join(tmpDir, "ignored-basename"), now: () => 1 });
    store.record({ skillName: "s", predictedP: 0.7, success: true, at: 1 });
    const onDisk = readFileSync(join(tmpDir, "skill-track.json"), "utf8");
    const parsed = JSON.parse(onDisk);
    expect(parsed.version).toBe(1);
    expect(parsed.chains.s).toHaveLength(1);

    // and a fresh store instance over the same real directory reloads it
    const reloaded = new SkillTrackRecordStore({ path: join(tmpDir, "another-basename") });
    expect(reloaded.summary("s")?.n).toBe(1);
  });
});

// ===========================================================================
// (b) Atomicity of the default fs: tmp write + rename
// ===========================================================================

describe("SkillTrackRecordStore — default fs atomicity", () => {
  afterEach(() => {
    vi.doUnmock("node:fs");
    vi.resetModules();
  });

  it("writes to a temp path and renames it onto the real target, never writing the target path directly", async () => {
    vi.resetModules();
    const calls: Array<{ fn: string; args: unknown[] }> = [];
    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      return {
        ...actual,
        writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
          calls.push({ fn: "writeFileSync", args });
          return actual.writeFileSync(...args);
        },
        renameSync: (...args: Parameters<typeof actual.renameSync>) => {
          calls.push({ fn: "renameSync", args });
          return actual.renameSync(...args);
        },
        mkdirSync: (...args: Parameters<typeof actual.mkdirSync>) => {
          calls.push({ fn: "mkdirSync", args });
          return actual.mkdirSync(...args);
        },
      };
    });

    const mod = await import("../track-record");
    const store = new mod.SkillTrackRecordStore({ path: join(tmpDir, "x"), now: () => 1 });
    store.record({ skillName: "s", predictedP: 0.5, success: true, at: 1 });

    const writeIdx = calls.findIndex((c) => c.fn === "writeFileSync");
    const renameIdx = calls.findIndex((c) => c.fn === "renameSync");
    expect(writeIdx).toBeGreaterThanOrEqual(0);
    expect(renameIdx).toBeGreaterThan(writeIdx);

    const targetPath = join(tmpDir, "skill-track.json");
    const writtenPath = calls[writeIdx].args[0] as string;
    const [renameFrom, renameTo] = calls[renameIdx].args as [string, string];

    expect(writtenPath).not.toBe(targetPath); // the write itself lands on a tmp file...
    expect(renameFrom).toBe(writtenPath); // ...which is exactly what gets renamed...
    expect(renameTo).toBe(targetPath); // ...onto the real target.

    const finalContent = JSON.parse(readFileSync(targetPath, "utf8"));
    expect(finalContent.chains.s).toHaveLength(1);
  });
});

// ===========================================================================
// (c) Tamper evidence
// ===========================================================================

describe("SkillTrackRecordStore — tamper detection", () => {
  it("pinpoints the exact {skillName, seq} where a mutated success flag breaks the hash chain, and load() surfaces (not repairs) it", () => {
    const { fs, files } = makeSharedFs();
    const store = new SkillTrackRecordStore({ path: "/v/x", fs, now: () => 0 });
    store.record({ skillName: "skillX", predictedP: 0.7, success: true, at: 1 });
    store.record({ skillName: "skillX", predictedP: 0.3, success: false, at: 2 });
    store.record({ skillName: "skillX", predictedP: 0.9, success: true, at: 3 });

    // hand-tamper the persisted bytes: flip seq=1's success flag
    const persisted = JSON.parse(files.get("/v/skill-track.json") as string);
    expect(persisted.chains.skillX[1].seq).toBe(1);
    persisted.chains.skillX[1].success = true; // was false
    files.set("/v/skill-track.json", JSON.stringify(persisted));

    // a fresh instance reloading the tampered bytes must surface, not repair
    const reloaded = new SkillTrackRecordStore({ path: "/v/x", fs, now: () => 0 });
    const loadResult = reloaded.load();

    expect(loadResult.ok).toBe(false);
    expect(loadResult.error).toContain("skillX");
    expect(loadResult.error).toContain("seq=1");

    expect(reloaded.verifyChain("skillX")).toEqual({ ok: false, brokenAt: { skillName: "skillX", seq: 1 } });
    expect(reloaded.verifyChain()).toEqual({ ok: false, brokenAt: { skillName: "skillX", seq: 1 } });

    // the tampered data is preserved for inspection, not silently discarded
    expect(reloaded.entries("skillX")).toHaveLength(3);
    expect(reloaded.entries("skillX")[1].success).toBe(true); // reflects the tampered bytes, unrepaired
  });

  it("pinpoints tampering with a predictedP value, not just success", () => {
    const { fs, files } = makeSharedFs();
    const store = new SkillTrackRecordStore({ path: "/v/x", fs, now: () => 0 });
    store.record({ skillName: "s", predictedP: 0.5, success: true, at: 1 });
    store.record({ skillName: "s", predictedP: 0.5, success: true, at: 2 });

    const persisted = JSON.parse(files.get("/v/skill-track.json") as string);
    persisted.chains.s[0].predictedP = 0.99;
    files.set("/v/skill-track.json", JSON.stringify(persisted));

    const reloaded = new SkillTrackRecordStore({ path: "/v/x", fs, now: () => 0 });
    expect(reloaded.verifyChain("s")).toEqual({ ok: false, brokenAt: { skillName: "s", seq: 0 } });
  });
});

// ===========================================================================
// (g) Corrupted / legacy / garbage JSON on disk
// ===========================================================================

describe("SkillTrackRecordStore — corrupted persisted state", () => {
  it("garbage (non-JSON) bytes yield load() {ok:false} with an error, and an empty-but-usable store", () => {
    const { fs, files } = makeSharedFs();
    files.set("/v/skill-track.json", "{not valid json at all");
    const store = new SkillTrackRecordStore({ path: "/v/x", fs, now: () => 0 });
    const result = store.load();

    expect(result.ok).toBe(false);
    expect(typeof result.error).toBe("string");
    expect(result.error!.length).toBeGreaterThan(0);
    expect(store.summaries()).toEqual([]);
    expect(store.entries("anything")).toEqual([]);

    // still usable afterward
    expect(() => store.record({ skillName: "s", predictedP: 0.5, success: true, at: 1 })).not.toThrow();
    expect(store.entries("s")).toHaveLength(1);
  });

  it("an unrecognized envelope (wrong version, missing chains) yields load() {ok:false} and an empty store", () => {
    const { fs, files } = makeSharedFs();
    files.set("/v/skill-track.json", JSON.stringify({ version: 2, chains: {} }));
    const store = new SkillTrackRecordStore({ path: "/v/x", fs });
    const result = store.load();
    expect(result.ok).toBe(false);
    expect(store.summaries()).toEqual([]);
  });

  it("structurally malformed chain entries yield load() {ok:false} and an empty store, never a crash", () => {
    const { fs, files } = makeSharedFs();
    files.set(
      "/v/skill-track.json",
      JSON.stringify({ version: 1, chains: { skillY: [{ foo: "bar", not: "an entry" }] } }),
    );
    expect(() => new SkillTrackRecordStore({ path: "/v/x", fs })).not.toThrow();
    const store = new SkillTrackRecordStore({ path: "/v/x", fs });
    const result = store.load();
    expect(result.ok).toBe(false);
    expect(result.error).toContain("skillY");
    expect(store.entries("skillY")).toEqual([]);
  });

  it("a missing file is not an error: load() {ok:true, migrated:false} with a fresh empty store", () => {
    const { fs } = makeSharedFs();
    const store = new SkillTrackRecordStore({ path: "/v/does/not/exist", fs });
    expect(store.load()).toEqual({ ok: true, migrated: false });
    expect(store.summaries()).toEqual([]);
  });

  it("a readFile that throws (not ENOENT) is caught, not a crash, and reported via load().error", () => {
    const fs: TrackRecordFs = {
      readFile() {
        throw new Error("simulated EACCES");
      },
      writeFile() {},
      mkdirp() {},
    };
    const store = new SkillTrackRecordStore({ path: "/v/x", fs });
    const result = store.load();
    expect(result.ok).toBe(false);
    expect(result.error).toContain("simulated EACCES");
  });
});

// ===========================================================================
// (d) Brier math via summary(): overall vs. windowed, boundary at exactly `window`
// ===========================================================================

describe("SkillTrackRecordStore.summary — brier / windowing", () => {
  it("brier === recentBrier when n === window exactly, then diverges once a 4th entry pushes past the window", () => {
    const { fs } = makeSharedFs();
    const store = new SkillTrackRecordStore({ path: "/v/x", fs, window: 3, now: () => 0 });

    // errors: (0.9-1)^2=0.01, (0.5-1)^2=0.25, (0.2-0)^2=0.04 -> sum=0.30, mean=0.10
    store.record({ skillName: "s", predictedP: 0.9, success: true, at: 1 });
    store.record({ skillName: "s", predictedP: 0.5, success: true, at: 2 });
    store.record({ skillName: "s", predictedP: 0.2, success: false, at: 3 });

    const atWindow = store.summary("s")!;
    expect(atWindow.n).toBe(3);
    expect(atWindow.brier).toBeCloseTo(0.1, 10);
    expect(atWindow.recentBrier).toBeCloseTo(0.1, 10);
    expect(atWindow.brier).toBe(atWindow.recentBrier);

    // 4th entry: (0.7-0)^2 = 0.49
    store.record({ skillName: "s", predictedP: 0.7, success: false, at: 4 });

    const past = store.summary("s")!;
    expect(past.n).toBe(4);
    // overall: (0.30 + 0.49) / 4 = 0.1975
    expect(past.brier).toBeCloseTo(0.1975, 10);
    // windowed (last 3: 0.5/true, 0.2/false, 0.7/false): (0.25 + 0.04 + 0.49) / 3 = 0.26
    expect(past.recentBrier).toBeCloseTo(0.26, 10);
    expect(past.brier).not.toBeCloseTo(past.recentBrier, 3);
  });

  it("windowed success rate, wilsonLower, and lastAt track only the trailing window", () => {
    const { fs } = makeSharedFs();
    const store = new SkillTrackRecordStore({ path: "/v/x", fs, window: 3, now: () => 0 });
    store.record({ skillName: "s", predictedP: 0.9, success: true, at: 1 });
    store.record({ skillName: "s", predictedP: 0.5, success: true, at: 2 });
    store.record({ skillName: "s", predictedP: 0.2, success: false, at: 3 });
    store.record({ skillName: "s", predictedP: 0.7, success: false, at: 4 });

    const s = store.summary("s")!;
    expect(s.successRate).toBeCloseTo(2 / 4, 10); // overall: true,true,false,false
    expect(s.recentSuccessRate).toBeCloseTo(1 / 3, 10); // last 3: true,false,false
    expect(s.wilsonLower).toBeCloseTo(wilsonLowerBound(1, 3), 10);
    expect(s.window).toBe(3);
    expect(s.lastAt).toBe(4);
  });

  it("counts verifiedN as entries carrying a certSha256, distinct from n", () => {
    const { fs } = makeSharedFs();
    const store = new SkillTrackRecordStore({ path: "/v/x", fs, now: () => 0 });
    store.record({ skillName: "s", predictedP: 0.5, success: true, at: 1, certSha256: "aa" });
    store.record({ skillName: "s", predictedP: 0.5, success: true, at: 2 });
    store.record({ skillName: "s", predictedP: 0.5, success: true, at: 3, certSha256: "bb" });

    const s = store.summary("s")!;
    expect(s.n).toBe(3);
    expect(s.verifiedN).toBe(2);
  });

  it("returns null for a skill with no recorded outcomes, and omits it from summaries()", () => {
    const { fs } = makeSharedFs();
    const store = new SkillTrackRecordStore({ path: "/v/x", fs });
    expect(store.summary("nope")).toBeNull();
    store.record({ skillName: "present", predictedP: 0.5, success: true, at: 1 });
    expect(store.summaries().map((s) => s.skillName)).toEqual(["present"]);
  });

  it("summaries() is sorted by skill name and reflects every skill with entries", () => {
    const { fs } = makeSharedFs();
    const store = new SkillTrackRecordStore({ path: "/v/x", fs, now: () => 0 });
    store.record({ skillName: "zeta", predictedP: 0.5, success: true, at: 1 });
    store.record({ skillName: "alpha", predictedP: 0.5, success: true, at: 1 });
    store.record({ skillName: "mid", predictedP: 0.5, success: true, at: 1 });
    expect(store.summaries().map((s) => s.skillName)).toEqual(["alpha", "mid", "zeta"]);
  });
});

// ===========================================================================
// serialize()
// ===========================================================================

describe("SkillTrackRecordStore.serialize", () => {
  it("produces a versioned {version:1, chains:{...}} envelope matching what was persisted", () => {
    const { fs, files } = makeSharedFs();
    const store = new SkillTrackRecordStore({ path: "/v/x", fs, now: () => 0 });
    store.record({ skillName: "s", predictedP: 0.5, success: true, at: 1 });
    expect(store.serialize()).toBe(files.get("/v/skill-track.json"));
    const parsed = JSON.parse(store.serialize());
    expect(parsed.version).toBe(1);
    expect(Object.keys(parsed.chains)).toEqual(["s"]);
  });
});

// ===========================================================================
// (h) 10k-entry chains: no accidental O(n^2) re-hash, sane time budget
// ===========================================================================

describe("SkillTrackRecordStore — scale", () => {
  it("records 10,000 entries for one skill within a sane time budget and stays chain-valid", () => {
    // (This is a genuinely ~10s CPU-bound test given the atomic-full-file-
    // write-per-record architecture; see the elapsedMs comment below. The
    // explicit 30s test timeout — vitest's default is 5s — accounts for
    // that, distinct from the 25s *assertion* budget on elapsedMs itself.)
    const { fs } = makeSharedFs();
    const store = new SkillTrackRecordStore({ path: "/v/x", fs, window: 20, now: () => 0 });

    const total = 10_000;
    const start = performance.now();
    for (let i = 0; i < total; i++) {
      store.record({
        skillName: "bulk",
        predictedP: (i % 100) / 100,
        success: i % 3 === 0,
        at: i,
      });
    }
    const elapsedMs = performance.now() - start;

    expect(store.entries("bulk")).toHaveLength(total);
    expect(store.verifyChain("bulk")).toEqual({ ok: true });
    expect(store.summary("bulk")!.n).toBe(total);
    // `record()` persists immediately, and the default/injectable fs
    // contract is a full-file atomic (tmp+rename) write — so each call's
    // *disk write* is honestly O(current file size); summed over 10,000
    // growing writes that is an inherent, bounded cost (not the O(n^2)
    // *re-hash* this budget actually guards against — see the dedicated
    // "marginal record() cost" test below for that). This budget is
    // generous specifically to absorb that inherent linear-per-call I/O
    // cost while still catching genuine runaway (accidental O(n^3), an
    // errant full re-verify loop, etc.) blowups.
    expect(elapsedMs).toBeLessThan(25_000);
  }, 30_000);

  it("a single record() on top of an already-9,999-entry chain is fast (no O(n) re-hash per call)", () => {
    // Seed 9,999 structurally-valid entries directly (skipping 9,999 real
    // record() calls, which would themselves pay the *inherent* O(n)
    // full-file-write cost this test is deliberately isolating away from).
    // Hashes are deliberately NOT cryptographically chained here — load()
    // will therefore report a tamper-style {ok:false}, which is fine: this
    // test only cares that the (tamper-preserving, per the contract) load
    // still populates `chains`/the serialization cache with all 9,999
    // entries, so the timed record() below reflects a genuinely large
    // pre-existing chain.
    const seeded: unknown[] = [];
    for (let i = 0; i < 9_999; i++) {
      seeded.push({
        skillName: "bulk3",
        predictedP: 0.5,
        success: true,
        at: i,
        seq: i,
        prevHash: `fake-${i}`,
        hash: `fake-${i + 1}`,
      });
    }
    const { fs, files } = makeSharedFs();
    files.set("/v/skill-track.json", JSON.stringify({ version: 1, chains: { bulk3: seeded } }));

    const store = new SkillTrackRecordStore({ path: "/v/x", fs, now: () => 0 });
    expect(store.entries("bulk3")).toHaveLength(9_999); // preserved despite load() reporting tamper

    const start = performance.now();
    const entry = store.record({ skillName: "bulk3", predictedP: 0.5, success: true, at: 999_999 });
    const elapsedMs = performance.now() - start;

    expect(entry.seq).toBe(9_999);
    expect(store.entries("bulk3")).toHaveLength(10_000);
    // A record() that accidentally re-hashes or re-verifies the whole
    // 9,999-entry prior chain would take on the order of seconds (crypto
    // hashing 9,999 entries), not milliseconds. One O(1) hash plus one
    // O(current-file-size) — but still just a single ~2MB write — write is
    // comfortably sub-second.
    expect(elapsedMs).toBeLessThan(1_000);
  });
});

// ===========================================================================
// Immutability / defensive copies
// ===========================================================================

describe("SkillTrackRecordStore — defensive returns", () => {
  it("entries() returns a fresh array each call; mutating it does not affect the store", () => {
    const { fs } = makeSharedFs();
    const store = new SkillTrackRecordStore({ path: "/v/x", fs, now: () => 0 });
    store.record({ skillName: "s", predictedP: 0.5, success: true, at: 1 });
    const arr = store.entries("s") as unknown as unknown[];
    arr.push("garbage");
    expect(store.entries("s")).toHaveLength(1);
  });

  it("a returned entry is frozen and cannot be mutated to corrupt the in-memory chain", () => {
    const { fs } = makeSharedFs();
    const store = new SkillTrackRecordStore({ path: "/v/x", fs, now: () => 0 });
    const entry = store.record({ skillName: "s", predictedP: 0.5, success: true, at: 1 });
    expect(Object.isFrozen(entry)).toBe(true);
    expect(() => {
      "use strict";
      (entry as { success: boolean }).success = false;
    }).toThrow();
    expect(store.entries("s")[0].success).toBe(true);
  });
});
