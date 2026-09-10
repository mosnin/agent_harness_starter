/**
 * Central-integration tests for the desktop skill-trust surface: the IPC
 * contract's new `trust` field on `skills.list` entries (guard + codec), the
 * `SkillsService` -> `SkillTrustService` enrichment (REAL trust/track files
 * built by the REAL engines — `SkillTrackRecordStore` hash chaining,
 * `serializeTrustStates` — never hand-forged JSON), the string-rendered badge
 * in the Skills view (structure + escaping), and the app-store reducer
 * carrying the badge through to renderer state.
 *
 * REAL-VS-MOCK POLICY: every metric asserted here is recomputed independently
 * with the real exported `brierScore`/`wilsonLowerBound` over the same
 * outcomes that were recorded — no expected number is invented.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
  decodeEvent,
  encodeEvent,
  isAppEvent,
  isSkillTrustBadgeView,
  type AppEvent,
} from "../ipc/contract";
import { SkillsService, type SkillsFs } from "../core/skills-service";
import { SkillTrustService } from "../core/skill-trust-service";
import { initialState, reduce } from "../core/app-store";
import { renderSkillList } from "../ui/skills-view";
import { trustBadgeLabel } from "../ui/skill-trust-badge";
import {
  SkillTrackRecordStore,
  brierScore,
  wilsonLowerBound,
} from "../../hades/skills/track-record";
import { serializeTrustStates, type SkillTrustState } from "../../hades/skills/demotion";
import { writeFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function memFs(initial?: Record<string, string>): SkillsFs {
  const files = new Map<string, string>(Object.entries(initial ?? {}));
  const dirs = new Set<string>();
  const dirOf = (p: string): string => p.slice(0, Math.max(0, p.lastIndexOf("/")));
  const baseOf = (p: string): string => p.slice(p.lastIndexOf("/") + 1);
  for (const p of files.keys()) dirs.add(dirOf(p));
  return {
    async readDir(dir) {
      return [...files.keys()].filter((p) => dirOf(p) === dir).map(baseOf);
    },
    async readFile(path) {
      const c = files.get(path);
      if (c === undefined) throw new Error(`ENOENT: ${path}`);
      return c;
    },
    async writeFile(path, content) {
      files.set(path, content);
      dirs.add(dirOf(path));
    },
    async mkdirp(dir) {
      dirs.add(dir);
    },
    async exists(dir) {
      return dirs.has(dir) || [...files.keys()].some((p) => dirOf(p) === dir);
    },
  };
}

function skillMd(name: string, description: string): string {
  return `---\nname: ${name}\ndescription: ${description}\ncapabilities: [x]\ntools: []\n---\n# ${name}\n\nBody.\n`;
}

const badge = {
  name: "great skill",
  status: "active" as const,
  wilsonLower: 0.7225,
  recentBrier: 0.01,
  n: 10,
  verifiedN: 10,
};

const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

function tempDataDir(): string {
  const d = mkdtempSync(join(tmpdir(), "hades-trust-wiring-"));
  tmpDirs.push(d);
  return d;
}

// ---------------------------------------------------------------------------
// Contract: guard + codec
// ---------------------------------------------------------------------------

describe("ipc contract: skills.list trust badges", () => {
  it("isSkillTrustBadgeView accepts every valid status and null metrics", () => {
    for (const status of ["active", "probation", "demoted", "unscored", "integrity-error"] as const) {
      expect(isSkillTrustBadgeView({ ...badge, status })).toBe(true);
    }
    expect(isSkillTrustBadgeView({ ...badge, wilsonLower: null, recentBrier: null })).toBe(true);
  });

  it("isSkillTrustBadgeView rejects malformed badges", () => {
    expect(isSkillTrustBadgeView(null)).toBe(false);
    expect(isSkillTrustBadgeView({ ...badge, status: "trusted" })).toBe(false);
    expect(isSkillTrustBadgeView({ ...badge, wilsonLower: NaN })).toBe(false);
    expect(isSkillTrustBadgeView({ ...badge, recentBrier: Infinity })).toBe(false);
    expect(isSkillTrustBadgeView({ ...badge, n: -1 })).toBe(false);
    expect(isSkillTrustBadgeView({ ...badge, verifiedN: 1.5 })).toBe(false);
    expect(isSkillTrustBadgeView({ ...badge, name: 7 })).toBe(false);
  });

  it("skills.list round-trips through encode/decode with and without trust, and rejects a bad badge", () => {
    const withTrust: AppEvent = {
      kind: "skills.list",
      skills: [{ name: "great skill", description: "d", trust: badge }],
    };
    expect(decodeEvent(encodeEvent(withTrust))).toEqual(withTrust);

    const withoutTrust: AppEvent = { kind: "skills.list", skills: [{ name: "a", description: "b" }] };
    expect(decodeEvent(encodeEvent(withoutTrust))).toEqual(withoutTrust);

    const bad = JSON.stringify({
      kind: "skills.list",
      skills: [{ name: "a", description: "b", trust: { ...badge, status: "nope" } }],
    });
    expect(() => decodeEvent(bad)).toThrow(/invalid fields/);
    expect(isAppEvent(JSON.parse(bad))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SkillsService -> SkillTrustService enrichment over REAL engine-built files
// ---------------------------------------------------------------------------

describe("SkillsService trust enrichment (real SkillTrustService over real files)", () => {
  it("attaches real badges: persisted status + store-computed metrics, unscored for history-less skills", async () => {
    const dataDir = tempDataDir();

    // REAL track record for "great skill": 3 verified successes at p=0.9,
    // hash-chained by the real store writing to the real temp dir.
    const store = new SkillTrackRecordStore({ path: join(dataDir, "skill-track.json") });
    const outcomes = [
      { predictedP: 0.9, success: true },
      { predictedP: 0.9, success: true },
      { predictedP: 0.8, success: true },
    ];
    outcomes.forEach((o, i) =>
      store.record({ skillName: "great skill", ...o, at: 1000 + i, certSha256: `c${i}`.repeat(4) })
    );

    // REAL persisted trust decision via the real serializer.
    const states = new Map<string, SkillTrustState>([
      [
        "great skill",
        { skillName: "great skill", status: "active", since: 1000, streak: 3, reasons: [] },
      ],
    ]);
    writeFileSync(join(dataDir, "skill-trust.json"), serializeTrustStates(states), "utf8");

    const svc = new SkillsService({
      dir: "/skills",
      fs: memFs({
        "/skills/great-skill.md": skillMd("great skill", "Does something great."),
        "/skills/fresh.md": skillMd("fresh", "No history yet."),
      }),
      trust: new SkillTrustService({ dataDir }),
    });

    const events = await svc.handle({ kind: "skills.list" } as const);
    expect(events).toHaveLength(1);
    const ev = events[0];
    if (ev.kind !== "skills.list") throw new Error("expected skills.list");

    const great = ev.skills.find((s) => s.name === "great skill");
    const fresh = ev.skills.find((s) => s.name === "fresh");
    expect(great?.trust).toBeDefined();
    expect(fresh?.trust).toBeDefined();

    // Independent recomputation with the real exported math — no invented numbers.
    const entries = store.entries("great skill");
    expect(great?.trust?.status).toBe("active");
    expect(great?.trust?.n).toBe(3);
    expect(great?.trust?.verifiedN).toBe(3);
    expect(great?.trust?.wilsonLower).toBe(wilsonLowerBound(3, 3));
    expect(great?.trust?.recentBrier).toBe(brierScore(entries.slice(-20)));

    // No persisted decision + no history -> honest unscored, null metrics.
    expect(fresh?.trust).toEqual({
      name: "fresh",
      status: "unscored",
      wilsonLower: null,
      recentBrier: null,
      n: 0,
      verifiedN: 0,
    });

    // Every attached badge passes the wire guard the renderer relies on.
    for (const s of ev.skills) expect(s.trust === undefined || isSkillTrustBadgeView(s.trust)).toBe(true);
  });

  it("a corrupt track store degrades to integrity-error badges — never unscored, never a dead list", async () => {
    const dataDir = tempDataDir();
    writeFileSync(join(dataDir, "skill-track.json"), "{ not json", "utf8");

    const svc = new SkillsService({
      dir: "/skills",
      fs: memFs({ "/skills/great-skill.md": skillMd("great skill", "d") }),
      trust: new SkillTrustService({ dataDir }),
    });
    const skills = await svc.list();
    expect(skills).toHaveLength(1);
    expect(skills[0].trust?.status).toBe("integrity-error");
  });

  it("without a trust source, entries carry no trust field (deterministic default)", async () => {
    const svc = new SkillsService({
      dir: "/skills",
      fs: memFs({ "/skills/great-skill.md": skillMd("great skill", "d") }),
    });
    const skills = await svc.list();
    expect(skills).toEqual([{ name: "great skill", description: "d" }]);
  });

  it("a throwing injected trust source degrades to badge-less entries instead of failing the listing", async () => {
    const svc = new SkillsService({
      dir: "/skills",
      fs: memFs({ "/skills/great-skill.md": skillMd("great skill", "d") }),
      trust: {
        badges: async () => {
          throw new Error("boom");
        },
      },
    });
    const skills = await svc.list();
    expect(skills).toEqual([{ name: "great skill", description: "d" }]);
  });
});

// ---------------------------------------------------------------------------
// Skills view: string-rendered badge (same classes as skill-trust-badge.css)
// ---------------------------------------------------------------------------

describe("renderSkillList trust badges", () => {
  it("renders the badge structure with the status class, label title, and metrics", () => {
    const html = renderSkillList([
      { name: "great skill", description: "d", trust: badge },
      { name: "plain", description: "no badge" },
    ]);
    expect(html).toContain('skill-trust-badge--active');
    expect(html).toContain('data-skill-trust-status="active"');
    expect(html).toContain("skill-trust-badge__dot");
    expect(html).toContain("wilson 0.7225 · brier 0.0100 · n=10");
    expect(html).toContain(`title="${trustBadgeLabel(badge)}"`);
    // Exactly one badge: the badge-less skill renders none.
    expect(html.match(/skill-trust-badge__dot/g)).toHaveLength(1);
  });

  it("null metrics render as words and hostile names never escape into markup", () => {
    const hostile = {
      name: '<script>alert(1)</script>',
      status: "integrity-error" as const,
      wilsonLower: null,
      recentBrier: null,
      n: 0,
      verifiedN: 0,
    };
    const html = renderSkillList([
      { name: '<script>alert(1)</script>', description: '"quoted" & <b>', trust: hostile },
    ]);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("integrity error");
    expect(html).toContain("wilson no track record · brier no track record · n=0");
  });
});

// ---------------------------------------------------------------------------
// app-store: the badge survives the reducer into renderer state
// ---------------------------------------------------------------------------

describe("app-store: skills.list trust passthrough", () => {
  it("reduce(skills.list) keeps per-skill trust badges in state", () => {
    const next = reduce(initialState(), {
      kind: "skills.list",
      skills: [{ name: "great skill", description: "d", trust: badge }],
    });
    expect(next.skills[0].trust).toEqual(badge);
  });
});
