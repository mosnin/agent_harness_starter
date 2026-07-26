import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGatewayCommand } from "../gateway-command";
import type { GatewayCommandIo } from "../gateway-command";
import { buildGatewayDeps, buildGatewayDepsFromEnv } from "../gateway-deps";
import type { GatewayCliDeps, GatewayAgentEngine } from "../gateway-deps";
import { JsonFileJobStore } from "../../schedule/store";
import { systemClock } from "../../schedule/clock";
import { ScheduledGatewayRuntime } from "../../schedule/gateway-runtime";
import type { HadesConfig } from "../../config/config";
import { InMemoryConnector } from "../../gateway/in-memory-connector";
import type { PlatformProbe } from "../../gateway/process";
import { runGatewayBench, formatGatewayBenchReport } from "../../gateway/gateway-bench";
import type { GatewayBenchReport } from "../../gateway/gateway-bench";

// `bench` is tested against an injected fake `runGatewayBench` seam (per the
// locked contract), rather than the real cross-team harness: at the time
// this test was written the real `runGatewayBench` throws on its `/link`
// step (its injected pairing-code generator emits codes containing "-",
// which `PairingGuard`'s `/pair` regex — `[A-Za-z0-9]{4,12}` — rejects).
// That bug lives in `../gateway/gateway-bench.ts`, a file owned by another
// team, not touched here; `gateway-command.ts`'s `runBench` already catches
// exactly this kind of failure and reports it honestly (see the "gateway
// bench failed" test below) rather than crashing.
vi.mock("../../gateway/gateway-bench", () => ({
  runGatewayBench: vi.fn(),
  formatGatewayBenchReport: vi.fn(),
}));

function tmpConfig(): HadesConfig {
  const dataDir = mkdtempSync(join(tmpdir(), "hades-gateway-cli-test-"));
  return { locale: "en", dataDir, gateway: {}, plugins: [] };
}

/** Fresh deps wired to a fake, network-free "slack" connector (real) + an offline "telegram" entry. */
function buildDeps(overrideReport?: PlatformProbe[]): GatewayCliDeps & { conn: InMemoryConnector; config: HadesConfig } {
  const conn = new InMemoryConnector("slack");
  const report: PlatformProbe[] = overrideReport ?? [
    { platform: "slack", mode: "real", detail: "via TEST" },
    { platform: "telegram", mode: "offline", detail: "missing HADES_TELEGRAM_TOKEN" },
  ];
  const config = tmpConfig();
  const deps = buildGatewayDeps(config, {}, { connectors: [conn], report });
  return { ...deps, conn, config };
}

function captureIo(): GatewayCommandIo & { lines: string[] } {
  const lines: string[] = [];
  return { lines, write: (l: string) => lines.push(l) };
}

