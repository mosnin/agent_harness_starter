import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, writeFile, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { sha256Hex } from "../../styx/certificate";
import { LIVE_MANIFEST_VERSION, preflightLiveShowdown } from "../showdown-live";
import type { LiveRunManifest } from "../showdown-live";
import {
  verifyLiveRunDir,
  renderManifestAudit,
  livePreflightSummary,
  type AuditFsDeps,
  type ManifestAudit,
} from "../live-manifest-verify";

// ===========================================================================
// Fixture helpers — real files on a real temp dir, real sha256Hex, a manifest
// shaped exactly like LiveRunManifest. Clearly a labelled TEST FIXTURE, never
// presented as a real keyed run: content strings say so explicitly and the
// provider/model are the real defaults `preflightLiveShowdown` would pick,
// not anything fabricated as if measured.
// ===========================================================================

const REPORT_CONTENT = "# FIXTURE Showdown Report (test fixture, not a real keyed run)\n";
const AUDIT_CONTENT = '{"seq":0,"event":"fixture-record"}\n';
const RESULT_CONTENT = '{"mode":"real","taskCount":1,"fixture":true}\n';

const tempDirs: string[] = [];

async function freshDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "live-manifest-verify-"));
  tempDirs.push(dir);
  return dir;
}

interface FixtureOptions {
  /** Loosely typed on purpose: some tamper-matrix tests need files[] names
   *  that violate LiveRunManifest's literal-union type (e.g. `../escape.txt`)
   *  to prove the on-disk-JSON auditor validates untyped bytes, not just
   *  TypeScript's compile-time guarantees. */
  files?: Array<{ name: string; sha256: string }>;
  manifestOverrides?: Record<string, unknown>;
  writeArtifacts?: boolean;
}

