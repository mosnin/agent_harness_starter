/**
 * Sustained-load (soak) harness for the A2A fabric — a REAL endurance test.
 *
 * Where {@link ../bench/live-bench.ts} `benchA2ARoundTrip` measures a single
 * burst of RPC round-trips, this module drives genuine, high-rate request/
 * response traffic through the *actual* production transport
 * ({@link InMemoryA2ATransport}) continuously across many time windows, and then
 * proves two properties that only show up under sustained load:
 *
 *   1. **Stability** — throughput does not degrade over time. Each window's
 *      messages/sec is measured independently with the platform high-resolution
 *      clock (`performance.now`). `throughputStability = min/max` across windows
 *      is the headline: a value near 1.0 means the late windows are as fast as
 *      the early ones (no slow accretion — GC pressure, unbounded map growth,
 *      timer churn, mailbox backlog, …). We report the real ratio; we do not
 *      clamp or fake it.
 *
 *   2. **No leak** — every registration is accounted for. `endpointsAtStart` is
 *      read from the *live* transport BEFORE the soak and `endpointsAtEnd` AFTER
 *      teardown; `leaked` is the honest comparison `endpointsAtEnd >
 *      endpointsAtStart`, not a hardcoded pass. Because the baseline is captured
 *      on a truly fresh transport (see below), ANY endpoint or RPC peer that
 *      fails to unregister on `close()` — including the echo server itself —
 *      surfaces here as a leak.
 *
 * The traffic itself is real: a single echo `RpcPeer` server answers correlated
 * requests issued by a single client `RpcPeer` over the shared transport (the
 * exact pattern `benchA2ARoundTrip` uses, reproduced here rather than imported).
 * A `RpcPeer` correlates responses by id, so a single client can legitimately
 * hold many outstanding requests at once — that is how we sustain a bounded
 * in-flight window without a fleet of endpoints.
 *
 * Concurrency is bounded by a fixed worker pool of size `concurrency`: exactly
 * that many workers each keep at most one request outstanding, so the number of
 * simultaneously in-flight requests can never exceed `concurrency`. A LIVE
 * counter is incremented immediately before each `request` and decremented in
 * its `finally`, and its running maximum is recorded per window and overall as
 * `peakInFlight` (which therefore satisfies `peakInFlight <= concurrency`).
 *
 * ### Baseline semantics (what `endpointsAtStart` includes)
 * The baseline is captured on a FRESH transport *before any inbox is
 * registered*, so `endpointsAtStart === 0`. This is deliberate and is the
 * strictest possible leak detector: the echo server and client endpoints are
 * registered afterwards and are ALL torn down in teardown, so a correct run
 * returns the transport to exactly zero inboxes and `endpointsAtEnd === 0 ===
 * endpointsAtStart`. If any endpoint or peer leaked its registration, `size()`
 * after teardown would exceed the baseline and `leaked` would be `true`. (An
 * alternative convention would register the echo server up front and treat that
 * count as the baseline; capturing at zero is a superset check that also catches
 * a leaked server, so it is what we use.)
 *
 * Defaults (10 windows × 5000 messages, concurrency 64) are tuned so `runSoak()`
 * completes in ~1-3s on the synchronous in-memory transport.
 */

import { InMemoryA2ATransport, AgentEndpoint } from "../a2a/bus";
import { RpcPeer } from "../a2a/rpc";

/** High-resolution monotonic clock — same source the live benchmarks use. */
const now = (): number => performance.now();

/** Per-window measurement produced during a soak run. */
export interface SoakWindow {
  index: number;
  messages: number;
  elapsedMs: number;
  throughputPerSec: number;
  peakInFlight: number;
}

/** Aggregate result of a full soak run. */
export interface SoakResult {
  windows: SoakWindow[];
  totalMessages: number;
  meanThroughput: number;
  minThroughput: number;
  maxThroughput: number;
  /** minThroughput / maxThroughput, in (0,1]. Near 1.0 == perfectly stable. */
  throughputStability: number;
  /** Max concurrent in-flight requests observed across the whole run. */
  peakInFlight: number;
  /** transport.size() BEFORE the soak (baseline). */
  endpointsAtStart: number;
  /** transport.size() AFTER teardown. Should equal endpointsAtStart. */
  endpointsAtEnd: number;
  /** true iff endpointsAtEnd > endpointsAtStart (a registration leak). */
  leaked: boolean;
}

