/**
 * The desktop `market.*` lane, end to end: contract codec -> `Sidecar`
 * routing -> `MarketService` over the REAL market stack -> `app-store`
 * reducer.
 *
 * This suite is written to fail loudly if the lane is fake:
 *  - a `market.*` command must survive the real `encodeCommand`/`decodeCommand`
 *    round trip and be recognized by the merged `isCommand` union (a lane
 *    that does not is unreachable from the renderer);
 *  - a `Sidecar` with NO market handler must emit an honest `market.error`,
 *    never a synthesized empty status a renderer would read as "no
 *    fabrications here";
 *  - `MarketService` must report numbers measured by the real engine over a
 *    real ed25519 identity, including `scoreDefined: false` for an
 *    undefined skill score;
 *  - `market.book` must be a PURE read — it may not settle money, move
 *    escrow, or record a reputation event;
 *  - a simulation view without its model banner must be REJECTED by the
 *    contract guard.
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  decodeCommand,
  decodeEvent,
  encodeCommand,
  encodeEvent,
  isAppEvent,
  isCommand,
  isMarketSimulationWire,
  type AppEvent,
  type Command,
} from "../ipc/contract";
import { Sidecar, type SwarmFactory, type SwarmHandle } from "../core/sidecar";
import { MarketService } from "../core/market-service";
import { initialState, reduce } from "../core/app-store";
import { openMarket } from "../../hades/market/wiring";
import {
  CertificateAuthority,
  generatePrivateKeyHex,
  sha256Hex,
  type CertificatePayload,
} from "../../hades/styx/certificate";

/** A deliberately empty environment: these tests must never read the real
 *  ambient env (a developer's HADES_STYX_KEY would silently change what the
 *  market trusts). Cast once, here, rather than at every call site. */
const EMPTY_ENV = {} as NodeJS.ProcessEnv;

const NOW = 1_700_000_000_000;
const OUTPUT = "the delivered agent output, verbatim";
const TRACE = JSON.stringify({ steps: ["plan", "verify"], ok: true });

function seededRng(seed: number): (bytes: number) => Uint8Array {
  let state = (seed ^ 0x9e3779b9) >>> 0 || 1;
  return (n: number): Uint8Array => {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      state ^= state << 13;
      state >>>= 0;
      state ^= state >>> 17;
      state >>>= 0;
      state ^= state << 5;
      state >>>= 0;
      out[i] = state & 0xff;
    }
    return out;
  };
}

