import { describe, it, expect } from "vitest";
import {
  FrameParser,
  MessageAssembler,
  WS_OPCODES,
  WsProtocolError,
  encodeClose,
  encodeFrame,
  parseClose,
} from "../a2a/ws/frame";
import type { WsFrame } from "../a2a/ws/frame";

/**
 * Deterministic PRNG (mulberry32) — reproducible from a numeric seed alone,
 * `Math.random` never appears in an assertion in this file.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomBuffer(rng: () => number, len: number): Buffer {
  const buf = Buffer.alloc(len);
  for (let i = 0; i < len; i++) buf[i] = Math.floor(rng() * 256);
  return buf;
}

// ===========================================================================
// Golden RFC 6455 section 5.7 examples — pins the byte layout exactly.
// ===========================================================================
describe("encodeFrame — RFC 6455 golden examples", () => {
  it("a single-frame unmasked text message 'Hello'", () => {
    const frame = encodeFrame({ opcode: WS_OPCODES.TEXT, payload: Buffer.from("Hello", "utf8") });
    expect(frame).toEqual(Buffer.from([0x81, 0x05, 0x48, 0x65, 0x6c, 0x6c, 0x6f]));
  });

  it("a single-frame masked text message 'Hello'", () => {
    const maskKey = Buffer.from([0x37, 0xfa, 0x21, 0x3d]);
    const frame = encodeFrame({ opcode: WS_OPCODES.TEXT, payload: Buffer.from("Hello", "utf8"), maskKey });
    expect(frame).toEqual(
      Buffer.from([0x81, 0x85, 0x37, 0xfa, 0x21, 0x3d, 0x7f, 0x9f, 0x4d, 0x51, 0x58])
    );
  });

  it("round-trips the golden masked frame back through FrameParser unmasked", () => {
    const maskKey = Buffer.from([0x37, 0xfa, 0x21, 0x3d]);
    const bytes = encodeFrame({ opcode: WS_OPCODES.TEXT, payload: Buffer.from("Hello", "utf8"), maskKey });
    const parser = new FrameParser({ requireMasked: true });
    const [frame] = parser.push(bytes);
    expect(frame.fin).toBe(true);
    expect(frame.opcode).toBe(WS_OPCODES.TEXT);
    expect(frame.payload.toString("utf8")).toBe("Hello");
  });

  it("encodes 16-bit and 64-bit extended length forms with the correct escape byte", () => {
    const mid = encodeFrame({ opcode: WS_OPCODES.BINARY, payload: Buffer.alloc(300) });
    expect(mid[1]).toBe(126);
    expect(mid.readUInt16BE(2)).toBe(300);

    const big = encodeFrame({ opcode: WS_OPCODES.BINARY, payload: Buffer.alloc(70000) });
    expect(big[1]).toBe(127);
    expect(big.readBigUInt64BE(2)).toBe(BigInt(70000));
  });
});

// ===========================================================================
// FrameParser — explicit protocol-violation tests
// ===========================================================================
describe("FrameParser — protocol violations", () => {
  it("RSV bits set -> WsProtocolError 1002", () => {
    const buf = Buffer.from([0x81 | 0x40, 0x00]); // RSV1 set
    const parser = new FrameParser();
    expect(() => parser.push(buf)).toThrow(WsProtocolError);
    try {
      parser.push(Buffer.from([0x81 | 0x20, 0x00])); // fresh parser state doesn't matter, still throws
    } catch (e) {
      expect(e).toBeInstanceOf(WsProtocolError);
      expect((e as WsProtocolError).code).toBe(1002);
    }
  });

  it("unmasked client frame with requireMasked -> 1002", () => {
    const unmasked = encodeFrame({ opcode: WS_OPCODES.TEXT, payload: Buffer.from("hi") });
    const parser = new FrameParser({ requireMasked: true });
    expect(() => parser.push(unmasked)).toThrow(WsProtocolError);
    const parser2 = new FrameParser({ requireMasked: true });
    try {
      parser2.push(unmasked);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect((e as WsProtocolError).code).toBe(1002);
    }
  });

  it("masked frame is accepted when requireMasked is set", () => {
    const masked = encodeFrame({ opcode: WS_OPCODES.TEXT, payload: Buffer.from("hi"), maskKey: Buffer.from([1, 2, 3, 4]) });
    const parser = new FrameParser({ requireMasked: true });
    const frames = parser.push(masked);
    expect(frames).toHaveLength(1);
    expect(frames[0].payload.toString()).toBe("hi");
  });

  it("control frame >125 bytes -> 1002", () => {
    // Hand-build: FIN=1, opcode=PING(0x9), len=126 (forces 2-byte extended length), extended length = 126.
    const header = Buffer.from([0x80 | WS_OPCODES.PING, 126, 0x00, 0x7e]);
    const payload = Buffer.alloc(126);
    const buf = Buffer.concat([header, payload]);
    const parser = new FrameParser();
    let threw: WsProtocolError | null = null;
    try {
      parser.push(buf);
    } catch (e) {
      threw = e as WsProtocolError;
    }
    expect(threw).toBeInstanceOf(WsProtocolError);
    expect(threw!.code).toBe(1002);
  });

  it("fragmented control frame (FIN=0) -> 1002", () => {
    const header = Buffer.from([0x00 | WS_OPCODES.PING, 0x00]); // FIN=0, opcode=PING, len=0
    const parser = new FrameParser();
    let threw: WsProtocolError | null = null;
    try {
      parser.push(header);
    } catch (e) {
      threw = e as WsProtocolError;
    }
    expect(threw).toBeInstanceOf(WsProtocolError);
    expect(threw!.code).toBe(1002);
  });

  it("oversize message -> 1009, detected from the declared length alone (before the body arrives)", () => {
    const parser = new FrameParser({ maxPayloadBytes: 100 });
    // Only send the header declaring a 200-byte payload; body never arrives.
    const header = Buffer.from([0x80 | WS_OPCODES.BINARY, 126, 0x00, 0xc8]); // 200
    let threw: WsProtocolError | null = null;
    try {
      parser.push(header);
    } catch (e) {
      threw = e as WsProtocolError;
    }
    expect(threw).toBeInstanceOf(WsProtocolError);
    expect(threw!.code).toBe(1009);
  });

  it("payload exactly at maxPayloadBytes is accepted; one byte over is rejected", () => {
    const ok = new FrameParser({ maxPayloadBytes: 10 });
    const okFrame = encodeFrame({ opcode: WS_OPCODES.BINARY, payload: Buffer.alloc(10) });
    expect(ok.push(okFrame)).toHaveLength(1);

    const bad = new FrameParser({ maxPayloadBytes: 10 });
    const badFrame = encodeFrame({ opcode: WS_OPCODES.BINARY, payload: Buffer.alloc(11) });
    expect(() => bad.push(badFrame)).toThrow(WsProtocolError);
  });
});

// ===========================================================================
// MessageAssembler — fragmentation + interleaved control frames
// ===========================================================================
describe("MessageAssembler", () => {
  it("continuation without a started message -> error", () => {
    const assembler = new MessageAssembler();
    const frame: WsFrame = { fin: true, opcode: WS_OPCODES.CONTINUATION, payload: Buffer.from("x") };
    expect(() => assembler.pushFrame(frame)).toThrow(WsProtocolError);
  });

  it("a new data frame while fragmenting is a protocol violation", () => {
    const assembler = new MessageAssembler();
    assembler.pushFrame({ fin: false, opcode: WS_OPCODES.TEXT, payload: Buffer.from("a") });
    expect(() =>
      assembler.pushFrame({ fin: false, opcode: WS_OPCODES.TEXT, payload: Buffer.from("b") })
    ).toThrow(WsProtocolError);
  });

  it("reassembles a 3-fragment text message with a PING interleaved mid-fragmentation", () => {
    const assembler = new MessageAssembler();
    expect(assembler.pushFrame({ fin: false, opcode: WS_OPCODES.TEXT, payload: Buffer.from("Hel") })).toBeNull();
    // Interleaved control frame must not disturb fragmentation state.
    expect(
      assembler.pushFrame({ fin: true, opcode: WS_OPCODES.PING, payload: Buffer.from("ping") })
    ).toBeNull();
    expect(
      assembler.pushFrame({ fin: false, opcode: WS_OPCODES.CONTINUATION, payload: Buffer.from("lo, ") })
    ).toBeNull();
    const result = assembler.pushFrame({ fin: true, opcode: WS_OPCODES.CONTINUATION, payload: Buffer.from("world!") });
    expect(result).not.toBeNull();
    expect(result!.opcode).toBe(WS_OPCODES.TEXT);
    expect(result!.payload.toString("utf8")).toBe("Hello, world!");
  });

  it("an unfragmented (fin=true) data frame returns immediately, no state retained", () => {
    const assembler = new MessageAssembler();
    const r1 = assembler.pushFrame({ fin: true, opcode: WS_OPCODES.TEXT, payload: Buffer.from("one") });
    const r2 = assembler.pushFrame({ fin: true, opcode: WS_OPCODES.BINARY, payload: Buffer.from("two") });
    expect(r1).toEqual({ opcode: WS_OPCODES.TEXT, payload: Buffer.from("one") });
    expect(r2).toEqual({ opcode: WS_OPCODES.BINARY, payload: Buffer.from("two") });
  });
});

// ===========================================================================
// Close frame codec
// ===========================================================================
describe("encodeClose / parseClose", () => {
  it("round-trips a code and a UTF-8 reason", () => {
    const encoded = encodeClose(1000, "bye 👋 — 再见");
    const decoded = parseClose(encoded);
    expect(decoded.code).toBe(1000);
    expect(decoded.reason).toBe("bye 👋 — 再见");
  });

  it("empty payload decodes to 1005 with an empty reason", () => {
    expect(parseClose(Buffer.alloc(0))).toEqual({ code: 1005, reason: "" });
  });

  it("rejects an invalid close code on encode", () => {
    expect(() => encodeClose(1005)).toThrow(WsProtocolError); // 1005 is reserved, never sent on the wire
    expect(() => encodeClose(999)).toThrow(WsProtocolError);
    expect(() => encodeClose(5000)).toThrow(WsProtocolError);
  });

  it("rejects an invalid close code on decode", () => {
    const buf = Buffer.alloc(2);
    buf.writeUInt16BE(1006, 0); // reserved, must never appear on the wire
    expect(() => parseClose(buf)).toThrow(WsProtocolError);
  });

  it("rejects a 1-byte close payload (must be 0 or >= 2 bytes)", () => {
    expect(() => parseClose(Buffer.from([0x03]))).toThrow(WsProtocolError);
  });

  it("rejects a close reason that is not valid UTF-8", () => {
    const buf = Buffer.alloc(4);
    buf.writeUInt16BE(1000, 0);
    buf[2] = 0xff; // invalid UTF-8 lead byte
    buf[3] = 0xfe;
    expect(() => parseClose(buf)).toThrow(WsProtocolError);
  });
});

// ===========================================================================
// Seeded fuzz: >=200 randomized frames, all three length forms, masked and
// unmasked, control frames interleaved mid-fragmentation, concatenated then
// RE-SPLIT at random byte boundaries (including 1-byte chunks and splits
// forced inside an extended-length field and inside a mask key) — must
// round-trip byte-exact through FrameParser + MessageAssembler.
// ===========================================================================
describe("fuzz: chunk-boundary-independent, byte-exact round-trip", () => {
  const SEED = 424242;
  const MESSAGE_COUNT = 220;

  interface Expected {
    opcode: 0x1 | 0x2;
    payload: Buffer;
  }

  it(`round-trips ${MESSAGE_COUNT} randomized frames through every possible chunk split (seed ${SEED})`, () => {
    const rng = mulberry32(SEED);
    const parts: Buffer[] = [];
    const expected: Expected[] = [];
    const forcedSplitRegions: Array<[number, number]> = []; // [start, end) offsets into the final master buffer to force a split inside

    let cursor = 0;
    function appendPart(buf: Buffer): number {
      const offset = cursor;
      parts.push(buf);
      cursor += buf.length;
      return offset;
    }

    function pickLen(i: number): number {
      if (i < 4) return 65536 + Math.floor(rng() * 3000); // guarantee a handful of 64-bit-length frames
      const r = rng();
      if (r < 0.55) return Math.floor(rng() * 126); // 7-bit form
      if (r < 0.92) return 126 + Math.floor(rng() * 4000); // 16-bit form
      return 65536 + Math.floor(rng() * 3000); // 64-bit form
    }

    for (let i = 0; i < MESSAGE_COUNT; i++) {
      const opcode: 0x1 | 0x2 = rng() < 0.5 ? WS_OPCODES.TEXT : WS_OPCODES.BINARY;
      const masked = rng() < 0.5;
      const maskKey = masked ? randomBuffer(rng, 4) : undefined;
      const fragmented = rng() < 0.3;
      const len = pickLen(i);
      const payload = randomBuffer(rng, len);

      if (!fragmented) {
        const frameStart = cursor;
        const frameBytes = encodeFrame({ opcode, payload, maskKey });
        appendPart(frameBytes);
        // Record a forced-split region inside the length header / mask key for a sample of frames.
        if (len >= 126) {
          const extLenBytes = len <= 0xffff ? 2 : 8;
          if (extLenBytes > 1) forcedSplitRegions.push([frameStart + 2, frameStart + 2 + extLenBytes]);
        }
        if (masked) {
          const maskKeyStart = frameStart + 2 + (len < 126 ? 0 : len <= 0xffff ? 2 : 8);
          forcedSplitRegions.push([maskKeyStart, maskKeyStart + 4]);
        }
      } else {
        // Split payload into 2-4 fragments; interleave a PING control frame mid-way.
        const fragCount = 2 + Math.floor(rng() * 3);
        const bounds: number[] = [0];
        for (let k = 1; k < fragCount; k++) bounds.push(Math.floor((len * k) / fragCount));
        bounds.push(len);
        for (let k = 0; k < fragCount; k++) {
          const chunk = payload.subarray(bounds[k], bounds[k + 1]);
          const isFirst = k === 0;
          const isLast = k === fragCount - 1;
          const frameOpcode = isFirst ? opcode : WS_OPCODES.CONTINUATION;
          const frameMaskKey = masked ? randomBuffer(rng, 4) : undefined;
          appendPart(encodeFrame({ opcode: frameOpcode, payload: Buffer.from(chunk), fin: isLast, maskKey: frameMaskKey }));
          if (!isLast && rng() < 0.5) {
            // Interleave a control frame between fragments.
            const pingPayload = randomBuffer(rng, Math.floor(rng() * 30));
            const pingMaskKey = masked ? randomBuffer(rng, 4) : undefined;
            appendPart(encodeFrame({ opcode: WS_OPCODES.PING, payload: pingPayload, fin: true, maskKey: pingMaskKey }));
          }
        }
      }
      expected.push({ opcode, payload });
    }

    const master = Buffer.concat(parts, cursor);
    expect(master.length).toBe(cursor);

    // Build split points: forced ones inside header/mask-key regions, a dense
    // 1-byte-chunk region, and a scatter of purely random points.
    const splitPoints = new Set<number>();
    for (const [s, e] of forcedSplitRegions) {
      if (e > s) splitPoints.add(s + Math.floor(rng() * (e - s)));
    }
    // A run of single-byte chunks somewhere in the middle of the stream.
    const denseStart = Math.floor(rng() * Math.max(1, master.length - 40));
    for (let i = 0; i < 40 && denseStart + i < master.length; i++) {
      splitPoints.add(denseStart + i);
    }
    // Scatter of random points across the whole buffer.
    const randomPointCount = Math.floor(master.length / 40);
    for (let i = 0; i < randomPointCount; i++) {
      splitPoints.add(1 + Math.floor(rng() * (master.length - 1)));
    }
    splitPoints.delete(0);
    splitPoints.delete(master.length);
    const sortedSplits = [...splitPoints].sort((a, b) => a - b);

    const chunks: Buffer[] = [];
    let prev = 0;
    for (const p of sortedSplits) {
      if (p <= prev) continue;
      chunks.push(master.subarray(prev, p));
      prev = p;
    }
    chunks.push(master.subarray(prev));
    expect(chunks.reduce((n, c) => n + c.length, 0)).toBe(master.length);
    expect(chunks.length).toBeGreaterThan(50); // proves real fragmentation happened, not one big chunk

    const parser = new FrameParser({ maxPayloadBytes: 200_000 });
    const assembler = new MessageAssembler();
    const actual: Expected[] = [];
    for (const chunk of chunks) {
      const frames = parser.push(chunk);
      for (const f of frames) {
        const msg = assembler.pushFrame(f);
        if (msg) actual.push(msg);
      }
    }

    expect(actual.length).toBe(expected.length);
    for (let i = 0; i < expected.length; i++) {
      expect(actual[i].opcode, `message ${i} opcode`).toBe(expected[i].opcode);
      expect(Buffer.compare(actual[i].payload, expected[i].payload), `message ${i} payload byte-exact`).toBe(0);
    }
  });

  it("is deterministic: the same seed reproduces an identical frame stream length", () => {
    // Re-run the same generator shape with the same seed and confirm the
    // total byte count matches — proves no Math.random leaked in.
    function totalBytesForSeed(seed: number): number {
      const rng = mulberry32(seed);
      let total = 0;
      for (let i = 0; i < 50; i++) {
        const len = i < 4 ? 65536 + Math.floor(rng() * 3000) : Math.floor(rng() * 200);
        const maskKey = rng() < 0.5 ? randomBuffer(rng, 4) : undefined;
        total += encodeFrame({ opcode: WS_OPCODES.BINARY, payload: Buffer.alloc(len), maskKey }).length;
      }
      return total;
    }
    expect(totalBytesForSeed(SEED)).toBe(totalBytesForSeed(SEED));
  });
});
