/* ------------------------------------------------------------------ *
 * bundle.test.ts
 *
 * Exercises the real portable-bundle builder against real temp
 * directories on the real filesystem -- no `fs` mocking anywhere. Every
 * `sha256` this module claims is independently recomputed here with
 * `node:crypto` directly against the bytes on disk, so the module's own
 * hashing is never trusted by its own test.
 * ------------------------------------------------------------------ */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import {
  BUNDLE_MANIFEST_FILE,
  BUNDLE_MANIFEST_VERSION,
  DEFAULT_BUNDLE_INCLUDES,
  bundleLaunchers,
  computeRootHash,
  planBundle,
  readManifest,
  stageBundle,
  verifyBundle,
  writeManifest,
  type BundleEntry,
  type BundleManifest,
  type BundleSourceSpec,
} from "../bundle";

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "hades-bundle-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function tmpDir(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

function realSha256(absPath: string): string {
  return createHash("sha256").update(readFileSync(absPath)).digest("hex");
}

function clockNow(startMs = 1_700_000_000_000) {
  return () => startMs;
}

/** Builds a real source tree covering every case the round-trip test needs:
 *  a nested dir, an executable, a 0-byte file, a unicode filename, and a
 *  file bigger than 2 MiB. */
function buildRichTree(sourceRoot: string): void {
  mkdirSync(path.join(sourceRoot, "nested", "deep"), { recursive: true });
  writeFileSync(path.join(sourceRoot, "nested", "deep", "leaf.txt"), "leaf contents\n");
  writeFileSync(path.join(sourceRoot, "empty.bin"), Buffer.alloc(0));
  writeFileSync(path.join(sourceRoot, "réunion-☃.txt"), "unicode filename contents\n", "utf8");

  const scriptPath = path.join(sourceRoot, "run.sh");
  writeFileSync(scriptPath, "#!/bin/sh\necho hi\n");
  chmodSync(scriptPath, 0o755);

  // > 2 MiB
  const big = Buffer.alloc(2 * 1024 * 1024 + 777, 0x5a);
  writeFileSync(path.join(sourceRoot, "big.bin"), big);
}

function richIncludes(): BundleSourceSpec[] {
  return [
    { from: "nested", to: "nested" },
    { from: "empty.bin", to: "empty.bin" },
    { from: "réunion-☃.txt", to: "réunion-☃.txt" },
    { from: "run.sh", to: "run.sh" },
    { from: "big.bin", to: "big.bin" },
  ];
}

// ===========================================================================
// 1. Round trip
// ===========================================================================

describe("round trip: stage then verify", () => {
  it("stages a real tree and verifies fully ok, with every hash independently recomputed", () => {
    buildRichTree(root);
    const outDir = path.join(tmpDir("hades-bundle-out-"), "bundle");

    const manifest = stageBundle({
      sourceRoot: root,
      outDir,
      include: richIncludes(),
      hadesVersion: "9.9.9",
      now: clockNow(),
    });

    expect(manifest.entries.length).toBe(5); // nested/deep/leaf.txt, empty.bin, unicode file, run.sh, big.bin
    expect(manifest.version).toBe(BUNDLE_MANIFEST_VERSION);
    expect(manifest.hadesVersion).toBe("9.9.9");

    // Independently recompute every claimed hash directly from disk.
    for (const entry of manifest.entries) {
      const abs = path.join(outDir, ...entry.path.split("/"));
      expect(existsSync(abs)).toBe(true);
      const st = statSync(abs);
      expect(st.size).toBe(entry.bytes);
      expect(realSha256(abs)).toBe(entry.sha256);
    }

    // Executable bit preserved for run.sh, not for the plain files.
    const runEntry = manifest.entries.find((e) => e.path === "run.sh")!;
    expect(runEntry.executable).toBe(true);
    const leafEntry = manifest.entries.find((e) => e.path === "nested/deep/leaf.txt")!;
    expect(leafEntry.executable).toBe(false);

    // Unicode filename staged correctly.
    const unicodeEntry = manifest.entries.find((e) => e.path === "réunion-☃.txt");
    expect(unicodeEntry).toBeDefined();

    // 0-byte file staged correctly.
    const emptyEntry = manifest.entries.find((e) => e.path === "empty.bin")!;
    expect(emptyEntry.bytes).toBe(0);
    expect(emptyEntry.sha256).toBe(createHash("sha256").update(Buffer.alloc(0)).digest("hex"));

    // >2MiB file staged and hashed correctly.
    const bigEntry = manifest.entries.find((e) => e.path === "big.bin")!;
    expect(bigEntry.bytes).toBe(2 * 1024 * 1024 + 777);

    const verification = verifyBundle(outDir);
    expect(verification).toEqual({
      ok: true,
      manifestOk: true,
      rootHashOk: true,
      missing: [],
      modified: [],
      extra: [],
      checked: manifest.entries.length,
    });
  });
});

