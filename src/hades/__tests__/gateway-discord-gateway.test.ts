import { describe, it, expect, beforeEach } from "vitest";
import {
  DiscordGatewayClient,
  DISCORD_DEFAULT_INTENTS,
  attachDiscordConnector,
  type DiscordSocket,
  type DiscordSocketFactory,
  type DiscordGatewayState,
  type DiscordGatewayTimers,
  type DiscordDispatch,
} from "../gateway/connectors/discord-gateway";
import { DiscordConnector } from "../gateway/connectors/discord";
import type { DiscordTransport } from "../gateway/connectors/discord";
import type { InboundMessage, OutboundReply } from "../../swarm-runtime/gateway/gateway";

// ---------------------------------------------------------------------------
// Deterministic test doubles: fake socket, fake virtual-clock timers, and a
// queue-driven random source. No real network, no real timers, anywhere.
// ---------------------------------------------------------------------------

class FakeDiscordSocket implements DiscordSocket {
  sent: string[] = [];
  closed = false;
  closeCode: number | null = null;
  closeReason: string | null = null;
  private messageHandlers: Array<(data: string) => void> = [];
  private closeHandlers: Array<(code: number, reason: string) => void> = [];
  private errorHandlers: Array<(err: Error) => void> = [];

  constructor(public readonly url: string) {}

  send(data: string): void {
    if (this.closed) throw new Error("cannot send on a closed fake socket");
    this.sent.push(data);
  }
  close(code = 1000, reason = ""): void {
    if (this.closed) return;
    this.closed = true;
    this.closeCode = code;
    this.closeReason = reason;
  }
  onMessage(h: (data: string) => void): void {
    this.messageHandlers.push(h);
  }
  onClose(h: (code: number, reason: string) => void): void {
    this.closeHandlers.push(h);
  }
  onError(h: (err: Error) => void): void {
    this.errorHandlers.push(h);
  }

  // ---- test-only server simulation ----
  emitMessage(obj: unknown): void {
    const data = JSON.stringify(obj);
    this.messageHandlers.forEach((h) => h(data));
  }
  emitRaw(data: string): void {
    this.messageHandlers.forEach((h) => h(data));
  }
  /** Simulate the server (or network) closing the connection. */
  emitClose(code: number, reason = ""): void {
    this.closed = true;
    this.closeHandlers.forEach((h) => h(code, reason));
  }
  emitError(err: Error): void {
    this.errorHandlers.forEach((h) => h(err));
  }

  sentOps(): Array<{ op: number; d: unknown }> {
    return this.sent.map((s) => JSON.parse(s));
  }
}

function makeFactory(): { factory: DiscordSocketFactory; created: FakeDiscordSocket[] } {
  const created: FakeDiscordSocket[] = [];
  const factory: DiscordSocketFactory = async (url: string) => {
    const sock = new FakeDiscordSocket(url);
    created.push(sock);
    return sock;
  };
  return { factory, created };
}

/** A virtual clock: setTimeout/clearTimeout scheduled against a manually-advanced `now`. */
class FakeTimers implements DiscordGatewayTimers {
  private now = 0;
  private nextId = 1;
  private timers = new Map<number, { fireAt: number; fn: () => void; seq: number }>();
  private seqCounter = 0;

  setTimeout = (fn: () => void, ms: number): unknown => {
    const id = this.nextId++;
    this.timers.set(id, { fireAt: this.now + Math.max(0, ms), fn, seq: this.seqCounter++ });
    return id;
  };
  clearTimeout = (h: unknown): void => {
    this.timers.delete(h as number);
  };
  get pendingCount(): number {
    return this.timers.size;
  }
  /** Advance the virtual clock, firing every timer due within the window, in order. */
  advance(ms: number): void {
    const target = this.now + ms;
    for (;;) {
      let nextId: number | null = null;
      let next: { fireAt: number; fn: () => void; seq: number } | null = null;
      for (const [id, entry] of this.timers) {
        if (entry.fireAt > target) continue;
        if (!next || entry.fireAt < next.fireAt || (entry.fireAt === next.fireAt && entry.seq < next.seq)) {
          next = entry;
          nextId = id;
        }
      }
      if (!next || nextId === null) break;
      this.timers.delete(nextId);
      this.now = next.fireAt;
      next.fn();
    }
    this.now = target;
  }
}

