/**
 * Central-integration tests for cycle 2's gateway modules: proves the new
 * capabilities are actually ON the product's real paths, not dead code.
 *
 *  - GatewayProcess routes every connector through withChunking, so an
 *    over-limit reply/proactive send leaves the wire as N marked, size-legal
 *    chunks (and the hub's logical counters still count messages, not chunks).
 *  - buildConnectorsFromEnv adopts the voice-capable TelegramVoiceConnector
 *    (voice notes are reachable from a running `hades gateway`), reporting
 *    the real stt/tts modes in the probe detail — env variable NAMES only.
 *  - probeGatewayEngine is the pure view of resolveGatewayEngine's decision
 *    table, and buildGatewayDepsFromEnv gates real engine construction on
 *    forStart (status/pair/send never build a swarm).
 *  - `hades gateway status` / `start --probe` print the honest engine line,
 *    and `start` tears the resolved engine down after the gateway stops.
 *  - The gateway barrel actually exports the new modules.
 */
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GatewayProcess, buildConnectorsFromEnv } from "../gateway/process";
import { InMemoryConnector } from "../gateway/in-memory-connector";
import { chunkMessage, platformFormat } from "../gateway/message-format";
import { TelegramVoiceConnector } from "../gateway/connectors/telegram-voice";
import { probeGatewayEngine, resolveGatewayEngine } from "../gateway/engine-select";
import { buildGatewayDepsFromEnv } from "../cli/gateway-deps";
import { runGatewayCommand } from "../cli/gateway-command";
import type { HadesConfig } from "../config/config";
import type { InboundMessage, OutboundReply } from "../../swarm-runtime/gateway/gateway";
import * as gatewayBarrel from "../gateway/index";

function tmpConfig(): HadesConfig {
  return { locale: "en", dataDir: mkdtempSync(join(tmpdir(), "hades-gw-wiring-")), gateway: {}, plugins: [] };
}

const LONG_TEXT = Array.from({ length: 60 }, (_, i) => `paragraph ${i}: ${"x".repeat(150)}`).join("\n\n");

describe("GatewayProcess: chunking is on the actual wire", () => {
  function build(handler: (m: InboundMessage) => Promise<OutboundReply>) {
    const conn = new InMemoryConnector("telegram");
    const gp = new GatewayProcess({
      handler,
      connectors: [conn],
      report: [{ platform: "telegram", mode: "real", detail: "via TEST" }],
    });
    return { conn, gp };
  }

  it("an over-limit reply leaves as exactly chunkMessage's marked, size-legal chunks — and the raw blob never hits the wire", async () => {
    const { conn, gp } = build(async () => ({ text: LONG_TEXT, accepted: true }));
    await gp.start();

    const reply = await conn.receive({ user: "u1", text: "hi" });

    const expectedChunks = chunkMessage(LONG_TEXT, "telegram");
    expect(expectedChunks.length).toBeGreaterThan(1);
    expect(conn.sent.map((s) => s.text)).toEqual(expectedChunks);

    const { maxChars } = platformFormat("telegram");
    for (const s of conn.sent) expect(s.text.length).toBeLessThanOrEqual(maxChars);
    // The unchunked original was never sent whole.
    expect(conn.sent.some((s) => s.text === LONG_TEXT)).toBe(false);
    // The decorator drained the reply so the connector's own reply path had
    // nothing left to double-send.
    expect(reply.text).toBe("");
  });

  it("an under-limit reply is byte-identical with exactly one send", async () => {
    const { conn, gp } = build(async () => ({ text: "short and sweet", accepted: true }));
    await gp.start();

    const reply = await conn.receive({ user: "u1", text: "hi" });

    expect(reply.text).toBe("short and sweet");
    expect(conn.sent).toHaveLength(1);
    expect(conn.sent[0].text).toBe("short and sweet");
  });

  it("proactive deliver() chunks identically", async () => {
    const { conn, gp } = build(async () => ({ text: "", accepted: true }));
    await gp.start();

    const ok = await gp.deliver("telegram", { user: "u9" }, LONG_TEXT);

    expect(ok).toBe(true);
    expect(conn.sent.map((s) => s.text)).toEqual(chunkMessage(LONG_TEXT, "telegram"));
  });

  it("counters stay logical: one inbound message + one chunked reply count 1/1, not 1/N", async () => {
    const { conn, gp } = build(async () => ({ text: LONG_TEXT, accepted: true }));
    await gp.start();

    await conn.receive({ user: "u1", text: "hi" });

    const counters = gp.status().counters;
    expect(conn.sent.length).toBeGreaterThan(1); // wire carried N chunks
    expect(counters.inbound).toBe(1);
    expect(counters.outbound).toBe(1); // ...but the gateway counted one reply
  });
});

