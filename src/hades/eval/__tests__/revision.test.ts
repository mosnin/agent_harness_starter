import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  resolveRevision,
  workTreeFingerprint,
  revisionOrder,
  isAncestor,
  type RevisionRef,
  type RevisionDeps,
  type RevisionRunResult,
} from "../revision";
import type { ScorecardRevision } from "../scorecard";

// ===========================================================================
// Compile-time contract: RevisionRef MUST be assignable to ScorecardRevision
// (a future drift between the two shapes breaks `tsc`, not just tests).
// ===========================================================================
function assertAssignable(ref: RevisionRef): void {
  const _: ScorecardRevision = ref;
  void _;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function initRepo(dir: string): void {
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test Runner"], { cwd: dir });
}

function commit(dir: string, message: string, dateIso: string): string {
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", message], {
    cwd: dir,
    env: { ...process.env, GIT_AUTHOR_DATE: dateIso, GIT_COMMITTER_DATE: dateIso },
  });
  return git(dir, ["rev-parse", "HEAD"]);
}

let repo: string;
let plainDir: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "hades-revision-repo-"));
  plainDir = mkdtempSync(join(tmpdir(), "hades-revision-plain-"));
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(plainDir, { recursive: true, force: true });
});

// ===========================================================================
// Real git repo
// ===========================================================================

describe("resolveRevision against a REAL git repo", () => {
  it("reports source:'git' with the real sha, branch, commit time, and subject", () => {
    initRepo(repo);
    writeFileSync(join(repo, "a.txt"), "one\n", "utf8");
    const sha1 = commit(repo, "first commit", "2020-01-01T00:00:00");

    const ref = resolveRevision({ cwd: repo, paths: [join(repo, "a.txt")] });
    assertAssignable(ref);

    expect(ref.source).toBe("git");
    expect(ref.sha).toBe(sha1);
    expect(ref.shortSha).toBe(sha1.slice(0, 12));
    expect(ref.dirty).toBe(false);
    expect(ref.branch).toBe("main");
    expect(ref.subject).toBe("first commit");
    expect(ref.committedAtMs).toBe(Date.parse("2020-01-01T00:00:00Z"));
    expect(ref.workTreeHash).toBe(workTreeFingerprint([join(repo, "a.txt")], { cwd: repo }));
  });

  it("marks a real dirty working tree as dirty:true", () => {
    initRepo(repo);
    writeFileSync(join(repo, "a.txt"), "one\n", "utf8");
    commit(repo, "first commit", "2020-01-01T00:00:00");

    const clean = resolveRevision({ cwd: repo });
    expect(clean.dirty).toBe(false);

    appendFileSync(join(repo, "a.txt"), "uncommitted change\n", "utf8");
    const dirty = resolveRevision({ cwd: repo });
    expect(dirty.dirty).toBe(true);
    expect(dirty.source).toBe("git");
  });

  it("reports branch:null on a real detached HEAD, while sha/subject still resolve", () => {
    initRepo(repo);
    writeFileSync(join(repo, "a.txt"), "one\n", "utf8");
    const sha1 = commit(repo, "first commit", "2020-01-01T00:00:00");
    writeFileSync(join(repo, "a.txt"), "two\n", "utf8");
    commit(repo, "second commit", "2020-01-02T00:00:00");

    execFileSync("git", ["checkout", "-q", sha1], { cwd: repo });
    const ref = resolveRevision({ cwd: repo });

    expect(ref.source).toBe("git");
    expect(ref.sha).toBe(sha1);
    expect(ref.branch).toBeNull();
    expect(ref.subject).toBe("first commit");
  });

  it("resolves real ancestry with isAncestor and real topo order with revisionOrder", () => {
    initRepo(repo);
    writeFileSync(join(repo, "a.txt"), "one\n", "utf8");
    const sha1 = commit(repo, "first commit", "2020-01-01T00:00:00");
    writeFileSync(join(repo, "a.txt"), "two\n", "utf8");
    const sha2 = commit(repo, "second commit", "2020-01-02T00:00:00");
    writeFileSync(join(repo, "a.txt"), "three\n", "utf8");
    const sha3 = commit(repo, "third commit", "2020-01-03T00:00:00");

    expect(isAncestor(sha1, sha2, { cwd: repo })).toBe(true);
    expect(isAncestor(sha1, sha3, { cwd: repo })).toBe(true);
    expect(isAncestor(sha2, sha3, { cwd: repo })).toBe(true);
    expect(isAncestor(sha2, sha1, { cwd: repo })).toBe(false);
    expect(isAncestor(sha3, sha1, { cwd: repo })).toBe(false);
    expect(isAncestor(sha1, sha1, { cwd: repo })).toBe(true); // a commit is its own ancestor under --is-ancestor

    // Descendants ordered before ancestors, and an unknown sha stays at the tail.
    const order = revisionOrder([sha1, sha3, sha2, "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"], { cwd: repo });
    expect(order).toEqual([sha3, sha2, sha1, "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"]);
  });

  it("revisionOrder returns the original order untouched when every sha is unknown", () => {
    initRepo(repo);
    writeFileSync(join(repo, "a.txt"), "one\n", "utf8");
    commit(repo, "first commit", "2020-01-01T00:00:00");

    const bogus = ["deadbeefdeadbeefdeadbeefdeadbeefdeadbeef", "0000000000000000000000000000000000000000"];
    expect(revisionOrder(bogus, { cwd: repo })).toEqual(bogus);
  });

  it("honestly falls back to source:'content' in a real repo with zero commits, while branch/dirty still resolve", () => {
    initRepo(repo);
    // No commit yet: HEAD does not resolve to a real commit sha.
    const ref = resolveRevision({ cwd: repo });
    assertAssignable(ref);

    expect(ref.source).toBe("content");
    expect(ref.committedAtMs).toBeNull();
    expect(ref.subject).toBeNull();
    expect(ref.branch).toBe("main"); // unborn-branch name still resolves via symbolic-ref
    expect(ref.dirty).toBe(false); // nothing staged/untracked yet

    writeFileSync(join(repo, "untracked.txt"), "x", "utf8");
    const withUntracked = resolveRevision({ cwd: repo });
    expect(withUntracked.dirty).toBe(true);
    expect(withUntracked.source).toBe("content");
  });
});