describe("buildGatewayDeps: composition order (pairing -> continuity -> badges -> agent)", () => {
  it("an untrusted inbound message gets the pairing prompt and the engine is never called", async () => {
    const respondSpy = vi.fn(async (turn) => ({ text: `engine saw: ${turn.text}` }));
    const engine: GatewayAgentEngine = { mode: "mock", respond: respondSpy };
    const conn = new InMemoryConnector("slack");
    const report: PlatformProbe[] = [{ platform: "slack", mode: "real", detail: "via TEST" }];
    const deps = buildGatewayDeps(tmpConfig(), {}, { connectors: [conn], report, engine });
    await deps.process.start();

    const reply = await conn.receive({ user: "unknown-user", text: "hello there" });

    expect(respondSpy).not.toHaveBeenCalled();
    expect(reply.accepted).toBe(false);
    expect(reply.text.toLowerCase()).toContain("pair");
  });

  it("after pairing, a message flows through continuity (identity + session) and arrives badge-stamped", async () => {
    const conn = new InMemoryConnector("slack");
    const report: PlatformProbe[] = [{ platform: "slack", mode: "real", detail: "via TEST" }];
    const deps = buildGatewayDeps(tmpConfig(), {}, { connectors: [conn], report }); // default mock echoEngine
    await deps.process.start();

    const issued = deps.pairing.issuePairingCode("trusted");
    const pairReply = await conn.receive({ user: "u1", text: `/pair ${issued.code}` });
    expect(pairReply.accepted).toBe(true);
    expect(deps.pairing.trustOf({ platform: "slack", user: "u1" })).toBe("trusted");

    const reply = await conn.receive({ user: "u1", text: "hi there" });
    expect(reply.text).toContain("[mock]"); // engine mode is reported, never disguised
    expect(reply.text).toContain("hi there");
    expect(reply.text).toContain("unverified"); // no STYX evidence attached -> honest default badge
  });

  it("files land under <dataDir>/gateway/ and are actually written on mutation", async () => {
    const config = tmpConfig();
    const conn = new InMemoryConnector("slack");
    const report: PlatformProbe[] = [{ platform: "slack", mode: "real", detail: "via TEST" }];
    const deps = buildGatewayDeps(config, {}, { connectors: [conn], report });

    expect(deps.identityPath).toBe(join(config.dataDir, "gateway", "identities.json"));
    expect(deps.trustPath).toBe(join(config.dataDir, "gateway", "trust.json"));
    expect(existsSync(deps.identityPath)).toBe(false); // nothing written yet

    await deps.process.start();
    const issued = deps.pairing.issuePairingCode("trusted");
    await conn.receive({ user: "u1", text: `/pair ${issued.code}` });

    expect(existsSync(deps.identityPath)).toBe(true);
    expect(existsSync(deps.trustPath)).toBe(true);
  });
});

describe("runGatewayCommand: start", () => {
  it("--probe reports the connector table and exits 0 WITHOUT starting", async () => {
    const deps = buildDeps();
    const startSpy = vi.spyOn(deps.process, "start");
    const io = captureIo();

    const res = await runGatewayCommand(["start", "--probe"], deps, io);

    expect(res.code).toBe(0);
    expect(startSpy).not.toHaveBeenCalled();
    expect(deps.process.status().running).toBe(false);
    expect(res.lines.join("\n")).toContain("slack");
    expect(res.lines.join("\n")).toContain("telegram");
    expect(io.lines.length).toBeGreaterThan(0); // probe table streamed too
  });

  it("with an injected wait: resolves and stops the process on wait completion", async () => {
    const deps = buildDeps();
    const stopSpy = vi.spyOn(deps.process, "stop");
    const io = captureIo();
    io.wait = async () => {}; // resolves immediately

    const res = await runGatewayCommand(["start"], deps, io);

    expect(res.code).toBe(0);
    expect(stopSpy).toHaveBeenCalledTimes(1);
    expect(deps.process.status().running).toBe(false);
    expect(io.lines.some((l) => l.includes("started"))).toBe(true);
    expect(io.lines.some((l) => l.includes("stopped"))).toBe(true);
  });

  it("--schedule against deps built WITHOUT a schedule factory fails honestly (never a silent fallback)", async () => {
    const deps = buildDeps(); // buildGatewayDeps: no schedule runtime factory wired
    const io = captureIo();

    const res = await runGatewayCommand(["start", "--schedule"], deps, io);

    expect(res.code).toBe(1);
    expect(res.lines.join("\n")).toContain("--schedule requires deps built by buildGatewayDepsFromEnv");
    expect(deps.process.status().running).toBe(false);
  });

  it("--schedule runs the REAL co-runtime over the durable job store and prints the honest zero outcome tally", async () => {
    const config = tmpConfig();
    // Seed the SAME durable file `hades schedule add` writes, via the REAL store.
    const seedStore = new JsonFileJobStore(join(config.dataDir, "schedule.json"), systemClock);
    seedStore.add({ name: "seeded job", cron: "0 3 * * *", timeZone: "UTC", task: { kind: "note", input: "x" } });

    // Empty env: mock echo engine (honest probe), zero env connectors.
    const deps = await buildGatewayDepsFromEnv(config, {}, { forStart: true });
    expect(deps.schedule).toBeDefined();
    // The factory composes a real ScheduledGatewayRuntime over the real paths.
    const probeBuild = deps.schedule!();
    expect(probeBuild.runtime).toBeInstanceOf(ScheduledGatewayRuntime);
    expect(probeBuild.storePath).toBe(join(config.dataDir, "schedule.json"));
    expect(probeBuild.receiptsPath).toBe(join(config.dataDir, "schedule-receipts.json"));
    expect(probeBuild.store.list().map((j) => j.name)).toEqual(["seeded job"]);

    const io = captureIo();
    io.wait = async () => {}; // resolves immediately — start, then clean shutdown

    const res = await runGatewayCommand(["start", "--schedule"], deps, io);

    expect(res.code).toBe(0);
    const joined = res.lines.join("\n");
    expect(joined).toContain(`schedule: 1 job(s) in ${join(config.dataDir, "schedule.json")}`);
    expect(joined).toContain(`schedule: delivery receipts ledger at ${join(config.dataDir, "schedule-receipts.json")}`);
    expect(joined).toContain("gateway+scheduler: started — waiting for messages and due jobs (Ctrl+C to stop).");
    expect(joined).toContain("gateway+scheduler: stopped.");
    // Nothing was due in the instant between start and stop — the tally is a
    // real zero count, printed verbatim, never a fabricated activity claim.
    expect(joined).toContain("schedule outcomes this run: delivered=0 abstained=0 withheld=0 failed=0 skipped=0");
    expect(deps.process.status().running).toBe(false);
  });
});