// ===========================================================================
// 2. Determinism
// ===========================================================================

describe("determinism", () => {
  it("two stageBundle calls over the same tree with the same injected now produce byte-identical bundle.json", () => {
    buildRichTree(root);
    const out1 = path.join(tmpDir("hades-bundle-det1-"), "bundle");
    const out2 = path.join(tmpDir("hades-bundle-det2-"), "bundle");

    stageBundle({ sourceRoot: root, outDir: out1, include: richIncludes(), hadesVersion: "1.2.3", now: clockNow(42) });
    stageBundle({ sourceRoot: root, outDir: out2, include: richIncludes(), hadesVersion: "1.2.3", now: clockNow(42) });

    const manifest1 = readFileSync(path.join(out1, BUNDLE_MANIFEST_FILE), "utf8");
    const manifest2 = readFileSync(path.join(out2, BUNDLE_MANIFEST_FILE), "utf8");
    expect(manifest1).toBe(manifest2);
  });

  it("entry order is path-sorted and stable regardless of directory-read order", () => {
    // Build the same set of files in two different creation orders; the
    // manifest's entries array must come out identically ordered either way.
    const srcA = tmpDir("hades-bundle-order-a-");
    mkdirSync(path.join(srcA, "z"));
    mkdirSync(path.join(srcA, "a"));
    writeFileSync(path.join(srcA, "z", "1.txt"), "one");
    writeFileSync(path.join(srcA, "a", "2.txt"), "two");
    writeFileSync(path.join(srcA, "m.txt"), "three");

    const srcB = tmpDir("hades-bundle-order-b-");
    writeFileSync(path.join(srcB, "m.txt"), "three");
    mkdirSync(path.join(srcB, "a"));
    writeFileSync(path.join(srcB, "a", "2.txt"), "two");
    mkdirSync(path.join(srcB, "z"));
    writeFileSync(path.join(srcB, "z", "1.txt"), "one");

    const include: BundleSourceSpec[] = [
      { from: "z", to: "z" },
      { from: "a", to: "a" },
      { from: "m.txt", to: "m.txt" },
    ];

    const outA = path.join(tmpDir("hades-bundle-order-outA-"), "bundle");
    const outB = path.join(tmpDir("hades-bundle-order-outB-"), "bundle");
    const manifestA = stageBundle({ sourceRoot: srcA, outDir: outA, include, hadesVersion: "1.0.0", now: clockNow(1) });
    const manifestB = stageBundle({ sourceRoot: srcB, outDir: outB, include, hadesVersion: "1.0.0", now: clockNow(1) });

    const pathsA = manifestA.entries.map((e) => e.path);
    const pathsB = manifestB.entries.map((e) => e.path);
    expect(pathsA).toEqual(pathsB);
    expect(pathsA).toEqual([...pathsA].sort());
  });
});

// ===========================================================================
// 3. Tamper matrix
// ===========================================================================

