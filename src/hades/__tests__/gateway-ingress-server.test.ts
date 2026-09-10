import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { WebhookIngressServer, type IngressRoute } from "../gateway/ingress/http-server";
import { slackIngressRoute, telegramIngressRoute, whatsAppIngressRoutes } from "../gateway/ingress/routes";
import { SlackConnector, type SlackTransport } from "../gateway/connectors/slack";
import { WhatsAppConnector, type WhatsAppTransport } from "../gateway/connectors/whatsapp";
import type { TelegramUpdate } from "../gateway/connectors/telegram";
import type { InboundMessage, OutboundReply } from "../../swarm-runtime/gateway/gateway";

// This suite drives a real `WebhookIngressServer` bound to 127.0.0.1:0 with
// real `fetch()` calls end to end — no mocked HTTP layer. Every expected
// HMAC is computed independently with node:crypto, never by calling the
// verification code under test.

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const echo = async (m: InboundMessage): Promise<OutboundReply> => ({ text: `echo:${m.text}`, accepted: true });

function slackSignature(secret: string, timestamp: string, rawBody: Buffer | string): string {
  const buf = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, "utf8");
  const base = Buffer.concat([Buffer.from(`v0:${timestamp}:`, "utf8"), buf]);
  return `v0=${createHmac("sha256", secret).update(base).digest("hex")}`;
}

function metaSignature(secret: string, rawBody: Buffer | string): string {
  const buf = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, "utf8");
  return `sha256=${createHmac("sha256", secret).update(buf).digest("hex")}`;
}

// ── generic server behavior ──────────────────────────────────────────────

describe("WebhookIngressServer", () => {
  it("listen(0) resolves the real ephemeral port and address() matches", async () => {
    const server = new WebhookIngressServer({ routes: [] });
    const { port } = await server.listen(0);
    expect(port).toBeGreaterThan(0);
    expect(server.address()).toEqual({ port });
    await server.close();
    expect(server.address()).toBeNull();
  });

  it("GET /healthz is built in and reports ok + uptimeMs from the injected clock", async () => {
    let clock = 1_000_000;
    const server = new WebhookIngressServer({ routes: [], now: () => clock });
    const { port } = await server.listen(0);
    clock += 4_500;
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, uptimeMs: 4_500 });
    await server.close();
  });

  it("answers an unknown path with 404", async () => {
    const server = new WebhookIngressServer({ routes: [] });
    const { port } = await server.listen(0);
    const res = await fetch(`http://127.0.0.1:${port}/does-not-exist`);
    expect(res.status).toBe(404);
    await server.close();
  });

  it("answers a known path with the wrong method as 405 + Allow header", async () => {
    const route: IngressRoute = { method: "POST", path: "/only-post", handle: async () => ({ status: 200 }) };
    const server = new WebhookIngressServer({ routes: [route] });
    const { port } = await server.listen(0);
    const res = await fetch(`http://127.0.0.1:${port}/only-post`, { method: "GET" });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
    await server.close();
  });

  it("turns a throwing route handler into a generic 500, never a stack trace", async () => {
    const route: IngressRoute = {
      method: "GET",
      path: "/boom",
      handle: async () => {
        throw new Error("super secret internal detail");
      },
    };
    const logs: string[] = [];
    const server = new WebhookIngressServer({ routes: [route], log: (l) => logs.push(l) });
    const { port } = await server.listen(0);
    const res = await fetch(`http://127.0.0.1:${port}/boom`);
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain("super secret internal detail");
    expect(text.toLowerCase()).not.toContain("at ");
    // The detail is allowed to reach the server-side log, just never the response.
    expect(logs.some((l) => l.includes("super secret internal detail"))).toBe(true);
    await server.close();
  });

  it("caps the request body: an oversized POST gets a 413, not a buffered giant body", async () => {
    const seenSizes: number[] = [];
    const route: IngressRoute = {
      method: "POST",
      path: "/echo-size",
      handle: async (req) => {
        seenSizes.push(req.rawBody.length);
        return { status: 200 };
      },
    };
    const server = new WebhookIngressServer({ routes: [route], maxBodyBytes: 16 });
    const { port } = await server.listen(0);

    const oversized = "x".repeat(10_000);
    const res = await fetch(`http://127.0.0.1:${port}/echo-size`, { method: "POST", body: oversized });
    expect(res.status).toBe(413);
    // The handler must never have been reached — the body was rejected
    // before routing, not buffered and then handed off.
    expect(seenSizes).toHaveLength(0);
    await server.close();
  });

  it("accepts a body right at the maxBodyBytes boundary", async () => {
    const route: IngressRoute = {
      method: "POST",
      path: "/echo-size",
      handle: async (req) => ({ status: 200, body: JSON.stringify({ size: req.rawBody.length }) }),
    };
    const server = new WebhookIngressServer({ routes: [route], maxBodyBytes: 16 });
    const { port } = await server.listen(0);
    const exact = "x".repeat(16);
    const res = await fetch(`http://127.0.0.1:${port}/echo-size`, { method: "POST", body: exact });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ size: 16 });
    await server.close();
  });

  it("close() is idempotent and a fresh listen() afterward works", async () => {
    const server = new WebhookIngressServer({ routes: [] });
    const first = await server.listen(0);
    await server.close();
    await expect(server.close()).resolves.toBeUndefined();

    const second = await server.listen(0);
    expect(second.port).toBeGreaterThan(0);
    const res = await fetch(`http://127.0.0.1:${second.port}/healthz`);
    expect(res.status).toBe(200);
    await server.close();
    void first;
  });

  it("close() destroys idle keep-alive sockets so it resolves promptly", async () => {
    const server = new WebhookIngressServer({ routes: [] });
    const { port } = await server.listen(0);
    // A default fetch() keeps the underlying connection alive for reuse; a
    // naive server.close() would hang until the client drops it.
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    await res.arrayBuffer();
    const start = Date.now();
    await server.close();
    expect(Date.now() - start).toBeLessThan(2_000);
  });

  it("a request that aborts mid-body does not crash the server or hang the handler", async () => {
    const route: IngressRoute = { method: "POST", path: "/slow", handle: async () => ({ status: 200 }) };
    const server = new WebhookIngressServer({ routes: [route] });
    const { port } = await server.listen(0);

    const controller = new AbortController();
    const pending = fetch(`http://127.0.0.1:${port}/slow`, {
      method: "POST",
      body: new ReadableStream({
        start(ctrl) {
          ctrl.enqueue(new TextEncoder().encode("partial"));
          // never closes — simulates a client that disappears mid-upload.
        },
      }),
      // @ts-expect-error -- required by undici for streamed bodies in Node
      duplex: "half",
      signal: controller.signal,
    });
    await delay(30);
    controller.abort();
    await expect(pending).rejects.toBeDefined();

    // The server must still be alive and answer other requests.
    const healthRes = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(healthRes.status).toBe(200);
    await server.close();
  });
});