describe("buildGatewayDeps: connectors exposed for the scheduler seam", () => {
  it("deps.connectors carries the EXACT connector instances the process registered (by reference)", () => {
    const conn = new InMemoryConnector("slack");
    const report: PlatformProbe[] = [{ platform: "slack", mode: "real", detail: "via TEST" }];
    const deps = buildGatewayDeps(tmpConfig(), {}, { connectors: [conn], report });
    expect(deps.connectors).toHaveLength(1);
    expect(deps.connectors[0]).toBe(conn);
  });
});

describe("runGatewayCommand: status", () => {
  it("reports running=false before start and running=true after", async () => {
    const deps = buildDeps();

    const before = await runGatewayCommand(["status"], deps);
    expect(before.code).toBe(0);
    expect(before.lines[0]).toContain("stopped");

    await deps.process.start();
    const after = await runGatewayCommand(["status"], deps);
    expect(after.lines[0]).toContain("running");
    expect(after.lines.join("\n")).toContain("counters:");

    await deps.process.stop();
  });
});

describe("runGatewayCommand: pair", () => {
  it("prints a one-time code that is genuinely redeemable via the same deps.pairing (not decorative)", async () => {
    const deps = buildDeps();

    const res = await runGatewayCommand(["pair"], deps);
    expect(res.code).toBe(0);
    const codeLine = res.lines.find((l) => l.startsWith("Pairing code:"));
    expect(codeLine).toBeDefined();
    const code = codeLine!.split(":")[1].trim();

    const wrapped = deps.pairing.wrap(async () => ({ text: "reached the agent", accepted: true }));
    const reply = await wrapped({ platform: "slack", user: "brand-new-user", text: `/pair ${code}` });

    expect(reply.accepted).toBe(true);
    expect(deps.pairing.trustOf({ platform: "slack", user: "brand-new-user" })).toBe("trusted");
  });

  it("--owner issues an owner-level code", async () => {
    const deps = buildDeps();
    const res = await runGatewayCommand(["pair", "--owner"], deps);
    expect(res.lines.join("\n")).toContain("Level: owner");
  });
});