describe("buildConnectorsFromEnv: voice-capable telegram adoption", () => {
  it("telegram comes up as the TelegramVoiceConnector with the voice probe folded into its detail (names only, no secrets)", () => {
    const SECRET = "sk-telegram-canary-31337";
    const { connectors, report } = buildConnectorsFromEnv({ HADES_TELEGRAM_TOKEN: SECRET });

    expect(connectors).toHaveLength(1);
    expect(connectors[0]).toBeInstanceOf(TelegramVoiceConnector);
    expect(connectors[0].platform).toBe("telegram");

    const telegram = report.find((p) => p.platform === "telegram")!;
    expect(telegram.mode).toBe("real");
    expect(telegram.detail).toContain("via HADES_TELEGRAM_TOKEN");
    // No STT/TTS keys in env: honest mock transcriber, no TTS at all.
    expect(telegram.detail).toContain("voice stt=mock");
    expect(telegram.detail).toContain("tts=offline");
    expect(JSON.stringify(report)).not.toContain(SECRET);
  });

  it("with an STT key the probe reports stt=real, and tts=real only behind HADES_TTS_ENABLED=1", () => {
    const base = { HADES_TELEGRAM_TOKEN: "t", HADES_STT_API_KEY: "sk-stt-canary" };

    const withKey = buildConnectorsFromEnv(base).report.find((p) => p.platform === "telegram")!;
    expect(withKey.detail).toContain("voice stt=real");
    expect(withKey.detail).toContain("tts=offline");

    const withTts = buildConnectorsFromEnv({ ...base, HADES_TTS_ENABLED: "1" }).report.find(
      (p) => p.platform === "telegram"
    )!;
    expect(withTts.detail).toContain("voice stt=real");
    expect(withTts.detail).toContain("tts=real");
    expect(JSON.stringify(withTts)).not.toContain("sk-stt-canary");
  });

  it("an offline telegram probe stays exactly the missing-variables report — no voice claims", () => {
    const telegram = buildConnectorsFromEnv({}).report.find((p) => p.platform === "telegram")!;
    expect(telegram.mode).toBe("offline");
    expect(telegram.detail).toBe("missing HADES_TELEGRAM_TOKEN, TELEGRAM_BOT_TOKEN");
  });
});

describe("probeGatewayEngine: the pure decision table", () => {
  it("matches resolveGatewayEngine's verdict for every non-building branch", async () => {
    for (const env of [
      {},
      { HADES_GATEWAY_ENGINE: "echo" },
      { HADES_GATEWAY_ENGINE: "swarm" }, // no key
      { HADES_GATEWAY_ENGINE: "banana" },
    ] as Record<string, string | undefined>[]) {
      const pure = probeGatewayEngine(env);
      const resolved = await resolveGatewayEngine(env);
      expect(pure.requested).toBe(resolved.probe.requested);
      expect(pure.mode).toBe(resolved.probe.mode);
      expect(pure.mode).toBe("mock");
    }
  });

  it("swarm + key probes mode real, naming only the variable and model — never the key value, and never constructing anything", () => {
    const SECRET = "sk-ant-canary-99";
    const probe = probeGatewayEngine({
      HADES_GATEWAY_ENGINE: "swarm",
      ANTHROPIC_API_KEY: SECRET,
    });
    expect(probe).toMatchObject({ requested: "swarm", mode: "real" });
    expect(probe.detail).toContain("ANTHROPIC_API_KEY");
    expect(probe.detail).toContain("configured");
    expect(probe.detail).not.toContain(SECRET);
  });

  it("honors HADES_GATEWAY_MODEL in the probed model name", () => {
    const probe = probeGatewayEngine({
      HADES_GATEWAY_ENGINE: "swarm",
      OPENAI_API_KEY: "k",
      HADES_GATEWAY_MODEL: "my-custom-model",
    });
    expect(probe.detail).toContain('model "my-custom-model"');
    expect(probe.detail).toContain("OPENAI_API_KEY");
  });
});

