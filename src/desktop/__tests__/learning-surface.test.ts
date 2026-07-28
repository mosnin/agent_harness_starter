import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  encodeLearningEvent,
  decodeLearningCommand,
  isLearningCommand,
  isLearningEvent,
  isLearningArmView,
  isLearningStatusView,
  LEARNING_COMMAND_KINDS,
  LEARNING_EVENT_KINDS,
  type LearningCommand,
  type LearningEvent,
  type LearningStatusView,
  type LearningArmView,
} from "../ipc/learning-contract";

import {
  LearningService,
  projectLearningStatus,
  type LearningStatusSource,
  type PersistedStatusLoader,
} from "../core/learning-service";

import {
  initialLearningState,
  applyLearningEvent,
  renderLearningCard,
  renderArmsTable,
  renderNotes,
  formatReward,
  type LearningCardState,
} from "../ui/learning-card";

import type { SwarmLearningStatus } from "../../hades/backends/swarm-learning";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CSS_PATH = join(__dirname, "../ui/learning-card.css");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function armView(overrides: Partial<LearningArmView> = {}): LearningArmView {
  return {
    name: "local-docker",
    pulls: 12,
    verified: 9,
    meanReward: 0.734,
    ucb: 1.12,
    ...overrides,
  };
}

function statusView(overrides: Partial<LearningStatusView> = {}): LearningStatusView {
  return {
    attached: true,
    source: "live",
    savedAt: null,
    counts: { recorded: 12, skipped: 2, duplicate: 1 },
    arms: [armView()],
    recentNotes: ["usd defaulted to 0 (never guessed)"],
    at: 1_700_000_000_000,
    ...overrides,
  };
}

/** A real, typed `SwarmLearningStatus` fixture — every field flows from this. */
function swarmLearningStatus(overrides: Partial<SwarmLearningStatus> = {}): SwarmLearningStatus {
  return {
    attached: true,
    counts: { recorded: 5, skipped: 1, duplicate: 0 },
    arms: {
      "local-docker": {
        pulls: 4,
        verified: 3,
        totalElapsedMs: 40_000,
        totalUsd: 0.4,
        meanReward: 0.62,
        ucb: 0.91,
      },
      "cloud-a": {
        // Never pulled: the engine itself stores meanReward: 0, ucb: null.
        pulls: 0,
        verified: 0,
        totalElapsedMs: 0,
        totalUsd: 0,
        meanReward: 0,
        ucb: null,
      },
    },
    recent: [
      { type: "recorded", at: 1, taskId: "t-1", backend: "local-docker", detail: { elapsedMsNote: "note-1" } },
      { type: "skipped", at: 2, taskId: "t-2", backend: "local-docker", detail: { usdNote: "note-2" } },
    ],
    ...overrides,
  };
}

/** Recursively freezes an object graph so any mutation attempt throws (strict mode). */
function deepFreeze<T>(obj: T): T {
  if (obj !== null && (typeof obj === "object" || typeof obj === "function")) {
    for (const key of Object.getOwnPropertyNames(obj)) {
      const value = (obj as Record<string, unknown>)[key];
      if (value !== null && (typeof value === "object" || typeof value === "function") && !Object.isFrozen(value)) {
        deepFreeze(value);
      }
    }
    Object.freeze(obj);
  }
  return obj;
}

// ===========================================================================
// learning-contract.ts
// ===========================================================================

describe("LearningCommand round-trip", () => {
  it("round-trips learning.get through encode/decode-style JSON", () => {
    const cmd: LearningCommand = { kind: "learning.get" };
    const line = JSON.stringify(cmd) + "\n";
    expect(decodeLearningCommand(line)).toEqual(cmd);
  });

  it("every command kind has a fixture (no kind left untested)", () => {
    expect(LEARNING_COMMAND_KINDS).toEqual(["learning.get"]);
  });
});

describe("LearningEvent encode -> JSON.parse -> guard round trip", () => {
  const events: LearningEvent[] = [
    { kind: "learning.status", status: statusView() },
    { kind: "learning.status", status: statusView({ source: "snapshot", savedAt: 99, arms: [] }) },
    { kind: "learning.status", status: statusView({ arms: [armView({ pulls: 0, meanReward: null, ucb: null })] }) },
    { kind: "learning.error", message: "no learning status available", at: 5 },
  ];

  it.each(events)("round-trips %j", (evt) => {
    const line = encodeLearningEvent(evt);
    expect(line.endsWith("\n")).toBe(true);
    const parsed: unknown = JSON.parse(line);
    expect(isLearningEvent(parsed)).toBe(true);
    expect(parsed).toEqual(evt);
  });

  it("every event kind has a round-trip fixture (no kind left untested)", () => {
    expect(new Set(events.map((e) => e.kind))).toEqual(new Set(LEARNING_EVENT_KINDS));
  });
});

