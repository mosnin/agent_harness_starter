import { describe, it, expect, vi } from "vitest";
import { GatewayProcess, buildConnectorsFromEnv } from "../gateway/process";
import { InMemoryConnector } from "../gateway/in-memory-connector";
import { RateLimiter } from "../gateway/rate-limiter";
import type { InboundMessage, OutboundReply } from "../../swarm-runtime/gateway/gateway";

const echo = async (m: InboundMessage): Promise<OutboundReply> => ({ text: `echo:${m.text}`, accepted: true });

/** Minimal on/off/emit emitter — stands in for Node's `process` in signal-handler tests. */
class FakeEmitter {
  listeners = new Map<string, Set<() => void>>();
  on(sig: string, cb: () => void): this {
    if (!this.listeners.has(sig)) this.listeners.set(sig, new Set());
    this.listeners.get(sig)!.add(cb);
    return this;
  }
  off(sig: string, cb: () => void): this {
    this.listeners.get(sig)?.delete(cb);
    return this;
  }
  emit(sig: string): void {
    for (const cb of [...(this.listeners.get(sig) ?? [])]) cb();
  }
}

describe("buildConnectorsFromEnv", () => {
  it("reports all 6 platforms offline for an empty env, naming only missing variable names", () => {
    const { connectors, report } = buildConnectorsFromEnv({});
    expect(connectors).toHaveLength(0);
    expect(report).toHaveLength(6);
    expect(report.every((p) => p.mode === "offline")).toBe(true);
    expect(new Set(report.map((p) => p.platform))).toEqual(
      new Set(["telegram", "discord", "slack", "whatsapp", "signal", "email"])
    );
    for (const p of report) {
      expect(p.detail.toLowerCase()).toContain("missing");
    }

    const telegram = report.find((p) => p.platform === "telegram")!;
    expect(telegram.detail).toContain("HADES_TELEGRAM_TOKEN");
    expect(telegram.detail).toContain("TELEGRAM_BOT_TOKEN");

    const whatsapp = report.find((p) => p.platform === "whatsapp")!;
    expect(whatsapp.detail).toContain("HADES_WHATSAPP_TOKEN");
    expect(whatsapp.detail).toContain("HADES_WHATSAPP_PHONE_ID");

    const signal = report.find((p) => p.platform === "signal")!;
    expect(signal.detail).toContain("HADES_SIGNAL_URL");
    expect(signal.detail).toContain("HADES_SIGNAL_NUMBER");

    const email = report.find((p) => p.platform === "email")!;
    expect(email.detail).toContain("HADES_EMAIL_ADDRESS");
  });

  it("brings up exactly telegram + email as real when only those creds are present, and never leaks the secret value", () => {
    const CANARY = "sk-canary-should-never-leak-9f3e2b";
    const env = {
      HADES_TELEGRAM_TOKEN: CANARY,
      HADES_EMAIL_ADDRESS: "bot@example.com",
      HADES_EMAIL_IMAP_HOST: "imap.example.com",
      HADES_EMAIL_SMTP_HOST: "smtp.example.com",
      HADES_EMAIL_USER: "bot@example.com",
      HADES_EMAIL_PASS: CANARY,
    };
    const { connectors, report } = buildConnectorsFromEnv(env);

    expect(connectors).toHaveLength(2);
    expect(connectors.map((c) => c.platform).sort()).toEqual(["email", "telegram"]);

    const real = report.filter((p) => p.mode === "real");
    expect(real.map((p) => p.platform).sort()).toEqual(["email", "telegram"]);
    expect(report.filter((p) => p.mode === "offline")).toHaveLength(4);
    expect(report).toHaveLength(6);

    expect(JSON.stringify(report)).not.toContain(CANARY);
  });

  it("treats a legacy fallback var (e.g. DISCORD_BOT_TOKEN) as real too, naming which var was used", () => {
    const { connectors, report } = buildConnectorsFromEnv({ DISCORD_BOT_TOKEN: "fallback-token" });
    expect(connectors.map((c) => c.platform)).toEqual(["discord"]);
    const discord = report.find((p) => p.platform === "discord")!;
    expect(discord.mode).toBe("real");
    expect(discord.detail).toContain("DISCORD_BOT_TOKEN");
    expect(discord.detail).not.toContain("fallback-token");
  });

  it("requires BOTH whatsapp vars together — one alone stays offline", () => {
    const { connectors, report } = buildConnectorsFromEnv({ HADES_WHATSAPP_TOKEN: "tok-only" });
    expect(connectors).toHaveLength(0);
    const whatsapp = report.find((p) => p.platform === "whatsapp")!;
    expect(whatsapp.mode).toBe("offline");
    expect(whatsapp.detail).toContain("HADES_WHATSAPP_PHONE_ID");
    expect(whatsapp.detail).not.toContain("HADES_WHATSAPP_TOKEN"); // token IS present, only the phone id is missing
  });
});