describe("tamper matrix", () => {
  function stageSimple(): { outDir: string; manifest: BundleManifest } {
    mkdirSync(path.join(root, "sub"), { recursive: true });
    writeFileSync(path.join(root, "sub", "a.txt"), "aaaa");
    writeFileSync(path.join(root, "sub", "b.txt"), "bbbb");
    const outDir = path.join(tmpDir("hades-bundle-tamper-"), "bundle");
    const manifest = stageBundle({
      sourceRoot: root,
      outDir,
      include: [{ from: "sub", to: "sub" }],
      hadesVersion: "1.0.0",
      now: clockNow(7),
    });
    return { outDir, manifest };
  }

  it("flipping one byte in a file yields modified, ok:false", () => {
    const { outDir } = stageSimple();
    const target = path.join(outDir, "sub", "a.txt");
    const buf = readFileSync(target);
    buf[0] = buf[0] ^ 0xff;
    writeFileSync(target, buf);

    const result = verifyBundle(outDir);
    expect(result.modified).toEqual(["sub/a.txt"]);
    expect(result.missing).toEqual([]);
    expect(result.extra).toEqual([]);
    expect(result.ok).toBe(false);
  });

  it("truncating a file yields modified (byte-count mismatch)", () => {
    const { outDir } = stageSimple();
    const target = path.join(outDir, "sub", "a.txt");
    writeFileSync(target, "a"); // was "aaaa"

    const result = verifyBundle(outDir);
    expect(result.modified).toEqual(["sub/a.txt"]);
    expect(statSync(target).size).not.toBe(4);
    expect(result.ok).toBe(false);
  });

  it("deleting a file yields missing", () => {
    const { outDir } = stageSimple();
    rmSync(path.join(outDir, "sub", "a.txt"));

    const result = verifyBundle(outDir);
    expect(result.missing).toEqual(["sub/a.txt"]);
    expect(result.modified).toEqual([]);
    expect(result.ok).toBe(false);
  });

  it("adding a file yields extra, ok:false unless allowExtra", () => {
    const { outDir } = stageSimple();
    writeFileSync(path.join(outDir, "sub", "intruder.txt"), "surprise");

    const strict = verifyBundle(outDir);
    expect(strict.extra).toEqual(["sub/intruder.txt"]);
    expect(strict.ok).toBe(false);

    const lenient = verifyBundle(outDir, { allowExtra: true });
    expect(lenient.extra).toEqual(["sub/intruder.txt"]);
    expect(lenient.ok).toBe(true);
  });

  it("swapping two files' contents flags both as modified", () => {
    const { outDir } = stageSimple();
    const aPath = path.join(outDir, "sub", "a.txt");
    const bPath = path.join(outDir, "sub", "b.txt");
    const aContent = readFileSync(aPath);
    const bContent = readFileSync(bPath);
    writeFileSync(aPath, bContent);
    writeFileSync(bPath, aContent);

    const result = verifyBundle(outDir);
    expect(result.modified.sort()).toEqual(["sub/a.txt", "sub/b.txt"]);
    expect(result.missing).toEqual([]);
    expect(result.extra).toEqual([]);
    expect(result.ok).toBe(false);
  });

  it("editing rootHash flags rootHashOk:false independently of file integrity", () => {
    const { outDir, manifest } = stageSimple();
    const tampered: BundleManifest = { ...manifest, rootHash: "0".repeat(64) };
    writeManifest(outDir, tampered);

    const result = verifyBundle(outDir);
    expect(result.rootHashOk).toBe(false);
    expect(result.manifestOk).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.modified).toEqual([]);
    expect(result.ok).toBe(false);
  });

  it("corrupting bundle.json into invalid JSON yields manifestOk:false, never a thrown exception", () => {
    const { outDir } = stageSimple();
    writeFileSync(path.join(outDir, BUNDLE_MANIFEST_FILE), "{ not valid json ][");

    let result;
    expect(() => {
      result = verifyBundle(outDir);
    }).not.toThrow();
    expect(result).toEqual({ ok: false, manifestOk: false, rootHashOk: false, missing: [], modified: [], extra: [], checked: 0 });
  });

  it("a mismatched manifest version is refused honestly, not thrown", () => {
    const { outDir, manifest } = stageSimple();
    const tampered = { ...manifest, version: BUNDLE_MANIFEST_VERSION + 1 };
    writeManifest(outDir, tampered as unknown as BundleManifest);

    let result;
    expect(() => {
      result = verifyBundle(outDir);
    }).not.toThrow();
    expect(result).toEqual({ ok: false, manifestOk: false, rootHashOk: false, missing: [], modified: [], extra: [], checked: 0 });
  });

  it("verifyBundle on a missing bundle directory is a diagnosis, not a throw", () => {
    let result;
    expect(() => {
      result = verifyBundle(path.join(tmpDir("hades-bundle-missing-"), "does-not-exist"));
    }).not.toThrow();
    expect(result).toEqual({ ok: false, manifestOk: false, rootHashOk: false, missing: [], modified: [], extra: [], checked: 0 });
  });
});

