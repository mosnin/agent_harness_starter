import { SlackConnector, type SlackEventPayload } from "../connectors/slack";
import { WhatsAppConnector, type WhatsAppWebhookPayload } from "../connectors/whatsapp";
import type { TelegramUpdate } from "../connectors/telegram";
import type { IngressRequest, IngressResponse, IngressRoute } from "./http-server";
import { verifyMetaSignature, verifySlackSignature, verifyTelegramSecretToken } from "./signatures";

/**
 * Route factories that bind cryptographically verified webhook bytes to the
 * existing platform connectors. Each factory owns exactly the platform's
 * envelope: header extraction, signature verification against the *raw*
 * bytes (before any `JSON.parse`), retry/duplicate-delivery dedup, and — only
 * once a request is proven authentic — decoding and handing the payload to
 * the connector. None of this touches the connectors' own logic; it exists
 * so a webhook can be pointed at one port with only a token/secret.
 */

const DEFAULT_DEDUPE_CAPACITY = 1000;

/** A small capacity-bounded "seen" set. Oldest entry evicted first (FIFO). */
class BoundedSeenSet {
  private readonly order: string[] = [];
  private readonly seen = new Set<string>();
  private readonly capacity: number;

  constructor(capacity: number) {
    this.capacity = Math.max(1, Math.floor(capacity));
  }

  has(key: string): boolean {
    return this.seen.has(key);
  }

  /** Marks `key` seen, evicting the oldest entry first if at capacity. */
  add(key: string): void {
    if (this.seen.has(key)) return;
    if (this.seen.size >= this.capacity) {
      const oldest = this.order.shift();
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    this.seen.add(key);
    this.order.push(key);
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function json(status: number, body: unknown, headers?: Record<string, string>): IngressResponse {
  return { status, body: JSON.stringify(body), headers };
}

function decodeJson<T>(rawBody: Buffer): { ok: true; value: T } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(rawBody.toString("utf8")) as T };
  } catch {
    return { ok: false };
  }
}

// ── Slack ────────────────────────────────────────────────────────────────

export interface SlackIngressRouteOptions {
  connector: SlackConnector;
  signingSecret: string;
  path?: string;
  now?: () => number;
  dedupeCapacity?: number;
  log?: (line: string) => void;
}

/**
 * Slack Events API route. Verifies the `X-Slack-Signature` v0 HMAC over the
 * raw body, then:
 *  - `url_verification` payloads are answered synchronously with the
 *    challenge (no signed event required to do so, only a valid signature).
 *  - Everything else (`event_callback`, etc.) is ACKed with `200` immediately
 *    and handed to `connector.ingest` out-of-band — Slack expects an ack
 *    within ~3 seconds, well inside which a full agent turn may not finish,
 *    so the actual routing/reply happens after the response is already sent.
 *    A rejection from that background ingest is caught and logged, never
 *    left as an unhandled rejection.
 * Retried deliveries (Slack resends on a slow ack, carrying
 * `X-Slack-Retry-Num` and the same `event_id`) are deduped by a bounded,
 * capacity-evicting cache so a slow first ingest never runs twice.
 */
export function slackIngressRoute(opts: SlackIngressRouteOptions): IngressRoute {
  const path = opts.path ?? "/webhooks/slack";
  const nowFn = opts.now ?? Date.now;
  const log = opts.log ?? (() => {});
  const dedupe = new BoundedSeenSet(opts.dedupeCapacity ?? DEFAULT_DEDUPE_CAPACITY);

  return {
    method: "POST",
    path,
    async handle(req: IngressRequest): Promise<IngressResponse> {
      const verdict = verifySlackSignature({
        signingSecret: opts.signingSecret,
        timestampHeader: req.headers["x-slack-request-timestamp"],
        signatureHeader: req.headers["x-slack-signature"],
        rawBody: req.rawBody,
        nowMs: nowFn(),
      });
      if (!verdict.ok) {
        log(`slack ingress: rejected request on ${path} (${verdict.reason})`);
        return json(401, { error: "unauthorized" });
      }

      const decoded = decodeJson<SlackEventPayload>(req.rawBody);
      if (!decoded.ok) {
        log(`slack ingress: signed request on ${path} had malformed JSON`);
        return json(400, { error: "invalid json" });
      }
      const payload = decoded.value;

      if (payload.type === "url_verification") {
        const result = await opts.connector.ingest(payload);
        return json(200, { challenge: result.challenge });
      }

      const eventId = payload.event_id;
      const retryNum = req.headers["x-slack-retry-num"];
      if (eventId) {
        if (dedupe.has(eventId)) {
          log(`slack ingress: dropped duplicate delivery of event ${eventId}${retryNum ? ` (retry ${retryNum})` : ""}`);
          return json(200, { ok: true });
        }
        dedupe.add(eventId);
      }

      void opts.connector.ingest(payload).catch((err) => {
        log(`slack ingress: connector.ingest failed for event ${eventId ?? "(none)"}: ${errMessage(err)}`);
      });
      return json(200, { ok: true });
    },
  };
}

// ── WhatsApp (Meta Cloud API) ───────────────────────────────────────────────

export interface WhatsAppIngressRouteOptions {
  connector: WhatsAppConnector;
  appSecret: string;
  verifyToken: string;
  path?: string;
  dedupeCapacity?: number;
  log?: (line: string) => void;
}