describe("GatewayProcess: lifecycle", () => {
  it("start() is idempotent — a second call does not re-start connectors", async () => {
    const conn = new InMemoryConnector("slack");
    const startSpy = vi.spyOn(conn, "start");
    const gp = new GatewayProcess({
      handler: echo,
      connectors: [conn],
      report: [{ platform: "slack", mode: "real", detail: "via TEST" }],
    });

    const s1 = await gp.start();
    const s2 = await gp.start();

    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(s1.running).toBe(true);
    expect(s2.running).toBe(true);
    expect(s1.startedAt).toBe(s2.startedAt);
  });

  it("stop() is idempotent and actually awaits the connector's in-flight async stop()", async () => {
    let releaseStop: () => void = () => {};
    const stopGate = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    const conn = new InMemoryConnector("discord");
    const realStop = conn.stop.bind(conn);
    let stopStarted = false;
    const stopSpy = vi.spyOn(conn, "stop").mockImplementation(async () => {
      stopStarted = true;
      await stopGate;
      await realStop();
    });

    const gp = new GatewayProcess({
      handler: echo,
      connectors: [conn],
      report: [{ platform: "discord", mode: "real", detail: "via TEST" }],
    });
    await gp.start();

    const stopPromise = gp.stop();
    await Promise.resolve();
    await Promise.resolve();
    expect(stopStarted).toBe(true);
    expect(gp.status().running).toBe(true); // stop() hasn't resolved yet — still "running" until it truly finishes

    releaseStop();
    await stopPromise;
    expect(gp.status().running).toBe(false);

    await gp.stop(); // second stop — must resolve cleanly, without calling connector.stop() again
    expect(stopSpy).toHaveBeenCalledTimes(1);
  });

  it("counters survive stop()", async () => {
    const conn = new InMemoryConnector("telegram");
    const gp = new GatewayProcess({
      handler: echo,
      connectors: [conn],
      report: [{ platform: "telegram", mode: "real", detail: "via TEST" }],
    });
    await gp.start();
    await conn.receive({ user: "u1", text: "hi" });
    const before = gp.status().counters;

    await gp.stop();
    const after = gp.status().counters;

    expect(after).toEqual(before);
    expect(after.inbound).toBe(1);
    expect(after.outbound).toBe(1);
  });

  it("status() reflects running correctly across start/stop", async () => {
    const conn = new InMemoryConnector("slack");
    const gp = new GatewayProcess({
      handler: echo,
      connectors: [conn],
      report: [{ platform: "slack", mode: "real", detail: "via TEST" }],
    });
    expect(gp.status().running).toBe(false);
    await gp.start();
    expect(gp.status().running).toBe(true);
    await gp.stop();
    expect(gp.status().running).toBe(false);
  });
});

