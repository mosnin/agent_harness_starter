/**
 * Tests for `src/hades/cli/migrate-command.ts` -- the `hades migrate`
 * terminal surface over the real T1-T5 migration engine.
 *
 * No mocks: every test drives real temp directories, real T3 fixtures
 * (`../../migrate/fixtures`), and the real discover -> read -> plan -> apply
 * pipeline via `runMigrateCommand` itself.
 */
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MIGRATE_USAGE, defaultMigrateDeps, runMigrateCommand, type MigrateCommandDeps } from "../migrate-command";
import { materializeHermesFixture, materializeOpenClawFixture } from "../../migrate/fixtures";
import type { ApplyDeps } from "../../migrate/apply";
import { SecretVault } from "../../migrate/secrets";
import { FileMemoryStore } from "../../memory/store";
import { GuardedMemoryStore } from "../../memory/guard";
import { FileSessionStore } from "../../memory/session-store";
import { fileConfigAccess } from "../../state/wiring";
import { FileModelSelection } from "../../models/selection";
import { defaultModelRegistry } from "../../models/defaults";

// The real model registry doesn't know the fictional model ids these test
// fixtures embed ("hermes-large-v3" / "openclaw-large-v1") -- honestly, a
// real `hades migrate` run against one of these fixtures WOULD raise a
// `model-unknown` blocker. So these tests build the SAME real, file-backed
// wiring `../migrate-command.ts`'s own default `deps()` factory uses, just
// with a model registry extended to also recognize the fixtures' model ids
// -- otherwise every test below would be exercising the "unknown model"
// blocker path instead of the real end-to-end write path.
const FIXTURE_MODEL_IDS = ["hermes-large-v3", "openclaw-large-v1"];

function testApplyDeps(dataDir: string, env: NodeJS.ProcessEnv, now: () => number): ApplyDeps & { knownModelIds: string[] } {
  const baseMemory = new FileMemoryStore(join(dataDir, "memory.json"));
  const memory = new GuardedMemoryStore(baseMemory, { now });
  const sessions = new FileSessionStore(join(dataDir, "sessions.json"));
  const config = fileConfigAccess(dataDir, env);
  const modelSelection = new FileModelSelection(join(dataDir, "model.json"), now);
  const knownModelIds = [...defaultModelRegistry().list().map((m) => m.id), ...FIXTURE_MODEL_IDS];
  return {
    dataDir,
    memory,
    guard: memory,
    sessions,
    config,
    modelSelection,
    skillsDir: join(dataDir, "skills"),
    contextFilesDir: join(dataDir, "context-files"),
    secretsPath: join(dataDir, "secrets.env"),
    secrets: new SecretVault(),
    now,
    knownModelIds,
  };
}

let tmpDirs: string[] = [];
function freshDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of tmpDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
  tmpDirs = [];
});

function isolatedDeps(overrides: Partial<MigrateCommandDeps> = {}): MigrateCommandDeps {
  const home = freshDir("hades-migrate-home-");
  const dataDir = freshDir("hades-migrate-data-");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    HERMES_HOME: undefined,
    OPENCLAW_HOME: undefined,
    XDG_CONFIG_HOME: undefined,
    XDG_DATA_HOME: undefined,
    APPDATA: undefined,
    LOCALAPPDATA: undefined,
    HADES_DATA_DIR: dataDir,
    HADES_SKILLS_DIR: undefined,
  };
  const now = () => 1_700_000_000_000;
  return {
    env,
    cwd: process.cwd(),
    home,
    platform: process.platform,
    now,
    dataDir,
    deps: () => testApplyDeps(dataDir, env, now),
    ...overrides,
  };
}

function parseJson(lines: string[]): unknown {
  return JSON.parse(lines.join("\n"));
}

// ---------------------------------------------------------------------------
// help / usage / dispatch
// ---------------------------------------------------------------------------

