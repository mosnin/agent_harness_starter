import { describe, it, expect } from "vitest";
import {
  encodeFleetCommand,
  decodeFleetCommand,
  encodeFleetEvent,
  decodeFleetEvent,
  isFleetCommand,
  isFleetEvent,
  isBackendView,
  isFleetWorkerView,
  FLEET_COMMAND_KINDS,
  FLEET_EVENT_KINDS,
  type FleetCommand,
  type FleetEvent,
  type BackendView,
  type FleetWorkerView,
} from "../ipc/fleet-contract";

const backend: BackendView = {
  name: "docker",
  kind: "container",
  capabilities: ["docker", "container"],
  locality: "local",
  supportsHibernate: true,
  available: true,
  cost: { perRunningHourUsd: 0, perHibernatedHourUsd: 0, perProvisionUsd: 0, source: "configured" },
  telemetry: {
    provisions: 3,
    failures: 1,
    provisionLatencyEmaMs: 420.5,
    runningMs: 60_000,
    hibernatedMs: 5_000,
    accruedUsd: 0.12,
  },
};

const worker: FleetWorkerView = {
  workerId: "w-1",
  backend: "docker",
  nativeId: "docker-7",
  state: "running",
  startedAt: 1_700_000_000_000,
  idleMs: 4_200,
};

// ---------------------------------------------------------------------------
// Round trips
// ---------------------------------------------------------------------------

describe("FleetCommand round-trip", () => {
  const commands: FleetCommand[] = [
    { kind: "fleet.list" },
    { kind: "fleet.probe" },
    { kind: "fleet.hibernate", workerId: "w-1" },
    { kind: "fleet.wake", workerId: "w-1" },
    { kind: "fleet.terminate", workerId: "w-1" },
  ];

  it.each(commands)("round-trips %j", (cmd) => {
    const decoded = decodeFleetCommand(encodeFleetCommand(cmd));
    expect(decoded).toEqual(cmd);
  });

  it("encodes with a trailing newline", () => {
    const line = encodeFleetCommand({ kind: "fleet.list" });
    expect(line.endsWith("\n")).toBe(true);
    expect(line).toBe('{"kind":"fleet.list"}\n');
  });

  it("every command kind has a round-trip fixture (no kind left untested)", () => {
    expect(new Set(commands.map((c) => c.kind))).toEqual(new Set(FLEET_COMMAND_KINDS));
    expect(commands.length).toBe(FLEET_COMMAND_KINDS.length);
  });
});

describe("FleetEvent round-trip", () => {
  const events: FleetEvent[] = [
    { kind: "fleet.snapshot", backends: [backend], workers: [worker], at: 1_700_000_000_000 },
    { kind: "fleet.worker.upsert", worker },
    { kind: "fleet.error", message: "backend unreachable", workerId: "w-1", at: 1_700_000_000_000 },
  ];

  it.each(events)("round-trips %j", (evt) => {
    const decoded = decodeFleetEvent(encodeFleetEvent(evt));
    expect(decoded).toEqual(evt);
  });

  it("round-trips fleet.error without the optional workerId", () => {
    const evt: FleetEvent = { kind: "fleet.error", message: "no such worker", at: 5 };
    expect(decodeFleetEvent(encodeFleetEvent(evt))).toEqual(evt);
  });

  it("round-trips an empty fleet.snapshot", () => {
    const evt: FleetEvent = { kind: "fleet.snapshot", backends: [], workers: [], at: 0 };
    expect(decodeFleetEvent(encodeFleetEvent(evt))).toEqual(evt);
  });

  it("every event kind has a round-trip fixture (no kind left untested)", () => {
    expect(new Set(events.map((e) => e.kind))).toEqual(new Set(FLEET_EVENT_KINDS));
    expect(events.length).toBe(FLEET_EVENT_KINDS.length);
  });
});

// ---------------------------------------------------------------------------
// Kind tuples exactly match the unions
// ---------------------------------------------------------------------------