describe("GatewayProcess: counters", () => {
  it("mirror-driven counters count exact inbound/outbound traffic (3 in, 2 out — one reply is empty)", async () => {
    const conn = new InMemoryConnector("whatsapp");
    let n = 0;
    const handler = async (m: InboundMessage): Promise<OutboundReply> => {
      n += 1;
      return n === 3 ? { text: "", accepted: false } : { text: `reply ${n} to ${m.text}`, accepted: true };
    };
    const gp = new GatewayProcess({
      handler,
      connectors: [conn],
      report: [{ platform: "whatsapp", mode: "real", detail: "via TEST" }],
    });
    await gp.start();

    await conn.receive({ user: "u", text: "1" });
    await conn.receive({ user: "u", text: "2" });
    await conn.receive({ user: "u", text: "3" });

    const counters = gp.status().counters;
    expect(counters.inbound).toBe(3);
    expect(counters.outbound).toBe(2);
    expect(counters.rateLimited).toBe(0);
  });

  it("counts rate-limited messages via the wrapped RateLimiter, and never mirrors them as inbound", async () => {
    let t = 0;
    const limiter = new RateLimiter({ capacity: 1, refillMs: 10_000, now: () => t });
    const conn = new InMemoryConnector("signal");
    const gp = new GatewayProcess({
      handler: echo,
      connectors: [conn],
      report: [{ platform: "signal", mode: "real", detail: "via TEST" }],
      rateLimiter: limiter,
    });
    await gp.start();

    const first = await conn.receive({ user: "u1", text: "1" });
    const second = await conn.receive({ user: "u1", text: "2" });

    expect(first.accepted).toBe(true);
    expect(second.accepted).toBe(false);

    const counters = gp.status().counters;
    expect(counters.rateLimited).toBe(1);
    // ConnectorHub's rate-limit branch returns before ever calling the mirror,
    // so a rejected message contributes to neither inbound nor outbound —
    // only to rateLimited.
    expect(counters.inbound).toBe(1);
    expect(counters.outbound).toBe(1);
  });

  it("deliver() also drives the outbound counter via the same mirror seam", async () => {
    const conn = new InMemoryConnector("discord");
    const gp = new GatewayProcess({
      handler: echo,
      connectors: [conn],
      report: [{ platform: "discord", mode: "real", detail: "via TEST" }],
    });
    await gp.start();
    await gp.deliver("discord", { user: "u1" }, "proactive hello");
    expect(gp.status().counters.outbound).toBe(1);
  });
});

describe("GatewayProcess: deliver", () => {
  it("deliver() to an unregistered platform returns false without throwing", async () => {
    const gp = new GatewayProcess({ handler: echo, connectors: [], report: [] });
    await expect(gp.deliver("nope", { user: "x" }, "hi")).resolves.toBe(false);
  });

  it("deliver() to a registered platform sends and returns true", async () => {
    const conn = new InMemoryConnector("telegram");
    const gp = new GatewayProcess({
      handler: echo,
      connectors: [conn],
      report: [{ platform: "telegram", mode: "real", detail: "via TEST" }],
    });
    const ok = await gp.deliver("telegram", { user: "u1", channel: "c1" }, "hello there");
    expect(ok).toBe(true);
    expect(conn.sent[0]).toEqual({ target: { user: "u1", channel: "c1" }, text: "hello there" });
  });
});

describe("GatewayProcess.installSignalHandlers", () => {
  it("registers exactly SIGINT+SIGTERM, firing SIGINT stops the process, and the uninstaller removes both", async () => {
    const conn = new InMemoryConnector("cli");
    const gp = new GatewayProcess({
      handler: echo,
      connectors: [conn],
      report: [{ platform: "cli", mode: "real", detail: "via TEST" }],
    });
    await gp.start();
    expect(gp.status().running).toBe(true);

    const emitter = new FakeEmitter();
    const uninstall = gp.installSignalHandlers(emitter);

    expect(emitter.listeners.size).toBe(2);
    expect(emitter.listeners.get("SIGINT")?.size).toBe(1);
    expect(emitter.listeners.get("SIGTERM")?.size).toBe(1);

    emitter.emit("SIGINT");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(gp.status().running).toBe(false);

    uninstall();
    expect(emitter.listeners.get("SIGINT")?.size).toBe(0);
    expect(emitter.listeners.get("SIGTERM")?.size).toBe(0);
  });

  it("never touches a real emitter beyond what it's handed — no other signal names registered", async () => {
    const gp = new GatewayProcess({ handler: echo, connectors: [], report: [] });
    const emitter = new FakeEmitter();
    gp.installSignalHandlers(emitter);
    expect([...emitter.listeners.keys()].sort()).toEqual(["SIGINT", "SIGTERM"]);
  });
});

describe("GatewayProcess: no credential leakage", () => {
  it("status() never contains a credential value pulled from env", () => {
    const CANARY = "hunter2-canary-abcde12345";
    const gp = new GatewayProcess({ handler: echo, env: { HADES_SLACK_TOKEN: CANARY } });
    const s = gp.status();
    expect(JSON.stringify(s)).not.toContain(CANARY);
    const slack = s.platforms.find((p) => p.platform === "slack")!;
    expect(slack.mode).toBe("real");
    expect(slack.detail).toBe("via HADES_SLACK_TOKEN");
  });
});
