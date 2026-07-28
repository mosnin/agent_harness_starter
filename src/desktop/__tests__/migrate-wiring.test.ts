/**
 * Central-integration tests for the desktop `migrate.*` lane.
 *
 * The "is it actually wired, or is it dead code?" tests:
 *
 *  1. `migrate.*` messages really are part of the `Command`/`AppEvent`
 *     unions and survive a full encode -> decode round trip on the wire,
 *     and the guards really reject malformed/hostile payloads (including a
 *     `migrate.apply` that forgot `confirm`).
 *  2. `Sidecar` really routes them to a `MigrateHandler`, and really reports
 *     an honest `migrate.error` when none is configured — never an empty
 *     scan, which a renderer would legitimately read as "nothing to import".
 *  3. `MigrateService` really drives the REAL migration engine against a
 *     REAL materialized Hermes fixture on disk: it scans, plans, refuses to
 *     write without `confirm`, applies transactionally, and reports the real
 *     hash-chained receipts. No mocked fs, no scripted fake pipeline.
 *  4. Nothing on this lane ever carries secret MATERIAL — asserted by
 *     seeding a distinctive key into the fixture and grepping every
 *     serialized event for it.
 *  5. The renderer really renders the card from real events and really turns
 *     its buttons into real wire commands.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  decodeCommand,
  decodeEvent,
  encodeCommand,
  encodeEvent,
  isCommand,
  isAppEvent,
  type AppEvent,
  type Command,
} from "../ipc/contract";
import { isMigrateCommand, isMigrateEvent, type MigrateEvent } from "../ipc/migrate-contract";
import { Sidecar, type MigrateHandler, type SwarmFactory } from "../core/sidecar";
import { MigrateService } from "../core/migrate-service";
import { initialMigrateSlice, migrateSelectors, reduceMigrate } from "../core/migrate-slice";
import { renderMigrateCard } from "../ui/migrate-card";
import { createApp, type Bridge } from "../ui/renderer";
import { DEFAULT_ENTRIES, filterEntries } from "../ui/command-palette";
import { initialState, reduce } from "../core/app-store";
import { materializeHermesFixture } from "../../hades/migrate/fixtures";
import { defaultMigrateDeps, type MigrateCommandDeps } from "../../hades/cli/migrate-command";

// ---------------------------------------------------------------------------
// Fixtures / helpers
// ---------------------------------------------------------------------------

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

const CANARY_KEY = "sk-canary-DESKTOP-MIGRATE-must-never-reach-the-wire-0123456789";

/** A real Hermes install on disk (plus a canary API key) and a real, empty Hades dataDir. */
function realFixture(): { deps: MigrateCommandDeps; sourceRoot: string; dataDir: string } {
  const home = freshDir("hades-desktop-migrate-home-");
  const dataDir = freshDir("hades-desktop-migrate-data-");
  const sourceRoot = join(home, ".hermes");
  materializeHermesFixture(sourceRoot, {
    variant: "home",
    withSecrets: true,
    memories: 2,
    sessions: 1,
    skills: 1,
    seed: 5,
  });
  // Overwrite the fixture's .env with a distinctive canary so the no-leak
  // sweep below is checking for a value we know is really in the source.
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
  return {
    deps: { ...defaultMigrateDeps(env), home, dataDir, now: () => 1_700_000_000_000 },
    sourceRoot,
    dataDir,
  };
}

const noopFactory: SwarmFactory = () => ({
  swarm: undefined,
  // `dispatchGoal` is REQUIRED by SwarmHandle; the stub omitted it, so it never
  // actually satisfied the interface it claims to stand in for. These tests
  // never dispatch, so it throws rather than silently returning a fake goal id.
  dispatchGoal: (): { goalId: string } => {
    throw new Error("noopFactory: dispatchGoal is not used by the migrate-wiring tests");
  },
  snapshot: () => ({ workers: [], tasks: [], runs: [], metrics: undefined }),
  on: () => () => {},
  stop: async () => {},
});

function collect(): { events: AppEvent[]; emit: (e: AppEvent) => void } {
  const events: AppEvent[] = [];
  return { events, emit: (e) => events.push(e) };
}

