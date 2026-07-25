/**
 * skill-trust-service.test.ts
 *
 * REAL-VS-MOCK POLICY: every test drives the REAL `SkillTrackRecordStore`
 * (hash-chained, real sha256) and the REAL `parseTrustStates`/
 * `serializeTrustStates` (de)serializers to build the on-disk bytes
 * `SkillTrustService` reads — nothing about a skill's metrics or trust
 * state is fabricated by this test file. Only the *filesystem* is faked (an
 * in-memory async `TrustFilesFs`), plus one end-to-end pass against a real
 * `mkdtemp`'d directory with the real `node:fs`-backed default.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  SkillTrustService,
  isSkillTrustBadgeData,
  nodeTrustFilesFs,
  type SkillTrustBadgeData,
  type TrustFilesFs,
} from "../core/skill-trust-service";
import { serializeTrustStates, type SkillTrustState } from "../../hades/skills/demotion";
import { SkillTrackRecordStore, type TrackRecordFs } from "../../hades/skills/track-record";

const DATA_DIR = "/virtual/.hades";
const TRUST_PATH = join(DATA_DIR, "skill-trust.json");
const TRACK_PATH = join(DATA_DIR, "skill-track.json");

// ===========================================================================
// helpers
// ===========================================================================

/** An in-memory synchronous `TrackRecordFs` backed by a plain `Map`, used
 *  only to build real, real-hashed track-record bytes via the real store. */
function syncFsOverMap(files: Map<string, string>): TrackRecordFs {
  return {
    readFile: (p) => (files.has(p) ? (files.get(p) as string) : null),
    writeFile: (p, c) => {
      files.set(p, c);
    },
    mkdirp: () => {},
  };
}

/** Builds a real hash-chained skill-track.json for `skillName` with the
 *  given outcomes, and returns both the persisted bytes and the store's own
 *  summary (the expected values our service must copy verbatim). */
function buildRealTrackFile(
  skillName: string,
  outcomes: Array<{ predictedP: number; success: boolean; certSha256?: string }>,
): { content: string; store: SkillTrackRecordStore } {
  const files = new Map<string, string>();
  const fs = syncFsOverMap(files);
  const store = new SkillTrackRecordStore({ path: TRACK_PATH, fs, now: () => 0 });
  let at = 1;
  for (const o of outcomes) {
    store.record({ skillName, predictedP: o.predictedP, success: o.success, at: at++, certSha256: o.certSha256 });
  }
  return { content: files.get(TRACK_PATH) as string, store };
}

function trustFileContent(states: Array<SkillTrustState>): string {
  const map = new Map<string, SkillTrustState>();
  for (const s of states) map.set(s.skillName, s);
  return serializeTrustStates(map);
}

function trustState(skillName: string, status: SkillTrustState["status"], overrides?: Partial<SkillTrustState>): SkillTrustState {
  return { skillName, status, since: 100, streak: 0, reasons: [], ...overrides };
}

/** An in-memory `TrustFilesFs`: exact-path lookup, `null` for anything not
 *  registered (ENOENT semantics), and optional per-path rejection. */
function fakeFs(
  filesByPath: Record<string, string>,
  opts?: { rejectPaths?: Set<string> },
): TrustFilesFs & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    async readFile(path: string): Promise<string | null> {
      reads.push(path);
      if (opts?.rejectPaths?.has(path)) {
        throw new Error(`simulated read failure for ${path}`);
      }
      return Object.prototype.hasOwnProperty.call(filesByPath, path) ? filesByPath[path] : null;
    },
  };
}

/** Flips one recorded entry's `success` flag directly in the persisted JSON
 *  bytes without touching its `hash` — the same "hand-tamper the persisted
 *  bytes" technique `track-record.test.ts` uses — so the chain no longer
 *  verifies against its own recomputed hash. */
function tamperFlipSuccess(trackJson: string, skillName: string, seq: number): string {
  const parsed = JSON.parse(trackJson) as { chains: Record<string, Array<{ success: boolean }>> };
  parsed.chains[skillName][seq].success = !parsed.chains[skillName][seq].success;
  return JSON.stringify(parsed);
}

// ===========================================================================
// (a) badges() — real files, healthy path
// ===========================================================================

