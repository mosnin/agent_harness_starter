/**
 * Puts per-platform outbound chunking on the actual wire.
 *
 * {@link chunkMessage} (./message-format) already knows how to split an
 * over-long reply into size-legal, `(i/n)`-marked pieces — but nothing wired
 * that into the connectors themselves. Every {@link PlatformConnector}'s own
 * reply path (`if (reply.text) await transport.send(...)`) and every
 * proactive {@link ConnectorHub.deliver} call sends `reply.text`/`text`
 * verbatim, so a reply or a proactive push that exceeds the platform's
 * `maxChars` either gets rejected by the real API or silently truncated by
 * it — the gateway never actually chunks anything it sends.
 *
 * {@link ChunkingConnector} closes that gap by decorating any
 * `PlatformConnector`: every `send()` call is chunked before it reaches the
 * inner transport, and every inbound-triggered reply is intercepted, chunked,
 * and delivered chunk-by-chunk through the inner connector's own `send`
 * (`start()`'s wrapping), so the inner connector's normal single-text reply
 * path never has anything left to send. The decorator adds no behavior of
 * its own beyond splitting and re-sequencing text that was always going to be
 * sent — no new I/O, no new dependencies, no retry policy of its own.
 *
 * @module hades/gateway/chunked-delivery
 */

import { chunkMessage, platformFormat } from "./message-format";
import type { PlatformConnector, DeliveryTarget } from "./connector";
import type { InboundMessage, OutboundReply } from "../../swarm-runtime/gateway/gateway";

/**
 * Sequentially deliver `chunks` via `sendChunk`, in order, awaiting each one
 * before starting the next. On the i-th chunk's failure (1-indexed), stops
 * immediately — chunks after it are never attempted — and rethrows a new
 * `Error` that names `platform` and the failed index `i` of `n`, with the
 * original failure chained as `cause` and its message folded in so nothing
 * about the underlying failure is lost. Chunks 1..i-1 are, by construction,
 * already delivered by the time this throws.
 */
async function deliverSequentially(
  platform: string,
  chunks: string[],
  sendChunk: (chunk: string) => Promise<void>,
): Promise<void> {
  const n = chunks.length;
  for (let idx = 0; idx < n; idx++) {
    try {
      await sendChunk(chunks[idx]);
    } catch (err) {
      const i = idx + 1;
      const { maxChars } = platformFormat(platform);
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(
        `ChunkingConnector: delivery to platform "${platform}" (maxChars=${maxChars}) failed at chunk ${i}/${n} — ` +
          `chunk(s) 1..${i - 1} were already delivered, chunk(s) ${i}..${n} were not attempted ` +
          `(underlying error: ${reason})`,
        { cause: err },
      );
    }
  }
}

/**
 * Decorates a {@link PlatformConnector} so every reply and every proactive
 * `send()` leaves the gateway as N marked, size-legal chunks per
 * {@link chunkMessage}, instead of the inner connector's raw, unchunked text.
 *
 * - `send(target, text)`: chunks `text` for `this.platform` and delivers each
 *   chunk to `inner.send` strictly sequentially, in order. Empty `text`
 *   chunks to `[]` and sends nothing — no call to `inner.send` at all.
 * - `start(handler)`: wraps `handler` so that once it resolves, its reply
 *   text is chunked. A single chunk (or no chunk, i.e. empty text) is left
 *   completely untouched — the reply is returned as-is and the inner
 *   connector's own existing "if (reply.text) send(...)" path remains the
 *   one and only wire path, so the common case gets zero extra transport
 *   calls and byte-identical output. Multiple chunks are delivered by this
 *   decorator itself, sequentially, via `inner.send`, and the wrapped
 *   handler then returns `{ ...reply, text: "" }` so the inner connector's
 *   own reply path has nothing left to send (avoiding a duplicate,
 *   unchunked send of the full text).
 * - `stop()` / `platform` delegate to `inner` unchanged.
 *
 * A mid-sequence `inner.send` failure (in either `send()` or the `start()`
 * reply path) stops immediately and rethrows an `Error` naming the platform
 * and the failed chunk's index — chunks before it are already delivered,
 * chunks after it are never attempted. Nothing is ever swallowed or silently
 * retried.
 */
export class ChunkingConnector implements PlatformConnector {
  constructor(private readonly inner: PlatformConnector) {}

  get platform(): PlatformConnector["platform"] {
    return this.inner.platform;
  }

  async send(target: DeliveryTarget, text: string): Promise<void> {
    const chunks = chunkMessage(text, this.platform);
    await deliverSequentially(this.platform, chunks, (chunk) => this.inner.send(target, chunk));
  }

  async start(handler: (msg: InboundMessage) => Promise<OutboundReply>): Promise<void> {
    const wrapped = async (msg: InboundMessage): Promise<OutboundReply> => {
      const reply = await handler(msg);
      const chunks = chunkMessage(reply.text, this.platform);

      if (chunks.length <= 1) {
        // Empty text (chunks.length === 0) or already within the platform's
        // limit (chunks.length === 1): nothing for this decorator to do —
        // hand the reply back unmodified so the inner connector's normal
        // reply path stays the wire path, unchanged and undelayed.
        return reply;
      }

      const target: DeliveryTarget = { user: msg.user, channel: msg.channel };
      await deliverSequentially(this.platform, chunks, (chunk) => this.inner.send(target, chunk));

      // This decorator already delivered every chunk directly through
      // inner.send — leave nothing for the inner connector's own
      // "if (reply.text) send(...)" reply path to send.
      return { ...reply, text: "" };
    };

    await this.inner.start(wrapped);
  }

  async stop(): Promise<void> {
    await this.inner.stop();
  }
}

/**
 * Wrap every connector in `connectors` with {@link ChunkingConnector} so
 * every reply and proactive send it delivers is chunked on the wire.
 * Idempotent: a connector that is already a `ChunkingConnector` is returned
 * as-is rather than wrapped again (checked with `instanceof`), so chunking
 * twice never double-marks a message or re-chunks already-chunked text.
 */
export function withChunking(connectors: PlatformConnector[]): PlatformConnector[] {
  return connectors.map((c) => (c instanceof ChunkingConnector ? c : new ChunkingConnector(c)));
}
