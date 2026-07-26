import { describe, it, expect, vi } from "vitest";
import { GatewayService, type GatewayStatusSource, type PairingSource } from "../core/gateway-service";
import { isGatewayEvent, encodeGatewayEvent, decodeGatewayCommand } from "../ipc/gateway-contract";
import type { GatewayCommand, GatewayEvent } from "../ipc/gateway-contract";
import { GatewayProcess, type PlatformProbe } from "../../hades/gateway/process";
import { PairingGuard } from "../../hades/gateway/pairing";
import { InMemoryTrustStore } from "../../hades/gateway/trust-store";
import { InMemoryIdentityStore, IdentityLinker } from "../../hades/gateway/continuity";
import type { InboundMessage, OutboundReply } from "../../swarm-runtime/gateway/gateway";

const SENTINEL_STACK = "at Object.<anonymous> (/definitely/not/a/real/path.ts:999:1)";

async function collect(service: GatewayService, cmd: GatewayCommand): Promise<GatewayEvent[]> {
  const events: GatewayEvent[] = [];
  await service.handle(cmd, (e) => events.push(e));
  return events;
}

function noopHandler(): (msg: InboundMessage) => Promise<OutboundReply> {
  return async () => ({ text: "ok", accepted: true });
}

function makeRealGatewayProcess(now: () => number): GatewayProcess {
  const report: PlatformProbe[] = [
    { platform: "telegram", mode: "offline", detail: "missing HADES_TELEGRAM_TOKEN, TELEGRAM_BOT_TOKEN" },
    { platform: "discord", mode: "offline", detail: "missing HADES_DISCORD_TOKEN, DISCORD_BOT_TOKEN" },
  ];
  return new GatewayProcess({
    handler: noopHandler(),
    connectors: [],
    report,
    now,
    log: () => {},
  });
}

function makeRealPairingGuard(now: () => number): PairingGuard {
  const trust = new InMemoryTrustStore();
  const identities = new InMemoryIdentityStore();
  const linker = new IdentityLinker(identities, { now });
  return new PairingGuard({ trust, identities, linker, now });
}

// ---------------------------------------------------------------------------
// gateway.status.get — no source
// ---------------------------------------------------------------------------

describe("GatewayService.handle gateway.status.get with no source", () => {
  it("emits exactly one honest gateway.error, never a fabricated empty status", async () => {
    const service = new GatewayService({});
    const events = await collect(service, { kind: "gateway.status.get" });
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      kind: "gateway.error",
      message: "no gateway attached to this sidecar",
      at: expect.any(Number),
    });
  });
});

// ---------------------------------------------------------------------------
// gateway.status.get — real GatewayProcess
// ---------------------------------------------------------------------------

