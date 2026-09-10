import { describe, it, expect } from "vitest";
import { ChunkingConnector, withChunking } from "../gateway/chunked-delivery";
import { chunkMessage, platformFormat } from "../gateway/message-format";
import { ConnectorHub, type Mirror } from "../gateway/connector";
import type { PlatformConnector, DeliveryTarget } from "../gateway/connector";
import { TelegramConnector } from "../gateway/connectors/telegram";
import type { TelegramTransport, TelegramUpdate } from "../gateway/connectors/telegram";
import { DiscordConnector } from "../gateway/connectors/discord";
import type { DiscordTransport } from "../gateway/connectors/discord";
import { SignalConnector } from "../gateway/connectors/signal";
import type { SignalTransport, SignalEnvelope } from "../gateway/connectors/signal";
import type { InboundMessage, OutboundReply, GatewayPlatform } from "../../swarm-runtime/gateway/gateway";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

/** A generous multi-paragraph body, long enough to force chunking on every
 * platform's limit (telegram 4096 / discord 2000 / signal 2000). */
function buildLongBody(paragraphs: number): string {
  const sentence =
    "The quick brown fox jumps over the lazy dog and keeps running through the verification gate. ";
  const para = sentence.repeat(4).trim();
  return Array.from({ length: paragraphs }, (_, i) => `${para} (paragraph ${i + 1})`).join("\n\n");
}

/** A BadgeStamper-shaped trailing verified line, exactly as ./badge.ts renders it. */
const BADGE_LINE = "✅ *verified* — p≥0.92 · cert 1a2b3c4d5e6f";

function buildStampedOverLimitReply(paragraphs = 25): string {
  return `${buildLongBody(paragraphs)}\n\n${BADGE_LINE}`;
}

const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const MARKER_RE = /^(.*) \((\d+)\/(\d+)\)$/s;

/** Strip a chunk's trailing " (i/n)" marker (if any), returning the body and parsed i/n. */
function parseMarker(chunk: string): { body: string; i?: number; n?: number } {
  const m = MARKER_RE.exec(chunk);
  if (!m) return { body: chunk };
  return { body: m[1], i: Number(m[2]), n: Number(m[3]) };
}

/** A minimal fake PlatformConnector — records every send(), can be told to throw on a 1-indexed call. */
function fakeConnector(
  platform: GatewayPlatform,
  opts: { failOnCall?: number } = {},
): PlatformConnector & { sent: Array<{ target: DeliveryTarget; text: string }>; calls: number } {
  const sent: Array<{ target: DeliveryTarget; text: string }> = [];
  let calls = 0;
  return {
    platform,
    sent,
    get calls() {
      return calls;
    },
    async start() {
      // not exercised in the fakeConnector.send() tests
    },
    async send(target, text) {
      calls += 1;
      if (opts.failOnCall !== undefined && calls === opts.failOnCall) {
        throw new Error(`fakeConnector: simulated transport failure on call ${calls}`);
      }
      sent.push({ target, text });
    },
    async stop() {
      // no-op
    },
  };
}

// ---------------------------------------------------------------------------
// ChunkingConnector.send()
// ---------------------------------------------------------------------------