// ===========================================================================
// 4. Path safety
// ===========================================================================

describe("path safety", () => {
  it("refuses a `to` containing .. into plan.refused, and never writes it", () => {
    writeFileSync(path.join(root, "f.txt"), "hi");
    const outDir = path.join(tmpDir("hades-bundle-safety-"), "bundle");
    const include: BundleSourceSpec[] = [{ from: "f.txt", to: "../escape.txt" }];

    const plan = planBundle({ sourceRoot: root, outDir, include, hadesVersion: "1.0.0" });
    expect(plan.refused).toEqual([{ from: "f.txt", reason: expect.stringContaining("escapes the bundle root") }]);
    expect(plan.files).toEqual([]);

    const manifest = stageBundle({ sourceRoot: root, outDir, include, hadesVersion: "1.0.0", now: clockNow(1) });
    expect(manifest.entries).toEqual([]);
    expect(existsSync(path.join(path.dirname(outDir), "escape.txt"))).toBe(false);
  });

  it("refuses a `to` that is absolute", () => {
    writeFileSync(path.join(root, "f.txt"), "hi");
    const outDir = path.join(tmpDir("hades-bundle-safety2-"), "bundle");
    const include: BundleSourceSpec[] = [{ from: "f.txt", to: "/etc/passwd" }];

    const plan = planBundle({ sourceRoot: root, outDir, include, hadesVersion: "1.0.0" });
    expect(plan.refused).toHaveLength(1);
    expect(plan.refused[0].from).toBe("f.txt");
    expect(plan.files).toEqual([]);
  });

  it("refuses a `to` that normalizes outside outDir via nested traversal", () => {
    writeFileSync(path.join(root, "f.txt"), "hi");
    const outDir = path.join(tmpDir("hades-bundle-safety3-"), "bundle");
    const include: BundleSourceSpec[] = [{ from: "f.txt", to: "a/../../b.txt" }];

    const plan = planBundle({ sourceRoot: root, outDir, include, hadesVersion: "1.0.0" });
    expect(plan.refused).toHaveLength(1);
  });

  it("refuses a symlink inside sourceRoot pointing outside it, via realpath comparison", () => {
    const outsideDir = tmpDir("hades-bundle-outside-");
    writeFileSync(path.join(outsideDir, "secret.txt"), "top secret");

    mkdirSync(path.join(root, "linked"));
    symlinkSync(path.join(outsideDir, "secret.txt"), path.join(root, "linked", "escape-link"));

    const outDir = path.join(tmpDir("hades-bundle-safety4-"), "bundle");
    const include: BundleSourceSpec[] = [{ from: "linked", to: "linked" }];

    const plan = planBundle({ sourceRoot: root, outDir, include, hadesVersion: "1.0.0" });
    expect(plan.files).toEqual([]);
    expect(plan.refused.length).toBeGreaterThan(0);
    expect(plan.refused[0].reason).toContain("symlink escapes sourceRoot");

    const manifest = stageBundle({ sourceRoot: root, outDir, include, hadesVersion: "1.0.0", now: clockNow(1) });
    expect(manifest.entries).toEqual([]);
  });

  it("follows a symlink pointing inside sourceRoot and hashes it by content", () => {
    mkdirSync(path.join(root, "real-target"));
    writeFileSync(path.join(root, "real-target", "content.txt"), "real content here");
    mkdirSync(path.join(root, "linked-in"));
    symlinkSync(path.join(root, "real-target", "content.txt"), path.join(root, "linked-in", "alias.txt"));

    const outDir = path.join(tmpDir("hades-bundle-safety5-"), "bundle");
    const include: BundleSourceSpec[] = [{ from: "linked-in", to: "linked-in" }];

    const manifest = stageBundle({ sourceRoot: root, outDir, include, hadesVersion: "1.0.0", now: clockNow(1) });
    expect(manifest.entries).toHaveLength(1);
    expect(manifest.entries[0].path).toBe("linked-in/alias.txt");
    expect(manifest.entries[0].sha256).toBe(createHash("sha256").update("real content here").digest("hex"));

    const result = verifyBundle(outDir);
    expect(result.ok).toBe(true);
  });
});

