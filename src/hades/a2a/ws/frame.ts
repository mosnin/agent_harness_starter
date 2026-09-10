/**
 * RFC 6455 WebSocket frame codec — pure, Buffer-in/Buffer-out.
 *
 * No `ws` dependency: this hand-rolls the base framing protocol (section 5 of
 * RFC 6455) — the 2..14 byte header (7/16/64-bit length forms), XOR masking,
 * fragmentation (continuation frames), control frames (close/ping/pong) and
 * their interleaving rules. `socket.ts` builds the handshake and the live
 * duplex wrapper on top of this module; this module itself never touches the
 * network — it only transforms bytes, which is what makes it exhaustively
 * fuzzable (see `a2a-ws-frame.test.ts`).
 */

/** The seven opcodes RFC 6455 defines. Frozen to their exact numeric literals. */
export const WS_OPCODES = {
  CONTINUATION: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa,
} as const;

/** A single parsed WebSocket frame (post unmasking — `payload` is always raw). */
export interface WsFrame {
  fin: boolean;
  opcode: number;
  payload: Buffer;
}

/**
 * Thrown by {@link FrameParser} / {@link MessageAssembler} / {@link parseClose}
 * on any protocol violation. `code` is the WebSocket close code the violation
 * maps to (1002 = protocol error, 1009 = message too big) so callers can close
 * the connection with the correct status without re-deriving it.
 */
export class WsProtocolError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.name = "WsProtocolError";
    this.code = code;
  }
}

const MAX_CONTROL_PAYLOAD = 125;

/** XOR-mask (or unmask — the operation is its own inverse) `payload` against a 4-byte `maskKey`. */
function applyMask(payload: Buffer, maskKey: Buffer): Buffer {
  const out = Buffer.allocUnsafe(payload.length);
  for (let i = 0; i < payload.length; i++) {
    out[i] = payload[i] ^ maskKey[i % 4];
  }
  return out;
}

/**
 * Encode one WebSocket frame. `fin` defaults to `true` (unfragmented). Passing
 * a `maskKey` (exactly 4 bytes) masks the frame and sets the MASK bit — the
 * client is required to mask, the server is required not to; this function
 * just does whatever the caller asks, matching the RFC's byte layout exactly.
 * Picks the 7-bit / 16-bit / 64-bit length form automatically.
 */
export function encodeFrame(opts: {
  opcode: number;
  payload: Buffer;
  fin?: boolean;
  maskKey?: Buffer;
}): Buffer {
  const { opcode, payload, maskKey } = opts;
  const fin = opts.fin ?? true;
  const masked = maskKey !== undefined;
  if (masked && maskKey!.length !== 4) {
    throw new Error(`maskKey must be exactly 4 bytes, got ${maskKey!.length}`);
  }
  if (opcode < 0 || opcode > 0xf) {
    throw new Error(`opcode out of range: ${opcode}`);
  }
  const len = payload.length;
  const byte0 = (fin ? 0x80 : 0) | (opcode & 0x0f);
  const maskBit = masked ? 0x80 : 0;

  let header: Buffer;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = byte0;
    header[1] = maskBit | len;
  } else if (len <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = byte0;
    header[1] = maskBit | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = byte0;
    header[1] = maskBit | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }

  const parts: Buffer[] = [header];
  if (masked) {
    parts.push(maskKey!);
    parts.push(applyMask(payload, maskKey!));
  } else {
    parts.push(payload);
  }
  return Buffer.concat(parts);
}

/**
 * Streaming frame decoder. Feed it arbitrarily fragmented chunks (even 1 byte
 * at a time, even split inside the extended-length field or the mask key) via
 * {@link push}; it buffers until a full frame is available and returns every
 * frame completed by that call (zero, one, or many). Throws a typed
 * {@link WsProtocolError} the instant a violation is unambiguous — RSV bits set
 * (1002), a fragmented or oversize control frame (1002), an unmasked frame when
 * `requireMasked` is set (1002), or a declared payload length over
 * `maxPayloadBytes` (1009, default 4 MiB).
 */
export class FrameParser {
  private buf: Buffer = Buffer.alloc(0);
  private readonly requireMasked: boolean;
  private readonly maxPayloadBytes: number;

  constructor(opts: { requireMasked?: boolean; maxPayloadBytes?: number } = {}) {
    this.requireMasked = opts.requireMasked ?? false;
    this.maxPayloadBytes = opts.maxPayloadBytes ?? 4 * 1024 * 1024;
  }

  push(chunk: Buffer): WsFrame[] {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    const frames: WsFrame[] = [];
    for (;;) {
      const frame = this.tryParseOne();
      if (frame === null) break;
      frames.push(frame);
    }
    return frames;
  }

  /** Attempt to parse exactly one frame off the front of `this.buf`. Returns null if more bytes are needed. */
  private tryParseOne(): WsFrame | null {
    const buf = this.buf;
    if (buf.length < 2) return null;

    const byte0 = buf[0];
    const byte1 = buf[1];
    const fin = (byte0 & 0x80) !== 0;
    const rsv = byte0 & 0x70;
    const opcode = byte0 & 0x0f;
    const masked = (byte1 & 0x80) !== 0;
    const lenBits = byte1 & 0x7f;
    const isControl = opcode >= 0x8;

    if (rsv !== 0) {
      throw new WsProtocolError(1002, "reserved bits (RSV1-3) must be zero");
    }
    if (isControl && !fin) {
      throw new WsProtocolError(1002, "control frames must not be fragmented");
    }

    let offset = 2;
    let extLenBytes = 0;
    if (lenBits === 126) extLenBytes = 2;
    else if (lenBits === 127) extLenBytes = 8;

    if (buf.length < offset + extLenBytes) return null;

    let payloadLen: number;
    if (lenBits === 126) {
      payloadLen = buf.readUInt16BE(offset);
      offset += 2;
    } else if (lenBits === 127) {
      const big = buf.readBigUInt64BE(offset);
      offset += 8;
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new WsProtocolError(1009, "declared payload length exceeds safe integer range");
      }
      payloadLen = Number(big);
    } else {
      payloadLen = lenBits;
    }