describe("GatewayService.handle gateway.status.get with a real GatewayProcess", () => {
  it("projects a not-yet-started process (startedAt: null, running: false)", async () => {
    let clock = 1_000;
    const now = () => clock;
    const gp = makeRealGatewayProcess(now);
    const service = new GatewayService({ source: gp, now });

    const events = await collect(service, { kind: "gateway.status.get" });
    expect(events).toHaveLength(1);
    const evt = events[0];
    expect(evt.kind).toBe("gateway.status");
    if (evt.kind !== "gateway.status") throw new Error("unreachable");
    expect(evt.status.running).toBe(false);
    expect(evt.status.startedAt).toBeNull();
    expect(evt.status.platforms).toEqual([
      { platform: "telegram", mode: "offline", detail: "missing HADES_TELEGRAM_TOKEN, TELEGRAM_BOT_TOKEN" },
      { platform: "discord", mode: "offline", detail: "missing HADES_DISCORD_TOKEN, DISCORD_BOT_TOKEN" },
    ]);
    expect(evt.status.counters).toEqual({ inbound: 0, outbound: 0, rateLimited: 0 });
    expect(evt.status.engine).toBeNull();
    expect(evt.status.at).toBe(1_000);

    // Passes the guard and round-trips through the codec.
    expect(isGatewayEvent(evt)).toBe(true);
    const line = encodeGatewayEvent(evt);
    expect(JSON.parse(line.trimEnd())).toEqual(evt);
  });

  it("projects a started process with startedAt as a real number, not null", async () => {
    let clock = 5_000;
    const now = () => clock;
    const gp = makeRealGatewayProcess(now);
    await gp.start();
    clock = 6_000;

    const service = new GatewayService({ source: gp, now });
    const events = await collect(service, { kind: "gateway.status.get" });
    expect(events).toHaveLength(1);
    const evt = events[0];
    expect(evt.kind).toBe("gateway.status");
    if (evt.kind !== "gateway.status") throw new Error("unreachable");
    expect(evt.status.running).toBe(true);
    expect(evt.status.startedAt).toBe(5_000);
    expect(evt.status.at).toBe(6_000);
    expect(isGatewayEvent(evt)).toBe(true);
  });

  it("attaches the engine probe's verdict verbatim when configured", async () => {
    const now = () => 42;
    const gp = makeRealGatewayProcess(now);
    const service = new GatewayService({
      source: gp,
      now,
      engineProbe: () => ({ requested: "claude-sonnet-5", mode: "real", detail: "ANTHROPIC_API_KEY present" }),
    });

    const events = await collect(service, { kind: "gateway.status.get" });
    expect(events).toHaveLength(1);
    const evt = events[0];
    if (evt.kind !== "gateway.status") throw new Error("unreachable");
    expect(evt.status.engine).toEqual({
      requested: "claude-sonnet-5",
      mode: "real",
      detail: "ANTHROPIC_API_KEY present",
    });
  });

  it("projects engine: null when the engineProbe returns undefined", async () => {
    const now = () => 42;
    const gp = makeRealGatewayProcess(now);
    const service = new GatewayService({ source: gp, now, engineProbe: () => undefined });

    const events = await collect(service, { kind: "gateway.status.get" });
    const evt = events[0];
    if (evt.kind !== "gateway.status") throw new Error("unreachable");
    expect(evt.status.engine).toBeNull();
  });

  it("emits exactly one gateway.error, message only (no stack), when the source throws", async () => {
    const throwing: GatewayStatusSource = {
      status: () => {
        const err = new Error("gateway crashed");
        err.stack = `Error: gateway crashed\n${SENTINEL_STACK}`;
        throw err;
      },
    };
    const service = new GatewayService({ source: throwing, now: () => 7 });
    const events = await collect(service, { kind: "gateway.status.get" });
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ kind: "gateway.error", message: "gateway crashed", at: 7 });
    expect(JSON.stringify(events[0])).not.toContain(SENTINEL_STACK);
  });

  it("emits exactly one gateway.error, message only, when the engineProbe throws", async () => {
    const gp = makeRealGatewayProcess(() => 1);
    const throwingProbe = () => {
      const err = new Error("engine probe exploded");
      err.stack = `Error: engine probe exploded\n${SENTINEL_STACK}`;
      throw err;
    };
    const service = new GatewayService({ source: gp, now: () => 1, engineProbe: throwingProbe });
    const events = await collect(service, { kind: "gateway.status.get" });
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ kind: "gateway.error", message: "engine probe exploded", at: 1 });
    expect(JSON.stringify(events[0])).not.toContain(SENTINEL_STACK);
  });

  it("stringifies a thrown non-Error value rather than crashing", async () => {
    const throwing: GatewayStatusSource = {
      status: () => {
        throw "just a string, not an Error";
      },
    };
    const service = new GatewayService({ source: throwing, now: () => 3 });
    const events = await collect(service, { kind: "gateway.status.get" });
    expect(events).toEqual([{ kind: "gateway.error", message: "just a string, not an Error", at: 3 }]);
  });

  it("emit is called exactly once even when both status() and the engineProbe would otherwise run", async () => {
    const gp = makeRealGatewayProcess(() => 1);
    const emit = vi.fn();
    const service = new GatewayService({
      source: gp,
      now: () => 1,
      engineProbe: () => ({ requested: "x", mode: "mock", detail: "no key" }),
    });
    await service.handle({ kind: "gateway.status.get" }, emit);
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it("never emits a gateway.paircode in response to gateway.status.get", async () => {
    const gp = makeRealGatewayProcess(() => 1);
    const service = new GatewayService({ source: gp, now: () => 1 });
    const events = await collect(service, { kind: "gateway.status.get" });
    expect(events.every((e) => e.kind !== "gateway.paircode")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// gateway.pair.issue — no pairing seam
// ---------------------------------------------------------------------------

describe("GatewayService.handle gateway.pair.issue with no pairing seam", () => {
  it("emits exactly one honest gateway.error, never a fabricated code", async () => {
    const service = new GatewayService({});
    const events = await collect(service, { kind: "gateway.pair.issue", level: "trusted" });
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      kind: "gateway.error",
      message: "no pairing seam attached to this sidecar",
      at: expect.any(Number),
    });
  });
});

// ---------------------------------------------------------------------------
// gateway.pair.issue — real PairingGuard
// ---------------------------------------------------------------------------

describe("GatewayService.handle gateway.pair.issue with a real PairingGuard", () => {
  it("maps level 'trusted' correctly and passes expiresAt through untouched", async () => {
    const now = () => 100_000;
    const guard = makeRealPairingGuard(now);
    const service = new GatewayService({
      pairing: guard,
      now,
    });

    const events = await collect(service, { kind: "gateway.pair.issue", level: "trusted" });
    expect(events).toHaveLength(1);
    const evt = events[0];
    expect(evt.kind).toBe("gateway.paircode");
    if (evt.kind !== "gateway.paircode") throw new Error("unreachable");
    expect(evt.pair.level).toBe("trusted");
    expect(typeof evt.pair.code).toBe("string");
    expect(evt.pair.code.length).toBeGreaterThan(0);
    // The real PairingGuard's default codeTtlMs is 10 minutes from now().
    expect(evt.pair.expiresAt).toBe(100_000 + 10 * 60 * 1000);
    expect(evt.pair.at).toBe(100_000);
    expect(isGatewayEvent(evt)).toBe(true);
  });

  it("maps level 'owner' correctly", async () => {
    const now = () => 200_000;
    const guard = makeRealPairingGuard(now);
    const service = new GatewayService({ pairing: guard, now });

    const events = await collect(service, { kind: "gateway.pair.issue", level: "owner" });
    const evt = events[0];
    if (evt.kind !== "gateway.paircode") throw new Error("unreachable");
    expect(evt.pair.level).toBe("owner");
  });

  it("the issued code actually redeems through the real guard at 'trusted' level", async () => {
    const now = () => 0;
    const guard = makeRealPairingGuard(now);
    const service = new GatewayService({ pairing: guard, now });

    const events = await collect(service, { kind: "gateway.pair.issue", level: "trusted" });
    const evt = events[0];
    if (evt.kind !== "gateway.paircode") throw new Error("unreachable");

    const wrapped = guard.wrap(async () => ({ text: "handled", accepted: true }));
    const reply = await wrapped({ platform: "telegram", user: "u1", channel: "c1", text: `/pair ${evt.pair.code}` });
    expect(reply.accepted).toBe(true);
    expect(guard.trustOf({ platform: "telegram", user: "u1" })).toBe("trusted");
  });

  it("round-trips a real paircode event through the codec (encode -> JSON.parse -> isGatewayEvent)", async () => {
    const now = () => 55;
    const guard = makeRealPairingGuard(now);
    const service = new GatewayService({ pairing: guard, now });

    const events = await collect(service, { kind: "gateway.pair.issue", level: "trusted" });
    const line = encodeGatewayEvent(events[0]);
    const decoded = JSON.parse(line.trimEnd());
    expect(isGatewayEvent(decoded)).toBe(true);
    expect(decoded).toEqual(events[0]);
  });

  it("emits exactly one gateway.error, message only (no stack), when the pairing seam throws", async () => {
    const throwing: PairingSource = {
      issuePairingCode: () => {
        const err = new Error("pairing store unavailable");
        err.stack = `Error: pairing store unavailable\n${SENTINEL_STACK}`;
        throw err;
      },
    };
    const service = new GatewayService({ pairing: throwing, now: () => 9 });
    const events = await collect(service, { kind: "gateway.pair.issue", level: "owner" });
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ kind: "gateway.error", message: "pairing store unavailable", at: 9 });
    expect(JSON.stringify(events[0])).not.toContain(SENTINEL_STACK);
  });

  it("stringifies a thrown non-Error value rather than crashing", async () => {
    const throwing: PairingSource = {
      issuePairingCode: () => {
        throw { code: "EWEIRD" };
      },
    };
    const service = new GatewayService({ pairing: throwing, now: () => 2 });
    const events = await collect(service, { kind: "gateway.pair.issue", level: "trusted" });
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("gateway.error");
    if (events[0].kind !== "gateway.error") throw new Error("unreachable");
    expect(events[0].message).not.toContain(SENTINEL_STACK);
  });

  it("emit is called exactly once", async () => {
    const guard = makeRealPairingGuard(() => 1);
    const emit = vi.fn();
    const service = new GatewayService({ pairing: guard, now: () => 1 });
    await service.handle({ kind: "gateway.pair.issue", level: "trusted" }, emit);
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it("never emits a gateway.status in response to gateway.pair.issue", async () => {
    const guard = makeRealPairingGuard(() => 1);
    const service = new GatewayService({ pairing: guard, now: () => 1 });
    const events = await collect(service, { kind: "gateway.pair.issue", level: "trusted" });
    expect(events.every((e) => e.kind !== "gateway.status")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// handle() never rejects
// ---------------------------------------------------------------------------

describe("GatewayService.handle never rejects", () => {
  it("resolves even when every seam throws synchronously", async () => {
    const throwingSource: GatewayStatusSource = {
      status: () => {
        throw new Error("boom");
      },
    };
    const throwingPairing: PairingSource = {
      issuePairingCode: () => {
        throw new Error("boom");
      },
    };
    const service = new GatewayService({ source: throwingSource, pairing: throwingPairing, now: () => 1 });
    await expect(collect(service, { kind: "gateway.status.get" })).resolves.toBeDefined();
    await expect(collect(service, { kind: "gateway.pair.issue", level: "trusted" })).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// End-to-end through the wire codec (real engine, real guard, decoded commands)
// ---------------------------------------------------------------------------

describe("GatewayService end-to-end over the wire protocol", () => {
  it("decodes a command off the wire, handles it against real engine objects, and the emitted event survives encode/decode", async () => {
    const now = () => 12_345;
    const gp = makeRealGatewayProcess(now);
    const guard = makeRealPairingGuard(now);
    const service = new GatewayService({ source: gp, pairing: guard, now });

    const statusCmd = decodeGatewayCommand(JSON.stringify({ kind: "gateway.status.get" }));
    const statusEvents = await collect(service, statusCmd);
    expect(statusEvents).toHaveLength(1);
    expect(isGatewayEvent(statusEvents[0])).toBe(true);
    expect(JSON.parse(encodeGatewayEvent(statusEvents[0]).trimEnd())).toEqual(statusEvents[0]);

    const pairCmd = decodeGatewayCommand(JSON.stringify({ kind: "gateway.pair.issue", level: "owner" }));
    const pairEvents = await collect(service, pairCmd);
    expect(pairEvents).toHaveLength(1);
    expect(isGatewayEvent(pairEvents[0])).toBe(true);
    expect(JSON.parse(encodeGatewayEvent(pairEvents[0]).trimEnd())).toEqual(pairEvents[0]);
  });
});