describe("ChunkingConnector.send()", () => {
  it("chunks over-limit text into N size-legal, marked, ordered pieces and forwards them sequentially", async () => {
    const inner = fakeConnector("discord");
    const chunker = new ChunkingConnector(inner);
    const text = buildStampedOverLimitReply(20);
    const target: DeliveryTarget = { user: "u1", channel: "c1" };

    await chunker.send(target, text);

    const expected = chunkMessage(text, "discord");
    expect(expected.length).toBeGreaterThan(1); // sanity: this text really does need chunking
    expect(inner.sent.map((s) => s.text)).toEqual(expected);

    const { maxChars } = platformFormat("discord");
    for (const s of inner.sent) {
      expect(s.text.length).toBeLessThanOrEqual(maxChars);
      expect(s.target).toEqual(target);
    }

    // Every chunk carries its (i/n) marker, in strict 1..n order.
    const parsed = inner.sent.map((s) => parseMarker(s.text));
    expect(parsed.every((p) => p.i !== undefined && p.n === expected.length)).toBe(true);
    expect(parsed.map((p) => p.i)).toEqual(Array.from({ length: expected.length }, (_, k) => k + 1));

    // The badge line survives intact, unsplit, inside the final chunk.
    const last = inner.sent[inner.sent.length - 1].text;
    expect(last).toContain(BADGE_LINE);
    // No earlier chunk contains any fragment of the badge marker.
    for (const s of inner.sent.slice(0, -1)) {
      expect(s.text).not.toContain("verified");
    }
  });

  it("sends nothing for empty text", async () => {
    const inner = fakeConnector("telegram");
    const chunker = new ChunkingConnector(inner);
    await chunker.send({ user: "u1" }, "");
    expect(inner.sent).toEqual([]);
    expect(inner.calls).toBe(0);
  });

  it("passes an under-limit message through as a single, unmarked, byte-identical send", async () => {
    const inner = fakeConnector("signal");
    const chunker = new ChunkingConnector(inner);
    const short = "hello from the swarm";
    await chunker.send({ user: "u1" }, short);
    expect(inner.sent).toEqual([{ target: { user: "u1" }, text: short }]);
    expect(inner.calls).toBe(1);
  });

  it("delivers platform() from the inner connector, unmodified", () => {
    const inner = fakeConnector("signal");
    const chunker = new ChunkingConnector(inner);
    expect(chunker.platform).toBe("signal");
  });

  it("stops immediately and rethrows a named error on a mid-sequence failure, without retrying", async () => {
    const inner = fakeConnector("discord", { failOnCall: 2 });
    const chunker = new ChunkingConnector(inner);
    const text = buildStampedOverLimitReply(20);
    const expected = chunkMessage(text, "discord");
    const n = expected.length;
    expect(n).toBeGreaterThanOrEqual(3); // need at least one never-attempted chunk to prove the point

    await expect(chunker.send({ user: "u1" }, text)).rejects.toThrow(
      new RegExp(`discord.*chunk 2/${n}`, "s"),
    );

    // Exactly one chunk was actually delivered (call 1 succeeded before call 2 threw).
    expect(inner.sent.length).toBe(1);
    expect(inner.sent[0].text).toBe(expected[0]);
    // The connector never attempted chunk 3 or beyond — total calls stop at the failing one.
    expect(inner.calls).toBe(2);
  });

  it("never splits an astral codepoint into a lone surrogate on the wire", async () => {
    const inner = fakeConnector("signal"); // maxChars 2000
    const chunker = new ChunkingConnector(inner);
    // No spaces/newlines anywhere, so chunkMessage is forced into its hard-split
    // path (no paragraph/line/word boundary available near the limit).
    const emoji = "😀"; // surrogate pair, 2 UTF-16 code units
    const text = emoji.repeat(1400); // ~2800 code units, over the 2000 limit
    await chunker.send({ user: "u1" }, text);

    expect(inner.sent.length).toBeGreaterThan(1);
    const { maxChars } = platformFormat("signal");
    for (const s of inner.sent) {
      expect(s.text.length).toBeLessThanOrEqual(maxChars);
      const { body } = parseMarker(s.text);
      expect(LONE_SURROGATE_RE.test(body)).toBe(false);
    }
    // Reassembling every chunk's body (marker stripped) reproduces the original text exactly.
    const rebuilt = inner.sent.map((s) => parseMarker(s.text).body).join("");
    expect(rebuilt).toBe(text);
  });
});

// ---------------------------------------------------------------------------
// ChunkingConnector.start() — real connectors, fake transports
// ---------------------------------------------------------------------------

