import { describe, it, expect } from "vitest";
import {
  encodeGatewayEvent,
  decodeGatewayCommand,
  isGatewayCommand,
  isGatewayEvent,
  isGatewayStatusView,
  isGatewayPairCodeView,
  isGatewayProbeView,
  GATEWAY_COMMAND_KINDS,
  GATEWAY_EVENT_KINDS,
  type GatewayCommand,
  type GatewayEvent,
  type GatewayStatusView,
  type GatewayPairCodeView,
  type GatewayProbeView,
} from "../ipc/gateway-contract";

const probe: GatewayProbeView = { platform: "telegram", mode: "real", detail: "via HADES_TELEGRAM_TOKEN" };
const offlineProbe: GatewayProbeView = { platform: "discord", mode: "offline", detail: "missing DISCORD_BOT_TOKEN" };

const status: GatewayStatusView = {
  running: true,
  startedAt: 1_700_000_000_000,
  platforms: [probe, offlineProbe],
  counters: { inbound: 12, outbound: 9, rateLimited: 1 },
  engine: { requested: "claude-sonnet", mode: "real", detail: "live API key present" },
  at: 1_700_000_001_000,
};

const pair: GatewayPairCodeView = {
  code: "AB12CD",
  level: "trusted",
  expiresAt: 1_700_000_600_000,
  at: 1_700_000_000_000,
};

// ---------------------------------------------------------------------------
// Round trips (via decodeGatewayCommand — encodeGatewayCommand is
// intentionally not part of the locked contract, matching
// learning-contract.ts's single-direction codec shape)
// ---------------------------------------------------------------------------

describe("GatewayCommand round-trip", () => {
  const commands: GatewayCommand[] = [
    { kind: "gateway.status.get" },
    { kind: "gateway.pair.issue", level: "trusted" },
  ];

  it.each(commands)("round-trips %j through JSON.stringify -> decodeGatewayCommand", (cmd) => {
    const decoded = decodeGatewayCommand(JSON.stringify(cmd));
    expect(decoded).toEqual(cmd);
  });

  it("round-trips gateway.pair.issue for the owner level too", () => {
    const cmd: GatewayCommand = { kind: "gateway.pair.issue", level: "owner" };
    expect(decodeGatewayCommand(JSON.stringify(cmd))).toEqual(cmd);
  });

  it("every command kind has a round-trip fixture (no kind left untested)", () => {
    expect(new Set(commands.map((c) => c.kind))).toEqual(new Set(GATEWAY_COMMAND_KINDS));
    expect(commands.length).toBe(GATEWAY_COMMAND_KINDS.length);
  });
});

describe("GatewayEvent encode", () => {
  const events: GatewayEvent[] = [
    { kind: "gateway.status", status },
    { kind: "gateway.paircode", pair },
    { kind: "gateway.error", message: "no gateway attached to this sidecar", at: 5 },
  ];

  it("encodes with a trailing newline and valid JSON matching the source event", () => {
    for (const evt of events) {
      const line = encodeGatewayEvent(evt);
      expect(line.endsWith("\n")).toBe(true);
      expect(JSON.parse(line.trimEnd())).toEqual(evt);
    }
  });

  it("encodes gateway.status.get's absence tersely", () => {
    const line = encodeGatewayEvent({ kind: "gateway.error", message: "x", at: 0 });
    expect(line).toBe('{"kind":"gateway.error","message":"x","at":0}\n');
  });

  it("every event kind has an encode fixture (no kind left untested)", () => {
    expect(new Set(events.map((e) => e.kind))).toEqual(new Set(GATEWAY_EVENT_KINDS));
    expect(events.length).toBe(GATEWAY_EVENT_KINDS.length);
  });

  it("round-trips a gateway.status event through encode -> JSON.parse -> isGatewayEvent", () => {
    const line = encodeGatewayEvent({ kind: "gateway.status", status });
    const parsed = JSON.parse(line.trimEnd());
    expect(isGatewayEvent(parsed)).toBe(true);
    expect(parsed).toEqual({ kind: "gateway.status", status });
  });

  it("round-trips an empty-platforms gateway.status event", () => {
    const emptyStatus: GatewayStatusView = {
      running: false,
      startedAt: null,
      platforms: [],
      counters: { inbound: 0, outbound: 0, rateLimited: 0 },
      engine: null,
      at: 0,
    };
    const line = encodeGatewayEvent({ kind: "gateway.status", status: emptyStatus });
    expect(JSON.parse(line.trimEnd())).toEqual({ kind: "gateway.status", status: emptyStatus });
  });
});