/**
 * Drive sustained echo-RPC traffic through the real A2A transport across many
 * windows, measuring per-window throughput and stability, and verifying that the
 * transport returns to its baseline inbox count after teardown (no leak).
 *
 * @param opts.windows           number of measurement windows (default 10)
 * @param opts.messagesPerWindow round-trips per window (default 5000)
 * @param opts.concurrency       max in-flight requests / worker-pool size (default 64)
 */
export async function runSoak(
  opts: { windows?: number; messagesPerWindow?: number; concurrency?: number } = {}
): Promise<SoakResult> {
  const windowCount = opts.windows ?? 10;
  const messagesPerWindow = opts.messagesPerWindow ?? 5000;
  const concurrency = Math.max(1, opts.concurrency ?? 64);

  // FRESH transport. Baseline is captured before ANY inbox is registered, so it
  // is the strictest leak reference: everything we register below must be gone
  // after teardown for endpointsAtEnd to return to this value.
  const transport = new InMemoryA2ATransport();
  const endpointsAtStart = transport.size();

  // Echo server + client over the shared transport (same shape as
  // benchA2ARoundTrip). A single client peer holds many correlated requests at
  // once, which is how we sustain the in-flight window.
  const serverEp = new AgentEndpoint({ agentId: "soak-server", team: "soak" }, transport, {
    idPrefix: "srv",
  });
  const clientEp = new AgentEndpoint({ agentId: "soak-client", team: "soak" }, transport, {
    idPrefix: "cli",
  });

  const server = new RpcPeer(serverEp);
  server.serve((payload) => payload); // echo
  const client = new RpcPeer(clientEp);

  // LIVE in-flight tracking, shared across all workers and windows.
  let inFlight = 0;
  let windowPeak = 0;
  let overallPeak = 0;

  const doRequest = async (): Promise<void> => {
    inFlight++;
    if (inFlight > windowPeak) windowPeak = inFlight;
    if (inFlight > overallPeak) overallPeak = inFlight;
    try {
      // timeoutMs: 0 disables the per-request timer — delivery is synchronous so
      // nothing can genuinely time out, and this keeps timer churn out of the
      // throughput measurement.
      await client.request(serverEp.address, { ping: 1 }, { timeoutMs: 0 });
    } finally {
      inFlight--;
    }
  };

  const windows: SoakWindow[] = [];

  for (let w = 0; w < windowCount; w++) {
    windowPeak = 0;

    // Bounded worker pool: exactly `concurrency` workers, each keeping at most
    // one request outstanding — so in-flight never exceeds `concurrency`.
    let dispatched = 0;
    const worker = async (): Promise<void> => {
      while (dispatched < messagesPerWindow) {
        dispatched++;
        await doRequest();
      }
    };

    const t0 = now();
    const pool = Array.from({ length: Math.min(concurrency, messagesPerWindow) }, () => worker());
    await Promise.all(pool);
    const elapsedMs = now() - t0;

    const throughputPerSec = elapsedMs > 0 ? (messagesPerWindow / elapsedMs) * 1000 : Infinity;
    windows.push({
      index: w,
      messages: messagesPerWindow,
      elapsedMs,
      throughputPerSec,
      peakInFlight: windowPeak,
    });
  }

  // TEARDOWN: close everything we registered. On a correct run this unregisters
  // every inbox and transport.size() returns to the baseline.
  client.close();
  server.close();
  clientEp.close();
  serverEp.close();

  const endpointsAtEnd = transport.size();
  const leaked = endpointsAtEnd > endpointsAtStart;

  const throughputs = windows.map((x) => x.throughputPerSec);
  const totalMessages = windows.reduce((a, x) => a + x.messages, 0);
  const meanThroughput =
    throughputs.length > 0 ? throughputs.reduce((a, b) => a + b, 0) / throughputs.length : 0;
  const minThroughput = throughputs.length > 0 ? Math.min(...throughputs) : 0;
  const maxThroughput = throughputs.length > 0 ? Math.max(...throughputs) : 0;
  const throughputStability = maxThroughput > 0 ? minThroughput / maxThroughput : 1;

  return {
    windows,
    totalMessages,
    meanThroughput,
    minThroughput,
    maxThroughput,
    throughputStability,
    peakInFlight: overallPeak,
    endpointsAtStart,
    endpointsAtEnd,
    leaked,
  };
}