describe("kind tuples exactly match their unions", () => {
  it("LEARNING_COMMAND_KINDS has no duplicates", () => {
    expect(new Set(LEARNING_COMMAND_KINDS).size).toBe(LEARNING_COMMAND_KINDS.length);
  });

  it("LEARNING_EVENT_KINDS has no duplicates", () => {
    expect(new Set(LEARNING_EVENT_KINDS).size).toBe(LEARNING_EVENT_KINDS.length);
    expect([...LEARNING_EVENT_KINDS].sort()).toEqual(["learning.error", "learning.status"].sort());
  });

  // Compile-time coverage assertion: this switch has no default branch that
  // does anything other than funnel into `never`. If a kind is ever added to
  // `LearningCommand`/`LearningEvent` without a case here, this file fails to
  // type-check.
  /** Narrows the DISCRIMINANT, not the whole object: exhausting a literal
  * union member leaves `cmd.kind` as `never`, whereas the object itself
  * is not narrowed away — so the previous form never actually enforced
  * the coverage it advertised. */
function assertNeverCommand(x: never): string {
    throw new Error(`uncovered LearningCommand kind: ${JSON.stringify(x)}`);
  }
  function classifyCommand(cmd: LearningCommand): string {
    switch (cmd.kind) {
      case "learning.get":
        return "get";
      default:
        return assertNeverCommand(cmd.kind);
    }
  }

  function assertNeverEvent(x: never): string {
    throw new Error(`uncovered LearningEvent kind: ${JSON.stringify(x)}`);
  }
  function classifyEvent(evt: LearningEvent): string {
    switch (evt.kind) {
      case "learning.status":
        return "status";
      case "learning.error":
        return "error";
      default:
        return assertNeverEvent(evt);
    }
  }

  it("exhaustive command switch covers every real command kind at runtime", () => {
    for (const kind of LEARNING_COMMAND_KINDS) {
      expect(() => classifyCommand({ kind })).not.toThrow();
    }
  });

  it("exhaustive event switch covers every real event kind at runtime", () => {
    const fixtures: Record<(typeof LEARNING_EVENT_KINDS)[number], LearningEvent> = {
      "learning.status": { kind: "learning.status", status: statusView() },
      "learning.error": { kind: "learning.error", message: "x", at: 0 },
    };
    for (const kind of LEARNING_EVENT_KINDS) {
      expect(() => classifyEvent(fixtures[kind])).not.toThrow();
    }
  });
});

describe("isLearningArmView", () => {
  it("accepts a valid never-pulled arm (nulls) and a valid pulled arm", () => {
    expect(isLearningArmView(armView({ pulls: 0, meanReward: null, ucb: null }))).toBe(true);
    expect(isLearningArmView(armView())).toBe(true);
  });

  it("rejects string pulls", () => {
    expect(isLearningArmView({ ...armView(), pulls: "12" })).toBe(false);
  });

  it("rejects a NaN meanReward", () => {
    expect(isLearningArmView({ ...armView(), meanReward: Number.NaN })).toBe(false);
  });

  it("rejects a NaN ucb", () => {
    expect(isLearningArmView({ ...armView(), ucb: Number.NaN })).toBe(false);
  });

  it("rejects Infinity for meanReward/ucb", () => {
    expect(isLearningArmView({ ...armView(), meanReward: Number.POSITIVE_INFINITY })).toBe(false);
    expect(isLearningArmView({ ...armView(), ucb: Number.NEGATIVE_INFINITY })).toBe(false);
  });

  it("rejects a missing or mistyped name", () => {
    const { name, ...rest } = armView();
    expect(isLearningArmView(rest)).toBe(false);
    expect(isLearningArmView({ ...armView(), name: 7 })).toBe(false);
  });

  it("rejects non-objects", () => {
    expect(isLearningArmView(null)).toBe(false);
    expect(isLearningArmView("arm")).toBe(false);
    expect(isLearningArmView([armView()])).toBe(false);
  });
});