async function writeFixtureRunDir(opts: FixtureOptions = {}): Promise<{ dir: string; manifest: LiveRunManifest }> {
  const dir = await freshDir();

  if (opts.writeArtifacts !== false) {
    await writeFile(join(dir, "report.md"), REPORT_CONTENT, "utf8");
    await writeFile(join(dir, "audit.jsonl"), AUDIT_CONTENT, "utf8");
    await writeFile(join(dir, "result.json"), RESULT_CONTENT, "utf8");
  }

  const files =
    opts.files ??
    [
      { name: "report.md", sha256: sha256Hex(REPORT_CONTENT) },
      { name: "audit.jsonl", sha256: sha256Hex(AUDIT_CONTENT) },
      { name: "result.json", sha256: sha256Hex(RESULT_CONTENT) },
    ];

  const manifest = {
    version: LIVE_MANIFEST_VERSION,
    mode: "real",
    seed: 42,
    taskCount: 1,
    provider: "anthropic",
    model: "claude-sonnet-5",
    nodeVersion: process.version,
    startedAt: 1_000,
    finishedAt: 2_000,
    wallMs: 1_000,
    files,
    vtph: { swarm: 10, baseline: 5, multiple: 2, swarmVerified: 1, baselineVerified: 1 },
    ...opts.manifestOverrides,
  } as unknown as LiveRunManifest;

  await writeFile(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
  return { dir, manifest };
}

function checkByName(audit: ManifestAudit, name: string) {
  const c = audit.checks.find((c) => c.name === name);
  if (!c) throw new Error(`expected a check named ${name}, got: ${audit.checks.map((c) => c.name).join(", ")}`);
  return c;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

// ===========================================================================
// The tamper matrix
// ===========================================================================

describe("verifyLiveRunDir — tamper matrix", () => {
  it("passes every check for a pristine fixture", async () => {
    const { dir } = await writeFixtureRunDir();
    const audit = await verifyLiveRunDir(dir);
    expect(audit.ok).toBe(true);
    expect(audit.checks.every((c) => c.ok)).toBe(true);
    expect(audit.manifest).toBeDefined();
    expect(audit.manifest?.version).toBe(LIVE_MANIFEST_VERSION);
    // Every declared check name present.
    const names = audit.checks.map((c) => c.name);
    for (const expected of [
      "directory-listing",
      "manifest-parses",
      "manifest-version",
      "manifest-shape",
      "model-non-empty",
      "files-path-traversal-safe",
      "files-no-duplicates",
      "file-hash:audit.jsonl",
      "file-hash:report.md",
      "file-hash:result.json",
      "no-extra-files",
      "no-leftover-tmp",
    ]) {
      expect(names).toContain(expected);
    }
  });

  it("catches a single flipped byte in one artifact via ONLY that file's hash check", async () => {
    const { dir } = await writeFixtureRunDir();
    // Flip one byte in report.md without touching the manifest's hash.
    await writeFile(join(dir, "report.md"), REPORT_CONTENT.replace("FIXTURE", "fixture"), "utf8");

    const audit = await verifyLiveRunDir(dir);
    expect(audit.ok).toBe(false);
    expect(checkByName(audit, "file-hash:report.md").ok).toBe(false);
    expect(checkByName(audit, "file-hash:report.md").detail).toMatch(/sha256 mismatch/);
    expect(checkByName(audit, "file-hash:audit.jsonl").ok).toBe(true);
    expect(checkByName(audit, "file-hash:result.json").ok).toBe(true);
    // Nothing else should be collaterally broken by a single byte flip.
    expect(checkByName(audit, "manifest-shape").ok).toBe(true);
    expect(checkByName(audit, "no-extra-files").ok).toBe(true);
  });

  it("catches a deleted listed file as a missing-file failure on its own check", async () => {
    const { dir } = await writeFixtureRunDir();
    await unlink(join(dir, "audit.jsonl"));

    const audit = await verifyLiveRunDir(dir);
    expect(audit.ok).toBe(false);
    const c = checkByName(audit, "file-hash:audit.jsonl");
    expect(c.ok).toBe(false);
    expect(c.detail).toMatch(/could not be read/);
    expect(checkByName(audit, "file-hash:report.md").ok).toBe(true);
  });

  it("catches an added rogue file via no-extra-files, reported by name", async () => {
    const { dir } = await writeFixtureRunDir();
    await writeFile(join(dir, "rogue.txt"), "not in the manifest", "utf8");

    const audit = await verifyLiveRunDir(dir);
    expect(audit.ok).toBe(false);
    const c = checkByName(audit, "no-extra-files");
    expect(c.ok).toBe(false);
    expect(c.detail).toContain("rogue.txt");
  });

  it("tolerates files[] entries being reordered — order is not integrity", async () => {
    const inOrder = await writeFixtureRunDir();
    const reordered = await writeFixtureRunDir({
      files: [
        { name: "result.json", sha256: sha256Hex(RESULT_CONTENT) },
        { name: "report.md", sha256: sha256Hex(REPORT_CONTENT) },
        { name: "audit.jsonl", sha256: sha256Hex(AUDIT_CONTENT) },
      ],
    });

    const auditA = await verifyLiveRunDir(inOrder.dir);
    const auditB = await verifyLiveRunDir(reordered.dir);

    expect(auditA.ok).toBe(true);
    expect(auditB.ok).toBe(true);
    // The AUDIT's own check ordering is unaffected by manifest files[] order
    // (per-file checks are alphabetically sorted) — a reorder in the
    // manifest never reshuffles the audit's own check sequence.
    expect(auditA.checks.map((c) => c.name)).toEqual(auditB.checks.map((c) => c.name));
  });

  it("rejects path-traversal / absolute files[] names WITHOUT reading outside the run dir", async () => {
    const { dir } = await writeFixtureRunDir({
      files: [
        { name: "report.md", sha256: sha256Hex(REPORT_CONTENT) },
        { name: "../escape.txt", sha256: "deadbeef" },
        { name: "/etc/passwd", sha256: "deadbeef" },
      ],
    });

    const seenReads: string[] = [];
    const spyFs: AuditFsDeps = {
      readFile: async (path, enc) => {
        seenReads.push(path);
        if (!path.startsWith(dir + sep) && path !== join(dir, "manifest.json")) {
          throw new Error(`test spy: refused to simulate a read outside the run dir: ${path}`);
        }
        const { readFile } = await import("node:fs/promises");
        return readFile(path, enc);
      },
      readdir: async (path) => {
        const { readdir } = await import("node:fs/promises");
        return readdir(path);
      },
    };

    const audit = await verifyLiveRunDir(dir, spyFs);
    expect(audit.ok).toBe(false);

    const traversalCheck = checkByName(audit, "files-path-traversal-safe");
    expect(traversalCheck.ok).toBe(false);
    expect(traversalCheck.detail).toContain("../escape.txt");
    expect(traversalCheck.detail).toContain("/etc/passwd");

    // Every path actually handed to the spy readFile is inside `dir` (or is
    // manifest.json itself) — proving the traversal names were rejected by
    // string inspection alone, never by attempting a read.
    for (const p of seenReads) {
      expect(p.startsWith(dir + sep) || p === join(dir, "manifest.json")).toBe(true);
    }
    // Specifically: the unsafe names were never handed to readFile at all.
    expect(seenReads).not.toContain("../escape.txt");
    expect(seenReads).not.toContain("/etc/passwd");
    expect(seenReads.some((p) => p.includes("etc/passwd"))).toBe(false);
  });

  it("catches a version bump via manifest-version, independent of manifest-shape", async () => {
    const { dir } = await writeFixtureRunDir({ manifestOverrides: { version: LIVE_MANIFEST_VERSION + 1 } });
    const audit = await verifyLiveRunDir(dir);
    expect(audit.ok).toBe(false);
    expect(checkByName(audit, "manifest-version").ok).toBe(false);
    expect(checkByName(audit, "manifest-shape").ok).toBe(true);
    // Shape passed, so manifest is still surfaced (with the wrong version).
    expect(audit.manifest?.version).toBe(LIVE_MANIFEST_VERSION + 1);
  });

  it("accepts a manifest WITH the optional trust-adjusted verified-yield fields (numeric)", async () => {
    const { dir } = await writeFixtureRunDir({
      manifestOverrides: {
        vtph: {
          swarm: 10,
          baseline: 5,
          multiple: 2,
          swarmVerified: 1,
          baselineVerified: 1,
          swarmVerifiedYield: 144.9,
          baselineVerifiedYield: -3.5, // negative is legitimate (silent-wrong penalty)
        },
      },
    });
    const audit = await verifyLiveRunDir(dir);
    expect(audit.ok).toBe(true);
    expect(checkByName(audit, "manifest-shape").ok).toBe(true);
  });

  it("still accepts a pre-verifiedYield manifest (fields absent) — absence is never a shape error", async () => {
    // The default fixture manifest carries no swarmVerifiedYield /
    // baselineVerifiedYield, exactly like a manifest published before the
    // trust-adjusted metric existed.
    const { dir, manifest } = await writeFixtureRunDir();
    expect((manifest.vtph as Record<string, unknown>).swarmVerifiedYield).toBeUndefined();
    const audit = await verifyLiveRunDir(dir);
    expect(audit.ok).toBe(true);
    expect(checkByName(audit, "manifest-shape").ok).toBe(true);
  });

  it("rejects a wrong-typed optional vtph.swarmVerifiedYield via manifest-shape", async () => {
    const { dir } = await writeFixtureRunDir({
      manifestOverrides: {
        vtph: {
          swarm: 10,
          baseline: 5,
          multiple: 2,
          swarmVerified: 1,
          baselineVerified: 1,
          swarmVerifiedYield: "not-a-number",
        },
      },
    });
    const audit = await verifyLiveRunDir(dir);
    expect(audit.ok).toBe(false);
    const c = checkByName(audit, "manifest-shape");
    expect(c.ok).toBe(false);
    expect(c.detail).toContain("swarmVerifiedYield");
  });

  it("never throws on a manifest truncated mid-JSON, and fails manifest-parses honestly", async () => {
    const { dir, manifest } = await writeFixtureRunDir();
    const full = JSON.stringify(manifest, null, 2);
    const truncated = full.slice(0, Math.floor(full.length / 2));
    await writeFile(join(dir, "manifest.json"), truncated, "utf8");

    const audit = await expect(verifyLiveRunDir(dir)).resolves.toBeDefined();
    void audit;
    const result = await verifyLiveRunDir(dir);
    expect(result.ok).toBe(false);
    expect(checkByName(result, "manifest-parses").ok).toBe(false);
    expect(result.manifest).toBeUndefined();
  });

  it("catches a leftover manifest.json.tmp as an interrupted publish", async () => {
    const { dir } = await writeFixtureRunDir();
    await writeFile(join(dir, "manifest.json.tmp"), "{}", "utf8");

    const audit = await verifyLiveRunDir(dir);
    expect(audit.ok).toBe(false);
    const c = checkByName(audit, "no-leftover-tmp");
    expect(c.ok).toBe(false);
    expect(c.detail).toContain("manifest.json.tmp");
    // The .tmp file must not ALSO be double-reported as an unlisted extra file.
    expect(checkByName(audit, "no-extra-files").detail).not.toContain("manifest.json.tmp");
  });

  it("catches duplicate files[] entries via its own named check", async () => {
    const { dir } = await writeFixtureRunDir({
      files: [
        { name: "report.md", sha256: sha256Hex(REPORT_CONTENT) },
        { name: "report.md", sha256: sha256Hex(REPORT_CONTENT) },
        { name: "audit.jsonl", sha256: sha256Hex(AUDIT_CONTENT) },
        { name: "result.json", sha256: sha256Hex(RESULT_CONTENT) },
      ],
    });

    const audit = await verifyLiveRunDir(dir);
    expect(audit.ok).toBe(false);
    const c = checkByName(audit, "files-no-duplicates");
    expect(c.ok).toBe(false);
    expect(c.detail).toContain("report.md");
  });

  it("never throws for a rejecting fs (both readdir and readFile reject)", async () => {
    const rejectingFs: AuditFsDeps = {
      readFile: async () => {
        throw new Error("simulated readFile failure");
      },
      readdir: async () => {
        throw new Error("simulated readdir failure");
      },
    };

    const audit = await verifyLiveRunDir("/some/nonexistent/dir", rejectingFs);
    expect(audit.ok).toBe(false);
    expect(checkByName(audit, "directory-listing").ok).toBe(false);
    expect(checkByName(audit, "directory-listing").detail).toContain("simulated readdir failure");
    expect(checkByName(audit, "manifest-parses").ok).toBe(false);
    expect(checkByName(audit, "manifest-parses").detail).toContain("simulated readFile failure");
    expect(audit.manifest).toBeUndefined();
  });

  it("never throws for a synchronously-throwing fs", async () => {
    const throwingFs: AuditFsDeps = {
      readFile: (() => {
        throw new Error("sync boom");
      }) as unknown as AuditFsDeps["readFile"],
      readdir: (() => {
        throw new Error("sync boom readdir");
      }) as unknown as AuditFsDeps["readdir"],
    };
    await expect(verifyLiveRunDir("/whatever", throwingFs)).resolves.toBeDefined();
  });
});

// ===========================================================================
// Non-tamper-matrix structural checks
// ===========================================================================

describe("verifyLiveRunDir — checks array is stable-ordered and machine-consumable", () => {
  it("produces the identical checks array across repeated runs of the same fixture", async () => {
    const { dir } = await writeFixtureRunDir();
    const a = await verifyLiveRunDir(dir);
    const b = await verifyLiveRunDir(dir);
    expect(JSON.stringify(a.checks)).toBe(JSON.stringify(b.checks));
  });

  it("orders per-file checks alphabetically regardless of files[] declaration order", async () => {
    const { dir } = await writeFixtureRunDir({
      files: [
        { name: "result.json", sha256: sha256Hex(RESULT_CONTENT) },
        { name: "audit.jsonl", sha256: sha256Hex(AUDIT_CONTENT) },
        { name: "report.md", sha256: sha256Hex(REPORT_CONTENT) },
      ],
    });
    const audit = await verifyLiveRunDir(dir);
    const fileChecks = audit.checks.map((c) => c.name).filter((n) => n.startsWith("file-hash:"));
    expect(fileChecks).toEqual(["file-hash:audit.jsonl", "file-hash:report.md", "file-hash:result.json"]);
  });
});

describe("verifyLiveRunDir — model field is reported verbatim, never validated against a list", () => {
  it("reports an unrecognized model name verbatim as PASS (non-empty string)", async () => {
    const { dir } = await writeFixtureRunDir({ manifestOverrides: { model: "some-totally-unheard-of-model-xyz" } });
    const audit = await verifyLiveRunDir(dir);
    const c = checkByName(audit, "model-non-empty");
    expect(c.ok).toBe(true);
    expect(c.detail).toContain("some-totally-unheard-of-model-xyz");
  });

  it("fails model-non-empty for an empty model string", async () => {
    const { dir } = await writeFixtureRunDir({ manifestOverrides: { model: "" } });
    const audit = await verifyLiveRunDir(dir);
    expect(checkByName(audit, "model-non-empty").ok).toBe(false);
  });
});

describe("renderManifestAudit", () => {
  it("renders PASS/FAIL per check with no ANSI, and an honest overall verdict", () => {
    const audit: ManifestAudit = {
      ok: false,
      checks: [
        { name: "a", ok: true, detail: "all good" },
        { name: "b", ok: false, detail: "went wrong" },
      ],
    };
    const lines = renderManifestAudit(audit);
    expect(lines[0]).toBe("[PASS] a: all good");
    expect(lines[1]).toBe("[FAIL] b: went wrong");
    expect(lines[lines.length - 1]).toMatch(/^Overall: FAIL/);
    expect(lines[lines.length - 1]).toContain("1 of 2");
    for (const l of lines) {
      // eslint-disable-next-line no-control-regex
      expect(l).not.toMatch(/\x1b\[/);
    }
  });

  it("renders an honest PASS verdict when every check passes", () => {
    const audit: ManifestAudit = { ok: true, checks: [{ name: "a", ok: true, detail: "fine" }] };
    const lines = renderManifestAudit(audit);
    expect(lines[lines.length - 1]).toMatch(/^Overall: PASS/);
  });
});

// ===========================================================================
// livePreflightSummary — readiness honesty, both ways
// ===========================================================================

describe("livePreflightSummary", () => {
  it("reports ready:true and names the exact provider/model preflightLiveShowdown would use, with no paraphrase drift", () => {
    const env = { ANTHROPIC_API_KEY: "sk-test-key-material-not-real" };
    const preflight = preflightLiveShowdown(env);
    expect(preflight.ok).toBe(true);

    const summary = livePreflightSummary(env);
    expect(summary.ready).toBe(true);
    expect(summary.lines).toEqual([
      `READY — a live, keyed showdown would run against provider=${preflight.provider} model=${preflight.model}.`,
      ...preflight.reasons,
      "Command that closes the gate: hades showdown live --out runs/live-001",
    ]);
  });

  it("reports ready:true for an OpenAI-only env too, matching preflightLiveShowdown exactly", () => {
    const env = { OPENAI_API_KEY: "sk-test-openai-key" };
    const preflight = preflightLiveShowdown(env);
    const summary = livePreflightSummary(env);
    expect(summary.ready).toBe(true);
    expect(summary.lines[0]).toContain(`provider=${preflight.provider}`);
    expect(summary.lines[0]).toContain(`model=${preflight.model}`);
  });

  it("reports ready:false for the current keyless env shape, repeating preflight's reasons verbatim and stating the gate is UNMET", () => {
    const env: Record<string, string | undefined> = {};
    const preflight = preflightLiveShowdown(env);
    expect(preflight.ok).toBe(false);

    const summary = livePreflightSummary(env);
    expect(summary.ready).toBe(false);
    for (const reason of preflight.reasons) {
      expect(summary.lines).toContain(reason);
    }
    expect(summary.lines.some((l) => l.includes("UNMET"))).toBe(true);
    expect(summary.lines.some((l) => l.startsWith("READY —"))).toBe(false);
  });

  it("never claims a key exists when ANTHROPIC_API_KEY/OPENAI_API_KEY are present but empty strings", () => {
    const env = { ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "" };
    const summary = livePreflightSummary(env);
    expect(summary.ready).toBe(false);
  });
});