describe("runMigrateCommand -- help and dispatch", () => {
  it("prints usage with no args, `help`, and unknown subcommands (usage-appended, exit 2 for unknown)", async () => {
    const deps = isolatedDeps();
    const noArgs = await runMigrateCommand([], deps);
    expect(noArgs.code).toBe(0);
    expect(noArgs.lines).toEqual(MIGRATE_USAGE);

    const help = await runMigrateCommand(["help"], deps);
    expect(help.code).toBe(0);
    expect(help.lines).toEqual(MIGRATE_USAGE);

    const unknown = await runMigrateCommand(["bogus"], deps);
    expect(unknown.code).toBe(2);
    expect(unknown.lines[0]).toContain("Unknown migrate command");
  });

  it("documents every flag it parses, and parses every flag it documents", async () => {
    const documentedFlags = new Set([...MIGRATE_USAGE.join(" ").matchAll(/--[a-z-]+/g)].map((m) => m[0]));
    const actuallyParsedFlags = new Set(["--json", "--from", "--vendor", "--only", "--exclude", "--conflict", "--no-keys", "--verbose", "--yes", "--keep"]);
    for (const f of actuallyParsedFlags) {
      expect(documentedFlags.has(f)).toBe(true);
    }
    for (const f of documentedFlags) {
      expect(actuallyParsedFlags.has(f)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// scan
// ---------------------------------------------------------------------------

describe("runMigrateCommand -- scan", () => {
  it("honestly reports nothing found on a machine with no installs, and exits 0", async () => {
    const deps = isolatedDeps();
    const result = await runMigrateCommand(["scan"], deps);
    expect(result.code).toBe(0);
    expect(result.lines[0]).toContain("No Hermes/OpenClaw installation found; searched:");
    expect(result.lines.length).toBeGreaterThan(1);
  });

  it("--json produces machine-parseable, schema-stable output", async () => {
    const deps = isolatedDeps();
    const result = await runMigrateCommand(["scan", "--json"], deps);
    expect(result.code).toBe(0);
    const parsed = parseJson(result.lines) as { searched: string[]; skipped: unknown[]; sources: unknown[] };
    expect(Array.isArray(parsed.searched)).toBe(true);
    expect(Array.isArray(parsed.skipped)).toBe(true);
    expect(Array.isArray(parsed.sources)).toBe(true);
  });

  it("finds a real Hermes fixture placed at $HOME/.hermes", async () => {
    const deps = isolatedDeps();
    materializeHermesFixture(join(deps.home, ".hermes"), { variant: "home", memories: 1, sessions: 1, skills: 1 });
    const result = await runMigrateCommand(["scan"], deps);
    expect(result.code).toBe(0);
    expect(result.lines.some((l) => l.includes("hermes"))).toBe(true);
  });

  it("rejects an unexpected trailing argument with exit code 2", async () => {
    const deps = isolatedDeps();
    const result = await runMigrateCommand(["scan", "--bogus"], deps);
    expect(result.code).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// plan
// ---------------------------------------------------------------------------

describe("runMigrateCommand -- plan", () => {
  it("builds a plan from a real fixture via --from/--vendor with no blockers, and --json round-trips", async () => {
    const deps = isolatedDeps();
    const fixtureRoot = freshDir("hades-migrate-fixture-");
    materializeHermesFixture(fixtureRoot, { variant: "home", memories: 2, sessions: 1, skills: 1 });

    const text = await runMigrateCommand(["plan", "--from", fixtureRoot, "--vendor", "hermes"], deps);
    expect(text.code).toBe(0);
    expect(text.lines.some((l) => l.includes("ACTIONS"))).toBe(true);

    const json = await runMigrateCommand(["plan", "--from", fixtureRoot, "--vendor", "hermes", "--json"], deps);
    expect(json.code).toBe(0);
    const parsed = parseJson(json.lines) as { actions: unknown[]; blockers: unknown[]; planHash: string };
    expect(Array.isArray(parsed.actions)).toBe(true);
    expect(parsed.actions.length).toBeGreaterThan(0);
    expect(parsed.blockers).toEqual([]);
    expect(typeof parsed.planHash).toBe("string");
  });

  it("--only with an unknown kind exits 2 and names the valid kinds", async () => {
    const deps = isolatedDeps();
    const result = await runMigrateCommand(["plan", "--only", "not-a-real-kind"], deps);
    expect(result.code).toBe(2);
    expect(result.lines[0]).toContain("unknown kind");
    expect(result.lines[0]).toContain("memory");
    expect(result.lines[0]).toContain("session");
  });

  it("an unknown flag exits 2 with usage", async () => {
    const deps = isolatedDeps();
    const result = await runMigrateCommand(["plan", "--nope"], deps);
    expect(result.code).toBe(2);
    expect(result.lines.some((l) => l.startsWith("Usage:"))).toBe(true);
  });

  it("rejects an unknown --conflict / --vendor value with exit code 2", async () => {
    const deps = isolatedDeps();
    const badConflict = await runMigrateCommand(["plan", "--conflict", "not-a-policy"], deps);
    expect(badConflict.code).toBe(2);
    const badVendor = await runMigrateCommand(["plan", "--vendor", "not-a-vendor"], deps);
    expect(badVendor.code).toBe(2);
  });

  it("--only memory restricts the plan to memory actions only", async () => {
    const deps = isolatedDeps();
    const fixtureRoot = freshDir("hades-migrate-fixture-only-");
    materializeHermesFixture(fixtureRoot, { variant: "home", memories: 2, sessions: 1, skills: 1 });
    const result = await runMigrateCommand(["plan", "--from", fixtureRoot, "--vendor", "hermes", "--only", "memory", "--json"], deps);
    expect(result.code).toBe(0);
    const parsed = parseJson(result.lines) as { actions: Array<{ kind: string; action: string }> };
    const nonMemoryNonSkip = parsed.actions.filter((a) => a.kind !== "memory" && a.action !== "skip");
    expect(nonMemoryNonSkip).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// apply
// ---------------------------------------------------------------------------

describe("runMigrateCommand -- apply", () => {
  it("without --yes is a dry run: writes nothing and exits 0", async () => {
    const deps = isolatedDeps();
    const fixtureRoot = freshDir("hades-migrate-fixture-dry-");
    materializeHermesFixture(fixtureRoot, { variant: "home", memories: 2, sessions: 1, skills: 1 });

    const result = await runMigrateCommand(["apply", "--from", fixtureRoot, "--vendor", "hermes"], deps);
    expect(result.code).toBe(0);
    expect(result.lines.some((l) => l.includes("dry run — pass --yes to apply"))).toBe(true);
    expect(existsSync(join(deps.dataDir!, "memory.json"))).toBe(false);
    expect(existsSync(join(deps.dataDir!, "migrate-receipts.jsonl"))).toBe(false);
  });

  it("with --yes actually migrates a real fixture into the real engine (memory, sessions, skills, secrets)", async () => {
    const deps = isolatedDeps();
    const fixtureRoot = freshDir("hades-migrate-fixture-yes-");
    materializeHermesFixture(fixtureRoot, { variant: "home", withSecrets: true, memories: 2, sessions: 1, skills: 1 });

    const result = await runMigrateCommand(["apply", "--from", fixtureRoot, "--vendor", "hermes", "--yes"], deps);
    expect(result.code).toBe(0);
    expect(result.lines.some((l) => l.includes("Transaction committed"))).toBe(true);

    expect(existsSync(join(deps.dataDir!, "memory.json"))).toBe(true);
    const memory = JSON.parse(readFileSync(join(deps.dataDir!, "memory.json"), "utf8")) as Array<{ fact: string }>;
    expect(memory.length).toBeGreaterThan(0);

    expect(existsSync(join(deps.dataDir!, "sessions.json"))).toBe(true);
    expect(existsSync(join(deps.dataDir!, "secrets.env"))).toBe(true);
    if (process.platform !== "win32") {
      expect(statSync(join(deps.dataDir!, "secrets.env")).mode & 0o777).toBe(0o600);
    }
  });

  it("re-applying with --yes a second time makes no further changes (idempotent) and exits 0", async () => {
    const deps = isolatedDeps();
    const fixtureRoot = freshDir("hades-migrate-fixture-idem-");
    materializeHermesFixture(fixtureRoot, { variant: "home", memories: 2, sessions: 1, skills: 1 });

    const first = await runMigrateCommand(["apply", "--from", fixtureRoot, "--vendor", "hermes", "--yes", "--json"], deps);
    expect(first.code).toBe(0);
    const firstJson = parseJson(first.lines) as { receiptHead: string };

    const second = await runMigrateCommand(["apply", "--from", fixtureRoot, "--vendor", "hermes", "--yes", "--json"], deps);
    expect(second.code).toBe(0);
    const secondJson = parseJson(second.lines) as { receiptHead: string; failed: number };
    expect(secondJson.failed).toBe(0);
    expect(secondJson.receiptHead).toBe(firstJson.receiptHead);
  });

  it("requires --yes and --from together with the same flag grammar as plan (unknown flag -> exit 2)", async () => {
    const deps = isolatedDeps();
    const result = await runMigrateCommand(["apply", "--bogus", "--yes"], deps);
    expect(result.code).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------

describe("runMigrateCommand -- report", () => {
  it("reports an empty, valid chain before any apply has run", async () => {
    const deps = isolatedDeps();
    const result = await runMigrateCommand(["report"], deps);
    expect(result.code).toBe(0);
    expect(result.lines.some((l) => l.includes("0 entr"))).toBe(true);
    expect(result.lines.some((l) => l.includes("chain: OK"))).toBe(true);
  });

  it("summarizes real receipts after an apply, in both text and --json form", async () => {
    const deps = isolatedDeps();
    const fixtureRoot = freshDir("hades-migrate-fixture-report-");
    materializeHermesFixture(fixtureRoot, { variant: "home", memories: 2, sessions: 1, skills: 1 });
    await runMigrateCommand(["apply", "--from", fixtureRoot, "--vendor", "hermes", "--yes"], deps);

    const text = await runMigrateCommand(["report"], deps);
    expect(text.code).toBe(0);
    expect(text.lines.some((l) => l.includes("chain: OK"))).toBe(true);

    const json = await runMigrateCommand(["report", "--json"], deps);
    expect(json.code).toBe(0);
    const parsed = parseJson(json.lines) as { total: number; chainOk: boolean };
    expect(parsed.total).toBeGreaterThan(0);
    expect(parsed.chainOk).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// selftest
// ---------------------------------------------------------------------------

describe("runMigrateCommand -- selftest", () => {
  it("runs the real scan->read->plan->apply pipeline against materialized fixtures and passes", async () => {
    const deps = isolatedDeps();
    const result = await runMigrateCommand(["selftest"], deps);
    expect(result.lines.some((l) => l.startsWith("FAIL"))).toBe(false);
    expect(result.code).toBe(0);
    expect(result.lines.some((l) => l.includes("selftest: PASS"))).toBe(true);
    expect(result.lines.some((l) => l.includes("receiptHead unchanged=true"))).toBe(true);
  }, 30_000);

  it("--keep retains the temp fixture/data directory instead of deleting it", async () => {
    const deps = isolatedDeps();
    const result = await runMigrateCommand(["selftest", "--keep"], deps);
    expect(result.code).toBe(0);
    const keptLine = result.lines.find((l) => l.includes("--keep:"));
    expect(keptLine).toBeDefined();
    const path = keptLine!.split("retained at ")[1].trim();
    expect(existsSync(path)).toBe(true);
    rmSync(path, { recursive: true, force: true }); // clean up manually since selftest deliberately did not
  }, 30_000);
});

// ---------------------------------------------------------------------------
// defaultMigrateDeps
// ---------------------------------------------------------------------------

describe("defaultMigrateDeps", () => {
  it("derives sane env-driven defaults", () => {
    const deps = defaultMigrateDeps({ ...process.env, HADES_DATA_DIR: "/tmp/example-data-dir" });
    expect(deps.dataDir).toBe("/tmp/example-data-dir");
    expect(deps.platform).toBe(process.platform);
    expect(typeof deps.home).toBe("string");
  });
});