describe("isLearningStatusView", () => {
  it("accepts a valid live status and a valid snapshot status", () => {
    expect(isLearningStatusView(statusView())).toBe(true);
    expect(isLearningStatusView(statusView({ source: "snapshot", savedAt: 5 }))).toBe(true);
  });

  it("rejects notes arrays containing non-strings", () => {
    expect(isLearningStatusView({ ...statusView(), recentNotes: ["ok", 5] })).toBe(false);
    expect(isLearningStatusView({ ...statusView(), recentNotes: ["ok", null] })).toBe(false);
  });

  it("rejects an arms array containing an invalid element", () => {
    expect(isLearningStatusView({ ...statusView(), arms: [{ ...armView(), pulls: "4" }] })).toBe(false);
    expect(isLearningStatusView({ ...statusView(), arms: [{ ...armView(), meanReward: Number.NaN }] })).toBe(
      false
    );
  });

  it("rejects an invalid source", () => {
    expect(isLearningStatusView({ ...statusView(), source: "cached" })).toBe(false);
  });

  it("rejects source: 'live' vs savedAt shape mismatches only at the type level (wire allows any nullable number)", () => {
    // The wire guard is structural, not a cross-field business rule — a
    // live status with a non-null savedAt is still structurally valid JSON;
    // LearningService/projectLearningStatus own the actual honesty rule.
    expect(isLearningStatusView({ ...statusView(), source: "live", savedAt: 5 })).toBe(true);
  });

  it("rejects a missing or mistyped counts", () => {
    expect(isLearningStatusView({ ...statusView(), counts: { recorded: 1, skipped: 2 } })).toBe(false);
    expect(isLearningStatusView({ ...statusView(), counts: { recorded: "1", skipped: 2, duplicate: 0 } })).toBe(
      false
    );
  });

  it("rejects a missing or mistyped attached/at", () => {
    expect(isLearningStatusView({ ...statusView(), attached: "yes" })).toBe(false);
    expect(isLearningStatusView({ ...statusView(), at: "now" })).toBe(false);
  });

  it("rejects non-objects", () => {
    expect(isLearningStatusView(null)).toBe(false);
    expect(isLearningStatusView(42)).toBe(false);
  });
});