describe("kind tuples exactly match their unions", () => {
  it("FLEET_COMMAND_KINDS has no duplicates and matches the FleetCommand union", () => {
    expect(new Set(FLEET_COMMAND_KINDS).size).toBe(FLEET_COMMAND_KINDS.length);
    expect([...FLEET_COMMAND_KINDS].sort()).toEqual(
      ["fleet.list", "fleet.probe", "fleet.hibernate", "fleet.wake", "fleet.terminate"].sort()
    );
  });

  it("FLEET_EVENT_KINDS has no duplicates and matches the FleetEvent union", () => {
    expect(new Set(FLEET_EVENT_KINDS).size).toBe(FLEET_EVENT_KINDS.length);
    expect([...FLEET_EVENT_KINDS].sort()).toEqual(
      ["fleet.snapshot", "fleet.worker.upsert", "fleet.error"].sort()
    );
  });

  // Compile-time coverage assertion: this switch has no default branch that
  // does anything other than funnel into `never`. If a kind is ever added to
  // `FleetCommand` without a case here, `cmd` narrows to something other than
  // `never` in the default branch and this file fails to type-check.
  function assertNeverCommand(x: never): string {
    throw new Error(`uncovered FleetCommand kind: ${JSON.stringify(x)}`);
  }
  function classifyCommand(cmd: FleetCommand): string {
    switch (cmd.kind) {
      case "fleet.list":
        return "list";
      case "fleet.probe":
        return "probe";
      case "fleet.hibernate":
        return "hibernate";
      case "fleet.wake":
        return "wake";
      case "fleet.terminate":
        return "terminate";
      default:
        return assertNeverCommand(cmd);
    }
  }

  function assertNeverEvent(x: never): string {
    throw new Error(`uncovered FleetEvent kind: ${JSON.stringify(x)}`);
  }
  function classifyEvent(evt: FleetEvent): string {
    switch (evt.kind) {
      case "fleet.snapshot":
        return "snapshot";
      case "fleet.worker.upsert":
        return "worker.upsert";
      case "fleet.error":
        return "error";
      default:
        return assertNeverEvent(evt);
    }
  }

  it("exhaustive command switch covers every real command kind at runtime", () => {
    for (const kind of FLEET_COMMAND_KINDS) {
      const cmd = { kind, workerId: "w-1" } as FleetCommand;
      expect(() => classifyCommand(cmd)).not.toThrow();
    }
  });

  it("exhaustive event switch covers every real event kind at runtime", () => {
    const fixtures: Record<(typeof FLEET_EVENT_KINDS)[number], FleetEvent> = {
      "fleet.snapshot": { kind: "fleet.snapshot", backends: [], workers: [], at: 0 },
      "fleet.worker.upsert": { kind: "fleet.worker.upsert", worker },
      "fleet.error": { kind: "fleet.error", message: "x", at: 0 },
    };
    for (const kind of FLEET_EVENT_KINDS) {
      expect(() => classifyEvent(fixtures[kind])).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// isBackendView — field by field
// ---------------------------------------------------------------------------

describe("isBackendView", () => {
  it("accepts a valid view, including available: null", () => {
    expect(isBackendView(backend)).toBe(true);
    expect(isBackendView({ ...backend, available: null })).toBe(true);
  });

  it("rejects non-objects", () => {
    expect(isBackendView(null)).toBe(false);
    expect(isBackendView(undefined)).toBe(false);
    expect(isBackendView("docker")).toBe(false);
    expect(isBackendView(42)).toBe(false);
    expect(isBackendView([backend])).toBe(false);
  });

  it("rejects a missing or mistyped name", () => {
    const { name, ...rest } = backend;
    expect(isBackendView(rest)).toBe(false);
    expect(isBackendView({ ...backend, name: 7 })).toBe(false);
  });

  it("rejects a missing or mistyped kind", () => {
    const { kind, ...rest } = backend;
    expect(isBackendView(rest)).toBe(false);
    expect(isBackendView({ ...backend, kind: null })).toBe(false);
  });

  it("rejects a missing or mistyped capabilities", () => {
    const { capabilities, ...rest } = backend;
    expect(isBackendView(rest)).toBe(false);
    expect(isBackendView({ ...backend, capabilities: "docker" })).toBe(false);
    expect(isBackendView({ ...backend, capabilities: [1, 2] })).toBe(false);
  });

  it("rejects a missing or invalid locality", () => {
    const { locality, ...rest } = backend;
    expect(isBackendView(rest)).toBe(false);
    expect(isBackendView({ ...backend, locality: "cloud" })).toBe(false);
  });

  it("rejects a missing or mistyped supportsHibernate", () => {
    const { supportsHibernate, ...rest } = backend;
    expect(isBackendView(rest)).toBe(false);
    expect(isBackendView({ ...backend, supportsHibernate: "yes" })).toBe(false);
  });

  it("rejects a missing or mistyped available (must be boolean or null)", () => {
    const { available, ...rest } = backend;
    expect(isBackendView(rest)).toBe(false);
    expect(isBackendView({ ...backend, available: "true" })).toBe(false);
    expect(isBackendView({ ...backend, available: 1 })).toBe(false);
  });

  it("rejects a missing or invalid cost", () => {
    const { cost, ...rest } = backend;
    expect(isBackendView(rest)).toBe(false);
    expect(isBackendView({ ...backend, cost: { ...backend.cost, perRunningHourUsd: "0" } })).toBe(false);
    expect(isBackendView({ ...backend, cost: { ...backend.cost, perHibernatedHourUsd: undefined } })).toBe(
      false
    );
    expect(isBackendView({ ...backend, cost: { ...backend.cost, perProvisionUsd: NaN } })).toBe(false);
    expect(isBackendView({ ...backend, cost: { ...backend.cost, source: "measured" } })).toBe(false);
  });

  it("rejects a missing or invalid telemetry", () => {
    const { telemetry, ...rest } = backend;
    expect(isBackendView(rest)).toBe(false);
    expect(isBackendView({ ...backend, telemetry: { ...backend.telemetry, provisions: "3" } })).toBe(false);
    expect(isBackendView({ ...backend, telemetry: { ...backend.telemetry, failures: undefined } })).toBe(
      false
    );
    expect(
      isBackendView({ ...backend, telemetry: { ...backend.telemetry, provisionLatencyEmaMs: "fast" } })
    ).toBe(false);
    expect(isBackendView({ ...backend, telemetry: { ...backend.telemetry, runningMs: -Infinity } })).toBe(
      false
    );
    expect(isBackendView({ ...backend, telemetry: { ...backend.telemetry, hibernatedMs: null } })).toBe(
      false
    );
    expect(isBackendView({ ...backend, telemetry: { ...backend.telemetry, accruedUsd: "0.12" } })).toBe(
      false
    );
  });

  it("accepts provisionLatencyEmaMs: null (no samples yet)", () => {
    expect(
      isBackendView({ ...backend, telemetry: { ...backend.telemetry, provisionLatencyEmaMs: null } })
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isFleetWorkerView — field by field
// ---------------------------------------------------------------------------

describe("isFleetWorkerView", () => {
  it("accepts a valid worker view for every lifecycle state", () => {
    const states: FleetWorkerView["state"][] = [
      "provisioning",
      "running",
      "hibernating",
      "hibernated",
      "waking",
      "failed",
      "stopped",
    ];
    for (const state of states) {
      expect(isFleetWorkerView({ ...worker, state })).toBe(true);
    }
  });

  it("rejects non-objects", () => {
    expect(isFleetWorkerView(null)).toBe(false);
    expect(isFleetWorkerView("w-1")).toBe(false);
    expect(isFleetWorkerView([worker])).toBe(false);
  });

  it("rejects a missing or mistyped workerId", () => {
    const { workerId, ...rest } = worker;
    expect(isFleetWorkerView(rest)).toBe(false);
    expect(isFleetWorkerView({ ...worker, workerId: 1 })).toBe(false);
  });

  it("rejects a missing or mistyped backend", () => {
    const { backend: b, ...rest } = worker;
    expect(isFleetWorkerView(rest)).toBe(false);
    expect(isFleetWorkerView({ ...worker, backend: null })).toBe(false);
  });

  it("rejects a missing or mistyped nativeId", () => {
    const { nativeId, ...rest } = worker;
    expect(isFleetWorkerView(rest)).toBe(false);
    expect(isFleetWorkerView({ ...worker, nativeId: 7 })).toBe(false);
  });

  it("rejects a missing or unrecognized state", () => {
    const { state, ...rest } = worker;
    expect(isFleetWorkerView(rest)).toBe(false);
    expect(isFleetWorkerView({ ...worker, state: "sleeping" })).toBe(false);
    expect(isFleetWorkerView({ ...worker, state: "RUNNING" })).toBe(false);
  });

  it("rejects a missing or mistyped startedAt", () => {
    const { startedAt, ...rest } = worker;
    expect(isFleetWorkerView(rest)).toBe(false);
    expect(isFleetWorkerView({ ...worker, startedAt: "now" })).toBe(false);
    expect(isFleetWorkerView({ ...worker, startedAt: NaN })).toBe(false);
  });

  it("rejects a missing or mistyped idleMs", () => {
    const { idleMs, ...rest } = worker;
    expect(isFleetWorkerView(rest)).toBe(false);
    expect(isFleetWorkerView({ ...worker, idleMs: "500" })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isFleetCommand
// ---------------------------------------------------------------------------

describe("isFleetCommand", () => {
  it("accepts every valid command shape", () => {
    expect(isFleetCommand({ kind: "fleet.list" })).toBe(true);
    expect(isFleetCommand({ kind: "fleet.probe" })).toBe(true);
    expect(isFleetCommand({ kind: "fleet.hibernate", workerId: "w-1" })).toBe(true);
    expect(isFleetCommand({ kind: "fleet.wake", workerId: "w-1" })).toBe(true);
    expect(isFleetCommand({ kind: "fleet.terminate", workerId: "w-1" })).toBe(true);
  });

  it("rejects non-objects and missing/unknown kind", () => {
    expect(isFleetCommand(null)).toBe(false);
    expect(isFleetCommand(undefined)).toBe(false);
    expect(isFleetCommand("fleet.list")).toBe(false);
    expect(isFleetCommand([])).toBe(false);
    expect(isFleetCommand({})).toBe(false);
    expect(isFleetCommand({ kind: "fleet.bogus" })).toBe(false);
    expect(isFleetCommand({ kind: 42 })).toBe(false);
  });

  it("rejects fleet.hibernate/wake/terminate missing or mistyping workerId", () => {
    expect(isFleetCommand({ kind: "fleet.hibernate" })).toBe(false);
    expect(isFleetCommand({ kind: "fleet.hibernate", workerId: 1 })).toBe(false);
    expect(isFleetCommand({ kind: "fleet.wake" })).toBe(false);
    expect(isFleetCommand({ kind: "fleet.wake", workerId: null })).toBe(false);
    expect(isFleetCommand({ kind: "fleet.terminate" })).toBe(false);
    expect(isFleetCommand({ kind: "fleet.terminate", workerId: {} })).toBe(false);
  });

  it("rejects a command from the plain contract.ts union", () => {
    expect(isFleetCommand({ kind: "worker.kill", workerId: "w-1" })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isFleetEvent
// ---------------------------------------------------------------------------

describe("isFleetEvent", () => {
  it("accepts every valid event shape", () => {
    expect(isFleetEvent({ kind: "fleet.snapshot", backends: [], workers: [], at: 0 })).toBe(true);
    expect(isFleetEvent({ kind: "fleet.snapshot", backends: [backend], workers: [worker], at: 1 })).toBe(
      true
    );
    expect(isFleetEvent({ kind: "fleet.worker.upsert", worker })).toBe(true);
    expect(isFleetEvent({ kind: "fleet.error", message: "x", at: 0 })).toBe(true);
    expect(isFleetEvent({ kind: "fleet.error", message: "x", workerId: "w-1", at: 0 })).toBe(true);
  });

  it("rejects non-objects and missing/unknown kind", () => {
    expect(isFleetEvent(null)).toBe(false);
    expect(isFleetEvent(3)).toBe(false);
    expect(isFleetEvent([])).toBe(false);
    expect(isFleetEvent({ kind: "fleet.bogus" })).toBe(false);
  });

  it("rejects fleet.snapshot with a missing/mistyped backends, workers, or at", () => {
    expect(isFleetEvent({ kind: "fleet.snapshot", workers: [], at: 0 })).toBe(false);
    expect(isFleetEvent({ kind: "fleet.snapshot", backends: [], at: 0 })).toBe(false);
    expect(isFleetEvent({ kind: "fleet.snapshot", backends: [], workers: [] })).toBe(false);
    expect(isFleetEvent({ kind: "fleet.snapshot", backends: "none", workers: [], at: 0 })).toBe(false);
    expect(isFleetEvent({ kind: "fleet.snapshot", backends: [], workers: "none", at: 0 })).toBe(false);
    expect(isFleetEvent({ kind: "fleet.snapshot", backends: [], workers: [], at: "now" })).toBe(false);
  });

  it("rejects fleet.snapshot whose backends/workers array contains an invalid element", () => {
    expect(
      isFleetEvent({ kind: "fleet.snapshot", backends: [{ ...backend, name: undefined }], workers: [], at: 0 })
    ).toBe(false);
    expect(
      isFleetEvent({
        kind: "fleet.snapshot",
        backends: [],
        workers: [{ ...worker, state: "asleep" }],
        at: 0,
      })
    ).toBe(false);
  });

  it("rejects fleet.worker.upsert with a missing/invalid worker", () => {
    expect(isFleetEvent({ kind: "fleet.worker.upsert" })).toBe(false);
    expect(isFleetEvent({ kind: "fleet.worker.upsert", worker: { workerId: "w-1" } })).toBe(false);
  });

  it("rejects fleet.error with a missing/mistyped message, workerId, or at", () => {
    expect(isFleetEvent({ kind: "fleet.error", at: 0 })).toBe(false);
    expect(isFleetEvent({ kind: "fleet.error", message: 1, at: 0 })).toBe(false);
    expect(isFleetEvent({ kind: "fleet.error", message: "x" })).toBe(false);
    expect(isFleetEvent({ kind: "fleet.error", message: "x", at: "now" })).toBe(false);
    expect(isFleetEvent({ kind: "fleet.error", message: "x", workerId: 5, at: 0 })).toBe(false);
  });

  it("rejects an event from the plain contract.ts union", () => {
    expect(isFleetEvent({ kind: "log", line: "hi", at: 1 })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Codec error handling
// ---------------------------------------------------------------------------

describe("decodeFleetCommand error handling", () => {
  it("throws 'bad command: empty line' on empty input", () => {
    expect(() => decodeFleetCommand("")).toThrow("bad command: empty line");
    expect(() => decodeFleetCommand("   \n")).toThrow("bad command: empty line");
  });

  it("throws 'bad command: invalid JSON' on malformed JSON", () => {
    expect(() => decodeFleetCommand("not json {{{")).toThrow("bad command: invalid JSON");
  });

  it("throws 'bad command: missing kind' on a non-object payload", () => {
    expect(() => decodeFleetCommand("42")).toThrow("bad command: missing kind");
    expect(() => decodeFleetCommand('"fleet.list"')).toThrow("bad command: missing kind");
    expect(() => decodeFleetCommand("null")).toThrow("bad command: missing kind");
    expect(() => decodeFleetCommand("[]")).toThrow("bad command: missing kind");
  });

  it("throws 'bad command: missing kind' when kind is absent or non-string", () => {
    expect(() => decodeFleetCommand(JSON.stringify({ workerId: "w-1" }))).toThrow(
      "bad command: missing kind"
    );
    expect(() => decodeFleetCommand(JSON.stringify({ kind: 5 }))).toThrow("bad command: missing kind");
  });

  it('throws \'bad command: unknown kind "..."\' for an unrecognized kind', () => {
    expect(() => decodeFleetCommand(JSON.stringify({ kind: "fleet.bogus" }))).toThrow(
      'bad command: unknown kind "fleet.bogus"'
    );
  });

  it("throws 'bad command: missing or invalid fields...' when a required field is missing", () => {
    expect(() => decodeFleetCommand(JSON.stringify({ kind: "fleet.hibernate" }))).toThrow(
      'bad command: missing or invalid fields for kind "fleet.hibernate"'
    );
    expect(() => decodeFleetCommand(JSON.stringify({ kind: "fleet.wake", workerId: 5 }))).toThrow(
      'bad command: missing or invalid fields for kind "fleet.wake"'
    );
  });

  it("round-trips through encode -> decode with a trailing newline", () => {
    const line = encodeFleetCommand({ kind: "fleet.terminate", workerId: "w-9" });
    expect(decodeFleetCommand(line)).toEqual({ kind: "fleet.terminate", workerId: "w-9" });
  });
});

describe("decodeFleetEvent error handling", () => {
  it("throws 'bad event: empty line' on empty input", () => {
    expect(() => decodeFleetEvent("")).toThrow("bad event: empty line");
  });

  it("throws 'bad event: invalid JSON' on malformed JSON", () => {
    expect(() => decodeFleetEvent("{not valid")).toThrow("bad event: invalid JSON");
  });

  it("throws 'bad event: missing kind' on a non-object payload", () => {
    expect(() => decodeFleetEvent("true")).toThrow("bad event: missing kind");
    expect(() => decodeFleetEvent("[1,2,3]")).toThrow("bad event: missing kind");
  });

  it('throws \'bad event: unknown kind "..."\' for an unrecognized kind', () => {
    expect(() => decodeFleetEvent(JSON.stringify({ kind: "fleet.bogus" }))).toThrow(
      'bad event: unknown kind "fleet.bogus"'
    );
  });

  it("throws 'bad event: missing or invalid fields...' when a required field is missing", () => {
    expect(() => decodeFleetEvent(JSON.stringify({ kind: "fleet.error" }))).toThrow(
      'bad event: missing or invalid fields for kind "fleet.error"'
    );
    expect(() =>
      decodeFleetEvent(JSON.stringify({ kind: "fleet.snapshot", backends: [], workers: [] }))
    ).toThrow('bad event: missing or invalid fields for kind "fleet.snapshot"');
  });

  it("round-trips through encode -> decode with a trailing newline", () => {
    const line = encodeFleetEvent({ kind: "fleet.error", message: "boom", at: 42 });
    expect(decodeFleetEvent(line)).toEqual({ kind: "fleet.error", message: "boom", at: 42 });
  });
});