// ---------------------------------------------------------------------------
// Kind tuples exactly match the unions
// ---------------------------------------------------------------------------

describe("kind tuples exactly match their unions", () => {
  it("GATEWAY_COMMAND_KINDS has no duplicates and matches the GatewayCommand union", () => {
    expect(new Set(GATEWAY_COMMAND_KINDS).size).toBe(GATEWAY_COMMAND_KINDS.length);
    expect([...GATEWAY_COMMAND_KINDS].sort()).toEqual(["gateway.status.get", "gateway.pair.issue"].sort());
  });

  it("GATEWAY_EVENT_KINDS has no duplicates and matches the GatewayEvent union", () => {
    expect(new Set(GATEWAY_EVENT_KINDS).size).toBe(GATEWAY_EVENT_KINDS.length);
    expect([...GATEWAY_EVENT_KINDS].sort()).toEqual(
      ["gateway.status", "gateway.paircode", "gateway.error"].sort()
    );
  });

  // Compile-time coverage assertion: this switch has no default branch that
  // does anything other than funnel into `never`. If a kind is ever added to
  // `GatewayCommand` without a case here, `cmd` narrows to something other
  // than `never` in the default branch and this file fails to type-check.
  function assertNeverCommand(x: never): string {
    throw new Error(`uncovered GatewayCommand kind: ${JSON.stringify(x)}`);
  }
  function classifyCommand(cmd: GatewayCommand): string {
    switch (cmd.kind) {
      case "gateway.status.get":
        return "status.get";
      case "gateway.pair.issue":
        return "pair.issue";
      default:
        return assertNeverCommand(cmd);
    }
  }

  function assertNeverEvent(x: never): string {
    throw new Error(`uncovered GatewayEvent kind: ${JSON.stringify(x)}`);
  }
  function classifyEvent(evt: GatewayEvent): string {
    switch (evt.kind) {
      case "gateway.status":
        return "status";
      case "gateway.paircode":
        return "paircode";
      case "gateway.error":
        return "error";
      default:
        return assertNeverEvent(evt);
    }
  }

  it("exhaustive command switch covers every real command kind at runtime", () => {
    const fixtures: Record<(typeof GATEWAY_COMMAND_KINDS)[number], GatewayCommand> = {
      "gateway.status.get": { kind: "gateway.status.get" },
      "gateway.pair.issue": { kind: "gateway.pair.issue", level: "trusted" },
    };
    for (const kind of GATEWAY_COMMAND_KINDS) {
      expect(() => classifyCommand(fixtures[kind])).not.toThrow();
    }
  });

  it("exhaustive event switch covers every real event kind at runtime", () => {
    const fixtures: Record<(typeof GATEWAY_EVENT_KINDS)[number], GatewayEvent> = {
      "gateway.status": { kind: "gateway.status", status },
      "gateway.paircode": { kind: "gateway.paircode", pair },
      "gateway.error": { kind: "gateway.error", message: "x", at: 0 },
    };
    for (const kind of GATEWAY_EVENT_KINDS) {
      expect(() => classifyEvent(fixtures[kind])).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// isGatewayProbeView — field by field
// ---------------------------------------------------------------------------

describe("isGatewayProbeView", () => {
  it("accepts valid real and offline probes", () => {
    expect(isGatewayProbeView(probe)).toBe(true);
    expect(isGatewayProbeView(offlineProbe)).toBe(true);
  });

  it("rejects non-objects", () => {
    expect(isGatewayProbeView(null)).toBe(false);
    expect(isGatewayProbeView(undefined)).toBe(false);
    expect(isGatewayProbeView("telegram")).toBe(false);
    expect(isGatewayProbeView(42)).toBe(false);
    expect(isGatewayProbeView([probe])).toBe(false);
  });

  it("rejects a missing or mistyped platform", () => {
    const { platform, ...rest } = probe;
    expect(isGatewayProbeView(rest)).toBe(false);
    expect(isGatewayProbeView({ ...probe, platform: 7 })).toBe(false);
  });

  it("rejects an invalid mode (case-sensitive, closed set)", () => {
    expect(isGatewayProbeView({ ...probe, mode: "REAL" })).toBe(false);
    expect(isGatewayProbeView({ ...probe, mode: "mock" })).toBe(false);
    expect(isGatewayProbeView({ ...probe, mode: undefined })).toBe(false);
  });

  it("rejects a missing or mistyped detail", () => {
    const { detail, ...rest } = probe;
    expect(isGatewayProbeView(rest)).toBe(false);
    expect(isGatewayProbeView({ ...probe, detail: null })).toBe(false);
  });

  it("tolerates extra unknown fields", () => {
    expect(isGatewayProbeView({ ...probe, extra: "field" })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isGatewayStatusView — field by field, hostile-shape fuzzing
// ---------------------------------------------------------------------------

describe("isGatewayStatusView", () => {
  it("accepts a fully populated valid view", () => {
    expect(isGatewayStatusView(status)).toBe(true);
  });

  it("accepts startedAt: null and engine: null", () => {
    expect(isGatewayStatusView({ ...status, startedAt: null, engine: null })).toBe(true);
  });

  it("distinguishes null from undefined for startedAt (undefined rejected)", () => {
    expect(isGatewayStatusView({ ...status, startedAt: undefined })).toBe(false);
    const { startedAt, ...rest } = status;
    expect(isGatewayStatusView(rest)).toBe(false);
  });

  it("distinguishes null from undefined for engine (undefined rejected)", () => {
    expect(isGatewayStatusView({ ...status, engine: undefined })).toBe(false);
    const { engine, ...rest } = status;
    expect(isGatewayStatusView(rest)).toBe(false);
  });

  it("rejects non-objects", () => {
    expect(isGatewayStatusView(null)).toBe(false);
    expect(isGatewayStatusView(3)).toBe(false);
    expect(isGatewayStatusView([status])).toBe(false);
    expect(isGatewayStatusView("status")).toBe(false);
  });

  it("rejects a missing or mistyped running", () => {
    const { running, ...rest } = status;
    expect(isGatewayStatusView(rest)).toBe(false);
    expect(isGatewayStatusView({ ...status, running: "true" })).toBe(false);
    expect(isGatewayStatusView({ ...status, running: 1 })).toBe(false);
  });

  it("rejects a mistyped startedAt (must be finite number or null)", () => {
    expect(isGatewayStatusView({ ...status, startedAt: "now" })).toBe(false);
    expect(isGatewayStatusView({ ...status, startedAt: NaN })).toBe(false);
    expect(isGatewayStatusView({ ...status, startedAt: Infinity })).toBe(false);
    expect(isGatewayStatusView({ ...status, startedAt: -Infinity })).toBe(false);
  });

  it("rejects a missing or mistyped platforms array", () => {
    const { platforms, ...rest } = status;
    expect(isGatewayStatusView(rest)).toBe(false);
    expect(isGatewayStatusView({ ...status, platforms: "none" })).toBe(false);
    expect(isGatewayStatusView({ ...status, platforms: {} })).toBe(false);
  });

  it("rejects platforms containing a non-object element", () => {
    expect(isGatewayStatusView({ ...status, platforms: [probe, "telegram"] })).toBe(false);
    expect(isGatewayStatusView({ ...status, platforms: [probe, null] })).toBe(false);
    expect(isGatewayStatusView({ ...status, platforms: [probe, 42] })).toBe(false);
  });

  it("rejects platforms containing an element with an invalid mode", () => {
    expect(isGatewayStatusView({ ...status, platforms: [{ ...probe, mode: "REAL" }] })).toBe(false);
  });

  it("accepts an empty platforms array", () => {
    expect(isGatewayStatusView({ ...status, platforms: [] })).toBe(true);
  });

  it("rejects a missing or invalid counters", () => {
    const { counters, ...rest } = status;
    expect(isGatewayStatusView(rest)).toBe(false);
    expect(isGatewayStatusView({ ...status, counters: { ...status.counters, inbound: "12" } })).toBe(false);
    expect(isGatewayStatusView({ ...status, counters: { ...status.counters, outbound: undefined } })).toBe(
      false
    );
    expect(isGatewayStatusView({ ...status, counters: { ...status.counters, rateLimited: NaN } })).toBe(
      false
    );
    expect(isGatewayStatusView({ ...status, counters: { ...status.counters, inbound: Infinity } })).toBe(
      false
    );
  });

  it("rejects an engine with an invalid mode or missing field", () => {
    expect(isGatewayStatusView({ ...status, engine: { ...status.engine, mode: "MOCK" } })).toBe(false);
    expect(isGatewayStatusView({ ...status, engine: { ...status.engine, requested: undefined } })).toBe(
      false
    );
    expect(isGatewayStatusView({ ...status, engine: { ...status.engine, detail: 7 } })).toBe(false);
    expect(isGatewayStatusView({ ...status, engine: "real" })).toBe(false);
  });

  it("accepts engine: mode 'mock'", () => {
    expect(
      isGatewayStatusView({ ...status, engine: { requested: "local", mode: "mock", detail: "no API key" } })
    ).toBe(true);
  });

  it("rejects a missing or mistyped at", () => {
    const { at, ...rest } = status;
    expect(isGatewayStatusView(rest)).toBe(false);
    expect(isGatewayStatusView({ ...status, at: "now" })).toBe(false);
    expect(isGatewayStatusView({ ...status, at: NaN })).toBe(false);
  });

  it("tolerates extra unknown fields on the top-level view", () => {
    expect(isGatewayStatusView({ ...status, extra: "field" })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isGatewayPairCodeView — field by field
// ---------------------------------------------------------------------------

describe("isGatewayPairCodeView", () => {
  it("accepts a valid view for both trust levels", () => {
    expect(isGatewayPairCodeView(pair)).toBe(true);
    expect(isGatewayPairCodeView({ ...pair, level: "owner" })).toBe(true);
  });

  it("rejects non-objects", () => {
    expect(isGatewayPairCodeView(null)).toBe(false);
    expect(isGatewayPairCodeView("AB12CD")).toBe(false);
    expect(isGatewayPairCodeView([pair])).toBe(false);
  });

  it("rejects a missing or mistyped code", () => {
    const { code, ...rest } = pair;
    expect(isGatewayPairCodeView(rest)).toBe(false);
    expect(isGatewayPairCodeView({ ...pair, code: 123 })).toBe(false);
  });

  it("rejects an invalid level (closed set, case-sensitive)", () => {
    expect(isGatewayPairCodeView({ ...pair, level: "admin" })).toBe(false);
    expect(isGatewayPairCodeView({ ...pair, level: "TRUSTED" })).toBe(false);
    expect(isGatewayPairCodeView({ ...pair, level: "blocked" })).toBe(false);
    expect(isGatewayPairCodeView({ ...pair, level: undefined })).toBe(false);
  });

  it("rejects a missing or mistyped expiresAt", () => {
    const { expiresAt, ...rest } = pair;
    expect(isGatewayPairCodeView(rest)).toBe(false);
    expect(isGatewayPairCodeView({ ...pair, expiresAt: "soon" })).toBe(false);
    expect(isGatewayPairCodeView({ ...pair, expiresAt: NaN })).toBe(false);
    expect(isGatewayPairCodeView({ ...pair, expiresAt: Infinity })).toBe(false);
  });

  it("rejects a missing or mistyped at", () => {
    const { at, ...rest } = pair;
    expect(isGatewayPairCodeView(rest)).toBe(false);
    expect(isGatewayPairCodeView({ ...pair, at: "now" })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isGatewayCommand
// ---------------------------------------------------------------------------

describe("isGatewayCommand", () => {
  it("accepts every valid command shape", () => {
    expect(isGatewayCommand({ kind: "gateway.status.get" })).toBe(true);
    expect(isGatewayCommand({ kind: "gateway.pair.issue", level: "trusted" })).toBe(true);
    expect(isGatewayCommand({ kind: "gateway.pair.issue", level: "owner" })).toBe(true);
  });

  it("rejects non-objects and missing/unknown kind", () => {
    expect(isGatewayCommand(null)).toBe(false);
    expect(isGatewayCommand(undefined)).toBe(false);
    expect(isGatewayCommand("gateway.status.get")).toBe(false);
    expect(isGatewayCommand([])).toBe(false);
    expect(isGatewayCommand({})).toBe(false);
    expect(isGatewayCommand({ kind: "gateway.bogus" })).toBe(false);
    expect(isGatewayCommand({ kind: 42 })).toBe(false);
  });

  it("rejects gateway.pair.issue with a missing or illegal level", () => {
    expect(isGatewayCommand({ kind: "gateway.pair.issue" })).toBe(false);
    expect(isGatewayCommand({ kind: "gateway.pair.issue", level: "admin" })).toBe(false);
    expect(isGatewayCommand({ kind: "gateway.pair.issue", level: "TRUSTED" })).toBe(false);
    expect(isGatewayCommand({ kind: "gateway.pair.issue", level: "blocked" })).toBe(false);
    expect(isGatewayCommand({ kind: "gateway.pair.issue", level: 1 })).toBe(false);
    expect(isGatewayCommand({ kind: "gateway.pair.issue", level: null })).toBe(false);
  });

  it("rejects a command from the plain contract.ts / fleet-contract.ts unions", () => {
    expect(isGatewayCommand({ kind: "worker.kill", workerId: "w-1" })).toBe(false);
    expect(isGatewayCommand({ kind: "fleet.list" })).toBe(false);
  });

  it("tolerates extra unknown fields on gateway.status.get", () => {
    expect(isGatewayCommand({ kind: "gateway.status.get", extra: 1 })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isGatewayEvent
// ---------------------------------------------------------------------------

describe("isGatewayEvent", () => {
  it("accepts every valid event shape", () => {
    expect(isGatewayEvent({ kind: "gateway.status", status })).toBe(true);
    expect(isGatewayEvent({ kind: "gateway.paircode", pair })).toBe(true);
    expect(isGatewayEvent({ kind: "gateway.error", message: "x", at: 0 })).toBe(true);
  });

  it("rejects non-objects and missing/unknown kind", () => {
    expect(isGatewayEvent(null)).toBe(false);
    expect(isGatewayEvent(3)).toBe(false);
    expect(isGatewayEvent([])).toBe(false);
    expect(isGatewayEvent({ kind: "gateway.bogus" })).toBe(false);
  });

  it("rejects gateway.status with a missing or invalid status", () => {
    expect(isGatewayEvent({ kind: "gateway.status" })).toBe(false);
    expect(isGatewayEvent({ kind: "gateway.status", status: { ...status, running: "yes" } })).toBe(false);
    expect(isGatewayEvent({ kind: "gateway.status", status: null })).toBe(false);
  });

  it("rejects gateway.paircode with a missing or invalid pair", () => {
    expect(isGatewayEvent({ kind: "gateway.paircode" })).toBe(false);
    expect(isGatewayEvent({ kind: "gateway.paircode", pair: { ...pair, level: "admin" } })).toBe(false);
  });

  it("rejects gateway.error with a missing/mistyped message or at", () => {
    expect(isGatewayEvent({ kind: "gateway.error", at: 0 })).toBe(false);
    expect(isGatewayEvent({ kind: "gateway.error", message: 1, at: 0 })).toBe(false);
    expect(isGatewayEvent({ kind: "gateway.error", message: "x" })).toBe(false);
    expect(isGatewayEvent({ kind: "gateway.error", message: "x", at: "now" })).toBe(false);
  });

  it("rejects an event from the plain contract.ts / fleet-contract.ts unions", () => {
    expect(isGatewayEvent({ kind: "log", line: "hi", at: 1 })).toBe(false);
    expect(isGatewayEvent({ kind: "fleet.error", message: "x", at: 0 })).toBe(false);
  });

  it("never accepts a gateway.paircode payload as a gateway.status and vice versa", () => {
    expect(isGatewayEvent({ kind: "gateway.status", status: pair })).toBe(false);
    expect(isGatewayEvent({ kind: "gateway.paircode", pair: status })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Codec error handling — decodeGatewayCommand
// ---------------------------------------------------------------------------

describe("decodeGatewayCommand error handling", () => {
  it("throws 'bad command: empty line' on empty input", () => {
    expect(() => decodeGatewayCommand("")).toThrow("bad command: empty line");
    expect(() => decodeGatewayCommand("   \n")).toThrow("bad command: empty line");
    expect(() => decodeGatewayCommand("\t  \t")).toThrow("bad command: empty line");
  });

  it("throws 'bad command: invalid JSON' on malformed JSON", () => {
    expect(() => decodeGatewayCommand("not json {{{")).toThrow("bad command: invalid JSON");
    expect(() => decodeGatewayCommand("{kind: 'gateway.status.get'}")).toThrow("bad command: invalid JSON");
  });

  it("throws 'bad command: missing kind' on a non-object payload", () => {
    expect(() => decodeGatewayCommand("42")).toThrow("bad command: missing kind");
    expect(() => decodeGatewayCommand('"gateway.status.get"')).toThrow("bad command: missing kind");
    expect(() => decodeGatewayCommand("null")).toThrow("bad command: missing kind");
    expect(() => decodeGatewayCommand("[]")).toThrow("bad command: missing kind");
    expect(() => decodeGatewayCommand("true")).toThrow("bad command: missing kind");
  });

  it("throws 'bad command: missing kind' when kind is absent or non-string", () => {
    expect(() => decodeGatewayCommand(JSON.stringify({ level: "trusted" }))).toThrow(
      "bad command: missing kind"
    );
    expect(() => decodeGatewayCommand(JSON.stringify({ kind: 5 }))).toThrow("bad command: missing kind");
  });

  it('throws \'bad command: unknown kind "..."\' for an unrecognized kind', () => {
    expect(() => decodeGatewayCommand(JSON.stringify({ kind: "gateway.bogus" }))).toThrow(
      'bad command: unknown kind "gateway.bogus"'
    );
  });

  it('throws \'bad command: missing or invalid fields...\' for gateway.pair.issue missing level', () => {
    expect(() => decodeGatewayCommand(JSON.stringify({ kind: "gateway.pair.issue" }))).toThrow(
      'bad command: missing or invalid fields for kind "gateway.pair.issue"'
    );
  });

  it('throws \'bad command: missing or invalid fields...\' for gateway.pair.issue with an illegal level', () => {
    expect(() =>
      decodeGatewayCommand(JSON.stringify({ kind: "gateway.pair.issue", level: "admin" }))
    ).toThrow('bad command: missing or invalid fields for kind "gateway.pair.issue"');
    expect(() =>
      decodeGatewayCommand(JSON.stringify({ kind: "gateway.pair.issue", level: "TRUSTED" }))
    ).toThrow('bad command: missing or invalid fields for kind "gateway.pair.issue"');
    expect(() =>
      decodeGatewayCommand(JSON.stringify({ kind: "gateway.pair.issue", level: 1 }))
    ).toThrow('bad command: missing or invalid fields for kind "gateway.pair.issue"');
  });

  it("round-trips through JSON.stringify -> decode for gateway.status.get", () => {
    expect(decodeGatewayCommand(JSON.stringify({ kind: "gateway.status.get" }))).toEqual({
      kind: "gateway.status.get",
    });
  });

  it("trims surrounding whitespace/newlines before parsing", () => {
    const cmd = { kind: "gateway.pair.issue", level: "owner" };
    expect(decodeGatewayCommand(`  ${JSON.stringify(cmd)}  \n`)).toEqual(cmd);
  });
});