// ── Slack ────────────────────────────────────────────────────────────────

describe("slackIngressRoute", () => {
  const secret = "slack-signing-secret";
  const nowMs = 1_700_000_000_000;
  const timestamp = String(Math.floor(nowMs / 1000));

  function fakeTransport(): SlackTransport & { sent: Array<{ channel: string; text: string }> } {
    const sent: Array<{ channel: string; text: string }> = [];
    return { sent, async postMessage(channel, text) { sent.push({ channel, text }); } };
  }

  async function startSlackServer(opts: { dedupeCapacity?: number; handler?: typeof echo } = {}) {
    const transport = fakeTransport();
    const connector = new SlackConnector(transport);
    await connector.start(opts.handler ?? echo);
    const logs: string[] = [];
    const route = slackIngressRoute({
      connector,
      signingSecret: secret,
      now: () => nowMs,
      dedupeCapacity: opts.dedupeCapacity,
      log: (l) => logs.push(l),
    });
    const server = new WebhookIngressServer({ routes: [route], now: () => nowMs });
    const { port } = await server.listen(0);
    return { server, port, transport, connector, logs };
  }

  async function postSlack(port: number, payload: unknown, overrides: { sig?: string; ts?: string } = {}) {
    const rawBody = JSON.stringify(payload);
    const ts = overrides.ts ?? timestamp;
    const sig = overrides.sig ?? slackSignature(secret, ts, rawBody);
    return fetch(`http://127.0.0.1:${port}/webhooks/slack`, {
      method: "POST",
      headers: { "x-slack-request-timestamp": ts, "x-slack-signature": sig, "content-type": "application/json" },
      body: rawBody,
    });
  }

  it("answers url_verification with the challenge, no event required", async () => {
    const { server, port } = await startSlackServer();
    try {
      const res = await postSlack(port, { type: "url_verification", challenge: "chal-abc" });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ challenge: "chal-abc" });
    } finally {
      await server.close();
    }
  });

  it("full happy path: a signed event_callback lands in the real connector and posts the reply", async () => {
    const { server, port, transport } = await startSlackServer();
    try {
      const res = await postSlack(port, {
        type: "event_callback",
        event_id: "Ev-happy",
        event: { type: "message", user: "U1", text: "hello", channel: "C1" },
      });
      expect(res.status).toBe(200);
      await delay(20);
      expect(transport.sent).toEqual([{ channel: "C1", text: "echo:hello" }]);
    } finally {
      await server.close();
    }
  });

  it("acks 200 immediately and runs connector.ingest in the background (does not block on the handler)", async () => {
    let release: (() => void) | undefined;
    const slowHandler = async (m: InboundMessage): Promise<OutboundReply> => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { text: `slow-echo:${m.text}`, accepted: true };
    };
    const { server, port, transport } = await startSlackServer({ handler: slowHandler });
    try {
      const res = await postSlack(port, {
        type: "event_callback",
        event_id: "Ev-slow",
        event: { type: "message", user: "U1", text: "wait", channel: "C1" },
      });
      expect(res.status).toBe(200);
      // The response is already back even though the handler is still parked.
      expect(transport.sent).toHaveLength(0);
      expect(release).toBeDefined();
      release?.();
      await delay(20);
      expect(transport.sent).toEqual([{ channel: "C1", text: "slow-echo:wait" }]);
    } finally {
      await server.close();
    }
  });

  it("rejects a request with a missing signature header", async () => {
    const { server, port, transport } = await startSlackServer();
    try {
      const rawBody = JSON.stringify({ type: "url_verification", challenge: "x" });
      const res = await fetch(`http://127.0.0.1:${port}/webhooks/slack`, {
        method: "POST",
        headers: { "x-slack-request-timestamp": timestamp },
        body: rawBody,
      });
      expect(res.status).toBe(401);
      expect(transport.sent).toHaveLength(0);
    } finally {
      await server.close();
    }
  });

  it("rejects a tampered body", async () => {
    const { server, port, transport } = await startSlackServer();
    try {
      const payload = { type: "event_callback", event_id: "Ev-t", event: { type: "message", text: "x", channel: "C1" } };
      const rawBody = JSON.stringify(payload);
      const sig = slackSignature(secret, timestamp, rawBody);
      const res = await fetch(`http://127.0.0.1:${port}/webhooks/slack`, {
        method: "POST",
        headers: { "x-slack-request-timestamp": timestamp, "x-slack-signature": sig },
        body: rawBody + "tampered",
      });
      expect(res.status).toBe(401);
      expect(transport.sent).toHaveLength(0);
    } finally {
      await server.close();
    }
  });

  it("rejects a stale timestamp", async () => {
    const { server, port } = await startSlackServer();
    try {
      const staleTs = String(Math.floor(nowMs / 1000) - 600);
      const res = await postSlack(port, { type: "url_verification", challenge: "x" }, { ts: staleTs });
      expect(res.status).toBe(401);
    } finally {
      await server.close();
    }
  });

  it("400s a validly signed but malformed JSON body", async () => {
    const { server, port } = await startSlackServer();
    try {
      const rawBody = "{not json";
      const sig = slackSignature(secret, timestamp, rawBody);
      const res = await fetch(`http://127.0.0.1:${port}/webhooks/slack`, {
        method: "POST",
        headers: { "x-slack-request-timestamp": timestamp, "x-slack-signature": sig },
        body: rawBody,
      });
      expect(res.status).toBe(400);
    } finally {
      await server.close();
    }
  });

  it("dedupes an immediate retry of the same event_id (X-Slack-Retry-Num)", async () => {
    const { server, port, transport } = await startSlackServer();
    try {
      const payload = {
        type: "event_callback",
        event_id: "Ev-retry",
        event: { type: "message", text: "hi", channel: "C1" },
      };
      const rawBody = JSON.stringify(payload);
      const sig = slackSignature(secret, timestamp, rawBody);
      const send = (retryNum?: string) =>
        fetch(`http://127.0.0.1:${port}/webhooks/slack`, {
          method: "POST",
          headers: {
            "x-slack-request-timestamp": timestamp,
            "x-slack-signature": sig,
            ...(retryNum ? { "x-slack-retry-num": retryNum } : {}),
          },
          body: rawBody,
        });
      await send();
      await send("1");
      await delay(20);
      expect(transport.sent).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it("evicts the oldest event_id once the dedupe cache is at capacity (boundary-tested)", async () => {
    // The connector itself also dedupes event_ids (in an unbounded set), so
    // eviction is asserted at the route's own dedupe decision (its log
    // line), not through the connector's side effects — otherwise the
    // connector's independent dedup would mask what the route cache did.
    const { server, port, logs } = await startSlackServer({ dedupeCapacity: 2 });
    try {
      const evt = (id: string, channel: string) => ({
        type: "event_callback",
        event_id: id,
        event: { type: "message", text: id, channel },
      });
      await postSlack(port, evt("e1", "C1"));
      await postSlack(port, evt("e2", "C2"));
      await postSlack(port, evt("e3", "C3")); // capacity 2 -> evicts e1
      await postSlack(port, evt("e2", "C2")); // e2 still tracked -> route-level duplicate
      await postSlack(port, evt("e1", "C1")); // e1 was evicted -> passes the route's dedupe check again
      await delay(20);
      const droppedEventIds = logs
        .filter((l) => l.includes("dropped duplicate delivery"))
        .map((l) => l.match(/event (\S+)/)?.[1]);
      expect(droppedEventIds).toEqual(["e2"]);
    } finally {
      await server.close();
    }
  });
});

// ── WhatsApp ─────────────────────────────────────────────────────────────

describe("whatsAppIngressRoutes", () => {
  const appSecret = "wa-app-secret";
  const verifyToken = "wa-verify-token";

  function fakeTransport(): WhatsAppTransport & { sent: Array<{ to: string; text: string }> } {
    const sent: Array<{ to: string; text: string }> = [];
    return { sent, async sendMessage(to, text) { sent.push({ to, text }); } };
  }

  function textMessagePayload(id: string, from: string, body: string) {
    return { entry: [{ changes: [{ value: { messages: [{ id, from, type: "text", text: { body } }] } }] }] };
  }

  async function startWhatsAppServer(dedupeCapacity?: number) {
    const transport = fakeTransport();
    const connector = new WhatsAppConnector(transport, { verifyToken });
    await connector.start(echo);
    const logs: string[] = [];
    const routes = whatsAppIngressRoutes({ connector, appSecret, verifyToken, dedupeCapacity, log: (l) => logs.push(l) });
    const server = new WebhookIngressServer({ routes });
    const { port } = await server.listen(0);
    return { server, port, transport, logs };
  }

  it("GET handshake with the right token echoes the raw challenge", async () => {
    const { server, port } = await startWhatsAppServer();
    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${verifyToken}&hub.challenge=chal-999`
      );
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("chal-999");
    } finally {
      await server.close();
    }
  });

  it("GET handshake with the wrong token is rejected with 403", async () => {
    const { server, port } = await startWhatsAppServer();
    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=chal-999`
      );
      expect(res.status).toBe(403);
    } finally {
      await server.close();
    }
  });

  it("full happy path: a signed POST lands in the real connector and posts the reply", async () => {
    const { server, port, transport } = await startWhatsAppServer();
    try {
      const payload = textMessagePayload("wamid.1", "15551234567", "hi there");
      const rawBody = JSON.stringify(payload);
      const sig = metaSignature(appSecret, rawBody);
      const res = await fetch(`http://127.0.0.1:${port}/webhooks/whatsapp`, {
        method: "POST",
        headers: { "x-hub-signature-256": sig, "content-type": "application/json" },
        body: rawBody,
      });
      expect(res.status).toBe(200);
      expect(transport.sent).toEqual([{ to: "15551234567", text: "echo:hi there" }]);
    } finally {
      await server.close();
    }
  });

  it("rejects a POST with a bad signature and never touches the connector", async () => {
    const { server, port, transport } = await startWhatsAppServer();
    try {
      const payload = textMessagePayload("wamid.2", "15551234567", "hi");
      const rawBody = JSON.stringify(payload);
      const res = await fetch(`http://127.0.0.1:${port}/webhooks/whatsapp`, {
        method: "POST",
        headers: { "x-hub-signature-256": "sha256=" + "0".repeat(64) },
        body: rawBody,
      });
      expect(res.status).toBe(401);
      expect(transport.sent).toHaveLength(0);
    } finally {
      await server.close();
    }
  });

  it("400s a validly signed but malformed JSON body", async () => {
    const { server, port } = await startWhatsAppServer();
    try {
      const rawBody = "{not json";
      const sig = metaSignature(appSecret, rawBody);
      const res = await fetch(`http://127.0.0.1:${port}/webhooks/whatsapp`, {
        method: "POST",
        headers: { "x-hub-signature-256": sig },
        body: rawBody,
      });
      expect(res.status).toBe(400);
    } finally {
      await server.close();
    }
  });

  it("dedupes a redelivered message id", async () => {
    const { server, port, transport } = await startWhatsAppServer();
    try {
      const payload = textMessagePayload("wamid.dup", "15551234567", "once");
      const rawBody = JSON.stringify(payload);
      const sig = metaSignature(appSecret, rawBody);
      const send = () =>
        fetch(`http://127.0.0.1:${port}/webhooks/whatsapp`, {
          method: "POST",
          headers: { "x-hub-signature-256": sig },
          body: rawBody,
        });
      const first = await send();
      const second = await send();
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(transport.sent).toEqual([{ to: "15551234567", text: "echo:once" }]);
    } finally {
      await server.close();
    }
  });
});

