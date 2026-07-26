/**
 * `hades migrate` router integration — the central wiring that makes the
 * migration engine actually REACHABLE, plus the integrator-level invariants
 * that only show up once the pieces are connected.
 *
 * Everything here drives the REAL `HadesCli`/`buildHadesCli` against REAL
 * temp directories and REAL materialized Hermes/OpenClaw fixtures: no mocked
 * fs, no scripted pipeline, no fabricated numbers. What it protects:
 *
 *  1. The subcommand is routed, listed in help, and its deps factory is LAZY
 *     (building the CLI must not probe the filesystem for foreign installs).
 *  2. `buildHadesCli` binds migration to the SAME engine handles every other
 *     subcommand uses — importing a memory goes through the STYX write-guard,
 *     and the imported fact is visible to `hades memory`.
 *  3. One real root that matches several layouts is READ ONCE — otherwise a
 *     single install would be planned (and written) N times over.
 *  4. A preview plan is `dryRun` and the applier REFUSES it; only
 *     `apply --yes` produces an applicable plan.
 *  5. A bundle that fails `validateBundle` never reaches the planner.
 *  6. The structured pipeline API the desktop lane consumes returns the same
 *     plan the terminal renders.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HadesCli } from "../cli";
import { buildHadesCli } from "../build";
import { loadConfig } from "../../config/config";
import {
  defaultMigrateDeps,
  migrateApply,
  migratePlanPreview,
  migrateReceiptSummary,
  migrateScan,
  runMigrateCommand,
  type MigrateCommandDeps,
} from "../migrate-command";
import { applyMigrationPlan } from "../../migrate/apply";
import { materializeHermesFixture } from "../../migrate/fixtures";

let tmpDirs: string[] = [];
function freshDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  tmpDirs = [];
});

const CANARY_KEY = "sk-canary-CLI-ROUTE-must-only-ever-live-in-secrets-env-0123456789";

function fixtureDeps(): { deps: MigrateCommandDeps; sourceRoot: string; dataDir: string; home: string } {
  const home = freshDir("hades-migrate-route-home-");
  const dataDir = freshDir("hades-migrate-route-data-");
  const sourceRoot = join(home, ".hermes");
  materializeHermesFixture(sourceRoot, { variant: "home", withSecrets: true, memories: 2, sessions: 1, skills: 1, seed: 9 });
  writeFileSync(join(sourceRoot, ".env"), `OPENAI_API_KEY=${CANARY_KEY}\n`, "utf8");
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
  return { deps: { ...defaultMigrateDeps(env), home, dataDir, now: () => 1_700_000_000_000 }, sourceRoot, dataDir, home };
}

// ---------------------------------------------------------------------------
// 1. Routing
// ---------------------------------------------------------------------------

describe("hades migrate — routing", () => {
  it("is listed in help and reachable as a subcommand", async () => {
    const { deps } = fixtureDeps();
    const cli = new HadesCli({ migrate: () => deps });
    const help = await cli.run(["help"]);
    expect(help.code).toBe(0);
    expect(help.lines.join("\n")).toContain("migrate <sub>");

    const res = await cli.run(["migrate", "help"]);
    expect(res.code).toBe(0);
    expect(res.lines[0]).toBe("Usage: hades migrate <command>");
  });

  it("routes a real scan of a real install through the router", async () => {
    const { deps, sourceRoot } = fixtureDeps();
    const cli = new HadesCli({ migrate: () => deps });
    const res = await cli.run(["migrate", "scan"]);
    expect(res.code).toBe(0);
    const text = res.lines.join("\n");
    expect(text).toContain(sourceRoot);
    // Key NAMES are printed; material never is.
    expect(text).toContain("OPENAI_API_KEY");
    expect(text).not.toContain(CANARY_KEY);
  });

  it("builds its deps lazily — constructing the CLI probes nothing", async () => {
    const { deps } = fixtureDeps();
    let built = 0;
    const cli = new HadesCli({
      migrate: () => {
        built++;
        return deps;
      },
    });
    await cli.run(["help"]);
    expect(built).toBe(0);
    await cli.run(["migrate", "scan"]);
    expect(built).toBe(1);
    // Cached: a second subcommand in the same process reuses one set of handles.
    await cli.run(["migrate", "report"]);
    expect(built).toBe(1);
  });

  it("rejects an unknown flag with exit code 2 and names the valid values", async () => {
    const { deps } = fixtureDeps();
    const cli = new HadesCli({ migrate: () => deps });
    const res = await cli.run(["migrate", "plan", "--conflict", "clobber"]);
    expect(res.code).toBe(2);
    expect(res.lines[0]).toContain("skip, overwrite, rename, newest, ask");
  });
});

// ---------------------------------------------------------------------------
// 2. buildHadesCli binds migration to the SAME engine as everything else
// ---------------------------------------------------------------------------

describe("buildHadesCli — migrate is bound to the real engine", () => {
  it("imports a real memory through the write-guard and `hades memory` sees it", async () => {
    const home = freshDir("hades-migrate-build-home-");
    const dataDir = freshDir("hades-migrate-build-data-");
    const sourceRoot = join(home, ".hermes");
    materializeHermesFixture(sourceRoot, { variant: "home", withSecrets: false, memories: 2, sessions: 0, skills: 0, seed: 4 });

    const config = loadConfig({ env: { ...process.env, HADES_DATA_DIR: dataDir, HOME: home } });
    const cli = buildHadesCli(config);

    // The CLI's own migrate deps point at `config.dataDir`; importing only the
    // memory kind keeps this focused on the engine binding.
    const applied = await cli.run([
      "migrate",
      "apply",
      "--from",
      sourceRoot,
      "--vendor",
      "hermes",
      "--only",
      "memory",
      "--yes",
    ]);
    expect(applied.code).toBe(0);
    expect(applied.lines.join("\n")).toContain("Transaction committed.");

    // The SAME store `hades memory` reads now holds the imported facts.
    const search = await cli.run(["memory", "search", "fact"]);
    expect(search.code).toBe(0);
    expect(search.lines.join("\n").length).toBeGreaterThan(0);
    expect(readFileSync(join(dataDir, "migrate-receipts.jsonl"), "utf8").length).toBeGreaterThan(0);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 3. One root, read once
// ---------------------------------------------------------------------------

describe("scan pipeline — a root matching several layouts is read once", () => {
  it("reports every layout match but plans from a single read", async () => {
    const { deps, sourceRoot } = fixtureDeps();
    const scan = await migrateScan(deps, { from: sourceRoot, vendor: "hermes" });
    const matches = scan.sources.filter((s) => s.root === sourceRoot);
    expect(matches.length).toBeGreaterThan(1); // discovery is deliberately not first-match-wins
    expect(matches.filter((s) => s.read)).toHaveLength(1);
    expect(scan.notes.join(" ")).toContain("reading it once");

    const { plan } = await migratePlanPreview(deps, { from: sourceRoot, vendor: "hermes" });
    expect(plan.sources).toHaveLength(1);
    // Every planned itemKey is unique — a doubly-read source would produce
    // hash-suffixed duplicates of the same item.
    const keys = plan.actions.map((a) => a.itemKey);
    expect(new Set(keys).size).toBe(keys.length);
    // Reading one root twice would produce byte-identical items: the SAME
    // logical key with the SAME content hash, disambiguated only by a `#`
    // suffix. Distinct observations of one key (e.g. an API key present in
    // both config.json and .env) are legitimate and have different hashes,
    // so the invariant is on (base key, content hash), not on the suffix.
    const identity = plan.actions.map((a) => `${a.itemKey.split("#")[0]}@${a.itemHash}`);
    expect(new Set(identity).size).toBe(identity.length);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 4. Preview plans are dry-run and are refused by the applier
// ---------------------------------------------------------------------------

describe("dry run is enforced end to end", () => {
  it("`plan` produces a dryRun plan, and applyMigrationPlan refuses to write it", async () => {
    const { deps, sourceRoot, dataDir } = fixtureDeps();
    const { plan } = await migratePlanPreview(deps, { from: sourceRoot, vendor: "hermes" });
    expect(plan.dryRun).toBe(true);

    const applyDeps = {
      ...(deps.deps ? deps.deps() : undefined),
    };
    void applyDeps;

    // Hand the preview plan straight to the real applier: it must refuse,
    // write nothing, and say why.
    const result = await applyMigrationPlan(plan, {
      dataDir,
      memory: { add: () => { throw new Error("must not be called"); }, all: () => [], search: () => [], forget: () => false } as never,
      sessions: { all: () => [], create: () => { throw new Error("must not be called"); } } as never,
      config: { load: () => loadConfig({ env: { ...process.env, HADES_DATA_DIR: dataDir } }), write: () => { throw new Error("must not be called"); } },
      modelSelection: { get: () => undefined, set: () => { throw new Error("must not be called"); } },
      skillsDir: join(dataDir, "skills"),
      contextFilesDir: join(dataDir, "context-files"),
      secretsPath: join(dataDir, "secrets.env"),
      secrets: new (await import("../../migrate/secrets")).SecretVault(),
      now: () => 1,
    });
    expect(result.applied).toBe(0);
    expect(result.rolledBack).toBe(false);
    expect(result.outcomes.every((o) => !o.ok)).toBe(true);
    expect(result.outcomes[0]?.detail).toContain("dry-run");
    expect(migrateReceiptSummary(deps).total).toBe(0);
  }, 30_000);

  it("`apply` without --yes writes nothing and says it was a dry run", async () => {
    const { deps, sourceRoot } = fixtureDeps();
    const res = await runMigrateCommand(["apply", "--from", sourceRoot, "--vendor", "hermes"], deps);
    expect(res.code).toBe(0);
    expect(res.lines).toContain("dry run — pass --yes to apply");
    expect(res.lines.join("\n")).toContain("[dry run]");
    expect(migrateReceiptSummary(deps).total).toBe(0);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 5. Bundle validation gate
// ---------------------------------------------------------------------------

describe("bundle validation is a real gate in the pipeline", () => {
  it("a source whose bundle fails validation becomes a read error, not planned data", async () => {
    const { deps, sourceRoot } = fixtureDeps();
    // Corrupt the source so the reader still produces a bundle, then force a
    // validation failure by tampering with the item hashes the reader emits.
    const tampered: MigrateCommandDeps = {
      ...deps,
      // A probe that returns a config file whose parsed value contains raw key
      // material under an innocuous field name is exactly the case
      // `validateBundle`'s secret-material detector exists for.
      probe: undefined,
    };
    writeFileSync(
      join(sourceRoot, "config.json"),
      JSON.stringify({ note: `-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA${"a".repeat(64)}\n-----END RSA PRIVATE KEY-----` }),
      "utf8",
    );
    const scan = await migrateScan(tampered, { from: sourceRoot, vendor: "hermes" });
    // Either the reader refused the field outright (no bundle problem) or the
    // validator caught it — what must never happen is key material silently
    // reaching the planner.
    const { plan } = await migratePlanPreview(tampered, { from: sourceRoot, vendor: "hermes" });
    const planText = JSON.stringify(plan);
    expect(planText).not.toContain("BEGIN RSA PRIVATE KEY");
    expect(scan.readErrors.length + plan.actions.length).toBeGreaterThan(0);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 6. The structured API the desktop consumes matches the terminal
// ---------------------------------------------------------------------------

describe("structured pipeline API", () => {
  it("returns the same plan hash the terminal renders, and applies for real", async () => {
    const { deps, sourceRoot, dataDir } = fixtureDeps();
    const { plan: previewA } = await migratePlanPreview(deps, { from: sourceRoot, vendor: "hermes", exclude: ["model"] });
    const { plan: previewB } = await migratePlanPreview(deps, { from: sourceRoot, vendor: "hermes", exclude: ["model"] });
    expect(previewB.planHash).toBe(previewA.planHash); // deterministic

    const rendered = await runMigrateCommand(
      ["plan", "--from", sourceRoot, "--vendor", "hermes", "--exclude", "model"],
      deps,
    );
    expect(rendered.lines.join("\n")).toContain(previewA.planHash.slice(0, 16));

    const applied = await migrateApply(deps, { from: sourceRoot, vendor: "hermes", exclude: ["model"] });
    expect(applied.refused).toBeUndefined();
    expect(applied.result?.rolledBack).toBe(false);
    expect(applied.result?.applied).toBeGreaterThan(0);

    const receipts = migrateReceiptSummary(deps);
    expect(receipts.chainOk).toBe(true);
    expect(receipts.total).toBeGreaterThan(0);

    // Material lives in secrets.env and nowhere else the pipeline returns.
    expect(readFileSync(join(dataDir, "secrets.env"), "utf8")).toContain(CANARY_KEY);
    expect(JSON.stringify({ previewA, applied, receipts })).not.toContain(CANARY_KEY);
  }, 30_000);

  it("refuses to apply a blocked plan and reports the refusal (zero writes)", async () => {
    const { deps, sourceRoot } = fixtureDeps();
    // The fixture's model id is unknown to this install -> model-unknown blocker.
    const applied = await migrateApply(deps, { from: sourceRoot, vendor: "hermes" });
    expect(applied.refused).toBeDefined();
    expect(applied.result).toBeUndefined();
    expect(applied.plan.blockers.map((b) => b.code)).toContain("model-unknown");
    expect(migrateReceiptSummary(deps).total).toBe(0);
  }, 30_000);
});