describe("SkillTrustService.badges — both files healthy", () => {
  it("copies status from the persisted trust state and metrics verbatim from the real store summary", async () => {
    const { content: trackContent, store } = buildRealTrackFile("alpha", [
      { predictedP: 0.9, success: true, certSha256: "cert1" },
      { predictedP: 0.85, success: true },
      { predictedP: 0.2, success: false, certSha256: "cert2" },
      { predictedP: 0.8, success: true },
    ]);
    const expected = store.summary("alpha")!;
    const trust = trustFileContent([trustState("alpha", "active", { streak: 2 })]);

    const fs = fakeFs({ [TRUST_PATH]: trust, [TRACK_PATH]: trackContent });
    const service = new SkillTrustService({ dataDir: DATA_DIR, fs });

    const [badge] = await service.badges(["alpha"]);
    expect(badge.name).toBe("alpha");
    expect(badge.status).toBe("active");
    expect(badge.n).toBe(expected.n);
    expect(badge.verifiedN).toBe(expected.verifiedN);
    expect(badge.wilsonLower).toBe(expected.wilsonLower);
    expect(badge.recentBrier).toBe(expected.recentBrier);
    expect(badge.verifiedN).toBe(2); // two of the four outcomes carried a certSha256
  });

  it("status is copied verbatim for every non-terminal persisted status (probation)", async () => {
    const { content: trackContent } = buildRealTrackFile("beta", [
      { predictedP: 0.6, success: true },
      { predictedP: 0.4, success: false },
      { predictedP: 0.5, success: false },
      { predictedP: 0.55, success: true },
      { predictedP: 0.45, success: false },
    ]);
    const trust = trustFileContent([trustState("beta", "probation")]);
    const fs = fakeFs({ [TRUST_PATH]: trust, [TRACK_PATH]: trackContent });
    const service = new SkillTrustService({ dataDir: DATA_DIR, fs });

    const [badge] = await service.badges(["beta"]);
    expect(badge.status).toBe("probation");
    expect(badge.n).toBe(5);
  });
});

// ===========================================================================
// (b) degradation semantics — the CLI's trackStoreIssue distinction
// ===========================================================================

