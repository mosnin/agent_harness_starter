/**
 * Central-integration tests for the desktop gateway lane: the gateway
 * contract is merged into the composed IPC contract (`../ipc/contract.ts`),
 * the Sidecar routes `gateway.*` commands to a wired handler (with an honest
 * `gateway.error` when none is configured), and `runSidecar`'s DEFAULT wiring
 * answers `gateway.status.get` from the real `buildGatewayDeps` composition —
 * real env probes (variable NAMES only), real pairing guard, pure engine
 * probe.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  decodeCommand,
  encodeCommand,
  decodeEvent,
  encodeEvent,
  isAppEvent,
  isCommand,
} from "../ipc/contract";
import type { AppEvent, GatewayEvent, GatewayStatusView } from "../ipc/contract";
import { Sidecar } from "../core/sidecar";
import { GatewayService } from "../core/gateway-service";
import { runSidecar } from "../sidecar-entry";
import { GatewayProcess } from "../../hades/gateway/process";
import { PairingGuard } from "../../hades/gateway/pairing";
import { InMemoryTrustStore } from "../../hades/gateway/trust-store";
import { InMemoryIdentityStore, IdentityLinker } from "../../hades/gateway/continuity";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A real (never-started) GatewayProcess over an empty env — real probes, real zero counters. */
function realGatewayService(now = () => 1_000): GatewayService {
  const process = new GatewayProcess({
    handler: async () => ({ text: "", accepted: false }),
    env: {},
  });
  const identities = new InMemoryIdentityStore();
  const pairing = new PairingGuard({
    trust: new InMemoryTrustStore(),
    identities,
    linker: new IdentityLinker(identities),
  });
  return new GatewayService({
    source: process,
    pairing,
    engineProbe: () => ({ requested: "echo", mode: "mock", detail: "using the mock echo engine" }),
    now,
  });
}

async function* fakeInput(lines: string[]): AsyncGenerator<string> {
  for (const line of lines) yield line;
}

const savedEnv = { ...process.env };
afterEach(() => {
  process.env = { ...savedEnv };
});

// ---------------------------------------------------------------------------
// Contract merge
// ---------------------------------------------------------------------------

describe("ipc contract: gateway kinds are merged into Command/AppEvent", () => {
  it("decodeCommand accepts both gateway commands and rejects a bad pair level", () => {
    expect(decodeCommand('{"kind":"gateway.status.get"}')).toEqual({ kind: "gateway.status.get" });
    expect(decodeCommand('{"kind":"gateway.pair.issue","level":"owner"}')).toEqual({
      kind: "gateway.pair.issue",
      level: "owner",
    });
    expect(() => decodeCommand('{"kind":"gateway.pair.issue","level":"admin"}')).toThrow(/bad command/);
    expect(isCommand({ kind: "gateway.pair.issue", level: "trusted" })).toBe(true);
  });

  it("encodeEvent/decodeEvent round-trip every gateway event kind", () => {
    const status: GatewayStatusView = {
      running: false,
      startedAt: null,
      platforms: [{ platform: "telegram", mode: "offline", detail: "missing HADES_TELEGRAM_TOKEN" }],
      counters: { inbound: 0, outbound: 0, rateLimited: 0 },
      engine: { requested: "echo", mode: "mock", detail: "mock engine" },
      at: 7,
    };
    const events: AppEvent[] = [
      { kind: "gateway.status", status },
      { kind: "gateway.paircode", pair: { code: "ABCD1234", level: "trusted", expiresAt: 99, at: 7 } },
      { kind: "gateway.error", message: "nope", at: 7 },
    ];
    for (const ev of events) {
      expect(isAppEvent(ev)).toBe(true);
      expect(decodeEvent(encodeEvent(ev))).toEqual(ev);
    }
  });
});

// ---------------------------------------------------------------------------
// Sidecar routing
// ---------------------------------------------------------------------------

