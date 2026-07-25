import { describe, it, expect } from "vitest";
import * as net from "node:net";
import * as http from "node:http";
import * as crypto from "node:crypto";
import { spawn } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { acceptWebSocket, computeAccept, connectWebSocket, WsSocket } from "../a2a/ws/socket";
import { A2AHubServer, webSocketWire } from "../a2a/ws/hub";
import { FrameParser, WS_OPCODES, encodeFrame } from "../a2a/ws/frame";
import type { WsFrame } from "../a2a/ws/frame";
import { RemoteA2ATransport } from "../a2a/remote-transport";
import type { A2AMessage } from "../a2a/types";

// ===========================================================================
// Shared test utilities
// ===========================================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000, intervalMs = 5): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
    }
    await sleep(intervalMs);
  }
}

function listenEphemeral(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr === null || typeof addr === "string") throw new Error("expected an AddressInfo");
      resolve(addr.port);
    });
  });
}

function closeHttpServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

/**
 * A fully test-owned WebSocket peer: does its own handshake over a raw
 * `net.Socket` and its own frame decoding (via the real {@link FrameParser}),
 * so tests can inspect raw bytes / send hand-crafted (including deliberately
 * invalid) frames without any of `WsSocket`'s own protective behaviour in the
 * way.
 */
class RawPeer {
  readonly socket: net.Socket;
  private readonly parser = new FrameParser({ maxPayloadBytes: 8 * 1024 * 1024 });
  readonly frames: WsFrame[] = [];
  readonly rawChunks: Buffer[] = [];

  private constructor(socket: net.Socket) {
    this.socket = socket;
  }

  static async connect(port: number, path = "/a2a"): Promise<RawPeer> {
    const socket = net.connect(port, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", () => resolve());
      socket.once("error", reject);
    });
    const peer = new RawPeer(socket);
    const key = crypto.randomBytes(16).toString("base64");
    let headerBuf = Buffer.alloc(0);
    let handshakeDone = false;
    let handshakeError: Error | null = null;

    const onHandshakeData = (chunk: Buffer) => {
      headerBuf = Buffer.concat([headerBuf, chunk]);
      const idx = headerBuf.indexOf("\r\n\r\n");
      if (idx === -1) return;
      const headerText = headerBuf.subarray(0, idx).toString("utf8");
      socket.removeListener("data", onHandshakeData);
      if (!/^HTTP\/1\.1 101/.test(headerText)) {
        handshakeError = new Error(`handshake failed: ${headerText}`);
        handshakeDone = true;
        return;
      }
      handshakeDone = true;
      socket.on("data", (c: Buffer) => peer.ingest(c));
      const rest = headerBuf.subarray(idx + 4);
      if (rest.length > 0) peer.ingest(rest);
    };
    socket.on("data", onHandshakeData);
    socket.write(
      `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${key}\r\n\r\n`
    );
    await waitFor(() => handshakeDone, 3000);
    if (handshakeError) throw handshakeError;
    return peer;
  }

  private ingest(chunk: Buffer): void {
    this.rawChunks.push(chunk);
    this.frames.push(...this.parser.push(chunk));
  }

  /** Send a frame with full control over every field — including deliberately-invalid ones. */
  sendRaw(opts: { opcode: number; payload: Buffer; fin?: boolean; masked?: boolean }): void {
    const maskKey = opts.masked === false ? undefined : crypto.randomBytes(4);
    this.socket.write(encodeFrame({ opcode: opts.opcode, payload: opts.payload, fin: opts.fin, maskKey }));
  }

  async waitForFrame(predicate: (f: WsFrame) => boolean, timeoutMs = 3000): Promise<WsFrame> {
    await waitFor(() => this.frames.some(predicate), timeoutMs);
    return this.frames.find(predicate)!;
  }

  destroy(): void {
    this.socket.destroy();
  }
}

