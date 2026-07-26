/**
 * Tests for `src/hades/migrate/discovery.ts`.
 *
 * `discoverSources` is exercised almost entirely against an in-memory
 * {@link FsProbe} (`MemFs` below) -- fast, deterministic, and able to
 * simulate faults (throwing readDir, symlink loops, EACCES-like failures)
 * that are awkward to reproduce reliably against a real filesystem in CI.
 * `nodeFsProbe` itself gets a dedicated real-filesystem pass through real
 * temp directories, including a real symlink loop and a real oversized
 * directory, to prove the seam onto `node:fs` is honest.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { SOURCE_LAYOUTS, discoverSources, nodeFsProbe, type FsProbe } from "../discovery";
import type { MigrateVendor } from "../ir";

// ---------------------------------------------------------------------------
// In-memory FsProbe fixture
// ---------------------------------------------------------------------------

type MemEntry =
  | { kind: "file"; content: string }
  | { kind: "dir" }
  | { kind: "symlink"; target: string };

/**
 * A minimal, fully in-memory implementation of {@link FsProbe} using POSIX
 * ("/") paths, backed by a flat `Map<absPath, MemEntry>`. Supports symlinks
 * (including loops and escapes), throwing on specific paths to simulate
 * EACCES-style failures, and byte-capped reads.
 */
class MemFs {
  private entries = new Map<string, MemEntry>();
  private throwingReadDirPaths = new Set<string>();
  private throwingStatPaths = new Set<string>();

  mkdir(p: string): void {
    this.entries.set(p, { kind: "dir" });
    let parent = path.posix.dirname(p);
    while (parent !== "/" && parent !== "." && !this.entries.has(parent)) {
      this.entries.set(parent, { kind: "dir" });
      parent = path.posix.dirname(parent);
    }
  }

  writeFile(p: string, content: string): void {
    this.mkdir(path.posix.dirname(p));
    this.entries.set(p, { kind: "file", content });
  }

  has(p: string): boolean {
    return this.entries.has(p);
  }

  symlink(p: string, target: string): void {
    this.mkdir(path.posix.dirname(p));
    this.entries.set(p, { kind: "symlink", target });
  }

  makeReadDirThrow(p: string): void {
    this.throwingReadDirPaths.add(p);
  }

  makeStatThrow(p: string): void {
    this.throwingStatPaths.add(p);
  }

  private resolveSymlink(p: string, hops = 0): string | undefined {
    if (hops > 40) return undefined; // simulate ELOOP
    const e = this.entries.get(p);
    if (!e) return p; // dangling target, caller decides
    if (e.kind === "symlink") return this.resolveSymlink(e.target, hops + 1);
    return p;
  }

  toProbe(): FsProbe {
    const self = this;
    return {
      exists(p) {
        return self.entries.has(p);
      },
      isDir(p) {
        if (self.throwingStatPaths.has(p)) return false;
        const real = self.resolveSymlink(p);
        if (!real) return false;
        const e = self.entries.get(real);
        return e?.kind === "dir";
      },
      readDir(p) {
        if (self.throwingReadDirPaths.has(p)) throw new Error("simulated EACCES");
        const real = self.resolveSymlink(p) ?? p;
        const prefix = real === "/" ? "/" : `${real}/`;
        const names = new Set<string>();
        for (const key of self.entries.keys()) {
          if (key === real || !key.startsWith(prefix)) continue;
          const rest = key.slice(prefix.length);
          const first = rest.split("/")[0];
          if (first) names.add(first);
        }
        return [...names].sort();
      },
      stat(p) {
        if (self.throwingStatPaths.has(p)) throw new Error("simulated stat failure");
        const e = self.entries.get(p);
        if (!e) return undefined;
        if (e.kind === "symlink") {
          const real = self.resolveSymlink(p);
          const target = real ? self.entries.get(real) : undefined;
          const size = target?.kind === "file" ? target.content.length : 0;
          return { size, mtimeMs: 0, mode: 0o120000, isSymlink: true };
        }
        const size = e.kind === "file" ? e.content.length : 0;
        return { size, mtimeMs: 0, mode: e.kind === "dir" ? 0o40755 : 0o100644, isSymlink: false };
      },
      readFile(p, maxBytes) {
        const real = self.resolveSymlink(p) ?? p;
        const e = self.entries.get(real);
        if (!e || e.kind !== "file") return undefined;
        return maxBytes === undefined ? e.content : e.content.slice(0, maxBytes);
      },
      readBytes(p, maxBytes) {
        const real = self.resolveSymlink(p) ?? p;
        const e = self.entries.get(real);
        if (!e || e.kind !== "file") return undefined;
        return new TextEncoder().encode(e.content.slice(0, maxBytes));
      },
      realpath(p) {
        return self.resolveSymlink(p);
      },
    };
  }
}