/** Minimal shape used only to pull message ids out for dedup purposes. */
interface WhatsAppEnvelopeWithIds {
  entry?: Array<{
    changes?: Array<{
      value?: {
        messages?: Array<{ id?: string }>;
      };
    }>;
  }>;
}

function extractWhatsAppMessageIds(payload: WhatsAppEnvelopeWithIds): string[] {
  const ids: string[] = [];
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      for (const m of change.value?.messages ?? []) {
        if (m.id) ids.push(m.id);
      }
    }
  }
  return ids;
}

/**
 * WhatsApp Cloud API routes: the `GET` verification handshake and the `POST`
 * event delivery, on the same path (as Meta requires). `GET` requires the
 * query's `hub.verify_token` to match the configured token *and* delegates
 * to `connector.verify()` for the actual echo, so a connector built without
 * a matching token can never pass the handshake even if this route's token
 * were somehow misconfigured. `POST` verifies `X-Hub-Signature-256` over the
 * raw body before decoding, then dedupes by WhatsApp message id with a
 * bounded, capacity-evicting cache (Meta redelivers on a slow/failed ack).
 */
export function whatsAppIngressRoutes(opts: WhatsAppIngressRouteOptions): IngressRoute[] {
  const path = opts.path ?? "/webhooks/whatsapp";
  const log = opts.log ?? (() => {});
  const dedupe = new BoundedSeenSet(opts.dedupeCapacity ?? DEFAULT_DEDUPE_CAPACITY);

  const getRoute: IngressRoute = {
    method: "GET",
    path,
    async handle(req: IngressRequest): Promise<IngressResponse> {
      const mode = req.query.get("hub.mode") ?? "";
      const token = req.query.get("hub.verify_token") ?? "";
      const challenge = req.query.get("hub.challenge") ?? "";

      if (!token || token !== opts.verifyToken) {
        log(`whatsapp ingress: handshake token mismatch on ${path}`);
        return { status: 403, body: "forbidden", headers: { "content-type": "text/plain" } };
      }

      const echoed = opts.connector.verify(mode, token, challenge);
      if (echoed === null) {
        log(`whatsapp ingress: connector rejected handshake on ${path}`);
        return { status: 403, body: "forbidden", headers: { "content-type": "text/plain" } };
      }
      return { status: 200, body: echoed, headers: { "content-type": "text/plain" } };
    },
  };

  const postRoute: IngressRoute = {
    method: "POST",
    path,
    async handle(req: IngressRequest): Promise<IngressResponse> {
      const verdict = verifyMetaSignature({
        appSecret: opts.appSecret,
        signatureHeader: req.headers["x-hub-signature-256"],
        rawBody: req.rawBody,
      });
      if (!verdict.ok) {
        log(`whatsapp ingress: rejected request on ${path} (${verdict.reason})`);
        return json(401, { error: "unauthorized" });
      }

      const decoded = decodeJson<WhatsAppWebhookPayload & WhatsAppEnvelopeWithIds>(req.rawBody);
      if (!decoded.ok) {
        log(`whatsapp ingress: signed request on ${path} had malformed JSON`);
        return json(400, { error: "invalid json" });
      }
      const payload = decoded.value;

      const ids = extractWhatsAppMessageIds(payload);
      const freshIds = ids.filter((id) => !dedupe.has(id));
      for (const id of freshIds) dedupe.add(id);

      // Only skip re-ingesting when every message in this delivery has
      // already been processed — a mixed batch still needs a pass so the
      // genuinely new messages route.
      if (ids.length > 0 && freshIds.length === 0) {
        log(`whatsapp ingress: dropped duplicate delivery (${ids.length} already-seen message id(s))`);
        return json(200, { ok: true });
      }

      await opts.connector.ingest(payload);
      return json(200, { ok: true });
    },
  };

  return [getRoute, postRoute];
}

// ── Telegram ─────────────────────────────────────────────────────────────

export interface TelegramIngressRouteOptions {
  ingest: (update: TelegramUpdate) => Promise<void>;
  secretToken?: string;
  path?: string;
  log?: (line: string) => void;
}

/**
 * Telegram Bot API webhook route. When `secretToken` is configured, requires
 * `X-Telegram-Bot-Api-Secret-Token` to match it (constant-time) before
 * decoding — a wrong or missing token is a `401`, no exceptions. Without a
 * configured token the route accepts any delivery (Telegram itself makes the
 * secret optional). Once verified, the raw body is decoded and handed to the
 * injected `ingest` sink; a malformed body is a `400`, never a crash.
 */
export function telegramIngressRoute(opts: TelegramIngressRouteOptions): IngressRoute {
  const path = opts.path ?? "/webhooks/telegram";
  const log = opts.log ?? (() => {});

  return {
    method: "POST",
    path,
    async handle(req: IngressRequest): Promise<IngressResponse> {
      if (opts.secretToken) {
        const header = req.headers["x-telegram-bot-api-secret-token"];
        if (!verifyTelegramSecretToken(opts.secretToken, header)) {
          log(`telegram ingress: rejected request on ${path} (bad or missing secret token)`);
          return json(401, { error: "unauthorized" });
        }
      }

      const decoded = decodeJson<TelegramUpdate>(req.rawBody);
      if (!decoded.ok) {
        log(`telegram ingress: request on ${path} had malformed JSON`);
        return json(400, { error: "invalid json" });
      }

      await opts.ingest(decoded.value);
      return json(200, { ok: true });
    },
  };
}