describe("runGatewayCommand: send", () => {
  it("happy path delivers through a connected platform", async () => {
    const deps = buildDeps();
    const res = await runGatewayCommand(["send", "slack", "C1", "hello", "world"], deps);
    expect(res.code).toBe(0);
    expect(res.lines[0]).toContain("Sent to slack:C1");
    expect(deps.conn.sent[0].text).toBe("hello world");
  });

  it("fails honestly (exit 1) for an offline/unregistered platform", async () => {
    const deps = buildDeps();
    const res = await runGatewayCommand(["send", "telegram", "u1", "hi"], deps);
    expect(res.code).toBe(1);
    expect(res.lines[0]).toMatch(/offline|not connected/);
  });

  it("usage error on missing args", async () => {
    const deps = buildDeps();
    const res = await runGatewayCommand(["send", "slack"], deps);
    expect(res.code).toBe(1);
    expect(res.lines[0]).toMatch(/Usage/);
  });
});

describe("runGatewayCommand: bench", () => {
  const fakeReport: GatewayBenchReport = {
    platforms: ["telegram", "discord", "slack", "whatsapp", "signal", "email"],
    turns: 2,
    pairedHandles: 1,
    identities: 1,
    sessionIds: ["sess-1"],
    crossPlatformContinuity: true,
    switchedChannelFlagged: true,
    badges: { unverified: 2 },
    durationMs: 7,
    honest: { engineMode: "mock", transports: "fake" },
  };

  it("delegates to runGatewayBench and prints exactly formatGatewayBenchReport's lines", async () => {
    vi.mocked(runGatewayBench).mockResolvedValueOnce(fakeReport);
    vi.mocked(formatGatewayBenchReport).mockReturnValueOnce(["FAKE REPORT LINE 1", "FAKE REPORT LINE 2"]);

    const deps = buildDeps();
    const res = await runGatewayCommand(["bench"], deps);

    expect(res.code).toBe(0);
    expect(res.lines).toEqual(["FAKE REPORT LINE 1", "FAKE REPORT LINE 2"]);
    expect(runGatewayBench).toHaveBeenCalledTimes(1);
    expect(formatGatewayBenchReport).toHaveBeenCalledWith(fakeReport);
    expect(deps.conn.sent).toHaveLength(0); // the bench builds its own isolated stack — the CLI's own connector is never touched
  });

  it("reports a failed bench honestly (exit 1, no stack trace) instead of crashing the CLI", async () => {
    vi.mocked(runGatewayBench).mockRejectedValueOnce(new Error("bench harness exploded"));

    const deps = buildDeps();
    const res = await runGatewayCommand(["bench"], deps);

    expect(res.code).toBe(1);
    expect(res.lines).toEqual(["gateway bench failed: bench harness exploded"]);
  });
});

describe("runGatewayCommand: help / unknown", () => {
  it("no subcommand and 'help' both print usage with exit 0", async () => {
    const deps = buildDeps();
    const res1 = await runGatewayCommand([], deps);
    const res2 = await runGatewayCommand(["help"], deps);
    expect(res1.code).toBe(0);
    expect(res2.code).toBe(0);
    expect(res1.lines.join("\n")).toContain("Usage:");
  });

  it("unknown subcommand exits 1 with usage", async () => {
    const deps = buildDeps();
    const res = await runGatewayCommand(["frobnicate"], deps);
    expect(res.code).toBe(1);
    expect(res.lines.join("\n")).toContain('Unknown gateway subcommand: "frobnicate"');
    expect(res.lines.join("\n")).toContain("Usage:");
  });
});

describe("runGatewayCommand: no credential leakage", () => {
  it("start --probe and status never print a credential value from env", async () => {
    const CANARY = "canary-super-secret-token-123";
    const config = tmpConfig();
    const deps = buildGatewayDeps(config, { HADES_SLACK_TOKEN: CANARY });

    const probe = await runGatewayCommand(["start", "--probe"], deps);
    const status = await runGatewayCommand(["status"], deps);

    const all = [...probe.lines, ...status.lines].join("\n");
    expect(all).not.toContain(CANARY);
    expect(all).toContain("HADES_SLACK_TOKEN"); // the variable name is fine to print
  });
});