describe("ChunkingConnector.start() over real connectors", () => {
  it("TelegramConnector: an over-limit reply arrives as N marked sendMessage calls, each within 4096 chars", async () => {
    const sent: Array<{ chatId: string; text: string }> = [];
    const transport: TelegramTransport = {
      async getUpdates() {
        return [];
      },
      async sendMessage(chatId, text) {
        sent.push({ chatId, text });
      },
    };
    const telegram = new TelegramConnector(transport);
    const chunker = new ChunkingConnector(telegram);

    const bigReply = buildStampedOverLimitReply(30);
    const handler = async (_m: InboundMessage): Promise<OutboundReply> => ({ text: bigReply, accepted: true });

    // Drive updates via the transport's queue by re-wiring getUpdates for this call.
    const updates: TelegramUpdate[] = [
      { update_id: 1, message: { from: { id: 7 }, chat: { id: 700 }, text: "give me the long answer" } },
    ];
    let drained = false;
    (transport as { getUpdates: TelegramTransport["getUpdates"] }).getUpdates = async () => {
      if (drained) return [];
      drained = true;
      return updates;
    };

    await chunker.start(handler);
    await telegram.pollOnce();

    const expected = chunkMessage(bigReply, "telegram");
    expect(expected.length).toBeGreaterThan(1);
    expect(sent.map((s) => s.text)).toEqual(expected);
    expect(sent.every((s) => s.chatId === "700")).toBe(true);

    const { maxChars } = platformFormat("telegram");
    for (const s of sent) expect(s.text.length).toBeLessThanOrEqual(maxChars);
    expect(sent[sent.length - 1].text).toContain(BADGE_LINE);

    await chunker.stop();
  });

  it("DiscordConnector: an over-limit reply arrives as N marked createMessage calls, each within 2000 chars", async () => {
    const sent: Array<{ channelId: string; text: string }> = [];
    const transport: DiscordTransport = {
      async createMessage(channelId, text) {
        sent.push({ channelId, text });
      },
    };
    const discord = new DiscordConnector(transport);
    const chunker = new ChunkingConnector(discord);

    const bigReply = buildStampedOverLimitReply(25);
    const handler = async (_m: InboundMessage): Promise<OutboundReply> => ({ text: bigReply, accepted: true });
    await chunker.start(handler);

    await discord.ingest({ author: { id: "u9" }, channel_id: "chan9", content: "long please" });

    const expected = chunkMessage(bigReply, "discord");
    expect(expected.length).toBeGreaterThan(1);
    expect(sent.map((s) => s.text)).toEqual(expected);
    expect(sent.every((s) => s.channelId === "chan9")).toBe(true);
    const { maxChars } = platformFormat("discord");
    for (const s of sent) expect(s.text.length).toBeLessThanOrEqual(maxChars);
    expect(sent[sent.length - 1].text).toContain(BADGE_LINE);

    await chunker.stop();
  });

  it("SignalConnector: an over-limit reply arrives as N marked send calls, each within 2000 chars", async () => {
    const sent: Array<{ recipient: string; text: string }> = [];
    let queue: SignalEnvelope[] = [
      { envelope: { source: "+15550001111", dataMessage: { message: "long please" } } },
    ];
    const transport: SignalTransport = {
      async receive() {
        const batch = queue;
        queue = [];
        return batch;
      },
      async send(recipient, text) {
        sent.push({ recipient, text });
      },
    };
    const signal = new SignalConnector(transport);
    const chunker = new ChunkingConnector(signal);

    const bigReply = buildStampedOverLimitReply(25);
    const handler = async (_m: InboundMessage): Promise<OutboundReply> => ({ text: bigReply, accepted: true });
    await chunker.start(handler);
    await signal.pollOnce();

    const expected = chunkMessage(bigReply, "signal");
    expect(expected.length).toBeGreaterThan(1);
    expect(sent.map((s) => s.text)).toEqual(expected);
    expect(sent.every((s) => s.recipient === "+15550001111")).toBe(true);
    const { maxChars } = platformFormat("signal");
    for (const s of sent) expect(s.text.length).toBeLessThanOrEqual(maxChars);
    expect(sent[sent.length - 1].text).toContain(BADGE_LINE);

    await chunker.stop();
  });

  it("leaves an under-limit reply byte-identical with exactly one transport call (no decorator overhead)", async () => {
    const sent: Array<{ chatId: string; text: string }> = [];
    let queue: TelegramUpdate[] = [
      { update_id: 1, message: { from: { id: 1 }, chat: { id: 1 }, text: "hi" } },
    ];
    const transport: TelegramTransport = {
      async getUpdates() {
        const batch = queue;
        queue = [];
        return batch;
      },
      async sendMessage(chatId, text) {
        sent.push({ chatId, text });
      },
    };
    const telegram = new TelegramConnector(transport);
    const chunker = new ChunkingConnector(telegram);
    const short = "short and sweet";
    const handler = async (_m: InboundMessage): Promise<OutboundReply> => ({ text: short, accepted: true });
    await chunker.start(handler);
    await telegram.pollOnce();

    expect(sent).toEqual([{ chatId: "1", text: short }]);
    await chunker.stop();
  });

  it("sends nothing for an ignored/unauthorized (empty-text) reply", async () => {
    const sent: Array<{ channelId: string; text: string }> = [];
    const transport: DiscordTransport = {
      async createMessage(channelId, text) {
        sent.push({ channelId, text });
      },
    };
    const discord = new DiscordConnector(transport);
    const chunker = new ChunkingConnector(discord);
    const handler = async (_m: InboundMessage): Promise<OutboundReply> => ({ text: "", accepted: false });
    await chunker.start(handler);
    await discord.ingest({ author: { id: "u1" }, channel_id: "c1", content: "not authorized" });
    expect(sent).toEqual([]);
    await chunker.stop();
  });

  it("mid-sequence transport failure during a reply surfaces a named error, with prior chunks delivered and later ones never attempted", async () => {
    const sent: Array<{ channelId: string; text: string }> = [];
    let callCount = 0;
    const transport: DiscordTransport = {
      async createMessage(channelId, text) {
        callCount += 1;
        if (callCount === 2) throw new Error("simulated discord 429");
        sent.push({ channelId, text });
      },
    };
    const discord = new DiscordConnector(transport);
    const chunker = new ChunkingConnector(discord);
    const bigReply = buildStampedOverLimitReply(25);
    const expected = chunkMessage(bigReply, "discord");
    expect(expected.length).toBeGreaterThanOrEqual(4);
    const handler = async (_m: InboundMessage): Promise<OutboundReply> => ({ text: bigReply, accepted: true });
    await chunker.start(handler);

    await expect(
      discord.ingest({ author: { id: "u1" }, channel_id: "c1", content: "long please" }),
    ).rejects.toThrow(/discord.*chunk 2\//s);

    expect(sent.length).toBe(1);
    expect(sent[0].text).toBe(expected[0]);
    expect(callCount).toBe(2); // chunks 3..n were never attempted

    await chunker.stop();
  });
});

// ---------------------------------------------------------------------------
// ConnectorHub integration: proactive deliver() + mirror/counter semantics
// ---------------------------------------------------------------------------

describe("ChunkingConnector through ConnectorHub", () => {
  it("hub.deliver() (proactive send) chunks identically to the reply path", async () => {
    const sent: Array<{ chatId: string; text: string }> = [];
    const transport: TelegramTransport = {
      async getUpdates() {
        return [];
      },
      async sendMessage(chatId, text) {
        sent.push({ chatId, text });
      },
    };
    const telegram = new TelegramConnector(transport);
    const chunker = new ChunkingConnector(telegram);
    const handler = async (_m: InboundMessage): Promise<OutboundReply> => ({ text: "", accepted: false });
    const hub = new ConnectorHub(handler);
    hub.register(chunker);
    await hub.startAll();

    const bigReply = buildStampedOverLimitReply(25);
    const ok = await hub.deliver("telegram", { user: "u1", channel: "555" }, bigReply);
    expect(ok).toBe(true);

    const expected = chunkMessage(bigReply, "telegram");
    expect(expected.length).toBeGreaterThan(1);
    expect(sent.map((s) => s.text)).toEqual(expected);
    expect(sent.every((s) => s.chatId === "555")).toBe(true);

    await hub.stopAll();
  });

  it("mirrors/increments the outbound counter exactly once per reply, not once per chunk", async () => {
    const sent: Array<{ chatId: string; text: string }> = [];
    let queue: TelegramUpdate[] = [
      { update_id: 1, message: { from: { id: 1 }, chat: { id: 1 }, text: "long please" } },
    ];
    const transport: TelegramTransport = {
      async getUpdates() {
        const batch = queue;
        queue = [];
        return batch;
      },
      async sendMessage(chatId, text) {
        sent.push({ chatId, text });
      },
    };
    const telegram = new TelegramConnector(transport);
    const chunker = new ChunkingConnector(telegram);

    const bigReply = buildStampedOverLimitReply(25);
    const handler = async (_m: InboundMessage): Promise<OutboundReply> => ({ text: bigReply, accepted: true });

    // Mirror/counter shape matches GatewayProcess's own inbound/outbound bookkeeping.
    const counters = { inbound: 0, outbound: 0 };
    const mirror: Mirror = (event) => {
      if (event.direction === "in") counters.inbound += 1;
      else counters.outbound += 1;
    };
    const hub = new ConnectorHub(handler, { mirror });
    hub.register(chunker);
    await hub.startAll();
    await telegram.pollOnce();

    const expectedChunks = chunkMessage(bigReply, "telegram");
    expect(expectedChunks.length).toBeGreaterThan(1);
    // The wire really did carry N (>1) sends...
    expect(sent.length).toBe(expectedChunks.length);
    // ...but the hub's own counters only ever saw the one inbound message and
    // the one reply — chunking is a wire-level concern invisible to the mirror.
    expect(counters.inbound).toBe(1);
    expect(counters.outbound).toBe(1);

    await hub.stopAll();
  });
});

// ---------------------------------------------------------------------------
// withChunking()
// ---------------------------------------------------------------------------

describe("withChunking()", () => {
  it("wraps each connector in a ChunkingConnector", () => {
    const inner = fakeConnector("telegram");
    const [wrapped] = withChunking([inner]);
    expect(wrapped).toBeInstanceOf(ChunkingConnector);
    expect(wrapped.platform).toBe("telegram");
  });

  it("is idempotent: wrapping an already-wrapped connector does not double-wrap or double-mark chunks", async () => {
    const inner = fakeConnector("discord");
    const wrappedOnce = withChunking([inner]);
    const wrappedTwice = withChunking(wrappedOnce);

    // Same instances, not fresh wrappers.
    expect(wrappedTwice[0]).toBe(wrappedOnce[0]);

    const text = buildStampedOverLimitReply(20);
    const expected = chunkMessage(text, "discord");
    await wrappedTwice[0].send({ user: "u1" }, text);

    // Exactly N sends reached the real inner connector — not N re-chunked-again sends,
    // and no chunk carries a doubled "(i/n) (i/n)" marker.
    expect(inner.sent.map((s) => s.text)).toEqual(expected);
    for (const s of inner.sent) {
      const matches = s.text.match(/\(\d+\/\d+\)/g) ?? [];
      expect(matches.length).toBeLessThanOrEqual(1);
    }
  });

  it("wrapping a mixed list only wraps the connectors that need it", () => {
    const rawTelegram = fakeConnector("telegram");
    const alreadyWrapped = new ChunkingConnector(fakeConnector("discord"));
    const [a, b] = withChunking([rawTelegram, alreadyWrapped]);
    expect(a).toBeInstanceOf(ChunkingConnector);
    expect((a as ChunkingConnector).platform).toBe("telegram");
    expect(b).toBe(alreadyWrapped);
  });
});
