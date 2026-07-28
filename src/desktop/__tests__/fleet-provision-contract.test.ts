import { describe, it, expect } from "vitest";
import {
  parseFleetProvisionCommand,
  parseFleetProvisionEvent,
  serializeFleetProvisionCommand,
  serializeFleetProvisionEvent,
  isFleetProvisionCommand,
  isFleetProvisionEvent,
  FLEET_PROVISION_COMMAND_KINDS,
  FLEET_PROVISION_EVENT_KINDS,
  type FleetProvisionCommand,
  type FleetProvisionEvent,
} from "../ipc/fleet-provision-contract";
import type { FleetWorkerView } from "../ipc/fleet-contract";

const worker: FleetWorkerView = {
  workerId: "w-1",
  backend: "docker",
  nativeId: "docker-7",
  state: "provisioning",
  startedAt: 1_700_000_000_000,
  idleMs: 0,
};

const provisionCommand: FleetProvisionCommand = {
  kind: "fleet.provision",
  requestId: "req-1",
  spec: { workerId: "w-1", capabilities: ["gpu", "linux"], image: "ghcr.io/org/img:tag" },
  requirements: {
    capabilities: ["gpu"],
    requireHibernate: true,
    maxRunningHourUsd: 0.5,
    exclude: ["flaky"],
  },
};

const minimalCommand: FleetProvisionCommand = {
  kind: "fleet.provision",
  requestId: "req-2",
  spec: { workerId: "w-2", capabilities: [] },
};

const provisionedEvent: FleetProvisionEvent = {
  kind: "fleet.provisioned",
  requestId: "req-1",
  worker,
  backend: "docker",
  routing: { source: "bandit", backend: "docker", reason: "lowest cost" },
  at: 1_700_000_000_000,
};

const provisionedEventNoRouting: FleetProvisionEvent = {
  kind: "fleet.provisioned",
  requestId: "req-3",
  worker,
  backend: "local",
  at: 5,
};

const provisionErrorEvent: FleetProvisionEvent = {
  kind: "fleet.provision.error",
  requestId: "req-1",
  message: "no eligible backend",
  at: 1_700_000_000_001,
};

const restoredEvent: FleetProvisionEvent = {
  kind: "fleet.restored",
  workers: [worker],
  adoptedIds: ["w-1"],
  dropped: [{ workerId: "w-9", reason: "handle store entry unreadable" }],
  at: 1_700_000_000_002,
};

const restoredEventEmpty: FleetProvisionEvent = {
  kind: "fleet.restored",
  workers: [],
  adoptedIds: [],
  dropped: [],
  at: 0,
};

// ---------------------------------------------------------------------------
// Round trips
// ---------------------------------------------------------------------------

describe("FleetProvisionCommand round-trip", () => {
  const commands = [provisionCommand, minimalCommand];

  it.each(commands)("round-trips %j", (cmd) => {
    const decoded = parseFleetProvisionCommand(serializeFleetProvisionCommand(cmd));
    expect(decoded).toEqual(cmd);
  });

  it("serializes with a trailing newline", () => {
    const line = serializeFleetProvisionCommand(minimalCommand);
    expect(line.endsWith("\n")).toBe(true);
    expect(JSON.parse(line.trim())).toEqual(minimalCommand);
  });

  it("every command kind has a round-trip fixture (no kind left untested)", () => {
    expect(new Set(commands.map((c) => c.kind))).toEqual(new Set(FLEET_PROVISION_COMMAND_KINDS));
  });
});