function queueRandom(values: number[]): () => number {
  let i = 0;
  return () => {
    const v = values[Math.min(i, values.length - 1)];
    i++;
    return v;
  };
}

function makeLog(): { lines: string[]; log: (line: string) => void } {
  const lines: string[] = [];
  return { lines, log: (line: string) => lines.push(line) };
}

const TOKEN = "super-secret-bot-token-XYZ789";

function buildClient(
  overrides: Partial<{
    timers: FakeTimers;
    random: () => number;
    onDispatch: (e: DiscordDispatch) => void;
    onStateChange: (s: DiscordGatewayState) => void;
    log: (line: string) => void;
    maxReconnectDelayMs: number;
    maxReconnectAttempts: number;
    gatewayUrl: string;
  }> = {},
): {
  client: DiscordGatewayClient;
  created: FakeDiscordSocket[];
  timers: FakeTimers;
  states: DiscordGatewayState[];
  dispatches: DiscordDispatch[];
  logLines: string[];
} {
  const { factory, created } = makeFactory();
  const timers = overrides.timers ?? new FakeTimers();
  const states: DiscordGatewayState[] = [];
  const dispatches: DiscordDispatch[] = [];
  const { lines: logLines, log } = makeLog();

  const client = new DiscordGatewayClient({
    token: TOKEN,
    socketFactory: factory,
    onDispatch: (e) => {
      dispatches.push(e);
      overrides.onDispatch?.(e);
    },
    onStateChange: (s) => {
      states.push(s);
      overrides.onStateChange?.(s);
    },
    log: (line) => {
      log(line);
      overrides.log?.(line);
    },
    timers,
    random: overrides.random ?? queueRandom([0.5]),
    ...(overrides.maxReconnectDelayMs !== undefined ? { maxReconnectDelayMs: overrides.maxReconnectDelayMs } : {}),
    ...(overrides.maxReconnectAttempts !== undefined ? { maxReconnectAttempts: overrides.maxReconnectAttempts } : {}),
    ...(overrides.gatewayUrl !== undefined ? { gatewayUrl: overrides.gatewayUrl } : {}),
  });

  return { client, created, timers, states, dispatches, logLines };
}

function ready(sock: FakeDiscordSocket, sessionId = "sess-1", resumeUrl = "wss://resume-host.example.com", seq = 1): void {
  sock.emitMessage({ op: 0, s: seq, t: "READY", d: { session_id: sessionId, resume_gateway_url: resumeUrl, v: 10 } });
}