describe("SkillTrustService.badges — degradation semantics", () => {
  it("trust file present but track file missing: persisted status surfaces with null metrics (explicit degradation)", async () => {
    const trust = trustFileContent([trustState("gamma", "demoted", { streak: 0 })]);
    const fs = fakeFs({ [TRUST_PATH]: trust }); // no TRACK_PATH entry -> readFile resolves null (ENOENT)
    const service = new SkillTrustService({ dataDir: DATA_DIR, fs });

    const [badge] = await service.badges(["gamma"]);
    expect(badge.status).toBe("demoted");
    expect(badge.wilsonLower).toBeNull();
    expect(badge.recentBrier).toBeNull();
    expect(badge.n).toBe(0);
    expect(badge.verifiedN).toBe(0);
  });

  it("track file present but trust file missing: status is 'unscored' with REAL numbers attached (read-only, never re-decided)", async () => {
    const { content: trackContent, store } = buildRealTrackFile("delta", [
      { predictedP: 0.9, success: true },
      { predictedP: 0.9, success: true },
      { predictedP: 0.9, success: true },
      { predictedP: 0.9, success: true },
      { predictedP: 0.9, success: true },
      { predictedP: 0.9, success: true },
    ]);
    const expected = store.summary("delta")!;
    // No skill-trust.json at all: file is genuinely absent.
    const fs = fakeFs({ [TRACK_PATH]: trackContent });
    const service = new SkillTrustService({ dataDir: DATA_DIR, fs });

    const [badge] = await service.badges(["delta"]);
    // Even though `delta`'s real wilsonLower is high (six straight
    // verified-looking successes), the service NEVER re-decides a status —
    // it only reports "unscored" because no trust decision was persisted,
    // with delta's real metrics attached rather than nulled out.
    expect(badge.status).toBe("unscored");
    expect(badge.wilsonLower).toBe(expected.wilsonLower);
    expect(badge.wilsonLower).not.toBeNull();
    expect(badge.recentBrier).toBe(expected.recentBrier);
    expect(badge.n).toBe(6);
  });

  it("corrupt JSON in skill-trust.json degrades EVERY requested skill to integrity-error, even ones with a healthy track record", async () => {
    const { content: trackContent } = buildRealTrackFile("epsilon", [
      { predictedP: 0.9, success: true },
      { predictedP: 0.9, success: true },
    ]);
    const fs = fakeFs({ [TRUST_PATH]: "{not valid json", [TRACK_PATH]: trackContent });
    const service = new SkillTrustService({ dataDir: DATA_DIR, fs });

    const [badge] = await service.badges(["epsilon"]);
    expect(badge.status).toBe("integrity-error");
  });

  it("corrupt JSON in skill-track.json degrades every requested skill to integrity-error", async () => {
    const trust = trustFileContent([trustState("zeta", "active")]);
    const fs = fakeFs({ [TRUST_PATH]: trust, [TRACK_PATH]: "{ this is not json at all" });
    const service = new SkillTrustService({ dataDir: DATA_DIR, fs });

    const [badge] = await service.badges(["zeta"]);
    expect(badge.status).toBe("integrity-error");
    expect(badge.wilsonLower).toBeNull();
    expect(badge.n).toBe(0);
  });

  it("a genuinely tampered hash chain (real store, then byte-tampered) reports integrity-error for the tampered skill", async () => {
    const { content: trackContent } = buildRealTrackFile("eta", [
      { predictedP: 0.9, success: true },
      { predictedP: 0.9, success: true },
      { predictedP: 0.9, success: true },
    ]);
    const tampered = tamperFlipSuccess(trackContent, "eta", 1);
    const trust = trustFileContent([trustState("eta", "active")]);
    const fs = fakeFs({ [TRUST_PATH]: trust, [TRACK_PATH]: tampered });
    const service = new SkillTrustService({ dataDir: DATA_DIR, fs });

    const [badge] = await service.badges(["eta"]);
    expect(badge.status).toBe("integrity-error");
    expect(badge.wilsonLower).toBeNull();
    expect(badge.recentBrier).toBeNull();
  });

  it("tampering confined to one skill's chain does not poison a sibling skill's chain in the same file", async () => {
    const files = new Map<string, string>();
    const fs0 = syncFsOverMap(files);
    const store = new SkillTrackRecordStore({ path: TRACK_PATH, fs: fs0, now: () => 0 });
    store.record({ skillName: "theta", predictedP: 0.9, success: true, at: 1 });
    store.record({ skillName: "theta", predictedP: 0.9, success: true, at: 2 });
    store.record({ skillName: "iota", predictedP: 0.9, success: true, at: 1 });
    store.record({ skillName: "iota", predictedP: 0.9, success: true, at: 2 });
    const expectedIota = store.summary("iota")!;

    const tampered = tamperFlipSuccess(files.get(TRACK_PATH) as string, "theta", 0);
    const trust = trustFileContent([trustState("theta", "active"), trustState("iota", "active")]);
    const fs = fakeFs({ [TRUST_PATH]: trust, [TRACK_PATH]: tampered });
    const service = new SkillTrustService({ dataDir: DATA_DIR, fs });

    const [thetaBadge, iotaBadge] = await service.badges(["theta", "iota"]);
    expect(thetaBadge.status).toBe("integrity-error");
    expect(iotaBadge.status).toBe("active");
    expect(iotaBadge.wilsonLower).toBe(expectedIota.wilsonLower);
    expect(iotaBadge.n).toBe(2);
  });

  it("requested names unknown everywhere (no such skill in either file) report unscored with n=0", async () => {
    const trust = trustFileContent([trustState("known-skill", "active")]);
    const { content: trackContent } = buildRealTrackFile("known-skill", [{ predictedP: 0.9, success: true }]);
    const fs = fakeFs({ [TRUST_PATH]: trust, [TRACK_PATH]: trackContent });
    const service = new SkillTrustService({ dataDir: DATA_DIR, fs });

    const [badge] = await service.badges(["totally-unknown-skill"]);
    expect(badge.status).toBe("unscored");
    expect(badge.n).toBe(0);
    expect(badge.verifiedN).toBe(0);
    expect(badge.wilsonLower).toBeNull();
    expect(badge.recentBrier).toBeNull();
  });

  it("both files genuinely absent: every requested skill is unscored with n=0, never throws", async () => {
    const fs = fakeFs({});
    const service = new SkillTrustService({ dataDir: DATA_DIR, fs });
    const badges = await service.badges(["a", "b"]);
    for (const badge of badges) {
      expect(badge.status).toBe("unscored");
      expect(badge.n).toBe(0);
    }
  });
});

// ===========================================================================
// (c) badges() never throws, preserves order
// ===========================================================================