const dirs: string[] = [];
function tempDataDir(): string {
  const d = mkdtempSync(join(tmpdir(), "hades-market-desktop-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function plantSigningKey(dataDir: string, seed: number): CertificateAuthority {
  const privateKeyHex = generatePrivateKeyHex(seededRng(seed));
  mkdirSync(join(dataDir, "trust"), { recursive: true });
  writeFileSync(join(dataDir, "trust", "signing-key"), privateKeyHex, { mode: 0o600 });
  return new CertificateAuthority(privateKeyHex);
}

function payload(overrides: Partial<CertificatePayload> = {}): CertificatePayload {
  return {
    outputSha256: sha256Hex(OUTPUT),
    taskId: "task-alpha",
    verifierTier: "T1-reference",
    ensembleScore: 0.93,
    pCorrect: 0.95,
    epsilon: 0.05,
    traceSha256: sha256Hex(TRACE),
    verifierVersions: ["genrm-v1"],
    issuedAt: NOW - 1000,
    ...overrides,
  };
}

/** A real service over a real stack with one settled task. */
async function serviceWithHistory(
  seed = 71,
): Promise<{ service: MarketService; dataDir: string; privateKeyHex: string }> {
  const dataDir = tempDataDir();
  const privateKeyHex = generatePrivateKeyHex(seededRng(seed));
  const ca = plantSigningKey(dataDir, seed);
  const stack = openMarket({ dataDir, env: EMPTY_ENV });
  stack.economy.register("alice", "agent", 1000);
  stack.economy.postTask({ taskId: "task-alpha", domain: "code", reward: 100, difficulty: 0.5, postedAt: NOW });
  stack.economy.award({ taskId: "task-alpha", participantId: "alice", price: 80, claimedPCorrect: 0.9, awardedAt: NOW });
  await stack.economy.submitClaim({
    taskId: "task-alpha",
    participantId: "alice",
    outputText: OUTPUT,
    claimedPCorrect: 0.9,
    certificate: await ca.issue(payload()),
    traceJson: TRACE,
    submittedAt: NOW,
  });
  return { service: new MarketService({ stack: () => stack, now: () => NOW }), dataDir, privateKeyHex };
}

// ===========================================================================

describe("market.* is a real lane in the merged desktop contract", () => {
  const commands: Command[] = [
    { kind: "market.status" },
    { kind: "market.reputation", participantId: "alice", bins: 5 },
    { kind: "market.book", orders: [], offers: [], now: NOW },
    { kind: "market.simulate", seed: 3, rounds: 5, tasksPerRound: 2 },
  ];

  it("every market command survives encode/decode and is recognized by isCommand", () => {
    for (const cmd of commands) {
      expect(isCommand(cmd)).toBe(true);
      expect(decodeCommand(encodeCommand(cmd))).toEqual(cmd);
    }
  });

  it("every market event survives encode/decode and is recognized by isAppEvent", () => {
    const events: AppEvent[] = [
      {
        kind: "market.status",
        at: NOW,
        status: {
          root: null,
          issuerPublicKeyHex: "",
          issuerKeySource: "absent",
          trustedIssuers: [],
          acceptedTiers: ["T1-reference"],
          maxEpsilon: 0.1,
          requireTraceBinding: true,
          treasury: 1,
          totalTokens: 1,
          participants: [],
          openAwards: 0,
          settlements: 0,
          fabrications: 0,
          certificatesSpent: 0,
          chainOk: true,
          loadErrors: [],
        },
      },
      { kind: "market.error", op: "market.status", message: "nope", at: NOW },
    ];
    for (const ev of events) {
      expect(isAppEvent(ev)).toBe(true);
      expect(decodeEvent(encodeEvent(ev))).toEqual(ev);
    }
  });

  it("a malformed market command is REJECTED (no silent coercion at the process boundary)", () => {
    expect(isCommand({ kind: "market.book", orders: "not-an-array", offers: [], now: NOW })).toBe(false);
    expect(isCommand({ kind: "market.book", orders: [], offers: [], now: Number.NaN })).toBe(false);
    expect(isCommand({ kind: "market.reputation", bins: "many" })).toBe(false);
  });

  it("a simulation view stripped of its model banner is REJECTED by the guard", () => {
    const good = {
      modelLabel: "MODEL: ...",
      seed: 1,
      rounds: 2,
      tasksPerRound: 1,
      spearman: 1,
      convergedAtRound: null,
      participants: [],
      report: [],
    };
    expect(isMarketSimulationWire(good)).toBe(true);
    expect(isMarketSimulationWire({ ...good, modelLabel: "" })).toBe(false);
  });

  it("market events do not disturb swarm app state (they are read-only reports)", () => {
    const before = initialState();
    const after = reduce(before, { kind: "market.error", op: "market.status", message: "x", at: NOW });
    expect(after).toEqual(before);
  });
});

// ===========================================================================

describe("Sidecar routing", () => {
  const factory: SwarmFactory = () =>
    ({
      start: async () => {},
      stop: async () => {},
      snapshot: () => ({ workers: [], tasks: [], goals: [], verifications: [], metrics: null }),
      on: () => () => {},
      dispatch: async () => {},
    }) as unknown as SwarmHandle;

  it("with NO market handler, a market command yields an honest market.error — never a fake status", async () => {
    const events: AppEvent[] = [];
    const sidecar = new Sidecar({ factory, emit: (e) => events.push(e), now: () => NOW });
    await sidecar.handle({ kind: "market.status" });
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      kind: "market.error",
      op: "market.status",
      message: "the verified-work market is not configured in this build",
      at: NOW,
    });
  });

  it("with a real MarketService, a market.status command emits a real market.status event", async () => {
    const { service } = await serviceWithHistory(72);
    const events: AppEvent[] = [];
    const sidecar = new Sidecar({ factory, emit: (e) => events.push(e), now: () => NOW, market: service });
    await sidecar.handle({ kind: "market.status" });
    expect(events).toHaveLength(1);
    const ev = events[0];
    expect(ev.kind).toBe("market.status");
    expect(isAppEvent(ev)).toBe(true);
    if (ev.kind !== "market.status") throw new Error("unreachable");
    expect(ev.status.participants.map((p) => p.id)).toEqual(["alice"]);
    expect(ev.status.settlements).toBe(1);
  });
});

// ===========================================================================

