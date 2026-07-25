/**
 * Tests for `src/hades/migrate/report.ts` -- honest, terminal-grade
 * rendering of a `MigrationPlan`.
 *
 * Builds real `MigrationPlan`s via `buildMigrationPlan` (T4's own
 * `plan.ts`) and hand-built fixtures rather than trivial `PlannedAction`
 * literals wherever a full plan-shaped scenario is needed, so the rendering
 * assertions exercise the same data a real dry-run/apply flow would see.
 */
import { describe, expect, it } from "vitest";

import { buildMigrationPlan, type MigrateOptions, type PlannedAction, type MigrationPlan, type TargetProbe } from "../plan";
import { makeItem } from "../ir";
import type { MigrationBundle } from "../ir";
import { DEFAULT_CONFIG } from "../../config/config";
import { renderApplyReport, renderDiff, renderPlanJson, renderPlanText, type ApplyOutcome } from "../report";

// ---------------------------------------------------------------------------
// Fixtures (mirrors plan.test.ts's builders, kept local/independent)
// ---------------------------------------------------------------------------

function emptyStats() {
  return { filesScanned: 0, bytesRead: 0, truncated: false };
}

function bundle(overrides: Partial<MigrationBundle> = {}): MigrationBundle {
  return {
    vendor: "hermes",
    layout: "hermes-dotfile",
    root: "/home/u/.hermes",
    items: [],
    unimportable: [],
    readErrors: [],
    stats: emptyStats(),
    ...overrides,
  };
}

function target(overrides: Partial<TargetProbe> = {}): TargetProbe {
  return {
    dataDir: "/home/u/.hades",
    memoryFacts: [],
    sessions: [],
    skills: [],
    config: { ...DEFAULT_CONFIG },
    knownModelIds: ["claude-sonnet-5"],
    contextFiles: [],
    envVarNames: [],
    secretsFilePath: "/home/u/.hades/secrets.env",
    writable: { config: true, model: true, memory: true, session: true, skill: true, secret: true, "context-file": true, "tool-state": true, unknown: true },
    priorReceipts: [],
    ...overrides,
  };
}

function options(overrides: Partial<MigrateOptions> = {}): MigrateOptions {
  return { conflict: "skip", importSecrets: true, dryRun: true, now: 1_700_000_000_000, ...overrides };
}

function samplePlan(overrides?: { dryRun?: boolean; conflict?: MigrateOptions["conflict"] }): MigrationPlan {
  const items = [
    makeItem({ kind: "config", key: "config:gateway.trigger", value: "!hades", origin: { path: "/home/u/.hermes/config.json" }, confidence: 1 }),
    makeItem({ kind: "model", key: "model:selection", value: { modelId: "not-a-real-model" }, origin: { path: "/home/u/.hermes/model.json" }, confidence: 1 }),
    makeItem({
      kind: "session",
      key: "session:abc",
      value: { id: "abc", messages: [], tags: [], startedAt: 100, endedAt: 100 },
      origin: { path: "/home/u/.hermes/sessions/abc.jsonl" },
      confidence: 1,
    }),
  ];
  const b = bundle({ items, unimportable: [{ path: "/home/u/.hermes/sessions/broken.jsonl", kind: "session", reason: "invalid JSON" }] });
  const t = target({ sessions: [{ id: "abc", startedAt: 50 }] });
  return buildMigrationPlan({
    bundles: [b],
    secrets: [],
    target: t,
    options: options({ dryRun: overrides?.dryRun ?? true, conflict: overrides?.conflict ?? "overwrite" }),
  });
}

// ---------------------------------------------------------------------------
// renderPlanText
// ---------------------------------------------------------------------------