describe("buildGatewayDepsFromEnv: engine construction is start-gated", () => {
  it("non-start invocations get a PURE probe and never touch the manager factory", async () => {
    const createManager = vi.fn();
    const deps = await buildGatewayDepsFromEnv(
      tmpConfig(),
      { HADES_GATEWAY_ENGINE: "swarm", ANTHROPIC_API_KEY: "k" },
      { forStart: false, resolveDeps: { createManager: createManager as never } }
    );

    expect(createManager).not.toHaveBeenCalled();
    expect(deps.engineProbe).toMatchObject({ requested: "swarm", mode: "real" });
    expect(deps.engineProbe!.detail).toContain("configured");
    expect(deps.engineShutdown).toBeUndefined();
  });

  it("forStart + swarm + key resolves the real engine through the injected manager factory, and engineShutdown tears it down", async () => {
    const shutdown = vi.fn(async () => {});
    const createManager = vi.fn(async () => ({
      manager: {
        startGoal: async () => {
          throw new Error("not driven here");
        },
      },
      shutdown,
    }));

    const deps = await buildGatewayDepsFromEnv(
      tmpConfig(),
      { HADES_GATEWAY_ENGINE: "swarm", ANTHROPIC_API_KEY: "k" },
      { forStart: true, resolveDeps: { createManager: createManager as never } }
    );

    expect(createManager).toHaveBeenCalledTimes(1);
    expect(deps.engineProbe).toMatchObject({ requested: "swarm", mode: "real" });
    expect(deps.engineProbe!.detail).toContain("active");
    expect(deps.engineShutdown).toBeTypeOf("function");
    await deps.engineShutdown!();
    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it("forStart with no key falls back to the honest mock and a no-op shutdown — the factory is provably never called", async () => {
    const createManager = vi.fn();
    const deps = await buildGatewayDepsFromEnv(
      tmpConfig(),
      { HADES_GATEWAY_ENGINE: "swarm" },
      { forStart: true, resolveDeps: { createManager: createManager as never } }
    );

    expect(createManager).not.toHaveBeenCalled();
    expect(deps.engineProbe).toEqual({
      requested: "swarm",
      mode: "mock",
      detail: "missing ANTHROPIC_API_KEY, OPENAI_API_KEY",
    });
    await expect(deps.engineShutdown!()).resolves.toBeUndefined();
  });
});

describe("runGatewayCommand: the engine line and shutdown are wired", () => {
  function cliDeps(engineProbe?: { requested: "swarm" | "echo"; mode: "real" | "mock"; detail: string }) {
    const conn = new InMemoryConnector("slack");
    const report = [{ platform: "slack", mode: "real" as const, detail: "via TEST" }];
    return {
      conn,
      build: async (extra?: Partial<Record<"engineShutdown", () => Promise<void>>>) => {
        const { buildGatewayDeps } = await import("../cli/gateway-deps");
        const deps = buildGatewayDeps(tmpConfig(), {}, { connectors: [conn], report });
        return { ...deps, engineProbe, ...extra };
      },
    };
  }

  it("status prints the honest engine line when a probe is wired (and none when it is not)", async () => {
    const withProbe = cliDeps({ requested: "echo", mode: "mock", detail: "using the mock echo engine" });
    const res = await runGatewayCommand(["status"], await withProbe.build());
    expect(res.code).toBe(0);
    expect(res.lines.join("\n")).toContain("engine: mock (requested echo) — using the mock echo engine");

    const without = cliDeps(undefined);
    const res2 = await runGatewayCommand(["status"], await without.build());
    expect(res2.lines.join("\n")).not.toContain("engine:");
  });

  it("start --probe includes the engine line without starting", async () => {
    const rig = cliDeps({ requested: "swarm", mode: "real", detail: 'real verified swarm engine configured via ANTHROPIC_API_KEY, model "m"' });
    const deps = await rig.build();
    const res = await runGatewayCommand(["start", "--probe"], deps);
    expect(res.code).toBe(0);
    expect(deps.process.status().running).toBe(false);
    expect(res.lines.join("\n")).toContain("engine: real (requested swarm)");
  });

  it("start calls engineShutdown exactly once, after the gateway stopped", async () => {
    const calls: string[] = [];
    const rig = cliDeps({ requested: "echo", mode: "mock", detail: "mock" });
    const deps = await rig.build({
      engineShutdown: async () => {
        // The process must already be stopped when the engine goes down.
        expect(deps.process.status().running).toBe(false);
        calls.push("shutdown");
      },
    });

    const res = await runGatewayCommand(["start"], deps, {
      write: () => {},
      wait: async () => {},
    });

    expect(res.code).toBe(0);
    expect(calls).toEqual(["shutdown"]);
  });
});

describe("gateway barrel: the new modules are actually exported", () => {
  it("exports chunking, verified engine, engine selection, voice providers, and the voice connector", () => {
    expect(typeof gatewayBarrel.withChunking).toBe("function");
    expect(typeof gatewayBarrel.ChunkingConnector).toBe("function");
    expect(typeof gatewayBarrel.verifiedSwarmEngine).toBe("function");
    expect(typeof gatewayBarrel.extractGoalSignals).toBe("function");
    expect(typeof gatewayBarrel.scoreGoalSignals).toBe("function");
    expect(typeof gatewayBarrel.resolveGatewayEngine).toBe("function");
    expect(typeof gatewayBarrel.probeGatewayEngine).toBe("function");
    expect(typeof gatewayBarrel.buildVoiceFromEnv).toBe("function");
    expect(typeof gatewayBarrel.TelegramVoiceConnector).toBe("function");
    expect(typeof gatewayBarrel.createTelegramVoiceHttpTransport).toBe("function");
  });
});