describe("MarketService reports real, measured numbers", () => {
  it("market.status carries scoreDefined:false for an undefined skill score", async () => {
    const { service, privateKeyHex } = await serviceWithHistory(73);
    const ev = await service.handle({ kind: "market.status" });
    if (ev.kind !== "market.status") throw new Error(`unexpected ${ev.kind}`);
    const alice = ev.status.participants.find((p) => p.id === "alice");
    expect(alice).toBeDefined();
    expect(alice!.n).toBe(1);
    expect(alice!.scoreDefined).toBe(false);
    expect(ev.status.chainOk).toBe(true);
    expect(ev.status.certificatesSpent).toBe(1);
    // The PRIVATE key must never appear anywhere on the wire — only the
    // public half, which is what a verifier legitimately needs.
    expect(privateKeyHex.length).toBeGreaterThan(0);
    expect(JSON.stringify(ev)).not.toContain(privateKeyHex);
    expect(ev.status.issuerPublicKeyHex).toMatch(/^[0-9a-f]{64}$/);
    expect(ev.status.issuerPublicKeyHex).not.toBe(privateKeyHex);
  });

  it("market.reputation returns the real Murphy decomposition and calibration bins", async () => {
    const { service } = await serviceWithHistory(74);
    const ev = await service.handle({ kind: "market.reputation", participantId: "alice", bins: 4 });
    if (ev.kind !== "market.reputation") throw new Error(`unexpected ${ev.kind}`);
    expect(ev.participants).toHaveLength(1);
    const p = ev.participants[0];
    expect(p.participantId).toBe("alice");
    expect(p.calibration).toHaveLength(4);
    expect(p.scoreDefined).toBe(false);
    expect(Math.abs(p.brier - (p.reliability - p.resolution + p.uncertainty))).toBeLessThan(1e-9);
  });

  it("market.book is a PURE read — it never settles, never moves escrow, never records reputation", async () => {
    const dataDir = tempDataDir();
    plantSigningKey(dataDir, 75);
    const stack = openMarket({ dataDir, env: EMPTY_ENV });
    stack.economy.register("alice", "agent", 1000);
    const service = new MarketService({ stack: () => stack, now: () => NOW });

    const before = {
      tokens: stack.economy.totalTokens(),
      treasury: stack.economy.treasury(),
      history: stack.economy.history().length,
      entries: stack.reputation.entries().length,
      escrow: stack.economy.account("alice").escrowed,
    };

    const ev = await service.handle({
      kind: "market.book",
      orders: [{ taskId: "t1", domain: "code", maxPrice: 100, postedAt: NOW }],
      offers: [
        { participantId: "alice", taskId: "t1", price: 10, claimedPCorrect: 0.9, capability: { domain: "code", tags: [] } },
      ],
      now: NOW,
    });
    if (ev.kind !== "market.book") throw new Error(`unexpected ${ev.kind}`);
    expect(ev.book.matches).toHaveLength(1);
    expect(ev.book.matches[0].participantId).toBe("alice");

    expect(stack.economy.totalTokens()).toBe(before.tokens);
    expect(stack.economy.treasury()).toBe(before.treasury);
    expect(stack.economy.history().length).toBe(before.history);
    expect(stack.reputation.entries().length).toBe(before.entries);
    expect(stack.economy.account("alice").escrowed).toBe(before.escrow);
  });

  it("market.book reports rejections with their real codes rather than dropping them", async () => {
    const dataDir = tempDataDir();
    plantSigningKey(dataDir, 76);
    const service = new MarketService({ stack: () => openMarket({ dataDir, env: EMPTY_ENV }), now: () => NOW });
    const ev = await service.handle({
      kind: "market.book",
      orders: [{ taskId: "t1", domain: "code", maxPrice: 5, postedAt: NOW }],
      offers: [
        { participantId: "over", taskId: "t1", price: 50, claimedPCorrect: 0.9, capability: { domain: "code", tags: [] } },
        { participantId: "junk", taskId: "t1", price: -1, claimedPCorrect: 2, capability: null },
      ],
      now: NOW,
    });
    if (ev.kind !== "market.book") throw new Error(`unexpected ${ev.kind}`);
    expect(ev.book.rejected.map((r) => r.reason).sort()).toEqual(["invalid-offer", "price-over-max"]);
    expect(ev.book.matches).toHaveLength(0);
  });

  it("market.simulate carries the engine's own MODEL_LABEL and clamps a hostile size request", async () => {
    const service = new MarketService({
      stack: () => openMarket({ dataDir: null, env: EMPTY_ENV }),
      now: () => NOW,
      maxSimulationRounds: 4,
      maxSimulationTasksPerRound: 2,
    });
    const ev = await service.handle({ kind: "market.simulate", seed: 5, rounds: 100_000, tasksPerRound: 9_999 });
    if (ev.kind !== "market.simulated") throw new Error(`unexpected ${ev.kind}`);
    expect(ev.simulation.modelLabel).toContain("MODEL:");
    expect(ev.simulation.rounds).toBe(4);
    expect(ev.simulation.tasksPerRound).toBe(2);
    expect(isMarketSimulationWire(ev.simulation)).toBe(true);
  });

  it("a failing stack surfaces a real market.error, never a synthesized healthy view", async () => {
    const service = new MarketService({
      stack: () => {
        throw new Error("disk on fire");
      },
    });
    const ev = await service.handle({ kind: "market.status" });
    expect(ev.kind).toBe("market.error");
    if (ev.kind !== "market.error") throw new Error("unreachable");
    expect(ev.message).toContain("disk on fire");
  });
});