describe("SkillTrustService.badges — robustness", () => {
  it("preserves input order regardless of file contents", async () => {
    const trust = trustFileContent([trustState("z-skill", "demoted"), trustState("a-skill", "active")]);
    const { content: trackContent } = buildRealTrackFile("a-skill", [{ predictedP: 0.9, success: true }]);
    const fs = fakeFs({ [TRUST_PATH]: trust, [TRACK_PATH]: trackContent });
    const service = new SkillTrustService({ dataDir: DATA_DIR, fs });

    const names = ["z-skill", "a-skill", "unknown-skill", "z-skill"];
    const badges = await service.badges(names);
    expect(badges.map((b) => b.name)).toEqual(names);
    expect(badges[0].status).toBe("demoted");
    expect(badges[1].status).toBe("active");
    expect(badges[2].status).toBe("unscored");
    expect(badges[3].status).toBe("demoted");
  });

  it("never throws when fs.readFile rejects for both files", async () => {
    const fs = fakeFs(
      { [TRUST_PATH]: trustFileContent([trustState("x", "active")]), [TRACK_PATH]: "{}" },
      { rejectPaths: new Set([TRUST_PATH, TRACK_PATH]) },
    );
    const service = new SkillTrustService({ dataDir: DATA_DIR, fs });
    await expect(service.badges(["x", "y"])).resolves.toBeDefined();
    const badges = await service.badges(["x", "y"]);
    expect(badges).toHaveLength(2);
    for (const b of badges) expect(b.status).toBe("integrity-error");
  });

  it("never throws when fs.readFile rejects only for the track file", async () => {
    const trust = trustFileContent([trustState("solo", "active")]);
    const fs = fakeFs({ [TRUST_PATH]: trust, [TRACK_PATH]: "{}" }, { rejectPaths: new Set([TRACK_PATH]) });
    const service = new SkillTrustService({ dataDir: DATA_DIR, fs });
    const [badge] = await service.badges(["solo"]);
    expect(badge.status).toBe("integrity-error");
  });

  it("returns an empty array for an empty name list without reading anything unexpected", async () => {
    const fs = fakeFs({});
    const service = new SkillTrustService({ dataDir: DATA_DIR, fs });
    const badges = await service.badges([]);
    expect(badges).toEqual([]);
  });

  it("every returned badge satisfies the isSkillTrustBadgeData guard", async () => {
    const { content: trackContent } = buildRealTrackFile("guarded", [
      { predictedP: 0.7, success: true },
      { predictedP: 0.3, success: false },
    ]);
    const trust = trustFileContent([trustState("guarded", "probation")]);
    const fs = fakeFs({ [TRUST_PATH]: trust, [TRACK_PATH]: trackContent });
    const service = new SkillTrustService({ dataDir: DATA_DIR, fs });
    const badges = await service.badges(["guarded", "missing"]);
    for (const b of badges) expect(isSkillTrustBadgeData(b)).toBe(true);
  });
});

// ===========================================================================
// (d) dataDir defaulting
// ===========================================================================

describe("SkillTrustService — dataDir defaulting", () => {
  it("defaults dataDir to env.HADES_DATA_DIR when set", async () => {
    const customDir = "/custom/data/dir";
    const fs = fakeFs({ [join(customDir, "skill-trust.json")]: trustFileContent([trustState("s", "active")]) });
    const service = new SkillTrustService({ fs, env: { HADES_DATA_DIR: customDir } });
    const [badge] = await service.badges(["s"]);
    expect(badge.status).toBe("active");
    expect(fs.reads).toContain(join(customDir, "skill-trust.json"));
    expect(fs.reads).toContain(join(customDir, "skill-track.json"));
  });

  it("defaults dataDir to '.hades' when env.HADES_DATA_DIR is unset", async () => {
    const fs = fakeFs({ [join(".hades", "skill-trust.json")]: trustFileContent([trustState("s", "probation")]) });
    const service = new SkillTrustService({ fs, env: {} });
    const [badge] = await service.badges(["s"]);
    expect(badge.status).toBe("probation");
  });
});

// ===========================================================================
// (e) real end-to-end pass against the real filesystem
// ===========================================================================