// ===========================================================================
// 5. Missing sources
// ===========================================================================

describe("missing sources", () => {
  it("a missing optional source lands in plan.missing with ok still achievable", () => {
    writeFileSync(path.join(root, "present.txt"), "here");
    const outDir = path.join(tmpDir("hades-bundle-missing-opt-"), "bundle");
    const include: BundleSourceSpec[] = [
      { from: "present.txt", to: "present.txt" },
      { from: "absent.txt", to: "absent.txt", optional: true },
    ];

    const plan = planBundle({ sourceRoot: root, outDir, include, hadesVersion: "1.0.0" });
    expect(plan.missing).toEqual(["absent.txt"]);
    expect(plan.files).toHaveLength(1);

    const manifest = stageBundle({ sourceRoot: root, outDir, include, hadesVersion: "1.0.0", now: clockNow(1) });
    expect(manifest.entries).toHaveLength(1);
    expect(manifest.entries[0].path).toBe("present.txt");
  });

  it("a missing non-optional source fails the stage with an error naming the path", () => {
    const outDir = path.join(tmpDir("hades-bundle-missing-req-"), "bundle");
    const include: BundleSourceSpec[] = [{ from: "does-not-exist.txt", to: "does-not-exist.txt" }];

    expect(() => stageBundle({ sourceRoot: root, outDir, include, hadesVersion: "1.0.0", now: clockNow(1) })).toThrowError(
      /does-not-exist\.txt/,
    );
    expect(existsSync(outDir)).toBe(false);
  });
});

// ===========================================================================
// 6. maxTotalBytes
// ===========================================================================

describe("maxTotalBytes", () => {
  it("is enforced before anything is written, and reports the real total", () => {
    writeFileSync(path.join(root, "a.txt"), Buffer.alloc(1000, 1));
    writeFileSync(path.join(root, "b.txt"), Buffer.alloc(1000, 2));
    const outDir = path.join(tmpDir("hades-bundle-maxbytes-"), "bundle");
    const include: BundleSourceSpec[] = [
      { from: "a.txt", to: "a.txt" },
      { from: "b.txt", to: "b.txt" },
    ];

    const plan = planBundle({ sourceRoot: root, outDir, include, hadesVersion: "1.0.0" });
    expect(plan.totalBytes).toBe(2000);

    expect(() =>
      stageBundle({ sourceRoot: root, outDir, include, hadesVersion: "1.0.0", now: clockNow(1), maxTotalBytes: 1500 }),
    ).toThrowError(/2000/);
    expect(existsSync(outDir)).toBe(false);

    // Raising the limit above the real total succeeds.
    const manifest = stageBundle({ sourceRoot: root, outDir, include, hadesVersion: "1.0.0", now: clockNow(1), maxTotalBytes: 2000 });
    expect(manifest.entries).toHaveLength(2);
  });
});

// ===========================================================================
// 7. Executable bit + launchers
// ===========================================================================