describe("FleetProvisionEvent round-trip", () => {
  const events = [provisionedEvent, provisionedEventNoRouting, provisionErrorEvent, restoredEvent, restoredEventEmpty];

  it.each(events)("round-trips %j", (evt) => {
    const decoded = parseFleetProvisionEvent(serializeFleetProvisionEvent(evt));
    expect(decoded).toEqual(evt);
  });

  it("every event kind has a round-trip fixture (no kind left untested)", () => {
    expect(new Set(events.map((e) => e.kind))).toEqual(new Set(FLEET_PROVISION_EVENT_KINDS));
  });

  it("round-trips fleet.provisioned without the optional routing field", () => {
    const decoded = parseFleetProvisionEvent(serializeFleetProvisionEvent(provisionedEventNoRouting));
    expect(decoded).toEqual(provisionedEventNoRouting);
    expect(decoded.kind === "fleet.provisioned" && "routing" in decoded).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Kind tuples exactly match the unions (compile-time + runtime)
// ---------------------------------------------------------------------------

describe("kind tuples exactly match their unions", () => {
  it("FLEET_PROVISION_COMMAND_KINDS has no duplicates and matches the union", () => {
    expect(new Set(FLEET_PROVISION_COMMAND_KINDS).size).toBe(FLEET_PROVISION_COMMAND_KINDS.length);
    expect([...FLEET_PROVISION_COMMAND_KINDS].sort()).toEqual(["fleet.provision"].sort());
  });

  it("FLEET_PROVISION_EVENT_KINDS has no duplicates and matches the union", () => {
    expect(new Set(FLEET_PROVISION_EVENT_KINDS).size).toBe(FLEET_PROVISION_EVENT_KINDS.length);
    expect([...FLEET_PROVISION_EVENT_KINDS].sort()).toEqual(
      ["fleet.provisioned", "fleet.provision.error", "fleet.restored"].sort()
    );
  });

  // Compile-time coverage assertion: if a kind is ever added to
  // FleetProvisionCommand/FleetProvisionEvent without a case here, `cmd`/`evt`
  // narrows to something other than `never` in the default branch and this
  // file fails to type-check — the actual break-the-build mechanism the
  // comprehensiveness bar asks for, exercised at runtime too below.
  /** Narrows the DISCRIMINANT, not the whole object: exhausting a literal
  * union member leaves `cmd.kind` as `never`, whereas the object itself
  * is not narrowed away — so the previous form never actually enforced
  * the coverage it advertised. */
function assertNeverCommand(x: never): string {
    throw new Error(`uncovered FleetProvisionCommand kind: ${JSON.stringify(x)}`);
  }
  function classifyCommand(cmd: FleetProvisionCommand): string {
    switch (cmd.kind) {
      case "fleet.provision":
        return "provision";
      default:
        return assertNeverCommand(cmd.kind);
    }
  }

  function assertNeverEvent(x: never): string {
    throw new Error(`uncovered FleetProvisionEvent kind: ${JSON.stringify(x)}`);
  }
  function classifyEvent(evt: FleetProvisionEvent): string {
    switch (evt.kind) {
      case "fleet.provisioned":
        return "provisioned";
      case "fleet.provision.error":
        return "error";
      case "fleet.restored":
        return "restored";
      default:
        return assertNeverEvent(evt);
    }
  }

  it("exhaustive command switch covers every real command kind at runtime", () => {
    for (const kind of FLEET_PROVISION_COMMAND_KINDS) {
      expect(() => classifyCommand({ ...minimalCommand, kind })).not.toThrow();
    }
  });

  it("exhaustive event switch covers every real event kind at runtime", () => {
    const fixtures: Record<(typeof FLEET_PROVISION_EVENT_KINDS)[number], FleetProvisionEvent> = {
      "fleet.provisioned": provisionedEventNoRouting,
      "fleet.provision.error": provisionErrorEvent,
      "fleet.restored": restoredEventEmpty,
    };
    for (const kind of FLEET_PROVISION_EVENT_KINDS) {
      expect(() => classifyEvent(fixtures[kind])).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// isFleetProvisionCommand — field by field
// ---------------------------------------------------------------------------

describe("isFleetProvisionCommand", () => {
  it("accepts a full command and a minimal one (no requirements, no image)", () => {
    expect(isFleetProvisionCommand(provisionCommand)).toBe(true);
    expect(isFleetProvisionCommand(minimalCommand)).toBe(true);
  });

  it("rejects non-objects", () => {
    expect(isFleetProvisionCommand(null)).toBe(false);
    expect(isFleetProvisionCommand(undefined)).toBe(false);
    expect(isFleetProvisionCommand("fleet.provision")).toBe(false);
    expect(isFleetProvisionCommand(42)).toBe(false);
    expect(isFleetProvisionCommand([provisionCommand])).toBe(false);
  });

  it("rejects a mistyped or missing kind", () => {
    expect(isFleetProvisionCommand({ ...provisionCommand, kind: "fleet.list" })).toBe(false);
    const { kind, ...rest } = provisionCommand;
    expect(isFleetProvisionCommand(rest)).toBe(false);
  });

  it("rejects a non-string requestId, including an empty string", () => {
    expect(isFleetProvisionCommand({ ...provisionCommand, requestId: 5 })).toBe(false);
    expect(isFleetProvisionCommand({ ...provisionCommand, requestId: null })).toBe(false);
    expect(isFleetProvisionCommand({ ...provisionCommand, requestId: "" })).toBe(false);
    const { requestId, ...rest } = provisionCommand;
    expect(isFleetProvisionCommand(rest)).toBe(false);
  });

  it("rejects a missing spec, a non-object spec, and an empty workerId", () => {
    const { spec, ...rest } = provisionCommand;
    expect(isFleetProvisionCommand(rest)).toBe(false);
    expect(isFleetProvisionCommand({ ...provisionCommand, spec: "w-1" })).toBe(false);
    expect(isFleetProvisionCommand({ ...provisionCommand, spec: { ...spec, workerId: "" } })).toBe(false);
    expect(isFleetProvisionCommand({ ...provisionCommand, spec: { ...spec, workerId: 5 } })).toBe(false);
  });

  it("rejects a non-array capabilities field on spec", () => {
    expect(
      isFleetProvisionCommand({ ...provisionCommand, spec: { ...provisionCommand.spec, capabilities: "gpu" } })
    ).toBe(false);
    expect(
      isFleetProvisionCommand({
        ...provisionCommand,
        spec: { ...provisionCommand.spec, capabilities: [1, 2] },
      })
    ).toBe(false);
    expect(
      isFleetProvisionCommand({ ...provisionCommand, spec: { ...provisionCommand.spec, capabilities: null } })
    ).toBe(false);
  });

  it("rejects a mistyped optional image", () => {
    expect(isFleetProvisionCommand({ ...provisionCommand, spec: { ...provisionCommand.spec, image: 5 } })).toBe(
      false
    );
  });

  it("accepts an absent requirements block and rejects a malformed one", () => {
    expect(isFleetProvisionCommand(minimalCommand)).toBe(true);
    expect(isFleetProvisionCommand({ ...provisionCommand, requirements: "yes" })).toBe(false);
    expect(
      isFleetProvisionCommand({
        ...provisionCommand,
        requirements: { ...provisionCommand.requirements, requireHibernate: "yes" },
      })
    ).toBe(false);
    expect(
      isFleetProvisionCommand({
        ...provisionCommand,
        requirements: { ...provisionCommand.requirements, maxRunningHourUsd: "cheap" },
      })
    ).toBe(false);
    expect(
      isFleetProvisionCommand({
        ...provisionCommand,
        requirements: { ...provisionCommand.requirements, exclude: [1, 2] },
      })
    ).toBe(false);
    expect(
      isFleetProvisionCommand({
        ...provisionCommand,
        requirements: { ...provisionCommand.requirements, capabilities: "gpu" },
      })
    ).toBe(false);
  });

  it("rejects non-finite numbers anywhere a number is expected", () => {
    expect(
      isFleetProvisionCommand({
        ...provisionCommand,
        requirements: { ...provisionCommand.requirements, maxRunningHourUsd: Number.NaN },
      })
    ).toBe(false);
    expect(
      isFleetProvisionCommand({
        ...provisionCommand,
        requirements: { ...provisionCommand.requirements, maxRunningHourUsd: Number.POSITIVE_INFINITY },
      })
    ).toBe(false);
  });

  it("accepts requirements with every field individually optional/present", () => {
    expect(isFleetProvisionCommand({ ...minimalCommand, requirements: {} })).toBe(true);
    expect(isFleetProvisionCommand({ ...minimalCommand, requirements: { requireHibernate: false } })).toBe(true);
    expect(isFleetProvisionCommand({ ...minimalCommand, requirements: { maxRunningHourUsd: 0 } })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isFleetProvisionEvent — field by field
// ---------------------------------------------------------------------------

describe("isFleetProvisionEvent", () => {
  it("accepts every valid event shape", () => {
    expect(isFleetProvisionEvent(provisionedEvent)).toBe(true);
    expect(isFleetProvisionEvent(provisionedEventNoRouting)).toBe(true);
    expect(isFleetProvisionEvent(provisionErrorEvent)).toBe(true);
    expect(isFleetProvisionEvent(restoredEvent)).toBe(true);
    expect(isFleetProvisionEvent(restoredEventEmpty)).toBe(true);
  });

  it("rejects non-objects and a missing/unknown kind", () => {
    expect(isFleetProvisionEvent(null)).toBe(false);
    expect(isFleetProvisionEvent(3)).toBe(false);
    expect(isFleetProvisionEvent([])).toBe(false);
    expect(isFleetProvisionEvent({ kind: "fleet.bogus" })).toBe(false);
    expect(isFleetProvisionEvent({ kind: "fleet.snapshot", backends: [], workers: [], at: 0 })).toBe(false);
  });

  it("rejects fleet.provisioned with a missing/invalid requestId, worker, backend, or at", () => {
    const { requestId, ...rest1 } = provisionedEventNoRouting;
    expect(isFleetProvisionEvent(rest1)).toBe(false);
    expect(isFleetProvisionEvent({ ...provisionedEventNoRouting, requestId: "" })).toBe(false);
    expect(isFleetProvisionEvent({ ...provisionedEventNoRouting, worker: { workerId: "w-1" } })).toBe(false);
    expect(isFleetProvisionEvent({ ...provisionedEventNoRouting, backend: 5 })).toBe(false);
    expect(isFleetProvisionEvent({ ...provisionedEventNoRouting, at: "now" })).toBe(false);
  });

  it("rejects fleet.provisioned with a malformed routing block, accepts a well-formed one", () => {
    expect(isFleetProvisionEvent({ ...provisionedEventNoRouting, routing: "bandit" })).toBe(false);
    expect(isFleetProvisionEvent({ ...provisionedEventNoRouting, routing: { backend: "docker" } })).toBe(false);
    expect(isFleetProvisionEvent({ ...provisionedEventNoRouting, routing: { source: "bandit" } })).toBe(true);
  });

  it("rejects fleet.provision.error with a missing/mistyped requestId, message, or at", () => {
    expect(isFleetProvisionEvent({ kind: "fleet.provision.error", message: "x", at: 0 })).toBe(false);
    expect(isFleetProvisionEvent({ ...provisionErrorEvent, requestId: "" })).toBe(false);
    expect(isFleetProvisionEvent({ ...provisionErrorEvent, message: 1 })).toBe(false);
    expect(isFleetProvisionEvent({ ...provisionErrorEvent, at: "now" })).toBe(false);
  });

  it("rejects fleet.restored with a missing/invalid workers, adoptedIds, dropped, or at", () => {
    expect(isFleetProvisionEvent({ ...restoredEvent, workers: "none" })).toBe(false);
    expect(isFleetProvisionEvent({ ...restoredEvent, workers: [{ workerId: "w-1" }] })).toBe(false);
    expect(isFleetProvisionEvent({ ...restoredEvent, adoptedIds: [1, 2] })).toBe(false);
    expect(isFleetProvisionEvent({ ...restoredEvent, dropped: [{ workerId: "w-9" }] })).toBe(false);
    expect(isFleetProvisionEvent({ ...restoredEvent, dropped: [{ reason: "x" }] })).toBe(false);
    expect(isFleetProvisionEvent({ ...restoredEvent, dropped: [{ workerId: "", reason: "x" }] })).toBe(false);
    expect(isFleetProvisionEvent({ ...restoredEvent, at: undefined })).toBe(false);
  });

  it("accepts an empty fleet.restored (nothing to restore, distinct from no restore at all)", () => {
    expect(isFleetProvisionEvent(restoredEventEmpty)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Codec error handling (house error phrasing)
// ---------------------------------------------------------------------------

describe("parseFleetProvisionCommand error handling", () => {
  it("throws 'bad command: empty line' on empty input", () => {
    expect(() => parseFleetProvisionCommand("")).toThrow("bad command: empty line");
    expect(() => parseFleetProvisionCommand("   \n")).toThrow("bad command: empty line");
  });

  it("throws 'bad command: invalid JSON' on malformed/truncated JSON", () => {
    expect(() => parseFleetProvisionCommand("not json {{{")).toThrow("bad command: invalid JSON");
    // Truncated mid-object — a realistic partial-write-on-the-wire fuzz case.
    const truncated = JSON.stringify(provisionCommand).slice(0, 20);
    expect(() => parseFleetProvisionCommand(truncated)).toThrow("bad command: invalid JSON");
  });

  it("throws 'bad command: missing kind' on a non-object payload or absent/non-string kind", () => {
    expect(() => parseFleetProvisionCommand("42")).toThrow("bad command: missing kind");
    expect(() => parseFleetProvisionCommand("null")).toThrow("bad command: missing kind");
    expect(() => parseFleetProvisionCommand("[]")).toThrow("bad command: missing kind");
    expect(() => parseFleetProvisionCommand(JSON.stringify({ requestId: "r1" }))).toThrow(
      "bad command: missing kind"
    );
    expect(() => parseFleetProvisionCommand(JSON.stringify({ kind: 5 }))).toThrow("bad command: missing kind");
  });

  it('throws \'bad command: unknown kind "..."\' for a kind-swapped payload from the event union', () => {
    const swapped = { ...provisionedEventNoRouting, kind: "fleet.provisioned" };
    expect(() => parseFleetProvisionCommand(JSON.stringify(swapped))).toThrow(
      'bad command: unknown kind "fleet.provisioned"'
    );
    expect(() => parseFleetProvisionCommand(JSON.stringify({ kind: "fleet.bogus" }))).toThrow(
      'bad command: unknown kind "fleet.bogus"'
    );
  });

  it("throws 'bad command: missing or invalid fields...' when a required field is missing or invalid", () => {
    expect(() => parseFleetProvisionCommand(JSON.stringify({ kind: "fleet.provision" }))).toThrow(
      'bad command: missing or invalid fields for kind "fleet.provision"'
    );
    expect(() =>
      parseFleetProvisionCommand(JSON.stringify({ kind: "fleet.provision", requestId: "r1", spec: { workerId: "" } }))
    ).toThrow('bad command: missing or invalid fields for kind "fleet.provision"');
  });

  it("round-trips through parse -> serialize with a trailing newline", () => {
    const line = serializeFleetProvisionCommand(minimalCommand);
    expect(parseFleetProvisionCommand(line)).toEqual(minimalCommand);
  });
});

describe("parseFleetProvisionEvent error handling", () => {
  it("throws 'bad event: empty line' on empty input", () => {
    expect(() => parseFleetProvisionEvent("")).toThrow("bad event: empty line");
  });

  it("throws 'bad event: invalid JSON' on malformed/truncated JSON", () => {
    expect(() => parseFleetProvisionEvent("{not valid")).toThrow("bad event: invalid JSON");
    const truncated = JSON.stringify(restoredEvent).slice(0, 15);
    expect(() => parseFleetProvisionEvent(truncated)).toThrow("bad event: invalid JSON");
  });

  it("throws 'bad event: missing kind' on a non-object payload", () => {
    expect(() => parseFleetProvisionEvent("true")).toThrow("bad event: missing kind");
    expect(() => parseFleetProvisionEvent("[1,2,3]")).toThrow("bad event: missing kind");
  });

  it('throws \'bad event: unknown kind "..."\' for a kind-swapped payload from the command union', () => {
    const swapped = { ...minimalCommand, kind: "fleet.provision" }; // still a command kind, invalid as an event
    expect(() => parseFleetProvisionEvent(JSON.stringify(swapped))).toThrow(
      'bad event: unknown kind "fleet.provision"'
    );
  });

  it("throws 'bad event: missing or invalid fields...' when a required field is missing", () => {
    expect(() => parseFleetProvisionEvent(JSON.stringify({ kind: "fleet.provision.error" }))).toThrow(
      'bad event: missing or invalid fields for kind "fleet.provision.error"'
    );
    expect(() =>
      parseFleetProvisionEvent(JSON.stringify({ kind: "fleet.restored", workers: [], adoptedIds: [] }))
    ).toThrow('bad event: missing or invalid fields for kind "fleet.restored"');
  });

  it("round-trips through parse -> serialize with a trailing newline", () => {
    const line = serializeFleetProvisionEvent(provisionErrorEvent);
    expect(line.endsWith("\n")).toBe(true);
    expect(parseFleetProvisionEvent(line)).toEqual(provisionErrorEvent);
  });
});

// ---------------------------------------------------------------------------
// serialize* validate before writing
// ---------------------------------------------------------------------------

describe("serializeFleetProvisionCommand / serializeFleetProvisionEvent validate before writing", () => {
  it("throws instead of writing an invalid command to the wire", () => {
    const bogus = { kind: "fleet.provision", requestId: "", spec: { workerId: "w", capabilities: [] } };
    expect(() => serializeFleetProvisionCommand(bogus as unknown as FleetProvisionCommand)).toThrow(
      'bad command: missing or invalid fields for kind "fleet.provision"'
    );
  });

  it("throws instead of writing an invalid event to the wire", () => {
    const bogus = { kind: "fleet.provisioned", requestId: "r1" };
    expect(() => serializeFleetProvisionEvent(bogus as unknown as FleetProvisionEvent)).toThrow(
      'bad event: missing or invalid fields for kind "fleet.provisioned"'
    );
  });

  it("throws 'unknown kind' for a completely foreign kind at serialize time", () => {
    const bogus = { kind: "fleet.bogus" };
    expect(() => serializeFleetProvisionCommand(bogus as unknown as FleetProvisionCommand)).toThrow(
      'bad command: unknown kind "fleet.bogus"'
    );
    expect(() => serializeFleetProvisionEvent(bogus as unknown as FleetProvisionEvent)).toThrow(
      'bad event: unknown kind "fleet.bogus"'
    );
  });
});

// ---------------------------------------------------------------------------
// Fuzzing: prototype pollution, huge payloads, kind swaps
// ---------------------------------------------------------------------------

describe("fuzzing", () => {
  it("a __proto__ key inside spec never pollutes Object.prototype and the command is still rejected honestly", () => {
    const line = '{"kind":"fleet.provision","requestId":"r1","spec":{"__proto__":{"polluted":true},"workerId":"w1","capabilities":[]}}';
    // JSON.parse never triggers the [[Set]] prototype-pollution path — "__proto__"
    // becomes a normal own property, so this parses as a perfectly valid command.
    const decoded = parseFleetProvisionCommand(line);
    expect(decoded.spec.workerId).toBe("w1");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, "polluted")).toBe(false);
  });

  it("a top-level __proto__ key never pollutes Object.prototype", () => {
    const line = '{"__proto__":{"kind":"fleet.provision"},"kind":"fleet.provision","requestId":"r1","spec":{"workerId":"w1","capabilities":[]}}';
    expect(() => parseFleetProvisionCommand(line)).not.toThrow();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("rejects a ~1MB capabilities array (many short strings) with the house 'missing or invalid fields' phrasing", () => {
    const hugeCapabilities = Array.from({ length: 200_000 }, (_, i) => `cap-${i}`); // ~1.5MB of JSON
    const line = JSON.stringify({
      kind: "fleet.provision",
      requestId: "r1",
      spec: { workerId: "w1", capabilities: hugeCapabilities },
    });
    expect(line.length).toBeGreaterThan(1_000_000);
    expect(() => parseFleetProvisionCommand(line)).toThrow(
      'bad command: missing or invalid fields for kind "fleet.provision"'
    );
  });

  it("rejects a capabilities array with one absurdly long string", () => {
    const line = JSON.stringify({
      kind: "fleet.provision",
      requestId: "r1",
      spec: { workerId: "w1", capabilities: ["x".repeat(2_000_000)] },
    });
    expect(() => parseFleetProvisionCommand(line)).toThrow(
      'bad command: missing or invalid fields for kind "fleet.provision"'
    );
  });

  it("rejects an oversized requirements.exclude array the same way", () => {
    const line = JSON.stringify({
      kind: "fleet.provision",
      requestId: "r1",
      spec: { workerId: "w1", capabilities: [] },
      requirements: { exclude: Array.from({ length: 5_000 }, (_, i) => `backend-${i}`) },
    });
    expect(() => parseFleetProvisionCommand(line)).toThrow(
      'bad command: missing or invalid fields for kind "fleet.provision"'
    );
  });

  it("truncated JSON at every byte offset either throws invalid-JSON or (rarely, when the truncation happens to still be valid JSON) fails field validation — never returns a bogus success", () => {
    const full = JSON.stringify(provisionCommand);
    for (let cut = 1; cut < full.length; cut += 7) {
      const truncated = full.slice(0, cut);
      expect(() => parseFleetProvisionCommand(truncated)).toThrow(/^bad command: /);
    }
  });

  it("kind-swapped payload: a valid fleet.provisioned event's fields under a fleet.provision.error kind is rejected as invalid fields", () => {
    const swapped = { ...provisionedEventNoRouting, kind: "fleet.provision.error" };
    expect(() => parseFleetProvisionEvent(JSON.stringify(swapped))).toThrow(
      'bad event: missing or invalid fields for kind "fleet.provision.error"'
    );
  });

  it("parse(serialize(x)) is the identity for every command/event fixture, including edge-optional-field variants", () => {
    const commands = [provisionCommand, minimalCommand, { ...minimalCommand, requirements: {} }];
    for (const c of commands) {
      expect(parseFleetProvisionCommand(serializeFleetProvisionCommand(c))).toEqual(c);
    }
    const events = [provisionedEvent, provisionedEventNoRouting, provisionErrorEvent, restoredEvent, restoredEventEmpty];
    for (const e of events) {
      expect(parseFleetProvisionEvent(serializeFleetProvisionEvent(e))).toEqual(e);
    }
  });
});