// ===========================================================================
// Honest non-git fallback
// ===========================================================================

describe("resolveRevision honest content fallback", () => {
  it("falls back to source:'content' in a real directory that is not a git repository", () => {
    writeFileSync(join(plainDir, "f.txt"), "hello\n", "utf8");
    const ref = resolveRevision({ cwd: plainDir, paths: [join(plainDir, "f.txt")] });
    assertAssignable(ref);

    expect(ref.source).toBe("content");
    expect(ref.branch).toBeNull();
    expect(ref.dirty).toBe(false);
    expect(ref.committedAtMs).toBeNull();
    expect(ref.subject).toBeNull();
    expect(ref.sha).toBe(ref.workTreeHash);
    expect(ref.shortSha).toBe(ref.workTreeHash.slice(0, 12));
  });

  it("falls back to source:'content' when git is entirely missing (injected run -> code 127)", () => {
    const missingGit: RevisionDeps["run"] = (): RevisionRunResult => ({ code: 127, stdout: "", stderr: "not found" });
    writeFileSync(join(repo, "f.txt"), "hello\n", "utf8");
    initRepo(repo); // even a real repo must fall back honestly once `git` itself is unusable
    const ref = resolveRevision({ cwd: repo, run: missingGit });

    expect(ref.source).toBe("content");
    expect(ref.branch).toBeNull();
    expect(ref.dirty).toBe(false);
  });

  it("never throws when the injected run implementation itself throws", () => {
    const throwingRun: RevisionDeps["run"] = () => {
      throw new Error("boom");
    };
    expect(() => resolveRevision({ cwd: plainDir, run: throwingRun })).not.toThrow();
    const ref = resolveRevision({ cwd: plainDir, run: throwingRun });
    expect(ref.source).toBe("content");

    expect(() => revisionOrder(["a", "b"], { cwd: plainDir, run: throwingRun })).not.toThrow();
    expect(revisionOrder(["a", "b"], { cwd: plainDir, run: throwingRun })).toEqual(["a", "b"]);

    expect(() => isAncestor("a", "b", { cwd: plainDir, run: throwingRun })).not.toThrow();
    expect(isAncestor("a", "b", { cwd: plainDir, run: throwingRun })).toBe(false);
  });

  it("never trusts a hostile run() that claims success with a malformed sha", () => {
    const hostileRun: RevisionDeps["run"] = (bin, args): RevisionRunResult => {
      if (args[0] === "--version") return { code: 0, stdout: "git version 2.0.0\n", stderr: "" };
      if (args.join(" ") === "rev-parse --is-inside-work-tree") return { code: 0, stdout: "true\n", stderr: "" };
      if (args.join(" ") === "status --porcelain") return { code: 0, stdout: "", stderr: "" };
      if (args.join(" ") === "rev-parse --abbrev-ref HEAD") return { code: 0, stdout: "main\n", stderr: "" };
      if (args.join(" ") === "rev-parse HEAD") return { code: 0, stdout: "not-a-real-sha\n", stderr: "" };
      return { code: 1, stdout: "", stderr: "" };
    };
    const ref = resolveRevision({ cwd: plainDir, run: hostileRun });
    expect(ref.source).toBe("content"); // refused to trust the malformed "sha"
  });

  it("isAncestor is honestly false for an invalid ancestor/descendant instead of throwing", () => {
    expect(isAncestor("", "abc", { cwd: plainDir })).toBe(false);
    expect(isAncestor("abc", "", { cwd: plainDir })).toBe(false);
    expect(isAncestor("nonexistent-sha", "also-nonexistent", { cwd: plainDir })).toBe(false);
  });
});