describe("executable bit and launchers", () => {
  it("preserves the executable bit and reflects it in BundleEntry.executable", () => {
    const scriptPath = path.join(root, "run.sh");
    writeFileSync(scriptPath, "#!/bin/sh\necho hi\n");
    chmodSync(scriptPath, 0o755);
    writeFileSync(path.join(root, "data.txt"), "not executable");

    const outDir = path.join(tmpDir("hades-bundle-exec-"), "bundle");
    const manifest = stageBundle({
      sourceRoot: root,
      outDir,
      include: [
        { from: "run.sh", to: "run.sh" },
        { from: "data.txt", to: "data.txt" },
      ],
      hadesVersion: "1.0.0",
      now: clockNow(1),
    });

    const runEntry = manifest.entries.find((e) => e.path === "run.sh")!;
    const dataEntry = manifest.entries.find((e) => e.path === "data.txt")!;
    expect(runEntry.executable).toBe(true);
    expect(dataEntry.executable).toBe(false);

    const stagedMode = statSync(path.join(outDir, "run.sh")).mode & 0o111;
    expect(stagedMode).not.toBe(0);
  });

  it("bundleLaunchers reference nodeRequirement and exec the bundle's own entry point; the POSIX one passes `bash -n`", () => {
    writeFileSync(path.join(root, "hades.ts"), "// entry\n");
    const outDir = path.join(tmpDir("hades-bundle-launch-"), "bundle");
    const manifest = stageBundle({
      sourceRoot: root,
      outDir,
      include: [{ from: "hades.ts", to: "bin/hades.ts" }],
      hadesVersion: "1.0.0",
      now: clockNow(1),
    });

    const launchers = bundleLaunchers(manifest);
    expect(launchers.hades).toContain(manifest.nodeRequirement);
    expect(launchers.hades).toContain("bin/hades.ts");
    expect(launchers["hades.cmd"]).toContain(manifest.nodeRequirement);
    expect(launchers["hades.cmd"]).toContain("bin\\hades.ts");

    const scriptPath = path.join(tmpDir("hades-bundle-launch-script-"), "hades");
    writeFileSync(scriptPath, launchers.hades);
    expect(() => execFileSync("bash", ["-n", scriptPath])).not.toThrow();
  });
});

// ===========================================================================
// 8. nodeRuntime honesty
// ===========================================================================

describe("nodeRuntime honesty", () => {
  it("with no runtime input, embedded is false and the note names the requirement", () => {
    writeFileSync(path.join(root, "f.txt"), "hi");
    const outDir = path.join(tmpDir("hades-bundle-noruntime-"), "bundle");
    const manifest = stageBundle({
      sourceRoot: root,
      outDir,
      include: [{ from: "f.txt", to: "f.txt" }],
      hadesVersion: "1.0.0",
      now: clockNow(1),
    });

    expect(manifest.nodeRuntime.embedded).toBe(false);
    expect(manifest.nodeRuntime.version).toBeUndefined();
    expect(manifest.nodeRuntime.note).toContain(manifest.nodeRequirement);
    expect(manifest.entries.some((e) => e.path.startsWith("runtime/"))).toBe(false);
  });

  it("with a real runtime file supplied, embedded is true AND that file appears in entries", () => {
    const runtimeDir = tmpDir("hades-bundle-runtime-");
    const runtimeFile = path.join(runtimeDir, "node-fake-binary");
    writeFileSync(runtimeFile, Buffer.from("pretend this is a real node binary"));
    chmodSync(runtimeFile, 0o755);

    writeFileSync(path.join(root, "f.txt"), "hi");
    const outDir = path.join(tmpDir("hades-bundle-withruntime-"), "bundle");
    const manifest = stageBundle({
      sourceRoot: root,
      outDir,
      include: [{ from: "f.txt", to: "f.txt" }],
      hadesVersion: "1.0.0",
      now: clockNow(1),
      nodeRuntime: { from: runtimeFile, version: "20.11.0" },
    });

    expect(manifest.nodeRuntime.embedded).toBe(true);
    expect(manifest.nodeRuntime.version).toBe("20.11.0");
    expect(manifest.nodeRuntime.source).toBe(runtimeFile);

    const runtimeEntry = manifest.entries.find((e) => e.path === "runtime/node");
    expect(runtimeEntry).toBeDefined();
    expect(runtimeEntry!.sha256).toBe(realSha256(path.join(outDir, "runtime", "node")));

    const result = verifyBundle(outDir);
    expect(result.ok).toBe(true);
  });

  it("it is structurally impossible to claim embedded:true with no corresponding entry (missing runtime file fails the stage)", () => {
    writeFileSync(path.join(root, "f.txt"), "hi");
    const outDir = path.join(tmpDir("hades-bundle-badruntime-"), "bundle");

    expect(() =>
      stageBundle({
        sourceRoot: root,
        outDir,
        include: [{ from: "f.txt", to: "f.txt" }],
        hadesVersion: "1.0.0",
        now: clockNow(1),
        nodeRuntime: { from: path.join(root, "does-not-exist-node-binary"), version: "20.0.0" },
      }),
    ).toThrow();
    expect(existsSync(outDir)).toBe(false);
  });
});