describe("renderPlanText", () => {
  it("always leads with an unconditional [dry run] banner when plan.dryRun is true", () => {
    const plan = samplePlan({ dryRun: true });
    const lines = renderPlanText(plan);
    expect(lines[0]).toMatch(/\[dry run\]/);
  });

  it("never emits the dry-run banner when plan.dryRun is false", () => {
    const plan = samplePlan({ dryRun: false });
    const lines = renderPlanText(plan);
    expect(lines.some((l) => l.includes("[dry run]"))).toBe(false);
  });

  it("emits no ANSI escapes when color is not requested", () => {
    const plan = samplePlan();
    const lines = renderPlanText(plan, { color: false });
    for (const l of lines) expect(l).not.toMatch(/\x1b\[/);
  });

  it("emits ANSI escapes only on whole lines, never splitting an escape across a wrap boundary, when color is requested", () => {
    const plan = samplePlan();
    const lines = renderPlanText(plan, { color: true, width: 40 });
    for (const l of lines) {
      // Every ESC that appears must be immediately followed by a well-formed CSI sequence
      // ending in 'm' -- i.e. no line starts or ends mid-escape.
      const escCount = (l.match(/\x1b\[/g) ?? []).length;
      const resetCount = (l.match(/\x1b\[0m/g) ?? []).length;
      if (escCount > 0) {
        expect(l).toMatch(/^\x1b\[[0-9;]*m.*\x1b\[0m$/s);
        expect(resetCount).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it("hard-wraps every line to at most `width` characters, ignoring color escapes", () => {
    const plan = samplePlan();
    const width = 48;
    const lines = renderPlanText(plan, { width, verbose: true });
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(width);
  });

  it("lists every unimportable entry explicitly under NOT IMPORTED, never eliding behind a bare count", () => {
    const plan = samplePlan();
    const lines = renderPlanText(plan);
    const header = lines.find((l) => l.includes("NOT IMPORTED"));
    expect(header).toMatch(new RegExp(`NOT IMPORTED \\(${plan.unimportable.length}\\)`));
    for (const u of plan.unimportable) {
      expect(lines.some((l) => l.includes(u.path) && l.includes(u.reason))).toBe(true);
    }
  });

  it("lists every blocker with its code and message", () => {
    const plan = samplePlan(); // includes a model-unknown blocker
    const lines = renderPlanText(plan);
    for (const b of plan.blockers) {
      expect(lines.some((l) => l.includes(`[${b.code}]`) && l.includes(b.message.slice(0, 20)))).toBe(true);
    }
  });

  it("header action counts match an independent recount of plan.actions", () => {
    const plan = samplePlan();
    const lines = renderPlanText(plan, { width: 200 });
    const summaryLine = lines.find((l) => l.includes("action(s) planned"));
    expect(summaryLine).toBeDefined();
    const counts: Record<string, number> = {};
    for (const a of plan.actions) counts[a.action] = (counts[a.action] ?? 0) + 1;
    for (const kind of ["import", "merge", "rename", "overwrite", "skip", "quarantine", "abstain"]) {
      const re = new RegExp(`${kind}=(\\d+)`);
      const m = summaryLine!.match(re);
      expect(m).not.toBeNull();
      expect(Number(m![1])).toBe(counts[kind] ?? 0);
    }
  });

  it("clamps width to a sane floor rather than producing pathological output for tiny widths", () => {
    const plan = samplePlan();
    expect(() => renderPlanText(plan, { width: 1 })).not.toThrow();
    const lines = renderPlanText(plan, { width: 1 });
    expect(lines.length).toBeGreaterThan(0);
  });

  it("verbose mode includes vendor/source/risk detail that non-verbose mode omits", () => {
    const plan = samplePlan();
    const terse = renderPlanText(plan, { verbose: false, width: 200 }).join("\n");
    const verbose = renderPlanText(plan, { verbose: true, width: 200 }).join("\n");
    expect(verbose).toContain("vendor=hermes");
    expect(terse).not.toContain("vendor=hermes");
  });
});

// ---------------------------------------------------------------------------
// renderPlanJson
// ---------------------------------------------------------------------------

describe("renderPlanJson", () => {
  it("round-trips through JSON.stringify/parse without throwing and preserves core fields", () => {
    const plan = samplePlan();
    const json = renderPlanJson(plan);
    const roundTripped = JSON.parse(JSON.stringify(json));
    expect(roundTripped.planHash).toBe(plan.planHash);
    expect(roundTripped.dryRun).toBe(plan.dryRun);
    expect(roundTripped.actions).toHaveLength(plan.actions.length);
    expect(roundTripped.unimportable).toHaveLength(plan.unimportable.length);
  });

  it("every action carries itemKey/kind/action/risk/itemHash", () => {
    const plan = samplePlan();
    const json = renderPlanJson(plan) as { actions: Array<Record<string, unknown>> };
    for (const a of json.actions) {
      expect(typeof a.itemKey).toBe("string");
      expect(typeof a.kind).toBe("string");
      expect(typeof a.action).toBe("string");
      expect(typeof a.risk).toBe("string");
      expect(typeof a.itemHash).toBe("string");
    }
  });

  it("omits undefined optional action fields rather than emitting literal 'undefined'", () => {
    const plan = samplePlan();
    const json = renderPlanJson(plan);
    expect(JSON.stringify(json)).not.toContain("undefined");
  });
});

// ---------------------------------------------------------------------------
// renderApplyReport
// ---------------------------------------------------------------------------

describe("renderApplyReport", () => {
  it("is reconciled when every planned action has a matching outcome", () => {
    const plan = samplePlan();
    const outcomes: ApplyOutcome[] = plan.actions.map((a) => ({ itemKey: a.itemKey, action: a.action, ok: true, detail: "applied" }));
    const report = renderApplyReport(plan, outcomes);
    expect(report.reconciled).toBe(true);
    expect(report.missing).toEqual([]);
  });

  it("is NOT reconciled and lists exactly the missing item keys when coverage is incomplete", () => {
    const plan = samplePlan();
    expect(plan.actions.length).toBeGreaterThan(1);
    const partial = plan.actions.slice(1).map((a) => ({ itemKey: a.itemKey, action: a.action, ok: true, detail: "applied" }));
    const report = renderApplyReport(plan, partial);
    expect(report.reconciled).toBe(false);
    expect(report.missing).toEqual([plan.actions[0].itemKey]);
  });

  it("never claims success for an action that produced no outcome", () => {
    const plan = samplePlan();
    const report = renderApplyReport(plan, []);
    expect(report.reconciled).toBe(false);
    expect(report.missing.length).toBe(plan.actions.length);
    const json = report.json as { rows: Array<Record<string, unknown>> };
    for (const row of json.rows) {
      expect(row.reported).toBe(false);
      expect(row).not.toHaveProperty("ok");
    }
    for (const l of report.lines) {
      expect(l).not.toMatch(/\bOK\b/);
    }
  });

  it("reports a failed outcome as failed, not success", () => {
    const plan = samplePlan();
    const outcomes: ApplyOutcome[] = plan.actions.map((a) => ({ itemKey: a.itemKey, action: a.action, ok: false, detail: "disk full" }));
    const report = renderApplyReport(plan, outcomes);
    expect(report.reconciled).toBe(true); // coverage-only; success/failure is orthogonal
    const json = report.json as { failed: number; succeeded: number };
    expect(json.failed).toBe(plan.actions.length);
    expect(json.succeeded).toBe(0);
    expect(report.lines.some((l) => l.includes("FAILED"))).toBe(true);
  });

  it("opts.json renders `lines` as the JSON dump", () => {
    const plan = samplePlan();
    const outcomes: ApplyOutcome[] = plan.actions.map((a) => ({ itemKey: a.itemKey, action: a.action, ok: true, detail: "applied" }));
    const report = renderApplyReport(plan, outcomes, { json: true });
    const parsed = JSON.parse(report.lines.join("\n"));
    expect(parsed.reconciled).toBe(true);
  });

  it("ignores outcomes for item keys the plan never produced (surfaced as a note, not a phantom success)", () => {
    const plan = samplePlan();
    const outcomes: ApplyOutcome[] = [
      ...plan.actions.map((a) => ({ itemKey: a.itemKey, action: a.action, ok: true, detail: "applied" })),
      { itemKey: "config:totally-made-up", action: "import", ok: true, detail: "n/a" },
    ];
    const report = renderApplyReport(plan, outcomes);
    expect(report.reconciled).toBe(true);
    const json = report.json as { extraOutcomes: string[] };
    expect(json.extraOutcomes).toEqual(["config:totally-made-up"]);
  });
});

// ---------------------------------------------------------------------------
// renderDiff
// ---------------------------------------------------------------------------

describe("renderDiff", () => {
  function findAction(plan: MigrationPlan, itemKey: string): PlannedAction {
    const a = plan.actions.find((x) => x.itemKey === itemKey);
    if (!a) throw new Error(`no action ${itemKey}`);
    return a;
  }

  it("includes the conflict description and policy when the action arose from a real conflict", () => {
    const plan = samplePlan({ conflict: "overwrite" });
    const sessionAction = findAction(plan, "session:abc");
    const lines = renderDiff(sessionAction);
    expect(lines.join("\n")).toContain("conflict with:");
    expect(lines.join("\n")).toContain("policy=overwrite");
  });

  it("includes a before/after preview when an incumbent value is supplied", () => {
    const plan = samplePlan();
    const configAction = findAction(plan, "config:gateway.trigger");
    const lines = renderDiff(configAction, "old-trigger");
    expect(lines.some((l) => l.includes("before:") && l.includes("old-trigger"))).toBe(true);
  });

  it("always includes risk and reason", () => {
    const plan = samplePlan();
    const configAction = findAction(plan, "config:gateway.trigger");
    const lines = renderDiff(configAction).join("\n");
    expect(lines).toContain(`risk=${configAction.risk}`);
    expect(lines).toContain(configAction.reason);
  });
});

// ---------------------------------------------------------------------------
// No leakage: neither text nor JSON rendering ever contains key material or
// a path outside the roots actually involved in the plan.
// ---------------------------------------------------------------------------

describe("no leakage", () => {
  it("never renders anything resembling raw secret key material", () => {
    const secretItem = makeItem({
      kind: "secret",
      key: "secret:OPENAI_API_KEY",
      value: { envVar: "OPENAI_API_KEY", present: true, redactedPreview: "sk-a...b12c" },
      origin: { path: "/home/u/.hermes/.env", locator: "OPENAI_API_KEY" },
      confidence: 1,
    });
    const b = bundle({ items: [secretItem] });
    const t = target({ envVarNames: ["OPENAI_API_KEY"] });
    const plan = buildMigrationPlan({ bundles: [b], secrets: [], target: t, options: options({ conflict: "overwrite" }) });

    const textLines = renderPlanText(plan, { color: true, verbose: true });
    const jsonText = JSON.stringify(renderPlanJson(plan));
    const KEY_MATERIAL_RE = /sk-[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16}|-----BEGIN[ A-Z]*PRIVATE KEY-----/;
    for (const l of textLines) expect(l).not.toMatch(KEY_MATERIAL_RE);
    expect(jsonText).not.toMatch(KEY_MATERIAL_RE);
  });

  it("every source path rendered stays within the bundle root or the target dataDir", () => {
    const plan = samplePlan();
    const roots = ["/home/u/.hermes", "/home/u/.hades"];
    const lines = renderPlanText(plan, { verbose: true, width: 200 });
    for (const a of plan.actions) {
      // sourcePath itself must be within a known root (this asserts plan.ts's own discipline,
      // which report.ts inherits by construction since it never invents a path).
      expect(roots.some((r) => a.sourcePath.startsWith(r))).toBe(true);
    }
    // and every rendered "source=" annotation matches one of the actions' real sourcePaths --
    // report.ts never fabricates a path of its own.
    for (const l of lines) {
      const m = l.match(/source=(\S+)/);
      if (m) expect(plan.actions.some((a) => a.sourcePath === m[1])).toBe(true);
    }
  });
});