// ===========================================================================
// socket.ts — handshake and framing over real TCP
// ===========================================================================
describe("socket.ts: handshake + live duplex over real TCP", () => {
  it("a real client and a real server handshake against EACH OTHER and exchange text both ways", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    let serverSocket: WsSocket | null = null;
    server.on("upgrade", (req, sock, head) => {
      serverSocket = acceptWebSocket(req, sock as net.Socket, head);
    });
    const port = await listenEphemeral(server);

    const client = await connectWebSocket(`ws://127.0.0.1:${port}/a2a`);
    expect(client.isOpen()).toBe(true);
    await waitFor(() => serverSocket !== null);
    expect(serverSocket!.isOpen()).toBe(true);

    const serverReceived: string[] = [];
    serverSocket!.onMessage((t) => serverReceived.push(t));
    client.sendText("hello from client");
    await waitFor(() => serverReceived.length === 1);
    expect(serverReceived[0]).toBe("hello from client");

    const clientReceived: string[] = [];
    client.onMessage((t) => clientReceived.push(t));
    serverSocket!.sendText("hello from server");
    await waitFor(() => clientReceived.length === 1);
    expect(clientReceived[0]).toBe("hello from server");

    await client.close();
    await waitFor(() => serverSocket!.isOpen() === false);
    await closeHttpServer(server);
  });

  it("rejects a tampered Sec-WebSocket-Accept header", async () => {
    const server = net.createServer((socket) => {
      let buf = Buffer.alloc(0);
      socket.on("data", (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        if (buf.includes("\r\n\r\n")) {
          socket.write(
            "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: dGhpcyBpcyB3cm9uZw==\r\n\r\n"
          );
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const addr = server.address();
    if (addr === null || typeof addr === "string") throw new Error("expected AddressInfo");

    await expect(connectWebSocket(`ws://127.0.0.1:${addr.port}/a2a`)).rejects.toThrow(/Sec-WebSocket-Accept/);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("computeAccept matches an independently hand-computed value", () => {
    // Sanity-check against a value computed by hand from the RFC's own recipe.
    const key = "dGhlIHNhbXBsZSBub25jZQ=="; // RFC 6455 section 1.3's own example key
    expect(computeAccept(key)).toBe("s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
  });

  it("acceptWebSocket rejects a bad Sec-WebSocket-Version with 400 and returns null", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    let result: WsSocket | null | "not-called" = "not-called";
    server.on("upgrade", (req, sock, head) => {
      result = acceptWebSocket(req, sock as net.Socket, head);
    });
    const port = await listenEphemeral(server);

    const raw = net.connect(port, "127.0.0.1");
    let respBuf = Buffer.alloc(0);
    raw.on("data", (c: Buffer) => (respBuf = Buffer.concat([respBuf, c])));
    await new Promise<void>((resolve, reject) => {
      raw.once("connect", () => resolve());
      raw.once("error", reject);
    });
    raw.write(
      "GET /a2a HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 12\r\nSec-WebSocket-Key: dGVzdGtleQ==\r\n\r\n"
    );
    await waitFor(() => respBuf.length > 0);
    expect(respBuf.toString("utf8")).toMatch(/^HTTP\/1\.1 400/);
    expect(result).toBeNull();

    raw.destroy();
    await closeHttpServer(server);
  });

  it("acceptWebSocket rejects a missing Sec-WebSocket-Key with 400 and returns null", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    let result: WsSocket | null | "not-called" = "not-called";
    server.on("upgrade", (req, sock, head) => {
      result = acceptWebSocket(req, sock as net.Socket, head);
    });
    const port = await listenEphemeral(server);

    const raw = net.connect(port, "127.0.0.1");
    let respBuf = Buffer.alloc(0);
    raw.on("data", (c: Buffer) => (respBuf = Buffer.concat([respBuf, c])));
    await new Promise<void>((resolve, reject) => {
      raw.once("connect", () => resolve());
      raw.once("error", reject);
    });
    raw.write("GET /a2a HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\n\r\n");
    await waitFor(() => respBuf.length > 0);
    expect(respBuf.toString("utf8")).toMatch(/^HTTP\/1\.1 400/);
    expect(result).toBeNull();

    raw.destroy();
    await closeHttpServer(server);
  });

  it("a PING is auto-answered with a PONG carrying the identical payload", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    server.on("upgrade", (req, sock, head) => {
      acceptWebSocket(req, sock as net.Socket, head);
    });
    const port = await listenEphemeral(server);

    const peer = await RawPeer.connect(port, "/a2a");
    const pingPayload = Buffer.from("ping-payload-123");
    peer.sendRaw({ opcode: WS_OPCODES.PING, payload: pingPayload });

    const pong = await peer.waitForFrame((f) => f.opcode === WS_OPCODES.PONG);
    expect(Buffer.compare(pong.payload, pingPayload)).toBe(0);

    peer.destroy();
    await closeHttpServer(server);
  });

  it("server frames are unmasked on the wire; server rejects an unmasked inbound frame from the client", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    let serverSocket: WsSocket | null = null;
    server.on("upgrade", (req, sock, head) => {
      serverSocket = acceptWebSocket(req, sock as net.Socket, head);
    });
    const port = await listenEphemeral(server);

    // -- server does not mask its outbound frames --
    const peer = await RawPeer.connect(port, "/a2a");
    await waitFor(() => serverSocket !== null);
    serverSocket!.sendText("unmasked-from-server");
    await peer.waitForFrame((f) => f.opcode === WS_OPCODES.TEXT);
    const raw = Buffer.concat(peer.rawChunks);
    expect(raw[1] & 0x80).toBe(0); // MASK bit must be clear on a server->client frame

    const closed = new Promise<void>((resolve) => serverSocket!.onClose(() => resolve()));
    // -- server enforces masking on inbound frames: send an unmasked TEXT frame from the "client" --
    peer.sendRaw({ opcode: WS_OPCODES.TEXT, payload: Buffer.from("i refuse to mask"), masked: false });
    await closed; // the server-side WsSocket must fail the connection (1002) rather than accept it

    peer.destroy();
    await closeHttpServer(server);
  });

  it("close() performs the full closing handshake: both ends end up closed, cleanly", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    let serverSocket: WsSocket | null = null;
    let serverCloseInfo: { code: number; reason: string; clean: boolean } | null = null;
    server.on("upgrade", (req, sock, head) => {
      serverSocket = acceptWebSocket(req, sock as net.Socket, head);
      serverSocket!.onClose((info) => (serverCloseInfo = info));
    });
    const port = await listenEphemeral(server);

    const client = await connectWebSocket(`ws://127.0.0.1:${port}/a2a`);
    await waitFor(() => serverSocket !== null);

    await client.close(1000, "done");
    expect(client.isOpen()).toBe(false);
    await waitFor(() => serverSocket!.isOpen() === false);
    expect(serverCloseInfo).not.toBeNull();
    expect(serverCloseInfo!.clean).toBe(true);

    await closeHttpServer(server);
  });

  it("close() force-destroys via the timeout fallback when the peer never echoes CLOSE", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    let serverSocket: WsSocket | null = null;
    server.on("upgrade", (req, sock, head) => {
      const s = sock as net.Socket;
      const key = req.headers["sec-websocket-key"] as string;
      s.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${computeAccept(key)}\r\n\r\n`);
      // Deliberately short closeTimeoutMs so the test stays fast; the peer below never echoes CLOSE.
      serverSocket = new WsSocket({
        socket: s,
        maskOutbound: false,
        requireMaskedInbound: true,
        closeTimeoutMs: 100,
        initialData: head && head.length > 0 ? head : undefined,
      });
    });
    const port = await listenEphemeral(server);

    const peer = await RawPeer.connect(port, "/a2a"); // never sends a CLOSE frame back
    await waitFor(() => serverSocket !== null);

    const before = Date.now();
    let closeInfo: { code: number; reason: string; clean: boolean } | null = null;
    serverSocket!.onClose((info) => (closeInfo = info));
    await serverSocket!.close(1000, "bye");
    const elapsed = Date.now() - before;

    expect(serverSocket!.isOpen()).toBe(false);
    expect(closeInfo).not.toBeNull();
    expect(closeInfo!.clean).toBe(false); // timed out, not a real handshake
    expect(elapsed).toBeGreaterThanOrEqual(90); // proves the timeout path actually fired, not an instant resolve

    peer.destroy();
    await closeHttpServer(server);
  });
});

// ===========================================================================
// A2AHubServer + webSocketWire — proving distributed A2A stops being a
// loopback: two RemoteA2ATransport instances, each on its own real TCP
// connection, routed through one hub.
// ===========================================================================
describe("A2AHubServer + webSocketWire: distributed A2A across real TCP sockets", () => {
  async function setupHubAndTwoNodes(): Promise<{
    hub: A2AHubServer;
    port: number;
    nodeA: RemoteA2ATransport;
    nodeB: RemoteA2ATransport;
    wireA: Awaited<ReturnType<typeof webSocketWire>>;
    wireB: Awaited<ReturnType<typeof webSocketWire>>;
    teardown: () => Promise<void>;
  }> {
    const hub = new A2AHubServer();
    const { port } = await hub.listen(0);
    const url = `ws://127.0.0.1:${port}/a2a`;
    const wireA = await webSocketWire(url, { reconnect: false });
    const wireB = await webSocketWire(url, { reconnect: false });
    const nodeA = new RemoteA2ATransport({ wire: wireA });
    const nodeB = new RemoteA2ATransport({ wire: wireB });
    await waitFor(() => hub.connectionCount() === 2);
    return {
      hub,
      port,
      nodeA,
      nodeB,
      wireA,
      wireB,
      teardown: async () => {
        await wireA.close();
        await wireB.close();
        await hub.close();
      },
    };
  }

  it("delivers a direct message from an agent on node A to an agent on node B exactly once, payload intact", async () => {
    const { nodeA, nodeB, teardown } = await setupHubAndTwoNodes();
    try {
      const receivedOnB: A2AMessage[] = [];
      const receivedOnA: A2AMessage[] = [];
      nodeB.register({ agentId: "b1", team: "x" }, (m) => receivedOnB.push(m));
      // nodeA also has a local agent that must NOT receive a message addressed only to b1.
      nodeA.register({ agentId: "a-bystander", team: "x" }, (m) => receivedOnA.push(m));

      const payload = { greeting: "hi from a1", nested: { n: 42, list: [1, 2, 3] } };
      nodeA.publish({
        id: "m-1",
        from: { agentId: "a1", team: "x" },
        to: { agentId: "b1", team: "x" },
        kind: "event",
        payload,
        ts: 1,
      });

      await waitFor(() => receivedOnB.length === 1, 3000);
      await sleep(50); // give any erroneous duplicate/misdelivery time to show up
      expect(receivedOnB).toHaveLength(1);
      expect(receivedOnB[0].payload).toEqual(payload);
      expect(receivedOnB[0].from.agentId).toBe("a1");
      expect(receivedOnA).toHaveLength(0);
    } finally {
      await teardown();
    }
  });

  it("a team broadcast spans both nodes, skips the sender, skips off-team agents, and still reaches the sender's own node's teammates (loopback parity)", async () => {
    const { nodeA, nodeB, teardown } = await setupHubAndTwoNodes();
    try {
      nodeA.register({ agentId: "a-sender", team: "x" }, () => {
        throw new Error("sender must never receive its own broadcast");
      });
      const aTeammateSeen: A2AMessage[] = [];
      nodeA.register({ agentId: "a-teammate", team: "x" }, (m) => aTeammateSeen.push(m)); // same node, same team

      const bTeammateSeen: A2AMessage[] = [];
      nodeB.register({ agentId: "b-teammate", team: "x" }, (m) => bTeammateSeen.push(m)); // other node, same team

      const bOffTeamSeen: A2AMessage[] = [];
      nodeB.register({ agentId: "b-offteam", team: "y" }, (m) => bOffTeamSeen.push(m)); // other node, different team

      nodeA.publish({
        id: "bcast-1",
        from: { agentId: "a-sender", team: "x" },
        to: { broadcast: true, team: "x" },
        kind: "event",
        payload: { announce: true },
        ts: 1,
      });

      await waitFor(() => aTeammateSeen.length === 1 && bTeammateSeen.length === 1, 3000);
      await sleep(50);
      expect(aTeammateSeen).toHaveLength(1); // loopback parity: sender's own node's teammate DID receive it
      expect(bTeammateSeen).toHaveLength(1); // cross-node fan-out
      expect(bOffTeamSeen).toHaveLength(0); // team scoping enforced
      expect(aTeammateSeen[0].payload).toEqual({ announce: true });
    } finally {
      await teardown();
    }
  });

  it("reconnect: an outage queues frames (dropping the OLDEST on overflow, counted honestly), then flushes remaining frames in order once the hub comes back", async () => {
    const hub1 = new A2AHubServer();
    const { port } = await hub1.listen(0);
    const url = `ws://127.0.0.1:${port}/a2a`;

    const statuses: string[] = [];
    const received: string[] = [];
    const wire = await webSocketWire(url, {
      maxQueuedFrames: 5,
      reconnect: true,
      onStatus: (s) => statuses.push(s),
    });
    wire.onFrame((f) => received.push(f));
    expect(wire.status()).toBe("connected");

    // Kill the connection from the SERVER side.
    await hub1.close();
    await waitFor(() => wire.status() !== "connected", 3000);
    expect(statuses).toContain("reconnecting");

    // Publish 8 frames during the outage against a cap of 5: 3 must be dropped, oldest-first.
    for (let i = 0; i < 8; i++) wire.send(`frame-${i}`);
    expect(wire.droppedFrames()).toBe(3);

    // Bring the hub back up on the SAME port.
    const hub2 = new A2AHubServer();
    await hub2.listen(port);

    await waitFor(() => wire.status() === "connected", 5000);
    await waitFor(() => received.length === 5, 3000);
    expect(received).toEqual(["frame-3", "frame-4", "frame-5", "frame-6", "frame-7"]);
    expect(wire.droppedFrames()).toBe(3); // never silently reset

    await wire.close();
    await hub2.close();
  });
});

// ===========================================================================
// Cross-process leg (mandatory): a real `node` child process, speaking raw
// RFC 6455 bytes it constructs itself, crosses a real process boundary and
// its frame is routed to an in-test RemoteA2ATransport agent.
// ===========================================================================
describe("cross-process leg: a spawned node child process talks to the hub over raw WebSocket bytes", () => {
  it("child process handshake + one masked TEXT frame is relayed by the hub and routed to the in-test transport", async () => {
    const hub = new A2AHubServer();
    const { port } = await hub.listen(0);
    const url = `ws://127.0.0.1:${port}/a2a`;
    const wire = await webSocketWire(url);
    const node = new RemoteA2ATransport({ wire });
    const received: A2AMessage[] = [];
    node.register({ agentId: "host-agent", team: "x" }, (m) => received.push(m));

    const nonce = crypto.randomUUID();
    const envelope = {
      id: "child-1",
      from: { agentId: "child-agent", team: "x" },
      to: { agentId: "host-agent", team: "x" },
      kind: "event",
      payload: { fromChild: true, nonce },
      ts: 1,
    };

    // A minimal, self-contained RFC 6455 client: raw HTTP Upgrade handshake
    // over net.connect, then one masked TEXT frame. No project code is
    // imported here on purpose — this proves the wire format itself, not
    // just our own client implementation talking to our own server.
    const childScript = [
      "const net = require('net');",
      "const crypto = require('crypto');",
      "const port = Number(process.argv[1]);",
      "const path = process.argv[2];",
      "const payloadJson = process.argv[3];",
      "function maskPayload(payload, key) {",
      "  const out = Buffer.alloc(payload.length);",
      "  for (let i = 0; i < payload.length; i++) out[i] = payload[i] ^ key[i % 4];",
      "  return out;",
      "}",
      "function buildTextFrame(payload) {",
      "  const key = crypto.randomBytes(4);",
      "  const masked = maskPayload(payload, key);",
      "  const len = payload.length;",
      "  let header;",
      "  if (len < 126) {",
      "    header = Buffer.from([0x81, 0x80 | len]);",
      "  } else if (len <= 0xffff) {",
      "    header = Buffer.alloc(4);",
      "    header[0] = 0x81; header[1] = 0x80 | 126;",
      "    header.writeUInt16BE(len, 2);",
      "  } else {",
      "    header = Buffer.alloc(10);",
      "    header[0] = 0x81; header[1] = 0x80 | 127;",
      "    header.writeBigUInt64BE(BigInt(len), 2);",
      "  }",
      "  return Buffer.concat([header, key, masked]);",
      "}",
      "const socket = net.connect(port, '127.0.0.1', () => {",
      "  const key = crypto.randomBytes(16).toString('base64');",
      "  const req = 'GET ' + path + ' HTTP/1.1\\r\\nHost: 127.0.0.1:' + port + '\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Key: ' + key + '\\r\\nSec-WebSocket-Version: 13\\r\\n\\r\\n';",
      "  socket.write(req);",
      "});",
      "let buf = Buffer.alloc(0);",
      "let handshakeDone = false;",
      "socket.on('data', (chunk) => {",
      "  if (handshakeDone) return;",
      "  buf = Buffer.concat([buf, chunk]);",
      "  const idx = buf.indexOf('\\r\\n\\r\\n');",
      "  if (idx === -1) return;",
      "  const headerText = buf.slice(0, idx).toString('utf8');",
      "  if (!/^HTTP\\/1\\.1 101/.test(headerText)) {",
      "    process.stderr.write('handshake failed: ' + headerText);",
      "    process.exit(1);",
      "  }",
      "  handshakeDone = true;",
      "  const frame = buildTextFrame(Buffer.from(payloadJson, 'utf8'));",
      "  socket.write(frame);",
      "  setTimeout(() => { try { socket.end(); } catch (e) {} process.exit(0); }, 150);",
      "});",
      "socket.on('error', (e) => { process.stderr.write('ERR:' + e.message); process.exit(1); });",
      "setTimeout(() => { process.stderr.write('timed out'); process.exit(1); }, 5000);",
    ].join("\n");

    let child: ChildProcessByStdio<null, Readable, Readable> | null = spawn(
      process.execPath,
      ["-e", childScript, "--", String(port), "/a2a", JSON.stringify(envelope)],
      { stdio: ["ignore", "pipe", "pipe"] }
    );

    try {
      let stderr = "";
      child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));

      const exitCode = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error("child process timed out"));
        }, 8000);
        child!.on("exit", (code) => {
          clearTimeout(timer);
          resolve(code ?? -1);
        });
        child!.on("error", (e) => {
          clearTimeout(timer);
          reject(e);
        });
      });

      expect(exitCode, `child process failed, stderr: ${stderr}`).toBe(0);
      child = null; // already exited naturally; nothing left to clean up

      await waitFor(() => received.length === 1, 3000);
      expect(received[0].from.agentId).toBe("child-agent");
      expect(received[0].payload).toEqual({ fromChild: true, nonce });
    } finally {
      if (child && !child.killed) child.kill();
      await wire.close();
      await hub.close();
    }
  });
});