function hello(sock: FakeDiscordSocket, heartbeatIntervalMs = 40_000): void {
  sock.emitMessage({ op: 10, d: { heartbeat_interval: heartbeatIntervalMs } });
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("DiscordGatewayClient", () => {
  describe("HELLO -> heartbeat scheduling", () => {
    it("schedules the first heartbeat at heartbeat_interval * jitter, then beats on a steady interval carrying lastSeq", async () => {
      const { client, created, timers } = buildClient({ random: queueRandom([0.5]) });
      await client.start();
      const sock = created[0];
      hello(sock, 40_000);

      // jitter = 40000 * 0.5 = 20000ms exactly.
      timers.advance(19_999);
      expect(sock.sentOps().filter((p) => p.op === 1)).toHaveLength(0);
      timers.advance(1);
      const firstBeats = sock.sentOps().filter((p) => p.op === 1);
      expect(firstBeats).toHaveLength(1);
      expect(firstBeats[0].d).toBeNull(); // no seq observed yet

      // ACK it so the steady cycle doesn't think it's a zombie.
      sock.emitMessage({ op: 11 });
      ready(sock, "sess-1", "wss://resume-host.example.com", 7);

      // Steady interval is heartbeat_interval (40000ms) from the previous beat.
      timers.advance(39_999);
      expect(sock.sentOps().filter((p) => p.op === 1)).toHaveLength(1);
      timers.advance(1);
      const secondBeats = sock.sentOps().filter((p) => p.op === 1);
      expect(secondBeats).toHaveLength(2);
      expect(secondBeats[1].d).toBe(7); // carries lastSeq
    });
  });

  describe("opcode 1 (server heartbeat request)", () => {
    it("forces an immediate out-of-cycle heartbeat without disturbing the steady schedule", async () => {
      const { client, created, timers } = buildClient({ random: queueRandom([0.5]) });
      await client.start();
      const sock = created[0];
      hello(sock, 40_000);
      timers.advance(20_000); // first scheduled beat fires
      expect(sock.sentOps().filter((p) => p.op === 1)).toHaveLength(1);
      sock.emitMessage({ op: 11 }); // ACK it

      sock.emitMessage({ op: 1 }); // server requests a heartbeat
      const afterForced = sock.sentOps().filter((p) => p.op === 1);
      expect(afterForced).toHaveLength(2); // sent immediately, no timer advance needed

      // The steady schedule is untouched: next scheduled beat still fires
      // 40000ms after the *first* scheduled beat (t=20000+40000=60000), not
      // reset by the forced one (we're currently sitting at t=20000).
      timers.advance(39_999);
      expect(sock.sentOps().filter((p) => p.op === 1)).toHaveLength(2);
      timers.advance(1);
      expect(sock.sentOps().filter((p) => p.op === 1)).toHaveLength(3);
    });
  });

  describe("zombie connection detection", () => {
    it("closes with a resumable code and reconnects with RESUME (never a fresh IDENTIFY) when a session exists", async () => {
      const { client, created, timers } = buildClient({ random: queueRandom([0.5]) });
      await client.start();
      const sock0 = created[0];
      hello(sock0, 40_000);
      timers.advance(20_000);
      sock0.emitMessage({ op: 11 }); // ack first beat
      ready(sock0, "sess-zombie", "wss://resume-host.example.com", 3);

      // Next scheduled beat fires and gets no ACK.
      timers.advance(40_000);
      expect(sock0.sentOps().filter((p) => p.op === 1)).toHaveLength(2);
      expect(sock0.closed).toBe(false);

      // The following scheduled beat finds awaitingAck still true -> zombie.
      timers.advance(40_000);
      expect(sock0.closed).toBe(true);
      expect(sock0.closeCode).not.toBe(1000);
      expect([4004, 4010, 4011, 4012, 4013, 4014]).not.toContain(sock0.closeCode);
      expect(client.heartbeatStats().missedInARow).toBe(1);

      expect(created).toHaveLength(2);
      await flush(); // let connect()'s socketFactory await resolve and wireSocket() run
      const sock1 = created[1];
      hello(sock1, 40_000);
      const sent = sock1.sentOps();
      expect(sent).toHaveLength(1);
      expect(sent[0].op).toBe(6); // RESUME, not IDENTIFY (2)
      expect(sent[0].d).toMatchObject({ session_id: "sess-zombie", token: TOKEN });
    });
  });

  describe("READY / RESUME URL routing", () => {
    it("captures session_id + resume_gateway_url from READY and reconnects to the resume URL, not the base URL", async () => {
      const { client, created, timers } = buildClient({ random: queueRandom([0.5, 0.5]) });
      await client.start();
      const sock0 = created[0];
      expect(sock0.url).toBe("wss://gateway.discord.gg/?v=10&encoding=json");
      hello(sock0, 40_000);
      ready(sock0, "sess-resume", "wss://resume-host.example.com", 1);
      expect(client.sessionInfo()).toEqual({ sessionId: "sess-resume", resumeGatewayUrl: "wss://resume-host.example.com", lastSeq: 1 });

      // A resumable server-initiated close should drive a reconnect to the resume URL.
      sock0.emitClose(4001, "hiccup");
      // reconnectAttempts=0 -> delay = min(1000*2^0, 60000) * 0.5 = 500ms
      timers.advance(500);
      expect(created).toHaveLength(2);
      expect(created[1].url).toBe("wss://resume-host.example.com/?v=10&encoding=json");
    });
  });

  describe("opcode 7 RECONNECT", () => {
    it("closes and immediately resumes on a new connection", async () => {
      const { client, created } = buildClient({ random: queueRandom([0.5]) });
      await client.start();
      const sock0 = created[0];
      hello(sock0, 40_000);
      ready(sock0, "sess-rc", "wss://resume-host.example.com", 5);

      sock0.emitMessage({ op: 7 });
      expect(sock0.closed).toBe(true);
      expect(created).toHaveLength(2); // reconnect happened without any timer advance
      await flush();

      const sock1 = created[1];
      hello(sock1, 40_000);
      expect(sock1.sentOps()[0].op).toBe(6); // RESUME
    });
  });

  describe("opcode 9 INVALID_SESSION", () => {
    it("d:false discards the session, waits a 1-5s injected-random delay, then re-IDENTIFYs", async () => {
      const { client, created, timers } = buildClient({ random: queueRandom([0.5, 0.25]) });
      await client.start();
      const sock0 = created[0];
      hello(sock0, 40_000); // consumes random() #1 (0.5) for jitter
      ready(sock0, "sess-inv", "wss://resume-host.example.com", 9);

      sock0.emitMessage({ op: 9, d: false }); // consumes random() #2 (0.25) for the delay
      expect(client.sessionInfo().sessionId).toBeNull();
      expect(client.state()).toBe("reconnect-wait");
      expect(sock0.closed).toBe(true);

      // delay = 1000 + 0.25*4000 = 2000ms exactly
      timers.advance(1_999);
      expect(created).toHaveLength(1);
      timers.advance(1);
      expect(created).toHaveLength(2);
      await flush();

      const sock1 = created[1];
      hello(sock1, 40_000);
      expect(sock1.sentOps()[0].op).toBe(2); // fresh IDENTIFY, not RESUME
    });

    it("d:true resumes immediately on a new connection", async () => {
      const { client, created } = buildClient({ random: queueRandom([0.5]) });
      await client.start();
      const sock0 = created[0];
      hello(sock0, 40_000);
      ready(sock0, "sess-inv2", "wss://resume-host.example.com", 2);

      sock0.emitMessage({ op: 9, d: true });
      expect(sock0.closed).toBe(true);
      expect(created).toHaveLength(2);
      await flush();

      const sock1 = created[1];
      hello(sock1, 40_000);
      expect(sock1.sentOps()[0].op).toBe(6); // RESUME
    });
  });

  describe("close-code policy", () => {
    for (const code of [4004, 4010, 4011, 4012, 4013, 4014]) {
      it(`treats close code ${code} as fatal: state -> failed, onStateChange fires, no reconnect`, async () => {
        const { client, created, timers, states } = buildClient({ random: queueRandom([0.5]) });
        await client.start();
        const sock0 = created[0];
        sock0.emitClose(code, "fatal");
        expect(client.state()).toBe("failed");
        expect(states).toContain("failed");
        timers.advance(10 * 60_000);
        expect(created).toHaveLength(1); // never reconnected
        expect(client.state()).toBe("failed");
      });
    }

    it("treats other 4xxx codes and network-level closes as resumable with capped exponential backoff (exact delay sequence)", async () => {
      const { client, created, timers } = buildClient({
        random: queueRandom([0.5, 0.5, 0.5, 0.5, 0.5]),
        maxReconnectDelayMs: 10_000,
      });
      await client.start();
      // attempt 0: base = min(1000*2^0,10000)=1000 -> delay=500
      created[0].emitClose(1006, "network drop");
      expect(client.state()).toBe("reconnect-wait");
      timers.advance(499);
      expect(created).toHaveLength(1);
      timers.advance(1);
      expect(created).toHaveLength(2);
      await flush(); // wireSocket() on created[1] must run before we can close it

      // attempt 1: base = min(2000,10000)=2000 -> delay=1000
      created[1].emitClose(4002, "not fatal");
      timers.advance(999);
      expect(created).toHaveLength(2);
      timers.advance(1);
      expect(created).toHaveLength(3);
      await flush();

      // attempt 2: base = min(4000,10000)=4000 -> delay=2000
      created[2].emitClose(1006, "network drop");
      timers.advance(1999);
      expect(created).toHaveLength(3);
      timers.advance(1);
      expect(created).toHaveLength(4);
      await flush();

      // attempt 3: base = min(8000,10000)=8000 -> delay=4000
      created[3].emitClose(1006, "network drop");
      timers.advance(3999);
      expect(created).toHaveLength(4);
      timers.advance(1);
      expect(created).toHaveLength(5);
      await flush();

      // attempt 4: base = min(16000,10000) capped=10000 -> delay=5000
      created[4].emitClose(1006, "network drop");
      timers.advance(4999);
      expect(created).toHaveLength(5);
      timers.advance(1);
      expect(created).toHaveLength(6);
    });

    it("gives up (state -> failed) once maxReconnectAttempts is exhausted", async () => {
      const { client, created, timers } = buildClient({
        random: queueRandom([0, 0, 0]),
        maxReconnectAttempts: 2,
      });
      await client.start();
      created[0].emitClose(1006, "drop 1"); // attempt 0 scheduled (reconnectAttempts: 0 -> 1)
      timers.advance(60_000);
      expect(created).toHaveLength(2);
      await flush();

      created[1].emitClose(1006, "drop 2"); // attempt 1 scheduled (reconnectAttempts: 1 -> 2)
      timers.advance(60_000);
      expect(created).toHaveLength(3);
      expect(client.state()).not.toBe("failed");
      await flush();

      // 3rd close: reconnectAttempts (2) >= maxReconnectAttempts (2) -> failed, no further reconnect.
      created[2].emitClose(1006, "drop 3");
      expect(client.state()).toBe("failed");
      timers.advance(10 * 60_000);
      expect(created).toHaveLength(3);
    });
  });

  describe("sequence number monotonicity", () => {
    it("only ever increases lastSeq, and a null-s dispatch never clobbers it", async () => {
      const { client, created } = buildClient({ random: queueRandom([0.5]) });
      await client.start();
      const sock = created[0];
      sock.emitMessage({ op: 0, s: 5, t: "SOME_EVENT", d: {} });
      expect(client.sessionInfo().lastSeq).toBe(5);
      sock.emitMessage({ op: 0, s: null, t: "OTHER_EVENT", d: {} });
      expect(client.sessionInfo().lastSeq).toBe(5);
      sock.emitMessage({ op: 0, s: 3, t: "OLD_EVENT", d: {} });
      expect(client.sessionInfo().lastSeq).toBe(5);
      sock.emitMessage({ op: 0, s: 10, t: "NEW_EVENT", d: {} });
      expect(client.sessionInfo().lastSeq).toBe(10);
    });
  });

  describe("stop()", () => {
    it("cancels every pending timer, closes with 1000, transitions to closed, ignores late close events, and supports restart", async () => {
      const { client, created, timers } = buildClient({ random: queueRandom([0.5]) });
      await client.start();
      const sock0 = created[0];
      hello(sock0, 40_000); // schedules a heartbeat timer
      ready(sock0, "sess-stop", "wss://resume-host.example.com", 1);
      expect(timers.pendingCount).toBeGreaterThan(0);

      await client.stop();
      expect(timers.pendingCount).toBe(0);
      expect(sock0.closeCode).toBe(1000);
      expect(client.state()).toBe("closed");

      // Late close arriving after stop() must not trigger a reconnect.
      sock0.emitClose(1000, "late arrival");
      timers.advance(10 * 60_000);
      expect(client.state()).toBe("closed");
      expect(created).toHaveLength(1);

      // start() after stop() works.
      await client.start();
      expect(created).toHaveLength(2);
      expect(client.state()).toBe("connecting");
    });

    it("double-start is a no-op: only one connection is opened", async () => {
      const { client, created } = buildClient({ random: queueRandom([0.5]) });
      const p1 = client.start();
      const p2 = client.start();
      await Promise.all([p1, p2]);
      expect(created).toHaveLength(1);
    });
  });

  describe("malformed input resilience", () => {
    it("logs and skips malformed JSON and unknown opcodes without crashing", async () => {
      const { client, created, logLines } = buildClient({ random: queueRandom([0.5]) });
      await client.start();
      const sock = created[0];

      expect(() => sock.emitRaw("{ this is not json")).not.toThrow();
      expect(logLines.some((l) => /malformed/i.test(l))).toBe(true);

      expect(() => sock.emitMessage({ op: 9999, d: null })).not.toThrow();
      expect(logLines.some((l) => /unknown/i.test(l))).toBe(true);

      // The connection is still usable afterward.
      hello(sock, 40_000);
      expect(client.state()).toBe("identifying");
      expect(sock.sentOps().some((p) => p.op === 2)).toBe(true);
    });
  });

  describe("token secrecy", () => {
    it("never leaks the raw bot token into any log line, across a full multi-path run", async () => {
      const { client, created, timers, logLines } = buildClient({ random: queueRandom([0.5, 0.5, 0.5, 0.5]) });
      await client.start();
      const sock0 = created[0];
      hello(sock0, 40_000);
      ready(sock0, "sess-log", "wss://resume-host.example.com", 1);

      // exercise: malformed input, unknown opcode, zombie, invalid session, fatal close.
      sock0.emitRaw("not json {{{");
      sock0.emitMessage({ op: 12345 });
      timers.advance(20_000);
      sock0.emitMessage({ op: 11 });
      timers.advance(40_000); // beat, unacked
      timers.advance(40_000); // zombie -> reconnect
      expect(created.length).toBeGreaterThanOrEqual(2);
      await flush();
      const sock1 = created[1];
      hello(sock1, 40_000);
      sock1.emitMessage({ op: 9, d: false }); // schedules a delayed re-IDENTIFY (delay = 1000 + 0.5*4000 = 3000ms)
      timers.advance(3_000);
      await flush();
      expect(created.length).toBeGreaterThanOrEqual(3);
      const sock2 = created[2];
      hello(sock2, 40_000);
      sock2.emitClose(4004, "authentication failed");

      // Also feed an error whose message itself contains the raw token, to
      // prove redaction applies to arbitrary injected error text too.
      const { client: client2, created: created2 } = buildClient({ random: queueRandom([0.5]) });
      const logLines2: string[] = [];
      // Re-create with a socketFactory that rejects with a token-bearing error.
      const rejectingFactory: DiscordSocketFactory = async () => {
        throw new Error(`connect failed for token ${TOKEN}`);
      };
      const clientWithBadFactory = new DiscordGatewayClient({
        token: TOKEN,
        socketFactory: rejectingFactory,
        onDispatch: () => {},
        log: (l) => logLines2.push(l),
        timers: new FakeTimers(),
        random: queueRandom([0.5]),
      });
      await clientWithBadFactory.start();
      void client2;
      void created2;

      const allLines = [...logLines, ...logLines2];
      expect(allLines.length).toBeGreaterThan(0);
      for (const line of allLines) {
        expect(line.includes(TOKEN)).toBe(false);
      }
      expect(logLines2.some((l) => l.includes("[REDACTED_TOKEN]"))).toBe(true);
    });
  });

  describe("IDENTIFY payload", () => {
    it("includes token, intents, and properties {os, browser: 'hades', device: 'hades'}", async () => {
      const { client, created } = buildClient({ random: queueRandom([0.5]) });
      await client.start();
      const sock = created[0];
      hello(sock, 40_000);
      const sent = sock.sentOps();
      expect(sent).toHaveLength(1);
      expect(sent[0].op).toBe(2);
      const d = sent[0].d as { token: string; intents: number; properties: { os: string; browser: string; device: string } };
      expect(d.token).toBe(TOKEN);
      expect(d.intents).toBe(DISCORD_DEFAULT_INTENTS);
      expect(d.properties.browser).toBe("hades");
      expect(d.properties.device).toBe("hades");
      expect(typeof d.properties.os).toBe("string");
      expect(d.properties.os.length).toBeGreaterThan(0);
    });

    it("DISCORD_DEFAULT_INTENTS matches GUILDS | GUILD_MESSAGES | DIRECT_MESSAGES | MESSAGE_CONTENT", () => {
      expect(DISCORD_DEFAULT_INTENTS).toBe((1 << 0) | (1 << 9) | (1 << 12) | (1 << 15));
      expect(DISCORD_DEFAULT_INTENTS).toBe(37377);
    });
  });

  describe("state observability", () => {
    it("fires onStateChange for every transition, in order", async () => {
      const { client, created, timers, states } = buildClient({ random: queueRandom([0.5]) });
      await client.start();
      const sock0 = created[0];
      hello(sock0, 40_000);
      ready(sock0, "sess-obs", "wss://resume-host.example.com", 1);

      // Force a zombie -> reconnect+resume -> ready cycle.
      timers.advance(40_000); // beat #1 (unacked)
      timers.advance(40_000); // zombie -> new connection
      await flush();
      const sock1 = created[1];
      hello(sock1, 40_000);
      sock1.emitMessage({ op: 0, s: 2, t: "RESUMED", d: {} });

      await client.stop();

      expect(states).toEqual(["connecting", "identifying", "ready", "connecting", "resuming", "ready", "closed"]);
    });
  });
});

describe("attachDiscordConnector", () => {
  function fakeTransport(): DiscordTransport & { sent: Array<{ channelId: string; text: string }> } {
    const sent: Array<{ channelId: string; text: string }> = [];
    return {
      sent,
      async createMessage(channelId: string, text: string) {
        sent.push({ channelId, text });
      },
    };
  }

  it("routes MESSAGE_CREATE dispatches end-to-end into a DiscordConnector (dispatch -> ingest -> handler -> reply)", async () => {
    const { client, created } = buildClient({ random: queueRandom([0.5]) });
    const transport = fakeTransport();
    const connector = new DiscordConnector(transport);
    const handler = async (m: InboundMessage): Promise<OutboundReply> => ({ text: `echo:${m.text}`, accepted: true });
    await connector.start(handler);

    const detach = attachDiscordConnector(client, connector);
    await client.start();
    const sock = created[0];
    hello(sock, 40_000);

    sock.emitMessage({
      op: 0,
      s: 1,
      t: "MESSAGE_CREATE",
      d: { author: { id: "U1" }, channel_id: "C1", content: "hi there" },
    });
    await flush();

    expect(transport.sent).toEqual([{ channelId: "C1", text: "echo:hi there" }]);

    void detach;
  });

  it("isolates a throwing ingest so the dispatch loop keeps flowing", async () => {
    const { client, created } = buildClient({ random: queueRandom([0.5]) });
    const transport = fakeTransport();
    const connector = new DiscordConnector(transport);
    const handler = async (m: InboundMessage): Promise<OutboundReply> => {
      if (m.text === "boom") throw new Error("handler exploded");
      return { text: `echo:${m.text}`, accepted: true };
    };
    await connector.start(handler);

    const logLines: string[] = [];
    attachDiscordConnector(client, connector, (l) => logLines.push(l));
    await client.start();
    const sock = created[0];
    hello(sock, 40_000);

    sock.emitMessage({ op: 0, s: 1, t: "MESSAGE_CREATE", d: { author: { id: "U1" }, channel_id: "C1", content: "boom" } });
    await flush();
    expect(transport.sent).toHaveLength(0);

    sock.emitMessage({ op: 0, s: 2, t: "MESSAGE_CREATE", d: { author: { id: "U1" }, channel_id: "C1", content: "still-alive" } });
    await flush();
    expect(transport.sent).toEqual([{ channelId: "C1", text: "echo:still-alive" }]);
  });

  it("detach() stops forwarding further dispatches", async () => {
    const { client, created } = buildClient({ random: queueRandom([0.5]) });
    const transport = fakeTransport();
    const connector = new DiscordConnector(transport);
    const handler = async (m: InboundMessage): Promise<OutboundReply> => ({ text: `echo:${m.text}`, accepted: true });
    await connector.start(handler);

    const detach = attachDiscordConnector(client, connector);
    await client.start();
    const sock = created[0];
    hello(sock, 40_000);

    sock.emitMessage({ op: 0, s: 1, t: "MESSAGE_CREATE", d: { author: { id: "U1" }, channel_id: "C1", content: "one" } });
    await flush();
    expect(transport.sent).toHaveLength(1);

    detach();
    sock.emitMessage({ op: 0, s: 2, t: "MESSAGE_CREATE", d: { author: { id: "U1" }, channel_id: "C1", content: "two" } });
    await flush();
    expect(transport.sent).toHaveLength(1); // unchanged
  });

  it("ignores non-MESSAGE_CREATE dispatches", async () => {
    const { client, created } = buildClient({ random: queueRandom([0.5]) });
    const transport = fakeTransport();
    const connector = new DiscordConnector(transport);
    await connector.start(async (m) => ({ text: `echo:${m.text}`, accepted: true }));
    attachDiscordConnector(client, connector);
    await client.start();
    const sock = created[0];
    hello(sock, 40_000);
    sock.emitMessage({ op: 0, s: 1, t: "TYPING_START", d: { user_id: "U1", channel_id: "C1" } });
    await flush();
    expect(transport.sent).toHaveLength(0);
  });
});

describe("smoke: fresh client starts idle", () => {
  beforeEach(() => {
    // no-op; ensures describe-level isolation between top-level suites
  });
  it("reports state idle before start() is called", () => {
    const { client } = buildClient();
    expect(client.state()).toBe("idle");
    expect(client.heartbeatStats()).toEqual({ sent: 0, acked: 0, missedInARow: 0 });
    expect(client.sessionInfo()).toEqual({ sessionId: null, resumeGatewayUrl: null, lastSeq: null });
  });
});