const HOME = "/home/u";

/** `NodeJS.ProcessEnv` (as augmented by this repo's Next.js types, which require `NODE_ENV`) from a plain record. */
function mkEnv(vars: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return { NODE_ENV: "test", ...vars } as NodeJS.ProcessEnv;
}

function baseOpts(overrides: Partial<Parameters<typeof discoverSources>[1]> = {}) {
  return { platform: "linux" as NodeJS.Platform, home: HOME, env: mkEnv(), ...overrides };
}

// ---------------------------------------------------------------------------
// Layout parity: every SOURCE_LAYOUTS entry has a matching fixture
// ---------------------------------------------------------------------------

describe("SOURCE_LAYOUTS parity", () => {
  it("has unique layout ids", () => {
    const ids = SOURCE_LAYOUTS.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  for (const layout of SOURCE_LAYOUTS) {
    it(`detects "${layout.id}" from a fully-populated fixture with confidence 1`, () => {
      const rootSpec = layout.roots[0];
      const platform: NodeJS.Platform = rootSpec.platform === "*" ? "linux" : rootSpec.platform;

      const env: NodeJS.ProcessEnv = mkEnv();
      let root: string;
      // Resolve the root exactly like production code would, but here we
      // just need *a* concrete absolute path consistent with the template's
      // leading variable so we can plant the fixture at the same spot.
      const varName = rootSpec.template.split("/")[0].slice(1);
      const restSegments = rootSpec.template.split("/").slice(1);
      const sep = platform === "win32" ? "\\" : "/";
      const home = platform === "win32" ? "C:\\Users\\u" : HOME;

      switch (varName) {
        case "HERMES_HOME":
          root = platform === "win32" ? "C:\\Vendor\\Hermes" : "/opt/hermes-home";
          env.HERMES_HOME = root;
          break;
        case "OPENCLAW_HOME":
          root = platform === "win32" ? "C:\\Vendor\\OpenClaw" : "/opt/openclaw-home";
          env.OPENCLAW_HOME = root;
          break;
        case "XDG_CONFIG_HOME":
          env.XDG_CONFIG_HOME = `${home}/.config`;
          root = [env.XDG_CONFIG_HOME, ...restSegments].join(sep);
          break;
        case "APPDATA":
          env.APPDATA = `${home}\\AppData\\Roaming`;
          root = [env.APPDATA, ...restSegments].join(sep);
          break;
        case "HOME":
          root = [home, ...restSegments].join(sep);
          break;
        default:
          throw new Error(`discovery.test.ts fixture builder doesn't know template var "${varName}" -- add support`);
      }

      const mem = new MemFs();
      // MemFs is POSIX-only; for win32-only layouts we still validate using
      // posix-style separators translated by joinPlatform's win32.join,
      // which on posix-hosted paths still produces "\"-joined segments.
      // To keep the in-memory fixture simple and platform-agnostic, run
      // win32 layouts through MemFs using "/"-normalized paths instead.
      const usePosixShim = platform === "win32";
      const memRoot = usePosixShim ? root.replace(/\\/g, "/") : root;

      for (const m of layout.requiredMarkers) {
        const p = `${memRoot}/${m.relPath}`;
        if (m.type === "dir") mem.mkdir(p);
        else mem.writeFile(p, "{}");
      }
      for (const m of layout.optionalMarkers) {
        const p = `${memRoot}/${m.relPath}`;
        if (m.type === "dir") {
          mem.mkdir(p);
          mem.writeFile(`${p}/placeholder.json`, "{}");
        } else {
          mem.writeFile(p, m.relPath.endsWith("version") ? "9.9.9" : "{}");
        }
      }
      for (const rule of layout.artifactRules) {
        const p = `${memRoot}/${rule.relPath}`;
        if (rule.recursive) {
          mem.mkdir(p);
          mem.writeFile(`${p}/item-1.json`, "{}");
        } else if (!mem.has(p)) {
          mem.writeFile(p, "{}");
        }
      }

      if (usePosixShim) {
        // Re-home the probe under posix separators and tell discovery about
        // it via a posix-shaped platform so joinPlatform matches MemFs paths.
        const probe = mem.toProbe();
        const result = discoverSources(probe, {
          platform: "linux",
          home,
          env,
          explicitRoots: [{ root: memRoot, vendor: layout.vendor }],
        });
        const match = result.sources.find((s) => s.layout === layout.id);
        expect(match, `expected a match for layout "${layout.id}"`).toBeDefined();
        expect(match!.confidence).toBe(1);
        expect(match!.vendor).toBe(layout.vendor);
        return;
      }

      const probe = mem.toProbe();
      const result = discoverSources(probe, baseOpts({ platform, home, env }));
      const match = result.sources.find((s) => s.layout === layout.id);
      expect(match, `expected a match for layout "${layout.id}" (searched: ${result.searched.join(", ")})`).toBeDefined();
      expect(match!.confidence).toBe(1);
      expect(match!.vendor).toBe(layout.vendor);
      expect(match!.root).toBe(root);
      expect(result.searched).toContain(root);
    });
  }
});

// ---------------------------------------------------------------------------
// Scoring behavior
// ---------------------------------------------------------------------------

describe("discoverSources scoring", () => {
  it("scores a required-only match lower than a fully-populated one, never first-match-wins", () => {
    const mem = new MemFs();
    mem.writeFile(`${HOME}/.hermes/config.json`, "{}");
    const probe = mem.toProbe();
    const result = discoverSources(probe, baseOpts());
    const dotfile = result.sources.find((s) => s.layout === "hermes-dotfile");
    expect(dotfile).toBeDefined();
    expect(dotfile!.confidence).toBeCloseTo(0.5, 5);
  });

  it("reports every applicable layout for a root, not just the first", () => {
    const mem = new MemFs();
    mem.writeFile(`${HOME}/.hermes/config.json`, "{}");
    mem.mkdir(`${HOME}/.hermes/memory`);
    mem.mkdir(`${HOME}/.hermes/sessions`);
    mem.mkdir(`${HOME}/.hermes/skills`);
    mem.writeFile(`${HOME}/.hermes/model.json`, "{}");
    mem.writeFile(`${HOME}/.hermes/.hermes-version`, "1.2.3");
    const probe = mem.toProbe();
    const result = discoverSources(probe, baseOpts());
    expect(result.sources.filter((s) => s.vendor === "hermes")).toHaveLength(1);
    expect(result.sources[0].version).toBe("1.2.3");
    expect(result.sources[0].confidence).toBe(1);
  });

  it("detects a root that satisfies both a Hermes and an OpenClaw layout and reports both, cross-warned", () => {
    const mem = new MemFs();
    const shared = "/srv/shared-agent-home";
    mem.writeFile(`${shared}/config.json`, "{}");
    mem.writeFile(`${shared}/openclaw.json`, "{}");
    const probe = mem.toProbe();
    const result = discoverSources(
      probe,
      baseOpts({ explicitRoots: [{ root: shared }] }), // no vendor hint -> try every layout
    );
    const atShared = result.sources.filter((s) => s.root === shared);
    const vendors = new Set(atShared.map((s) => s.vendor));
    expect(vendors).toEqual(new Set<MigrateVendor>(["hermes", "openclaw"]));
    for (const s of atShared) {
      expect(s.warnings.some((w) => w.includes("also matched a different vendor"))).toBe(true);
    }
  });

  it("detects two layouts of the same vendor sharing a root and cross-warns them", () => {
    const mem = new MemFs();
    const shared = "/srv/shared-openclaw";
    mem.writeFile(`${shared}/openclaw.json`, "{}");
    mem.writeFile(`${shared}/clawdbot.json`, "{}");
    const probe = mem.toProbe();
    const result = discoverSources(probe, baseOpts({ explicitRoots: [{ root: shared, vendor: "openclaw" }] }));
    const atShared = result.sources.filter((s) => s.root === shared);
    expect(atShared.length).toBeGreaterThanOrEqual(2);
    for (const s of atShared) {
      expect(s.warnings.some((w) => w.includes("also matched other layout"))).toBe(true);
    }
  });

  it("flags a root that is Hades' own live dataDir as a refuse-worthy warning, while still reporting it", () => {
    const mem = new MemFs();
    const hadesDir = `${HOME}/.hades`;
    mem.writeFile(`${hadesDir}/config.json`, "{}"); // coincidentally shaped like a Hermes root
    const probe = mem.toProbe();
    const result = discoverSources(probe, baseOpts({ explicitRoots: [{ root: hadesDir, vendor: "hermes" }] }));
    const match = result.sources.find((s) => s.root === hadesDir);
    expect(match).toBeDefined();
    expect(match!.warnings.some((w) => w.startsWith("REFUSE:"))).toBe(true);
  });

  it("respects an explicit HADES_DATA_DIR override for self-detection", () => {
    const mem = new MemFs();
    const hadesDir = "/custom/hades-data";
    mem.writeFile(`${hadesDir}/config.json`, "{}");
    const probe = mem.toProbe();
    const result = discoverSources(
      probe,
      baseOpts({ env: mkEnv({ HADES_DATA_DIR: hadesDir }), explicitRoots: [{ root: hadesDir, vendor: "hermes" }] }),
    );
    const match = result.sources.find((s) => s.root === hadesDir);
    expect(match!.warnings.some((w) => w.startsWith("REFUSE:"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

describe("discoverSources inventory", () => {
  it("inventories recursive artifact rules and classifies kind correctly", () => {
    const mem = new MemFs();
    mem.writeFile(`${HOME}/.hermes/config.json`, "{}");
    mem.writeFile(`${HOME}/.hermes/memory/fact-1.json`, "{}");
    mem.writeFile(`${HOME}/.hermes/memory/nested/fact-2.json`, "{}");
    mem.writeFile(`${HOME}/.hermes/sessions/s1.json`, "{}");
    mem.writeFile(`${HOME}/.hermes/skills/web-search/skill.json`, "{}");
    const probe = mem.toProbe();
    const result = discoverSources(probe, baseOpts());
    const source = result.sources.find((s) => s.layout === "hermes-dotfile")!;
    expect(source.inventory.some((i) => i.kind === "config" && i.path.endsWith("config.json"))).toBe(true);
    expect(source.inventory.filter((i) => i.kind === "memory")).toHaveLength(2);
    expect(source.inventory.some((i) => i.kind === "session")).toBe(true);
    expect(source.inventory.some((i) => i.kind === "skill")).toBe(true);
  });

  it("caps recursion at maxDepth and warns instead of hanging on a depth bomb", () => {
    const mem = new MemFs();
    mem.writeFile(`${HOME}/.hermes/config.json`, "{}");
    let p = `${HOME}/.hermes/memory`;
    for (let i = 0; i < 30; i++) {
      p = `${p}/lvl${i}`;
      mem.mkdir(p);
    }
    mem.writeFile(`${p}/deep.json`, "{}");
    const probe = mem.toProbe();
    const result = discoverSources(probe, baseOpts({ maxDepth: 3 }));
    const source = result.sources.find((s) => s.layout === "hermes-dotfile")!;
    expect(source.inventory.some((i) => i.path.endsWith("deep.json"))).toBe(false);
    expect(source.warnings.some((w) => w.includes("max walk depth"))).toBe(true);
  });

  it("detects a symlink loop and does not hang or throw", () => {
    const mem = new MemFs();
    mem.writeFile(`${HOME}/.hermes/config.json`, "{}");
    mem.mkdir(`${HOME}/.hermes/memory`);
    mem.symlink(`${HOME}/.hermes/memory/loop`, `${HOME}/.hermes/memory`); // points back to itself
    const probe = mem.toProbe();
    const result = discoverSources(probe, baseOpts());
    const source = result.sources.find((s) => s.layout === "hermes-dotfile")!;
    expect(source.warnings.some((w) => w.includes("symlink loop"))).toBe(true);
  });

  it("records but does not follow a symlink that escapes the source root", () => {
    const mem = new MemFs();
    mem.writeFile(`${HOME}/.hermes/config.json`, "{}");
    mem.mkdir(`${HOME}/.hermes/memory`);
    mem.writeFile("/etc/other-secret-file", "outside");
    mem.symlink(`${HOME}/.hermes/memory/escape`, "/etc/other-secret-file");
    const probe = mem.toProbe();
    const result = discoverSources(probe, baseOpts());
    const source = result.sources.find((s) => s.layout === "hermes-dotfile")!;
    expect(source.warnings.some((w) => w.includes("escapes the source root"))).toBe(true);
  });

  it("treats a file where a directory marker is expected as absent, with a warning", () => {
    const mem = new MemFs();
    mem.writeFile(`${HOME}/.hermes/config.json`, "{}");
    mem.writeFile(`${HOME}/.hermes/memory`, "oops, this is a file"); // marker expects a dir
    const probe = mem.toProbe();
    const result = discoverSources(probe, baseOpts());
    const source = result.sources.find((s) => s.layout === "hermes-dotfile")!;
    expect(source.warnings.some((w) => w.includes('expected a directory at "memory"'))).toBe(true);
  });

  it("truncates and warns when the total entry cap is exceeded, never hangs", () => {
    const mem = new MemFs();
    mem.writeFile(`${HOME}/.hermes/config.json`, "{}");
    mem.mkdir(`${HOME}/.hermes/memory`);
    // more entries than the internal cap in one directory
    for (let i = 0; i < 5200; i++) mem.writeFile(`${HOME}/.hermes/memory/f${i}.json`, "{}");
    const probe = mem.toProbe();
    const result = discoverSources(probe, baseOpts());
    const source = result.sources.find((s) => s.layout === "hermes-dotfile")!;
    expect(source.inventory.length).toBeLessThan(5200);
    expect(source.warnings.some((w) => w.includes("inventory scan truncated"))).toBe(true);
  }, 20000);
});

// ---------------------------------------------------------------------------
// Robustness: never throws, honest skipped/warnings
// ---------------------------------------------------------------------------

describe("discoverSources robustness", () => {
  it("reports a dangling HERMES_HOME as skipped rather than throwing", () => {
    const mem = new MemFs(); // nothing on disk at all
    const probe = mem.toProbe();
    const result = discoverSources(probe, baseOpts({ env: mkEnv({ HERMES_HOME: "/nowhere/nothing" }) }));
    expect(result.searched).toContain("/nowhere/nothing");
    expect(result.skipped.some((s) => s.path === "/nowhere/nothing" && s.reason.includes("does not exist"))).toBe(true);
    expect(result.sources.some((s) => s.root === "/nowhere/nothing")).toBe(false);
  });

  it("reports a file where a directory root was expected", () => {
    const mem = new MemFs();
    mem.writeFile(`${HOME}/.hermes`, "not a directory");
    const probe = mem.toProbe();
    const result = discoverSources(probe, baseOpts());
    expect(result.skipped.some((s) => s.path === `${HOME}/.hermes` && s.reason.includes("not a directory"))).toBe(true);
  });

  it("reports an empty-but-present root", () => {
    const mem = new MemFs();
    mem.mkdir(`${HOME}/.hermes`);
    const probe = mem.toProbe();
    const result = discoverSources(probe, baseOpts());
    expect(result.skipped.some((s) => s.path === `${HOME}/.hermes` && s.reason.includes("empty"))).toBe(true);
  });

  it("reports a present-but-non-matching root", () => {
    const mem = new MemFs();
    mem.writeFile(`${HOME}/.hermes/random-file.txt`, "nothing relevant here");
    const probe = mem.toProbe();
    const result = discoverSources(probe, baseOpts());
    expect(result.skipped.some((s) => s.path === `${HOME}/.hermes` && s.reason.includes("does not match required markers"))).toBe(true);
  });

  it("never throws when probe.readDir throws (simulated EACCES)", () => {
    const mem = new MemFs();
    mem.writeFile(`${HOME}/.hermes/config.json`, "{}");
    mem.mkdir(`${HOME}/.hermes/memory`);
    mem.makeReadDirThrow(`${HOME}/.hermes/memory`);
    const probe = mem.toProbe();
    expect(() => discoverSources(probe, baseOpts())).not.toThrow();
    const result = discoverSources(probe, baseOpts());
    const source = result.sources.find((s) => s.layout === "hermes-dotfile")!;
    expect(source.warnings.some((w) => w.includes("unreadable directory"))).toBe(true);
  });

  it("never throws when the root itself is unreadable (simulated EACCES on readdir)", () => {
    const mem = new MemFs();
    mem.mkdir(`${HOME}/.hermes`);
    mem.writeFile(`${HOME}/.hermes/config.json`, "{}");
    mem.makeReadDirThrow(`${HOME}/.hermes`);
    const probe = mem.toProbe();
    expect(() => discoverSources(probe, baseOpts())).not.toThrow();
  });

  it("never throws when probe.stat throws", () => {
    const mem = new MemFs();
    mem.writeFile(`${HOME}/.hermes/config.json`, "{}");
    mem.mkdir(`${HOME}/.hermes/memory`);
    mem.writeFile(`${HOME}/.hermes/memory/bad.json`, "{}");
    mem.makeStatThrow(`${HOME}/.hermes/memory/bad.json`);
    const probe = mem.toProbe();
    expect(() => discoverSources(probe, baseOpts())).not.toThrow();
  });

  it("does not throw and produces no sources when nothing exists at all", () => {
    const mem = new MemFs();
    const probe = mem.toProbe();
    const result = discoverSources(probe, baseOpts());
    expect(result.sources).toEqual([]);
    expect(result.searched.length).toBeGreaterThan(0);
  });

  it("HERMES_HOME/OPENCLAW_HOME unset roots are simply not applicable (not searched, not skipped)", () => {
    const mem = new MemFs();
    const probe = mem.toProbe();
    const result = discoverSources(probe, baseOpts({ env: mkEnv() }));
    expect(result.searched.some((p) => p.includes("hermes-home") || p.includes("openclaw-home"))).toBe(false);
  });

  it("explicitRoots without a vendor hint tries every layout; with a vendor hint tries only that vendor's layouts", () => {
    const mem = new MemFs();
    mem.writeFile("/x/config.json", "{}");
    mem.writeFile("/x/openclaw.json", "{}");
    const probe = mem.toProbe();

    const withHint = discoverSources(probe, baseOpts({ explicitRoots: [{ root: "/x", vendor: "hermes" }] }));
    expect(withHint.sources.every((s) => s.vendor === "hermes")).toBe(true);

    const withoutHint = discoverSources(probe, baseOpts({ explicitRoots: [{ root: "/x" }] }));
    expect(withoutHint.sources.some((s) => s.vendor === "openclaw")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// nodeFsProbe -- real filesystem
// ---------------------------------------------------------------------------

describe("nodeFsProbe (real filesystem)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "hades-migrate-discovery-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("exists/isDir/readDir/stat/readFile/realpath reflect real disk state", () => {
    const probe = nodeFsProbe();
    const filePath = path.join(dir, "hello.txt");
    writeFileSync(filePath, "hello world");
    mkdirSync(path.join(dir, "sub"));

    expect(probe.exists(filePath)).toBe(true);
    expect(probe.exists(path.join(dir, "nope.txt"))).toBe(false);
    expect(probe.isDir(dir)).toBe(true);
    expect(probe.isDir(filePath)).toBe(false);
    expect(probe.readDir(dir).sort()).toEqual(["hello.txt", "sub"]);
    expect(probe.readFile(filePath)).toBe("hello world");
    const st = probe.stat(filePath);
    expect(st?.size).toBe("hello world".length);
    expect(st?.isSymlink).toBe(false);
    expect(probe.realpath(filePath)).toBe(filePath);
  });

  it("returns [] rather than throwing for a nonexistent directory", () => {
    const probe = nodeFsProbe();
    expect(probe.readDir(path.join(dir, "does-not-exist"))).toEqual([]);
  });

  it("returns undefined rather than throwing for stat/readFile/realpath on a missing path", () => {
    const probe = nodeFsProbe();
    const missing = path.join(dir, "missing");
    expect(probe.stat(missing)).toBeUndefined();
    expect(probe.readFile(missing)).toBeUndefined();
    expect(probe.readBytes(missing, 10)).toBeUndefined();
    expect(probe.realpath(missing)).toBeUndefined();
  });

  it("honours the maxBytes cap on readFile and readBytes", () => {
    const probe = nodeFsProbe();
    const filePath = path.join(dir, "big.txt");
    writeFileSync(filePath, "0123456789".repeat(100)); // 1000 bytes
    const text = probe.readFile(filePath, 10);
    expect(text).toBe("0123456789");
    const bytes = probe.readBytes(filePath, 5);
    expect(bytes).toBeDefined();
    expect(bytes!.length).toBe(5);
  });

  it("strips a leading UTF-8 BOM and does not crash on invalid UTF-8", () => {
    const probe = nodeFsProbe();
    const bomPath = path.join(dir, "bom.txt");
    writeFileSync(bomPath, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("hi")]));
    expect(probe.readFile(bomPath)).toBe("hi");

    const badUtf8Path = path.join(dir, "bad-utf8.bin");
    writeFileSync(badUtf8Path, Buffer.from([0xff, 0xfe, 0x00, 0x41]));
    expect(() => probe.readFile(badUtf8Path)).not.toThrow();
  });

  it("preserves CRLF line endings verbatim", () => {
    const probe = nodeFsProbe();
    const crlfPath = path.join(dir, "crlf.txt");
    writeFileSync(crlfPath, "line1\r\nline2\r\n");
    expect(probe.readFile(crlfPath)).toBe("line1\r\nline2\r\n");
  });

  it("detects a real symlink and resolves realpath through it", () => {
    const probe = nodeFsProbe();
    const target = path.join(dir, "target.txt");
    writeFileSync(target, "t");
    const link = path.join(dir, "link.txt");
    symlinkSync(target, link);
    expect(probe.stat(link)?.isSymlink).toBe(true);
    expect(probe.realpath(link)).toBe(target);
  });

  it("returns undefined realpath for a real symlink loop instead of throwing/hanging", () => {
    const probe = nodeFsProbe();
    const a = path.join(dir, "a");
    const b = path.join(dir, "b");
    symlinkSync(b, a);
    symlinkSync(a, b);
    expect(() => probe.realpath(a)).not.toThrow();
    expect(probe.realpath(a)).toBeUndefined();
  });

  it("discoverSources runs end-to-end against a real temp tree via nodeFsProbe", () => {
    const home = dir;
    mkdirSync(path.join(home, ".hermes", "memory"), { recursive: true });
    mkdirSync(path.join(home, ".hermes", "sessions"), { recursive: true });
    writeFileSync(path.join(home, ".hermes", "config.json"), JSON.stringify({ model: "claude" }));
    writeFileSync(path.join(home, ".hermes", "memory", "fact.json"), JSON.stringify({ fact: "hi" }));
    writeFileSync(path.join(home, ".hermes", ".hermes-version"), "3.1.4");

    const probe = nodeFsProbe();
    const result = discoverSources(probe, { platform: "linux", home, env: mkEnv() });

    const source = result.sources.find((s) => s.layout === "hermes-dotfile");
    expect(source).toBeDefined();
    expect(source!.vendor).toBe("hermes");
    expect(source!.version).toBe("3.1.4");
    expect(source!.inventory.some((i) => i.kind === "memory")).toBe(true);
    expect(source!.inventory.some((i) => i.kind === "config")).toBe(true);
  });

  it("handles a real directory with 10k entries without hanging or throwing", () => {
    const home = dir;
    const memoryDir = path.join(home, ".hermes", "memory");
    mkdirSync(memoryDir, { recursive: true });
    writeFileSync(path.join(home, ".hermes", "config.json"), "{}");
    for (let i = 0; i < 10000; i++) {
      writeFileSync(path.join(memoryDir, `f${i}.json`), "{}");
    }
    const probe = nodeFsProbe();
    const result = discoverSources(probe, { platform: "linux", home, env: mkEnv() });
    const source = result.sources.find((s) => s.layout === "hermes-dotfile")!;
    expect(source).toBeDefined();
    expect(source.inventory.length).toBeLessThan(10000);
    expect(source.warnings.some((w) => w.includes("truncated"))).toBe(true);
  }, 30000);
});