// ── Telegram ─────────────────────────────────────────────────────────────

describe("telegramIngressRoute", () => {
  function makeSink() {
    const updates: TelegramUpdate[] = [];
    return { updates, ingest: async (u: TelegramUpdate) => { updates.push(u); } };
  }

  it("full happy path: a POST with the correct secret token reaches the ingest sink", async () => {
    const { updates, ingest } = makeSink();
    const route = telegramIngressRoute({ ingest, secretToken: "tg-secret" });
    const server = new WebhookIngressServer({ routes: [route] });
    const { port } = await server.listen(0);
    try {
      const update: TelegramUpdate = { update_id: 42, message: { from: { id: 1 }, chat: { id: 1 }, text: "hi" } };
      const res = await fetch(`http://127.0.0.1:${port}/webhooks/telegram`, {
        method: "POST",
        headers: { "x-telegram-bot-api-secret-token": "tg-secret", "content-type": "application/json" },
        body: JSON.stringify(update),
      });
      expect(res.status).toBe(200);
      expect(updates).toEqual([update]);
    } finally {
      await server.close();
    }
  });

  it("rejects a wrong secret token with 401", async () => {
    const { updates, ingest } = makeSink();
    const route = telegramIngressRoute({ ingest, secretToken: "tg-secret" });
    const server = new WebhookIngressServer({ routes: [route] });
    const { port } = await server.listen(0);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/webhooks/telegram`, {
        method: "POST",
        headers: { "x-telegram-bot-api-secret-token": "wrong" },
        body: JSON.stringify({ update_id: 1 }),
      });
      expect(res.status).toBe(401);
      expect(updates).toHaveLength(0);
    } finally {
      await server.close();
    }
  });

  it("rejects a missing secret token with 401 when one is configured", async () => {
    const { updates, ingest } = makeSink();
    const route = telegramIngressRoute({ ingest, secretToken: "tg-secret" });
    const server = new WebhookIngressServer({ routes: [route] });
    const { port } = await server.listen(0);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/webhooks/telegram`, {
        method: "POST",
        body: JSON.stringify({ update_id: 1 }),
      });
      expect(res.status).toBe(401);
      expect(updates).toHaveLength(0);
    } finally {
      await server.close();
    }
  });

  it("accepts any delivery when no secret token is configured", async () => {
    const { updates, ingest } = makeSink();
    const route = telegramIngressRoute({ ingest });
    const server = new WebhookIngressServer({ routes: [route] });
    const { port } = await server.listen(0);
    try {
      const update: TelegramUpdate = { update_id: 7 };
      const res = await fetch(`http://127.0.0.1:${port}/webhooks/telegram`, {
        method: "POST",
        body: JSON.stringify(update),
      });
      expect(res.status).toBe(200);
      expect(updates).toEqual([update]);
    } finally {
      await server.close();
    }
  });

  it("400s a malformed JSON body even with a valid secret token", async () => {
    const { ingest } = makeSink();
    const route = telegramIngressRoute({ ingest, secretToken: "tg-secret" });
    const server = new WebhookIngressServer({ routes: [route] });
    const { port } = await server.listen(0);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/webhooks/telegram`, {
        method: "POST",
        headers: { "x-telegram-bot-api-secret-token": "tg-secret" },
        body: "{not json",
      });
      expect(res.status).toBe(400);
    } finally {
      await server.close();
    }
  });
});