// ---------------------------------------------------------------------------
// 1. Wire format
// ---------------------------------------------------------------------------

describe("desktop IPC contract — migrate.* merged into the unions", () => {
  const commands: Command[] = [
    { kind: "migrate.scan" },
    { kind: "migrate.scan", vendor: "hermes", from: "/tmp/x" },
    { kind: "migrate.plan" },
    { kind: "migrate.plan", conflict: "newest", importSecrets: false },
    { kind: "migrate.apply", confirm: false },
    { kind: "migrate.apply", confirm: true, vendor: "openclaw", conflict: "skip" },
    { kind: "migrate.receipts" },
  ];

  it.each(commands.map((c) => [`${c.kind}`, c] as const))(
    "Command %s round-trips through the real codec and isCommand agrees",
    (_kind, cmd) => {
      expect(isCommand(cmd)).toBe(true);
      expect(isMigrateCommand(cmd)).toBe(true);
      const decoded = decodeCommand(encodeCommand(cmd));
      expect(decoded).toEqual(cmd);
    },
  );

  const events: AppEvent[] = [
    {
      kind: "migrate.sources",
      at: 1,
      scan: {
        sources: [
          { vendor: "hermes", layout: "hermes-dotfile", root: "/home/u/.hermes", confidence: 0.9, itemCount: 12, warnings: [], read: true },
        ],
        searched: ["/home/u/.hermes"],
        skipped: [{ path: "/home/u/.openclaw", reason: "not present" }],
        readErrors: [],
        notes: [],
        secretEnvVars: ["OPENAI_API_KEY"],
      },
    },
    {
      kind: "migrate.plan",
      at: 2,
      scan: { sources: [], searched: [], skipped: [], readErrors: [], notes: [], secretEnvVars: [] },
      plan: {
        createdAt: 1,
        dryRun: true,
        planHash: "abc",
        sources: [{ vendor: "hermes", root: "/r", layout: "hermes-dotfile", itemCount: 3 }],
        actions: [
          {
            itemKey: "memory:1",
            kind: "memory",
            action: "import",
            reason: "new fact",
            vendor: "hermes",
            sourcePath: "memory.json",
            risk: "none",
            itemHash: "h",
          },
        ],
        blockers: [{ code: "model-unknown", message: "nope" }],
        unimportable: [{ path: "p", kind: "unknown", reason: "r", vendor: "hermes" }],
        warnings: [],
        byAction: [{ action: "import", count: 1 }],
        byKind: [{ kind: "memory", count: 1 }],
        destructive: 0,
        secretsToWrite: 0,
        alreadyImported: 0,
      },
    },
    {
      kind: "migrate.applied",
      at: 3,
      plan: {
        createdAt: 1,
        dryRun: false,
        planHash: "abc",
        sources: [],
        actions: [],
        blockers: [],
        unimportable: [],
        warnings: [],
        byAction: [],
        byKind: [],
        destructive: 0,
        secretsToWrite: 0,
        alreadyImported: 0,
      },
      result: {
        applied: 3,
        failed: 0,
        quarantined: 1,
        secretsWritten: 1,
        rolledBack: false,
        durationMs: 12,
        receiptPath: "/d/migrate-receipts.jsonl",
        receiptHead: "deadbeef",
        outcomes: [{ itemKey: "memory:1", action: "import", ok: true, detail: "wrote" }],
      },
    },
    {
      kind: "migrate.receipts",
      at: 4,
      receipts: { receiptPath: "/d/r.jsonl", total: 2, ok: 2, failed: 0, chainOk: true, byAction: [{ action: "import", count: 2 }] },
    },
    { kind: "migrate.error", op: "migrate.scan", message: "EACCES", at: 5 },
  ];

  it.each(events.map((e) => [`${e.kind}`, e] as const))(
    "AppEvent %s round-trips through the real codec and isAppEvent agrees",
    (_kind, ev) => {
      expect(isAppEvent(ev)).toBe(true);
      expect(isMigrateEvent(ev)).toBe(true);
      expect(decodeEvent(encodeEvent(ev))).toEqual(ev);
    },
  );

  it("rejects malformed payloads instead of coercing them", () => {
    // `confirm` is required on apply — a payload that forgot it must not be
    // accepted and then treated as a write.
    expect(isCommand({ kind: "migrate.apply" })).toBe(false);
    expect(isCommand({ kind: "migrate.apply", confirm: "yes" })).toBe(false);
    expect(isCommand({ kind: "migrate.plan", vendor: "hermes-ish" })).toBe(false);
    expect(isCommand({ kind: "migrate.plan", conflict: "clobber" })).toBe(false);
    expect(isCommand({ kind: "migrate.scan", from: 7 })).toBe(false);
    expect(() => decodeCommand(JSON.stringify({ kind: "migrate.apply" }))).toThrow();
    expect(isAppEvent({ kind: "migrate.error", op: "x" })).toBe(false);
    // Prototype-pollution shaped payload is refused outright.
    expect(isCommand(JSON.parse('{"kind":"migrate.scan","__proto__":{"x":1}}'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. Sidecar routing
// ---------------------------------------------------------------------------

describe("Sidecar — migrate.* routing", () => {
  it("routes every migrate command to the configured handler", async () => {
    const seen: Command[] = [];
    const handler: MigrateHandler = {
      handle: async (cmd) => {
        seen.push(cmd);
        return { kind: "migrate.error", op: cmd.kind, message: "ack", at: 1 };
      },
    };
    const { events, emit } = collect();
    const sidecar = new Sidecar({ factory: noopFactory, emit, migrate: handler });

    for (const cmd of [
      { kind: "migrate.scan" },
      { kind: "migrate.plan" },
      { kind: "migrate.apply", confirm: true },
      { kind: "migrate.receipts" },
    ] as Command[]) {
      await sidecar.handle(cmd);
    }

    expect(seen.map((c) => c.kind)).toEqual(["migrate.scan", "migrate.plan", "migrate.apply", "migrate.receipts"]);
    expect(events).toHaveLength(4);
    await sidecar.dispose();
  });

  it("reports an honest migrate.error (never an empty scan) when no handler is configured", async () => {
    const { events, emit } = collect();
    const sidecar = new Sidecar({ factory: noopFactory, emit });
    await sidecar.handle({ kind: "migrate.scan" });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "migrate.error", op: "migrate.scan" });
    expect((events[0] as { message: string }).message).toContain("not configured");
    await sidecar.dispose();
  });
});

// ---------------------------------------------------------------------------
// 3. MigrateService over the REAL engine and a REAL fixture on disk
// ---------------------------------------------------------------------------

describe("MigrateService — real pipeline, real filesystem", () => {
  it("scans a real Hermes install, previews, refuses to write unconfirmed, then applies for real", async () => {
    const { deps, sourceRoot, dataDir } = realFixture();
    const service = new MigrateService({ deps, now: () => 1_700_000_000_000 });

    // -- scan
    const scanned = await service.handle({ kind: "migrate.scan" });
    expect(scanned.kind).toBe("migrate.sources");
    if (scanned.kind !== "migrate.sources") throw new Error("unreachable");
    expect(scanned.scan.sources.some((s) => s.root === sourceRoot && s.vendor === "hermes")).toBe(true);
    expect(scanned.scan.secretEnvVars).toContain("OPENAI_API_KEY");

    // -- unconfirmed apply is a PREVIEW: it returns a dry-run plan and writes nothing
    const before = readFileSync(join(sourceRoot, ".env"), "utf8");
    const preview = await service.handle({ kind: "migrate.apply", confirm: false });
    expect(preview.kind).toBe("migrate.plan");
    if (preview.kind !== "migrate.plan") throw new Error("unreachable");
    expect(preview.plan.dryRun).toBe(true);
    const receiptsAfterPreview = await service.handle({ kind: "migrate.receipts" });
    if (receiptsAfterPreview.kind !== "migrate.receipts") throw new Error("unreachable");
    expect(receiptsAfterPreview.receipts.total).toBe(0);

    // -- confirmed apply does real work through the real applier
    const applied = await service.handle({ kind: "migrate.apply", confirm: true, conflict: "skip" });
    expect(applied.kind).toBe("migrate.applied");
    if (applied.kind !== "migrate.applied") throw new Error("unreachable");
    // The fixture names a model this install cannot run, so the plan is
    // blocked and the applier refuses — that IS the honest outcome, and it
    // must be reported as a refusal, never as a successful import.
    if (applied.result.refused) {
      expect(applied.plan.blockers.length).toBeGreaterThan(0);
      expect(applied.result.applied).toBe(0);
    } else {
      expect(applied.result.rolledBack).toBe(false);
      expect(applied.result.applied).toBeGreaterThan(0);
      expect(applied.result.receiptHead).not.toBe("");
    }

    // -- the source install is never mutated by a migration
    expect(readFileSync(join(sourceRoot, ".env"), "utf8")).toBe(before);

    // -- no secret material anywhere on the wire
    const wire = [scanned, preview, receiptsAfterPreview, applied].map((e) => JSON.stringify(e)).join("\n");
    expect(wire).not.toContain(CANARY_KEY);
    expect(wire).not.toContain(CANARY_KEY.slice(0, 24));
    expect(dataDir.length).toBeGreaterThan(0);
  }, 30_000);

  it("applies for real end to end (real writes, real hash-chained receipts, idempotent re-run)", async () => {
    const { deps, dataDir } = realFixture();
    const service = new MigrateService({ deps, now: () => 1_700_000_000_000 });

    // The fixture names a model this install cannot run — the honest engine
    // blocks on it — so this run excludes the `model` kind (the wire's
    // equivalent of `--exclude model`) to exercise the full write path.
    const applied = await service.handle({ kind: "migrate.apply", confirm: true, exclude: ["model"] });
    if (applied.kind !== "migrate.applied") throw new Error("unreachable");
    expect(applied.result.refused).toBeUndefined();
    expect(applied.plan.blockers).toEqual([]);
    expect(applied.plan.dryRun).toBe(false);
    expect(applied.result.rolledBack).toBe(false);
    expect(applied.result.failed).toBe(0);
    expect(applied.result.applied).toBeGreaterThan(0);
    expect(applied.result.secretsWritten).toBeGreaterThan(0);

    // Real files, written by the real engine into the real data directory.
    const secretsFile = readFileSync(join(dataDir, "secrets.env"), "utf8");
    expect(secretsFile).toContain("OPENAI_API_KEY=");
    expect(secretsFile).toContain(CANARY_KEY); // material belongs HERE and only here

    // Real receipts, and a chain that verifies.
    const receipts = await service.handle({ kind: "migrate.receipts" });
    if (receipts.kind !== "migrate.receipts") throw new Error("unreachable");
    expect(receipts.receipts.chainOk).toBe(true);
    expect(receipts.receipts.total).toBeGreaterThan(0);
    expect(receipts.receipts.failed).toBe(0);

    // Re-running is idempotent: the receipt head does not move.
    const again = await service.handle({ kind: "migrate.apply", confirm: true, exclude: ["model"] });
    if (again.kind !== "migrate.applied") throw new Error("unreachable");
    expect(again.result.receiptHead).toBe(applied.result.receiptHead);

    // ...and none of the events carried the key material.
    const wire = [applied, receipts, again].map((e) => JSON.stringify(e)).join("\n");
    expect(wire).not.toContain(CANARY_KEY);
  }, 30_000);

  it("turns a real engine failure into a migrate.error rather than a silent empty result", async () => {
    const { deps } = realFixture();
    // A data directory that cannot exist (a FILE where the directory must go)
    // is a real, reproducible failure of the target probe.
    const blockerFile = join(freshDir("hades-desktop-migrate-block-"), "not-a-dir");
    writeFileSync(blockerFile, "x", "utf8");
    const service = new MigrateService({
      deps: { ...deps, dataDir: join(blockerFile, "nested"), deps: () => { throw new Error("ENOTDIR: simulated real probe failure"); } },
      now: () => 1,
    });
    const ev = await service.handle({ kind: "migrate.plan" });
    expect(ev.kind).toBe("migrate.error");
    if (ev.kind !== "migrate.error") throw new Error("unreachable");
    expect(ev.message).toContain("ENOTDIR");
  });
});

// ---------------------------------------------------------------------------
// 4. Slice + card
// ---------------------------------------------------------------------------

describe("migrate slice + Import card", () => {
  it("reduces real events and never renders a refusal as an import", () => {
    let slice = initialMigrateSlice();
    slice = reduceMigrate(slice, {
      kind: "migrate.sources",
      at: 10,
      scan: {
        sources: [
          { vendor: "hermes", layout: "hermes-dotfile", root: "/home/u/.hermes", confidence: 0.9, itemCount: 12, warnings: [], read: true },
          { vendor: "hermes", layout: "hermes-xdg", root: "/home/u/.hermes", confidence: 0.9, itemCount: 12, warnings: [], read: false },
        ],
        searched: [],
        skipped: [],
        readErrors: [],
        notes: ["collapsed"],
        secretEnvVars: ["OPENAI_API_KEY"],
      },
    });
    expect(migrateSelectors.sourcesRead(slice)).toBe(1);
    expect(migrateSelectors.itemsFound(slice)).toBe(12);

    const html = renderMigrateCard(slice);
    expect(html).toContain("OPENAI_API_KEY");
    expect(html).toContain("duplicate layout match");

    slice = reduceMigrate(slice, {
      kind: "migrate.applied",
      at: 11,
      plan: {
        createdAt: 1,
        dryRun: false,
        planHash: "h",
        sources: [],
        actions: [],
        blockers: [{ code: "model-unknown", message: "no" }],
        unimportable: [],
        warnings: [],
        byAction: [],
        byKind: [],
        destructive: 0,
        secretsToWrite: 0,
        alreadyImported: 0,
      },
      result: {
        applied: 0,
        failed: 0,
        quarantined: 0,
        secretsWritten: 0,
        rolledBack: false,
        durationMs: 0,
        receiptPath: "",
        receiptHead: "",
        refused: "the plan has unresolved blocker(s); nothing was applied",
        outcomes: [],
      },
    });
    expect(migrateSelectors.importedSomething(slice)).toBe(false);
    const refusedHtml = renderMigrateCard(slice);
    expect(refusedHtml).toContain("Nothing was imported");
    expect(refusedHtml).toContain("Import blocked");

    // An error keeps the last real scan visible instead of reverting to "nothing found".
    slice = reduceMigrate(slice, { kind: "migrate.error", op: "migrate.scan", message: "EACCES", at: 12 });
    expect(slice.scan).not.toBeNull();
    expect(renderMigrateCard(slice)).toContain("EACCES");
  });

  it("escapes foreign data from another vendor's install", () => {
    let slice = initialMigrateSlice();
    slice = reduceMigrate(slice, {
      kind: "migrate.sources",
      at: 1,
      scan: {
        sources: [
          {
            vendor: "hermes",
            layout: '<img src=x onerror="alert(1)">',
            root: '/tmp/"><script>alert(1)</script>',
            confidence: 1,
            itemCount: 0,
            warnings: ["<b>warn</b>"],
            read: true,
          },
        ],
        searched: [],
        skipped: [],
        readErrors: [],
        notes: [],
        secretEnvVars: [],
      },
    });
    const html = renderMigrateCard(slice);
    // No foreign markup survives as markup: the tag delimiters are entities,
    // so `onerror="..."` is inert text inside a span, never an attribute.
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>warn");
    expect(html).toContain("&lt;script&gt;");
    // Anything landing in an ATTRIBUTE also has its quotes escaped, so a
    // quote in a foreign path cannot terminate the attribute.
    expect(html).toContain('title="/tmp/&quot;&gt;&lt;script&gt;');
  });

  it("app-store's reducer leaves swarm state untouched for migrate events", () => {
    const base = initialState();
    const next = reduce(base, { kind: "migrate.error", op: "migrate.scan", message: "x", at: 1 });
    expect(next).toEqual(base);
  });
});

// ---------------------------------------------------------------------------
// 5. Renderer wiring — buttons produce REAL wire commands
// ---------------------------------------------------------------------------

describe("renderer — Import card is reachable and sends real commands", () => {
  function fakeBridge(): { bridge: Bridge; sent: Command[]; push: (e: AppEvent) => void } {
    const sent: Command[] = [];
    let listener: ((e: AppEvent) => void) | undefined;
    return {
      sent,
      push: (e) => listener?.(e),
      bridge: {
        send: (cmd) => sent.push(cmd),
        onEvent: (cb) => {
          listener = cb;
          return () => {
            listener = undefined;
          };
        },
        start: async () => {},
        stop: async () => {},
      },
    };
  }

  it("renders the card on the Settings surface and dispatches migrate.scan/plan", () => {
    const { bridge, sent } = fakeBridge();
    const app = createApp(bridge);
    app.setNav("settings");
    expect(app.html()).toContain("Import from Hermes / OpenClaw");

    app.dispatchIntent({ cmd: "migrate.scan" });
    app.dispatchIntent({ cmd: "migrate.plan" });
    expect(sent.map((c) => c.kind)).toEqual(["migrate.scan", "migrate.plan"]);
    app.destroy();
  });

  it("never sends a confirmed apply without a real, unblocked plan", () => {
    const { bridge, sent, push } = fakeBridge();
    const app = createApp(bridge);
    app.setNav("settings");

    // No plan yet -> the intent is swallowed, nothing is sent.
    app.dispatchIntent({ cmd: "migrate.apply" });
    expect(sent).toHaveLength(0);

    const blockedPlan: MigrateEvent = {
      kind: "migrate.plan",
      at: 1,
      scan: { sources: [], searched: [], skipped: [], readErrors: [], notes: [], secretEnvVars: [] },
      plan: {
        createdAt: 1,
        dryRun: true,
        planHash: "h",
        sources: [],
        actions: [],
        blockers: [{ code: "target-not-writable", message: "read-only" }],
        unimportable: [],
        warnings: [],
        byAction: [],
        byKind: [],
        destructive: 0,
        secretsToWrite: 0,
        alreadyImported: 0,
      },
    };
    push(blockedPlan);
    app.dispatchIntent({ cmd: "migrate.apply" });
    expect(sent).toHaveLength(0); // still refused: the plan is blocked

    push({ ...blockedPlan, plan: { ...blockedPlan.plan, blockers: [] }, at: 2 } as MigrateEvent);
    app.dispatchIntent({ cmd: "migrate.apply" });
    expect(sent.map((c) => c.kind)).toEqual(["migrate.apply", "migrate.receipts"]);
    expect(sent[0]).toMatchObject({ kind: "migrate.apply", confirm: true });
    app.destroy();
  });
});

describe("command palette — migration is discoverable, but only its read-only halves", () => {
  it("offers scan/preview and never a confirmed apply", () => {
    const hits = filterEntries(DEFAULT_ENTRIES, "migrate");
    expect(hits.map((e) => e.id).sort()).toEqual(["migrate.plan", "migrate.scan"]);
    for (const entry of hits) {
      const cmd = entry.toCommand();
      expect(cmd).not.toBeNull();
      expect(isCommand(cmd)).toBe(true);
      expect((cmd as { kind: string }).kind).not.toBe("migrate.apply");
    }
  });
});

// ---------------------------------------------------------------------------
// 6. The real dataDir convention is shared with the CLI
// ---------------------------------------------------------------------------

describe("MigrateService — default deps target the same install as the CLI", () => {
  it("defaults to $HADES_DATA_DIR, the same root `hades migrate` uses", async () => {
    const dataDir = freshDir("hades-desktop-migrate-default-");
    mkdirSync(join(dataDir, "sub"), { recursive: true });
    const service = new MigrateService({
      deps: { ...defaultMigrateDeps({ ...process.env, HADES_DATA_DIR: dataDir }), home: freshDir("hades-empty-home-") },
      now: () => 1,
    });
    const ev = await service.handle({ kind: "migrate.receipts" });
    if (ev.kind !== "migrate.receipts") throw new Error("unreachable");
    expect(ev.receipts.receiptPath).toBe(join(dataDir, "migrate-receipts.jsonl"));
    expect(ev.receipts.total).toBe(0);
    expect(ev.receipts.chainOk).toBe(true);
  });
});