describe("Sidecar: gateway command routing", () => {
  it("routes gateway.status.get through a wired GatewayService and emits one real gateway.status", async () => {
    const events: AppEvent[] = [];
    const sidecar = new Sidecar({
      factory: () => ({ dispatchGoal: () => ({ goalId: "g" }), snapshot: () => ({ workers: [], tasks: [] }) }),
      emit: (e) => events.push(e),
      gateway: realGatewayService(),
    });

    await sidecar.handle({ kind: "gateway.status.get" });

    const gw = events.filter((e) => e.kind === "gateway.status");
    expect(gw).toHaveLength(1);
    const status = (gw[0] as Extract<GatewayEvent, { kind: "gateway.status" }>).status;
    expect(status.running).toBe(false);
    expect(status.startedAt).toBeNull();
    expect(status.platforms).toHaveLength(6); // all six real env probes, all offline for {}
    expect(status.platforms.every((p) => p.mode === "offline")).toBe(true);
    expect(status.engine).toEqual({ requested: "echo", mode: "mock", detail: "using the mock echo engine" });
  });

  it("gateway.pair.issue emits a real, redeemable-shaped paircode from the real PairingGuard", async () => {
    const events: AppEvent[] = [];
    const sidecar = new Sidecar({
      factory: () => ({ dispatchGoal: () => ({ goalId: "g" }), snapshot: () => ({ workers: [], tasks: [] }) }),
      emit: (e) => events.push(e),
      gateway: realGatewayService(),
    });

    await sidecar.handle({ kind: "gateway.pair.issue", level: "owner" });

    const pairs = events.filter((e) => e.kind === "gateway.paircode");
    expect(pairs).toHaveLength(1);
    const pair = (pairs[0] as Extract<GatewayEvent, { kind: "gateway.paircode" }>).pair;
    expect(pair.level).toBe("owner");
    expect(pair.code).toMatch(/^[A-Za-z0-9]{4,12}$/); // the exact shape PairingGuard's /pair regex redeems
    expect(pair.expiresAt).toBeGreaterThan(0);
  });

  it("without a gateway handler, a gateway command gets an honest gateway.error — never silence, never a fabricated status", async () => {
    const events: AppEvent[] = [];
    const sidecar = new Sidecar({
      factory: () => ({ dispatchGoal: () => ({ goalId: "g" }), snapshot: () => ({ workers: [], tasks: [] }) }),
      emit: (e) => events.push(e),
    });

    await sidecar.handle({ kind: "gateway.status.get" });
    await sidecar.handle({ kind: "gateway.pair.issue", level: "trusted" });

    expect(events).toHaveLength(2);
    for (const ev of events) {
      expect(ev.kind).toBe("gateway.error");
      expect((ev as Extract<GatewayEvent, { kind: "gateway.error" }>).message).toBe(
        "gateway is not configured in this build"
      );
    }
    expect(events.some((e) => e.kind === "gateway.status")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// runSidecar default wiring — the real end-to-end lane
// ---------------------------------------------------------------------------

describe("runSidecar: default gateway wiring answers over the real stack", () => {
  it("gateway.status.get round-trips the whole pipe: decode -> real GatewayService -> encoded gateway.status", async () => {
    // Isolate: fresh data dir, no engine opt-in, no connector creds that
    // could make this test's probes environment-dependent.
    process.env = {
      ...savedEnv,
      HADES_DATA_DIR: mkdtempSync(join(tmpdir(), "hades-sidecar-gw-")),
    };
    delete process.env.HADES_GATEWAY_ENGINE;
    for (const v of [
      "HADES_TELEGRAM_TOKEN",
      "TELEGRAM_BOT_TOKEN",
      "HADES_DISCORD_TOKEN",
      "DISCORD_BOT_TOKEN",
      "HADES_SLACK_TOKEN",
      "SLACK_BOT_TOKEN",
      "HADES_WHATSAPP_TOKEN",
      "HADES_WHATSAPP_PHONE_ID",
      "HADES_SIGNAL_URL",
      "HADES_SIGNAL_NUMBER",
      "HADES_EMAIL_ADDRESS",
    ]) {
      delete process.env[v];
    }

    const outputLines: string[] = [];
    await runSidecar(
      fakeInput([
        encodeCommand({ kind: "gateway.status.get" }),
        encodeCommand({ kind: "gateway.pair.issue", level: "trusted" }),
      ]),
      (line) => outputLines.push(line),
      {
        // Keep the default-fleet/default-factory heavy lanes out of this
        // test — the gateway default is wired independently of them.
        factory: () => ({ dispatchGoal: () => ({ goalId: "g" }), snapshot: () => ({ workers: [], tasks: [] }) }),
        fleet: { handle: async () => [] },
        inference: { kind: "mock", detail: "test" },
      }
    );

    const events = outputLines.map((l) => decodeEvent(l));
    const statusEv = events.find((e) => e.kind === "gateway.status") as
      | Extract<GatewayEvent, { kind: "gateway.status" }>
      | undefined;
    expect(statusEv).toBeDefined();
    expect(statusEv!.status.running).toBe(false);
    expect(statusEv!.status.platforms.map((p) => p.platform).sort()).toEqual([
      "discord",
      "email",
      "signal",
      "slack",
      "telegram",
      "whatsapp",
    ]);
    expect(statusEv!.status.platforms.every((p) => p.mode === "offline")).toBe(true);
    // Engine probe is the PURE decision — echo/mock for an un-opted-in env.
    expect(statusEv!.status.engine).toMatchObject({ requested: "echo", mode: "mock" });

    const pairEv = events.find((e) => e.kind === "gateway.paircode") as
      | Extract<GatewayEvent, { kind: "gateway.paircode" }>
      | undefined;
    expect(pairEv).toBeDefined();
    expect(pairEv!.pair.level).toBe("trusted");
    expect(pairEv!.pair.code).toMatch(/^[A-Za-z0-9]{4,12}$/);

    // Nothing on the wire ever carries a raw stack trace line.
    expect(outputLines.join("")).not.toMatch(/\n\s+at /);
  });

  it("an injected gateway handler overrides the default wiring", async () => {
    const handle = vi.fn(async (_cmd: unknown, emit: (e: GatewayEvent) => void) => {
      emit({ kind: "gateway.error", message: "injected", at: 1 });
    });

    const outputLines: string[] = [];
    await runSidecar(
      fakeInput([encodeCommand({ kind: "gateway.status.get" })]),
      (line) => outputLines.push(line),
      {
        factory: () => ({ dispatchGoal: () => ({ goalId: "g" }), snapshot: () => ({ workers: [], tasks: [] }) }),
        fleet: { handle: async () => [] },
        inference: { kind: "mock", detail: "test" },
        gateway: { handle },
      }
    );

    expect(handle).toHaveBeenCalledTimes(1);
    const events = outputLines.map((l) => decodeEvent(l));
    expect(events).toEqual([{ kind: "gateway.error", message: "injected", at: 1 }]);
  });
});