// ===========================================================================
// computeRootHash / readManifest / writeManifest direct coverage
// ===========================================================================

describe("computeRootHash", () => {
  it("is order-independent (sorts internally) and injection-proof against delimiter-like filenames", () => {
    const entries: BundleEntry[] = [
      { path: "a:b.txt", bytes: 3, sha256: "1".repeat(64), executable: false },
      { path: "a.txt", bytes: 3, sha256: "2".repeat(64), executable: false },
    ];
    const forward = computeRootHash(entries);
    const reversed = computeRootHash([...entries].reverse());
    expect(forward).toBe(reversed);

    // A filename crafted to look like it could smuggle a delimiter must
    // still hash distinctly from a genuinely different entry list.
    const tricky: BundleEntry[] = [{ path: "3:x", bytes: 1, sha256: "3".repeat(64), executable: false }];
    const trickyHash = computeRootHash(tricky);
    const different: BundleEntry[] = [{ path: "x", bytes: 1, sha256: "3".repeat(64), executable: false }];
    expect(trickyHash).not.toBe(computeRootHash(different));
  });

  it("changes when any single field changes", () => {
    const base: BundleEntry = { path: "f.txt", bytes: 10, sha256: "a".repeat(64), executable: false };
    const h0 = computeRootHash([base]);
    expect(computeRootHash([{ ...base, bytes: 11 }])).not.toBe(h0);
    expect(computeRootHash([{ ...base, executable: true }])).not.toBe(h0);
    expect(computeRootHash([{ ...base, sha256: "b".repeat(64) }])).not.toBe(h0);
    expect(computeRootHash([{ ...base, path: "g.txt" }])).not.toBe(h0);
  });
});

describe("readManifest / writeManifest", () => {
  it("round-trips a manifest through disk", () => {
    const dir = tmpDir("hades-bundle-rw-");
    const manifest: BundleManifest = {
      version: BUNDLE_MANIFEST_VERSION,
      name: "hades",
      hadesVersion: "1.0.0",
      createdAt: 123,
      platform: "any",
      arch: "x64",
      nodeRequirement: ">=20",
      nodeRuntime: { embedded: false, note: "external node required" },
      entries: [],
      rootHash: computeRootHash([]),
    };
    writeManifest(dir, manifest);
    expect(readManifest(dir)).toEqual(manifest);
  });

  it("readManifest throws on a missing bundle.json (verifyBundle is the layer that turns this into a diagnosis)", () => {
    const dir = tmpDir("hades-bundle-rw-missing-");
    expect(() => readManifest(dir)).toThrow();
  });
});

// ===========================================================================
// DEFAULT_BUNDLE_INCLUDES sanity
// ===========================================================================

describe("DEFAULT_BUNDLE_INCLUDES", () => {
  it("references real, repo-relative files that actually exist", () => {
    const repoRoot = path.resolve(__dirname, "..", "..", "..", "..");
    for (const spec of DEFAULT_BUNDLE_INCLUDES) {
      const abs = path.resolve(repoRoot, spec.from);
      if (spec.optional) continue;
      expect(existsSync(abs)).toBe(true);
    }
  });

  it("is a real, usable include set for stageBundle", () => {
    const repoRoot = path.resolve(__dirname, "..", "..", "..", "..");
    const outDir = path.join(tmpDir("hades-bundle-default-"), "bundle");
    const manifest = stageBundle({
      sourceRoot: repoRoot,
      outDir,
      include: [...DEFAULT_BUNDLE_INCLUDES],
      hadesVersion: "1.0.0",
      now: clockNow(1),
    });
    expect(manifest.entries.length).toBeGreaterThan(0);
    const result = verifyBundle(outDir);
    expect(result.ok).toBe(true);
  });
});