// ===========================================================================
// workTreeFingerprint
// ===========================================================================

describe("workTreeFingerprint", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hades-worktree-fp-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("is order-independent over its input paths", () => {
    const fileA = join(dir, "a.txt");
    const fileB = join(dir, "b.txt");
    writeFileSync(fileA, "alpha\n", "utf8");
    writeFileSync(fileB, "beta\n", "utf8");

    const fp1 = workTreeFingerprint([fileA, fileB]);
    const fp2 = workTreeFingerprint([fileB, fileA]);
    expect(fp1).toBe(fp2);
  });

  it("actually changes when a tracked file's real bytes change", () => {
    const fileA = join(dir, "a.txt");
    writeFileSync(fileA, "version one\n", "utf8");
    const before = workTreeFingerprint([fileA]);

    writeFileSync(fileA, "version two\n", "utf8");
    const after = workTreeFingerprint([fileA]);

    expect(before).not.toBe(after);
  });

  it("is stable and deterministic for identical byte content read twice", () => {
    const fileA = join(dir, "a.txt");
    writeFileSync(fileA, "stable content\n", "utf8");
    expect(workTreeFingerprint([fileA])).toBe(workTreeFingerprint([fileA]));
  });

  it("distinguishes a missing/unreadable path from an existing empty file", () => {
    const emptyFile = join(dir, "empty.txt");
    writeFileSync(emptyFile, "", "utf8");
    const missingFile = join(dir, "does-not-exist.txt");

    const withEmpty = workTreeFingerprint([emptyFile]);
    const withMissing = workTreeFingerprint([missingFile]);
    expect(withEmpty).not.toBe(withMissing);
  });

  it("changes when the SET of paths changes even if shared file content is identical", () => {
    const fileA = join(dir, "a.txt");
    const fileB = join(dir, "b.txt");
    writeFileSync(fileA, "same\n", "utf8");
    writeFileSync(fileB, "same\n", "utf8");

    expect(workTreeFingerprint([fileA])).not.toBe(workTreeFingerprint([fileA, fileB]));
  });

  it("resolves relative paths against deps.cwd", () => {
    const fileA = join(dir, "sub", "a.txt");
    mkdirSync(join(dir, "sub"), { recursive: true });
    writeFileSync(fileA, "nested\n", "utf8");

    const viaAbsolute = workTreeFingerprint([fileA]);
    const viaRelative = workTreeFingerprint(["sub/a.txt"], { cwd: dir });
    expect(viaRelative).toBe(viaAbsolute);
  });
});