describe("isLearningCommand / isLearningEvent", () => {
  it("accepts learning.get and rejects unknown kinds", () => {
    expect(isLearningCommand({ kind: "learning.get" })).toBe(true);
    expect(isLearningCommand({ kind: "learning.set" })).toBe(false);
    expect(isLearningCommand(null)).toBe(false);
    expect(isLearningCommand([])).toBe(false);
  });

  it("accepts learning.status/learning.error and rejects unknown kinds", () => {
    expect(isLearningEvent({ kind: "learning.status", status: statusView() })).toBe(true);
    expect(isLearningEvent({ kind: "learning.error", message: "x", at: 0 })).toBe(true);
    expect(isLearningEvent({ kind: "learning.bogus" })).toBe(false);
  });

  it("rejects learning.error with a missing/mistyped message or at", () => {
    expect(isLearningEvent({ kind: "learning.error", at: 0 })).toBe(false);
    expect(isLearningEvent({ kind: "learning.error", message: 1, at: 0 })).toBe(false);
    expect(isLearningEvent({ kind: "learning.error", message: "x" })).toBe(false);
  });

  it("rejects a command from the plain contract.ts / fleet-contract.ts unions", () => {
    expect(isLearningCommand({ kind: "fleet.list" })).toBe(false);
    expect(isLearningEvent({ kind: "fleet.error", message: "x", at: 0 })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// decodeLearningCommand — adversarial matrix
// ---------------------------------------------------------------------------

describe("decodeLearningCommand — adversarial matrix", () => {
  it("throws 'bad command: empty line' on empty/whitespace input", () => {
    expect(() => decodeLearningCommand("")).toThrow("bad command: empty line");
    expect(() => decodeLearningCommand("   \n")).toThrow("bad command: empty line");
  });

  it("throws 'bad command: invalid JSON' on malformed JSON", () => {
    expect(() => decodeLearningCommand("not json {{{")).toThrow("bad command: invalid JSON");
    expect(() => decodeLearningCommand("{unterminated")).toThrow("bad command: invalid JSON");
  });

  it("throws 'bad command: missing kind' on a non-object payload", () => {
    expect(() => decodeLearningCommand("42")).toThrow("bad command: missing kind");
    expect(() => decodeLearningCommand('"learning.get"')).toThrow("bad command: missing kind");
    expect(() => decodeLearningCommand("null")).toThrow("bad command: missing kind");
    expect(() => decodeLearningCommand("[]")).toThrow("bad command: missing kind");
    expect(() => decodeLearningCommand("true")).toThrow("bad command: missing kind");
  });

  it("throws 'bad command: missing kind' when kind is absent or non-string", () => {
    expect(() => decodeLearningCommand(JSON.stringify({}))).toThrow("bad command: missing kind");
    expect(() => decodeLearningCommand(JSON.stringify({ kind: 5 }))).toThrow("bad command: missing kind");
  });

  it('throws \'bad command: unknown kind "..."\' for an unrecognized/smuggled kind', () => {
    expect(() => decodeLearningCommand(JSON.stringify({ kind: "learning.bogus" }))).toThrow(
      'bad command: unknown kind "learning.bogus"'
    );
    // Extra-kind smuggling: a kind lifted from an entirely different wire
    // contract must still be rejected here — learning-contract.ts is
    // standalone and does not recognize fleet-contract.ts kinds.
    expect(() => decodeLearningCommand(JSON.stringify({ kind: "fleet.list" }))).toThrow(
      'bad command: unknown kind "fleet.list"'
    );
    expect(() => decodeLearningCommand(JSON.stringify({ kind: "runtime.start" }))).toThrow(
      'bad command: unknown kind "runtime.start"'
    );
  });

  it("resists a prototype-pollution-shaped payload: decodes safely and pollutes nothing", () => {
    const raw = '{"kind":"learning.get","__proto__":{"polluted":true}}';
    const cmd = decodeLearningCommand(raw);
    // `JSON.parse` treats "__proto__" as an ordinary own data property (per
    // ES2019+), never as prototype assignment — the decoded command is still
    // structurally a valid `{ kind: "learning.get" }`, and no *actual*
    // prototype anywhere in the process is touched.
    expect(cmd.kind).toBe("learning.get");
    expect(isLearningCommand(cmd)).toBe(true);
    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("resists a constructor/prototype-shaped payload without throwing an unrelated error", () => {
    const raw = '{"kind":"learning.get","constructor":{"prototype":{"polluted2":true}}}';
    expect(() => decodeLearningCommand(raw)).not.toThrow();
    expect((Object.prototype as Record<string, unknown>).polluted2).toBeUndefined();
  });

  it("round-trips through encode -> decode with a trailing newline", () => {
    const line = JSON.stringify({ kind: "learning.get" }) + "\n";
    expect(decodeLearningCommand(line)).toEqual({ kind: "learning.get" });
  });
});

// ===========================================================================
// learning-service.ts — projectLearningStatus
// ===========================================================================

describe("projectLearningStatus", () => {
  it("projects counts through unaltered", () => {
    const s = swarmLearningStatus();
    const view = projectLearningStatus(s, { source: "live", savedAt: null, at: 100 });
    expect(view.counts).toEqual(s.counts);
    expect(view.counts).not.toBe(s.counts); // must not alias the engine's own object
  });

  it("a zero-pull arm yields null meanReward and null ucb, never the engine's stored 0", () => {
    const s = swarmLearningStatus();
    const view = projectLearningStatus(s, { source: "live", savedAt: null, at: 1 });
    const cloudA = view.arms.find((a) => a.name === "cloud-a");
    expect(cloudA).toBeDefined();
    expect(cloudA?.pulls).toBe(0);
    expect(cloudA?.meanReward).toBeNull();
    expect(cloudA?.ucb).toBeNull();
  });

  it("a pulled arm passes meanReward/ucb through unaltered", () => {
    const s = swarmLearningStatus();
    const view = projectLearningStatus(s, { source: "live", savedAt: null, at: 1 });
    const dockerArm = view.arms.find((a) => a.name === "local-docker");
    expect(dockerArm).toEqual({ name: "local-docker", pulls: 4, verified: 3, meanReward: 0.62, ucb: 0.91 });
  });

  it("sorts arms by name regardless of Record key insertion order", () => {
    const s = swarmLearningStatus({
      arms: {
        zeta: { pulls: 1, verified: 1, totalElapsedMs: 1, totalUsd: 1, meanReward: 1, ucb: 1 },
        alpha: { pulls: 1, verified: 1, totalElapsedMs: 1, totalUsd: 1, meanReward: 1, ucb: 1 },
        mid: { pulls: 1, verified: 1, totalElapsedMs: 1, totalUsd: 1, meanReward: 1, ucb: 1 },
      },
    });
    const view = projectLearningStatus(s, { source: "live", savedAt: null, at: 1 });
    expect(view.arms.map((a) => a.name)).toEqual(["alpha", "mid", "zeta"]);
  });

  it("extracts elapsedMsNote/usdNote verbatim from recent[].detail", () => {
    const s = swarmLearningStatus({
      recent: [
        { type: "recorded", at: 1, detail: { elapsedMsNote: "note-a" } },
        { type: "recorded", at: 2, detail: { usdNote: "note-b" } },
        { type: "recorded", at: 3, detail: { elapsedMsNote: "note-c", usdNote: "note-d" } },
        { type: "skipped", at: 4 }, // no detail at all — contributes nothing
        { type: "skipped", at: 5, detail: { unrelated: "ignored" } },
      ],
    });
    const view = projectLearningStatus(s, { source: "live", savedAt: null, at: 1 });
    expect(view.recentNotes).toEqual(["note-a", "note-b", "note-c", "note-d"]);
  });

  it("caps recentNotes at 20, keeping the newest last (oldest dropped first)", () => {
    const recent = Array.from({ length: 25 }, (_, i) => ({
      type: "recorded" as const,
      at: i,
      detail: { elapsedMsNote: `note-${i}` },
    }));
    const s = swarmLearningStatus({ recent });
    const view = projectLearningStatus(s, { source: "live", savedAt: null, at: 1 });
    expect(view.recentNotes).toHaveLength(20);
    expect(view.recentNotes[0]).toBe("note-5");
    expect(view.recentNotes[19]).toBe("note-24");
  });

  it("threads meta.source/savedAt/at through exactly", () => {
    const s = swarmLearningStatus();
    const live = projectLearningStatus(s, { source: "live", savedAt: null, at: 42 });
    expect(live.source).toBe("live");
    expect(live.savedAt).toBeNull();
    expect(live.at).toBe(42);

    const snap = projectLearningStatus(s, { source: "snapshot", savedAt: 7, at: 42 });
    expect(snap.source).toBe("snapshot");
    expect(snap.savedAt).toBe(7);
  });

  it("passes attached through unaltered", () => {
    const attached = projectLearningStatus(swarmLearningStatus({ attached: true }), {
      source: "live",
      savedAt: null,
      at: 1,
    });
    const detached = projectLearningStatus(swarmLearningStatus({ attached: false }), {
      source: "live",
      savedAt: null,
      at: 1,
    });
    expect(attached.attached).toBe(true);
    expect(detached.attached).toBe(false);
  });

  it("handles an empty arms record and empty recent list honestly", () => {
    const s = swarmLearningStatus({ arms: {}, recent: [] });
    const view = projectLearningStatus(s, { source: "live", savedAt: null, at: 1 });
    expect(view.arms).toEqual([]);
    expect(view.recentNotes).toEqual([]);
  });

  it("every produced LearningStatusView passes isLearningStatusView", () => {
    const s = swarmLearningStatus();
    const view = projectLearningStatus(s, { source: "snapshot", savedAt: 5, at: 1 });
    expect(isLearningStatusView(view)).toBe(true);
  });
});

// ===========================================================================
// LearningService
// ===========================================================================

describe("LearningService", () => {
  function fakeSource(status: SwarmLearningStatus): LearningStatusSource {
    return { status: () => status };
  }

  it("emits learning.error 'no learning status available' when neither source nor loadPersisted is configured", async () => {
    const svc = new LearningService({ now: () => 1 });
    const emit = vi.fn();
    await svc.handle({ kind: "learning.get" }, emit);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith({ kind: "learning.error", message: "no learning status available", at: 1 });
  });

  it("prefers a live source over loadPersisted when both are configured", async () => {
    const liveStatus = swarmLearningStatus({ attached: true });
    const persistedLoader: PersistedStatusLoader = vi.fn(async () => ({
      at: 10,
      status: swarmLearningStatus({ attached: false }),
    }));
    const svc = new LearningService({ source: fakeSource(liveStatus), loadPersisted: persistedLoader, now: () => 5 });
    const emit = vi.fn();
    await svc.handle({ kind: "learning.get" }, emit);

    expect(persistedLoader).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledTimes(1);
    const [event] = emit.mock.calls[0] as [LearningEvent];
    expect(event.kind).toBe("learning.status");
    if (event.kind === "learning.status") {
      expect(event.status.source).toBe("live");
      expect(event.status.savedAt).toBeNull();
      expect(event.status.attached).toBe(true);
    }
  });

  it("falls back to loadPersisted when no live source is configured, tagging source: snapshot with the record's savedAt", async () => {
    const persisted = { at: 12345, status: swarmLearningStatus() };
    const svc = new LearningService({ loadPersisted: async () => persisted, now: () => 999 });
    const emit = vi.fn();
    await svc.handle({ kind: "learning.get" }, emit);

    expect(emit).toHaveBeenCalledTimes(1);
    const [event] = emit.mock.calls[0] as [LearningEvent];
    expect(event.kind).toBe("learning.status");
    if (event.kind === "learning.status") {
      expect(event.status.source).toBe("snapshot");
      expect(event.status.savedAt).toBe(12345);
      expect(event.status.at).toBe(999);
    }
  });

  it("emits 'no learning status available' when loadPersisted resolves undefined (nothing ever saved)", async () => {
    const svc = new LearningService({ loadPersisted: async () => undefined, now: () => 1 });
    const emit = vi.fn();
    await svc.handle({ kind: "learning.get" }, emit);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith({ kind: "learning.error", message: "no learning status available", at: 1 });
  });

  it("a throwing source emits learning.error with the error message and never rejects", async () => {
    const source: LearningStatusSource = {
      status: () => {
        throw new Error("bandit exploded");
      },
    };
    const svc = new LearningService({ source, now: () => 3 });
    const emit = vi.fn();
    await expect(svc.handle({ kind: "learning.get" }, emit)).resolves.toBeUndefined();
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith({ kind: "learning.error", message: "bandit exploded", at: 3 });
  });

  it("a throwing loadPersisted (rejected promise) emits learning.error and never rejects handle()", async () => {
    const svc = new LearningService({
      loadPersisted: async () => {
        throw new Error("disk offline");
      },
      now: () => 7,
    });
    const emit = vi.fn();
    await expect(svc.handle({ kind: "learning.get" }, emit)).resolves.toBeUndefined();
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith({ kind: "learning.error", message: "disk offline", at: 7 });
  });

  it("a non-Error throw is stringified into the error message", async () => {
    const source: LearningStatusSource = {
      status: () => {
        // eslint-disable-next-line @typescript-eslint/no-throw-literal
        throw "raw string failure";
      },
    };
    const svc = new LearningService({ source, now: () => 1 });
    const emit = vi.fn();
    await svc.handle({ kind: "learning.get" }, emit);
    expect(emit).toHaveBeenCalledWith({ kind: "learning.error", message: "raw string failure", at: 1 });
  });

  it("calls emit exactly once per handle() across every branch", async () => {
    const branches: Array<() => LearningService> = [
      () => new LearningService({}),
      () => new LearningService({ source: fakeSource(swarmLearningStatus()) }),
      () => new LearningService({ loadPersisted: async () => ({ at: 1, status: swarmLearningStatus() }) }),
      () => new LearningService({ loadPersisted: async () => undefined }),
      () =>
        new LearningService({
          source: {
            status: () => {
              throw new Error("x");
            },
          },
        }),
    ];
    for (const build of branches) {
      const svc = build();
      const emit = vi.fn();
      await svc.handle({ kind: "learning.get" }, emit);
      expect(emit).toHaveBeenCalledTimes(1);
    }
  });

  it("default now() is a real clock (produces increasing timestamps close to Date.now())", async () => {
    const svc = new LearningService({});
    const emit = vi.fn();
    const before = Date.now();
    await svc.handle({ kind: "learning.get" }, emit);
    const after = Date.now();
    const [event] = emit.mock.calls[0] as [LearningEvent];
    expect(event.kind).toBe("learning.error");
    if (event.kind === "learning.error") {
      expect(event.at).toBeGreaterThanOrEqual(before);
      expect(event.at).toBeLessThanOrEqual(after);
    }
  });
});

// ===========================================================================
// learning-card.ts
// ===========================================================================

describe("initialLearningState", () => {
  it("starts with no status and no error", () => {
    expect(initialLearningState()).toEqual({ status: null, error: null });
  });
});

describe("applyLearningEvent", () => {
  it("learning.status replaces status wholesale and clears any prior error", () => {
    const prior: LearningCardState = deepFreeze({ status: null, error: "stale error" });
    const event: LearningEvent = deepFreeze({ kind: "learning.status", status: statusView() });
    const next = applyLearningEvent(prior, event);
    expect(next.status).toEqual(statusView());
    expect(next.error).toBeNull();
  });

  it("learning.error sets the error while retaining the last-known status", () => {
    const prior: LearningCardState = deepFreeze({ status: statusView(), error: null });
    const event: LearningEvent = deepFreeze({ kind: "learning.error", message: "boom", at: 1 });
    const next = applyLearningEvent(prior, event);
    expect(next.error).toBe("boom");
    expect(next.status).toEqual(statusView());
  });

  it("never mutates a deep-frozen input state or event, and always returns a new object", () => {
    const prior: LearningCardState = deepFreeze({ status: statusView(), error: null });
    const statusEvent: LearningEvent = deepFreeze({ kind: "learning.status", status: statusView({ at: 2 }) });
    expect(() => applyLearningEvent(prior, statusEvent)).not.toThrow();
    const next = applyLearningEvent(prior, statusEvent);
    expect(next).not.toBe(prior);
    expect(prior.status).toEqual(statusView()); // original untouched

    const errorEvent: LearningEvent = deepFreeze({ kind: "learning.error", message: "x", at: 1 });
    expect(() => applyLearningEvent(prior, errorEvent)).not.toThrow();
    const afterError = applyLearningEvent(prior, errorEvent);
    expect(afterError).not.toBe(prior);
    expect(prior.error).toBeNull();
  });
});

describe("formatReward", () => {
  it("renders '—' for null", () => {
    expect(formatReward(null)).toBe("—");
  });

  it("renders '—' for NaN/Infinity (never a fabricated number)", () => {
    expect(formatReward(Number.NaN)).toBe("—");
    expect(formatReward(Number.POSITIVE_INFINITY)).toBe("—");
  });

  it("renders a real reward to 2 decimal places", () => {
    expect(formatReward(0.734)).toBe("0.73");
    expect(formatReward(0)).toBe("0.00");
    expect(formatReward(1)).toBe("1.00");
  });
});

describe("renderArmsTable — never-pulled honesty", () => {
  it("renders the literal text 'never pulled' for a zero-pull arm instead of a fabricated 0.00", () => {
    const html = renderArmsTable([armView({ name: "cloud-a", pulls: 0, meanReward: null, ucb: null })]);
    expect(html).toContain("never pulled");
    expect(html).not.toMatch(/0\.00/);
  });

  it("renders formatted numbers for a pulled arm, not 'never pulled'", () => {
    const html = renderArmsTable([armView({ name: "local-docker", pulls: 4, meanReward: 0.62, ucb: 0.91 })]);
    expect(html).not.toContain("never pulled");
    expect(html).toContain("0.62");
    expect(html).toContain("0.91");
  });

  it("renders an explicit empty state for zero arms, never a blank table", () => {
    const html = renderArmsTable([]);
    expect(html).not.toContain("<table");
    expect(html).toContain("learning-arms--empty");
  });
});

describe("renderNotes — empty state", () => {
  it("renders an explicit empty state for zero notes", () => {
    const html = renderNotes([]);
    expect(html).toContain("learning-notes--empty");
    expect(html).not.toContain("<ul");
  });

  it("renders a list item per note", () => {
    const html = renderNotes(["note-1", "note-2"]);
    expect((html.match(/learning-notes__item/g) ?? []).length).toBe(2);
  });
});

describe("renderLearningCard — empty / error / full states", () => {
  it("renders an honest 'No learning data yet' panel with no status and no error", () => {
    const html = renderLearningCard(initialLearningState());
    expect(html).toContain("No learning data yet");
    expect(html).not.toContain("<table");
  });

  it("renders the error banner alone when there is an error but no status yet", () => {
    const html = renderLearningCard({ status: null, error: "sidecar not attached" });
    expect(html).toContain("learning-error");
    expect(html).toContain("sidecar not attached");
    expect(html).not.toContain("No learning data yet");
  });

  it("renders the full card (counts + arms + notes) once a status is present", () => {
    const html = renderLearningCard({ status: statusView(), error: null });
    expect(html).toContain("learning-counts");
    expect(html).toContain("<table");
    expect(html).toContain("learning-notes");
    expect(html).not.toContain("learning-error");
  });

  it("retains the last-known status and shows the error banner when both are present", () => {
    const html = renderLearningCard({ status: statusView(), error: "learning.get failed" });
    expect(html).toContain("learning-error");
    expect(html).toContain("learning.get failed");
    expect(html).toContain("<table"); // last-known data still rendered
  });

  it("never mistakes a snapshot for live: renders the snapshot badge and saved-at time", () => {
    const html = renderLearningCard({ status: statusView({ source: "snapshot", savedAt: 1_700_000_000_000 }), error: null });
    expect(html).toContain("learning-badge--snapshot");
    expect(html).toContain(">snapshot<");
    expect(html).toContain("learning-card__saved-at");
  });

  it("renders the live badge with no saved-at note for a live status", () => {
    const html = renderLearningCard({ status: statusView({ source: "live", savedAt: null }), error: null });
    expect(html).toContain("learning-badge--live");
    expect(html).toContain(">live<");
    expect(html).not.toContain("learning-card__saved-at");
  });

  it("renders attached/detached badges honestly", () => {
    const attached = renderLearningCard({ status: statusView({ attached: true }), error: null });
    expect(attached).toContain("learning-badge--attached");
    const detached = renderLearningCard({ status: statusView({ attached: false }), error: null });
    expect(detached).toContain("learning-badge--detached");
  });
});

// ---------------------------------------------------------------------------
// XSS resistance
// ---------------------------------------------------------------------------

describe("renderLearningCard — XSS resistance", () => {
  it("escapes a hostile arm name (image-onerror payload)", () => {
    const evilArm = armView({ name: '<img src=x onerror=alert(1)>' });
    const html = renderLearningCard({ status: statusView({ arms: [evilArm] }), error: null });
    expect(html).not.toContain("<img src=x onerror=alert(1)>");
    expect(html).not.toMatch(/<img[^>]*onerror/);
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("escapes a hostile note (script-close-tag payload)", () => {
    const evilNote = "</div><script>alert(1)</script>";
    const html = renderLearningCard({ status: statusView({ recentNotes: [evilNote] }), error: null });
    expect(html).not.toContain("</div><script>");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;/div&gt;&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("escapes a hostile error message", () => {
    const evilMessage = '<script>alert("x")</script>\'quoted\'';
    const html = renderLearningCard({ status: null, error: evilMessage });
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&quot;x&quot;");
    expect(html).toContain("&#39;quoted&#39;");
  });

  it("escapes a hostile note inside renderNotes directly", () => {
    const html = renderNotes(["</div><script>alert(1)</script>"]);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("escapes a hostile arm name inside renderArmsTable directly, including the data attribute", () => {
    const evilName = '"><img src=x onerror=alert(1)>';
    const html = renderArmsTable([armView({ name: evilName })]);
    expect(html).not.toMatch(/<img[^>]*onerror/);
    expect(html).not.toMatch(/data-arm-name="[^"]*<img/);
  });
});

// ---------------------------------------------------------------------------
// CSS coverage: every class emitted by renderLearningCard exists in the
// stylesheet, and the stylesheet introduces no raw hex colors.
// ---------------------------------------------------------------------------

describe("learning-card.css coverage", () => {
  const css = readFileSync(CSS_PATH, "utf8");

  it("is real, non-empty CSS", () => {
    expect(css).toContain("{");
    expect(css).toContain("}");
    expect(css.trim().length).toBeGreaterThan(0);
  });

  it("introduces no raw hex colors outside tokens.css — every color must be a var(--...) reference", () => {
    // Strip comments first so a hex-looking example inside a /* ... */ note
    // (there are none today, but this keeps the check honest) can't produce
    // a false failure.
    const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(withoutComments).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  it("every class name emitted by renderLearningCard across all states has a matching selector", () => {
    const htmls = [
      renderLearningCard(initialLearningState()),
      renderLearningCard({ status: null, error: "boom" }),
      renderLearningCard({ status: statusView(), error: null }),
      renderLearningCard({ status: statusView({ source: "snapshot", savedAt: 1 }), error: "still failing" }),
      renderLearningCard({ status: statusView({ arms: [armView({ pulls: 0, meanReward: null, ucb: null })] }), error: null }),
      renderLearningCard({ status: statusView({ arms: [] }), error: null }),
      renderLearningCard({ status: statusView({ recentNotes: [] }), error: null }),
    ];

    const classNames = new Set<string>();
    for (const html of htmls) {
      for (const match of html.matchAll(/class="([^"]*)"/g)) {
        for (const cls of match[1].split(/\s+/).filter(Boolean)) {
          classNames.add(cls);
        }
      }
    }

    // Sanity: we actually collected a meaningful number of distinct classes.
    expect(classNames.size).toBeGreaterThan(10);

    for (const cls of classNames) {
      const escaped = cls.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const selectorRe = new RegExp(`\\.${escaped}\\b`);
      expect(css, `expected learning-card.css to define a selector for .${cls}`).toMatch(selectorRe);
    }
  });
});