describe("SkillTrustService — real filesystem integration", () => {
  it("reads real files written by the real store/serializer end to end", async () => {
    const dir = mkdtempSync(join(tmpdir(), "skill-trust-service-test-"));
    try {
      const { writeFileSync, mkdirSync } = await import("node:fs");
      mkdirSync(dir, { recursive: true });

      const files = new Map<string, string>();
      const trackPath = join(dir, "skill-track.json");
      const realStore = new SkillTrackRecordStore({
        path: trackPath,
        fs: {
          readFile: (p) => (files.has(p) ? (files.get(p) as string) : null),
          writeFile: (p, c) => {
            files.set(p, c);
            writeFileSync(p, c, "utf8");
          },
          mkdirp: () => {},
        },
        now: () => 0,
      });
      realStore.record({ skillName: "real-skill", predictedP: 0.9, success: true, at: 1 });
      realStore.record({ skillName: "real-skill", predictedP: 0.9, success: true, at: 2 });
      const expected = realStore.summary("real-skill")!;

      writeFileSync(
        join(dir, "skill-trust.json"),
        trustFileContent([trustState("real-skill", "active")]),
        "utf8",
      );

      const service = new SkillTrustService({ dataDir: dir, fs: nodeTrustFilesFs() });
      const [badge] = await service.badges(["real-skill", "never-recorded"]);
      expect(badge.status).toBe("active");
      expect(badge.n).toBe(expected.n);
      expect(badge.wilsonLower).toBe(expected.wilsonLower);

      const [, unknown] = await service.badges(["real-skill", "never-recorded"]);
      expect(unknown.status).toBe("unscored");
      expect(unknown.n).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("real filesystem: a directory with neither file present degrades to unscored, not integrity-error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "skill-trust-service-empty-test-"));
    try {
      const service = new SkillTrustService({ dataDir: dir, fs: nodeTrustFilesFs() });
      const [badge] = await service.badges(["nothing-here"]);
      expect(badge.status).toBe("unscored");
      expect(badge.n).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
// isSkillTrustBadgeData — total structural guard
// ===========================================================================

describe("isSkillTrustBadgeData", () => {
  const valid: SkillTrustBadgeData = {
    name: "some-skill",
    status: "active",
    wilsonLower: 0.81,
    recentBrier: 0.09,
    n: 14,
    verifiedN: 9,
  };

  it("accepts a well-formed value", () => {
    expect(isSkillTrustBadgeData(valid)).toBe(true);
  });

  it("accepts null metrics", () => {
    expect(isSkillTrustBadgeData({ ...valid, wilsonLower: null, recentBrier: null, n: 0, verifiedN: 0 })).toBe(true);
  });

  it.each(["active", "probation", "demoted", "unscored", "integrity-error"] as const)(
    "accepts status %s round-tripped through JSON.parse(JSON.stringify(...))",
    (status) => {
      const roundTripped = JSON.parse(JSON.stringify({ ...valid, status })) as unknown;
      expect(isSkillTrustBadgeData(roundTripped)).toBe(true);
    },
  );

  it("rejects null", () => {
    expect(isSkillTrustBadgeData(null)).toBe(false);
  });

  it("rejects arrays, even ones with all the right keys as elements", () => {
    expect(isSkillTrustBadgeData([valid])).toBe(false);
    expect(isSkillTrustBadgeData([])).toBe(false);
  });

  it("rejects a prototype-less object missing nothing but Object.prototype", () => {
    const bare = Object.assign(Object.create(null), valid);
    expect(isSkillTrustBadgeData(bare)).toBe(true); // structurally fine despite no prototype
    const barelyMissing = Object.create(null) as Record<string, unknown>;
    barelyMissing.name = "x";
    expect(isSkillTrustBadgeData(barelyMissing)).toBe(false); // missing required fields
  });

  it("rejects an unknown status string", () => {
    expect(isSkillTrustBadgeData({ ...valid, status: "trusted" })).toBe(false);
  });

  it("rejects NaN metrics", () => {
    expect(isSkillTrustBadgeData({ ...valid, wilsonLower: NaN })).toBe(false);
    expect(isSkillTrustBadgeData({ ...valid, recentBrier: NaN })).toBe(false);
  });

  it("rejects Infinity/-Infinity metrics", () => {
    expect(isSkillTrustBadgeData({ ...valid, wilsonLower: Infinity })).toBe(false);
    expect(isSkillTrustBadgeData({ ...valid, recentBrier: -Infinity })).toBe(false);
  });

  it("rejects missing fields", () => {
    const { n: _n, ...withoutN } = valid;
    expect(isSkillTrustBadgeData(withoutN)).toBe(false);
    const { name: _name, ...withoutName } = valid;
    expect(isSkillTrustBadgeData(withoutName)).toBe(false);
  });

  it("rejects non-integer or negative n/verifiedN", () => {
    expect(isSkillTrustBadgeData({ ...valid, n: 1.5 })).toBe(false);
    expect(isSkillTrustBadgeData({ ...valid, n: -1 })).toBe(false);
    expect(isSkillTrustBadgeData({ ...valid, verifiedN: -1 })).toBe(false);
  });

  it("rejects a non-string name", () => {
    expect(isSkillTrustBadgeData({ ...valid, name: 42 })).toBe(false);
  });

  it("rejects primitives and undefined", () => {
    expect(isSkillTrustBadgeData(undefined)).toBe(false);
    expect(isSkillTrustBadgeData("active")).toBe(false);
    expect(isSkillTrustBadgeData(42)).toBe(false);
    expect(isSkillTrustBadgeData(true)).toBe(false);
  });
});