    if (isControl && payloadLen > MAX_CONTROL_PAYLOAD) {
      throw new WsProtocolError(1002, `control frame payload exceeds ${MAX_CONTROL_PAYLOAD} bytes`);
    }
    if (payloadLen > this.maxPayloadBytes) {
      throw new WsProtocolError(1009, `payload length ${payloadLen} exceeds max ${this.maxPayloadBytes}`);
    }
    if (this.requireMasked && !masked) {
      throw new WsProtocolError(1002, "unmasked frame received but masking is required");
    }

    let maskKey: Buffer | null = null;
    if (masked) {
      if (buf.length < offset + 4) return null;
      maskKey = buf.subarray(offset, offset + 4);
      offset += 4;
    }

    if (buf.length < offset + payloadLen) return null;

    const rawPayload = buf.subarray(offset, offset + payloadLen);
    const payload = maskKey ? applyMask(rawPayload, maskKey) : Buffer.from(rawPayload);
    offset += payloadLen;

    // Commit: slice the consumed prefix off. Copy the remainder so it owns its
    // own memory (subarray would otherwise keep the whole original chunk alive).
    this.buf = Buffer.from(buf.subarray(offset));

    return { fin, opcode, payload };
  }
}

/**
 * Reassembles fragmented data frames (TEXT/BINARY started with `fin: false`,
 * continued by CONTINUATION frames) into one logical message, per RFC 6455
 * section 5.4. Control frames (PING/PONG/CLOSE) may legally interleave between
 * fragments of a data message — {@link pushFrame} lets them pass through
 * (returns `null`, does not disturb in-progress fragmentation state); the
 * caller is responsible for acting on control frames itself (see `socket.ts`).
 * Throws a typed {@link WsProtocolError} (1002) for a continuation frame with no
 * message in progress, or a new data frame opcode while one is already in
 * progress.
 */
export class MessageAssembler {
  private opcode: 0x1 | 0x2 | null = null;
  private chunks: Buffer[] = [];
  private totalLen = 0;

  pushFrame(f: WsFrame): { opcode: 0x1 | 0x2; payload: Buffer } | null {
    const isControl = f.opcode >= 0x8;
    if (isControl) {
      // Control frames never participate in fragmentation; pass through inert.
      return null;
    }

    if (f.opcode === WS_OPCODES.CONTINUATION) {
      if (this.opcode === null) {
        throw new WsProtocolError(1002, "continuation frame received with no message in progress");
      }
      this.chunks.push(f.payload);
      this.totalLen += f.payload.length;
      if (!f.fin) return null;
      const payload = Buffer.concat(this.chunks, this.totalLen);
      const opcode = this.opcode;
      this.reset();
      return { opcode, payload };
    }

    if (f.opcode === WS_OPCODES.TEXT || f.opcode === WS_OPCODES.BINARY) {
      if (this.opcode !== null) {
        throw new WsProtocolError(1002, "new data frame received while a fragmented message is in progress");
      }
      if (f.fin) {
        return { opcode: f.opcode, payload: f.payload };
      }
      this.opcode = f.opcode;
      this.chunks = [f.payload];
      this.totalLen = f.payload.length;
      return null;
    }

    throw new WsProtocolError(1002, `unsupported opcode ${f.opcode}`);
  }

  private reset(): void {
    this.opcode = null;
    this.chunks = [];
    this.totalLen = 0;
  }
}

/** Valid WebSocket close codes for a status *sent on the wire* (RFC 6455 section 7.4). */
function isValidWireCloseCode(code: number): boolean {
  if (code >= 1000 && code <= 1003) return true;
  if (code >= 1007 && code <= 1011) return true;
  if (code >= 3000 && code <= 4999) return true;
  return false;
}

/** Encode a CLOSE frame's payload: a 2-byte big-endian status code plus a UTF-8 reason. */
export function encodeClose(code: number, reason = ""): Buffer {
  if (!isValidWireCloseCode(code)) {
    throw new WsProtocolError(1002, `invalid close code ${code}`);
  }
  const reasonBuf = Buffer.from(reason, "utf8");
  if (reasonBuf.length > MAX_CONTROL_PAYLOAD - 2) {
    throw new WsProtocolError(1002, "close reason too long for a control frame");
  }
  const buf = Buffer.alloc(2 + reasonBuf.length);
  buf.writeUInt16BE(code, 0);
  reasonBuf.copy(buf, 2);
  return buf;
}

/** Decode a CLOSE frame's payload. Empty payload means "no status code" (RFC 6455 7.1.5) — reported as 1005. */
export function parseClose(payload: Buffer): { code: number; reason: string } {
  if (payload.length === 0) {
    return { code: 1005, reason: "" };
  }
  if (payload.length === 1) {
    throw new WsProtocolError(1002, "close frame payload must be 0 bytes or >= 2 bytes");
  }
  const code = payload.readUInt16BE(0);
  if (!isValidWireCloseCode(code)) {
    throw new WsProtocolError(1002, `invalid close code ${code}`);
  }
  const reasonBuf = payload.subarray(2);
  let reason: string;
  try {
    reason = new TextDecoder("utf-8", { fatal: true }).decode(reasonBuf);
  } catch {
    throw new WsProtocolError(1002, "close reason is not valid UTF-8");
  }
  return { code, reason };
}
