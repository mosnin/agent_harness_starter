/**
 * Resource-LEAK probe for the A2A fabric.
 *
 * Unlike the perf benchmarks in `live-bench.ts` (which time throughput), this
 * probe answers a different question: does the create → work → teardown lifecycle
 * of the REAL production primitives leave anything behind? It runs many full
 * cycles against a single shared {@link InMemoryA2ATransport} and, AFTER each
 * cycle has fully torn down, measures two genuine, load-bearing numbers:
 *
 *   - `transport.size()` — the count of registered subscriber inboxes. Every
 *     {@link AgentEndpoint} registers one on construction and removes it on
 *     `close()`. A missed unsubscribe would make this grow, cycle over cycle.
 *   - the sum of {@link RpcPeer.inFlight} across the peers created that cycle —
 *     the count of requests still awaiting a response. After `close()` (which
 *     rejects and clears all pending entries) this must be 0.
 *
 * A genuine leak — a forgotten `unsub()`, a peer that keeps a mailbox listener,
 * a pending map that is never cleared — would surface as monotonic growth in
 * `transportSize` and/or a non-zero `pendingRpc`, i.e. `maxDrift > 0` and
 * `leaked === true`. A correct lifecycle returns `transport.size()` to its
 * baseline after every single cycle, so `maxDrift === 0` and `leaked === false`.
 *
 * Everything measured here is the actual production API surface, driven with real
 * echo RPC round-trips — no mocks, no stubs. The numbers are what the code
 * genuinely does.
 */

import { InMemoryA2ATransport, AgentEndpoint } from "../a2a/bus";
import { RpcPeer } from "../a2a/rpc";

/** One measurement, taken on a fully-quiesced transport after a cycle tore down. */
export interface LeakSample {
  cycle: number;
  /** `transport.size()` after this cycle's teardown. */
  transportSize: number;
  /** Sum of `RpcPeer.inFlight()` across the cycle's peers after teardown. Should be 0. */
  pendingRpc: number;
}

/** Verdict of a full {@link probeLeaks} run. */
export interface LeakReport {
  /** Measured on the fresh transport before any cycle (a clean transport: size 0). */
  baseline: LeakSample;
  /** One entry per cycle, each measured AFTER that cycle fully tore down. */
  samples: LeakSample[];
  /** Convenience alias for the last sample. */
  final: LeakSample;
  /**
   * true iff `final.transportSize > baseline.transportSize`, OR `final.pendingRpc > 0`,
   * OR `transportSize` grows strictly monotonically across cycles (a creeping leak).
   */
  leaked: boolean;
  /** max over cycles of `(sample.transportSize - baseline.transportSize)`. 0 == perfectly clean. */
  maxDrift: number;
}

/**
 * Run `cycles` independent create→work→teardown cycles against one shared, real
 * {@link InMemoryA2ATransport} and prove tracked resource counts return to
 * baseline every cycle.
 *
 * Each cycle constructs `endpointsPerCycle` {@link AgentEndpoint}s on the shared
 * transport: endpoint 0 is an echo server (its {@link RpcPeer} answers every
 * request with the payload it received), the rest are clients. It then performs
 * `workPerCycle` real echo RPC round-trips spread round-robin across the clients
 * (timeouts disabled, matching `benchA2ARoundTrip`, so delivery is synchronous
 * and every request resolves — nothing is left pending by the workload itself).
 * Finally it `close()`s every peer and every endpoint created this cycle, then
 * samples `transport.size()` and the summed `inFlight()`.
 *
 * Defaults (50 × 8 endpoints × 200 round-trips) complete in ~1-3s.
 */
export async function probeLeaks(opts: {
  cycles?: number;
  endpointsPerCycle?: number;
  workPerCycle?: number;
} = {}): Promise<LeakReport> {
  const cycles = opts.cycles ?? 50;
  const endpointsPerCycle = Math.max(2, opts.endpointsPerCycle ?? 8);
  const workPerCycle = opts.workPerCycle ?? 200;

  // One shared transport for the whole run: this is what would accumulate leaked
  // subscriptions if teardown were incomplete.
  const transport = new InMemoryA2ATransport();

  // Baseline: a fresh transport has zero registered inboxes and nothing pending.
  const baseline: LeakSample = { cycle: -1, transportSize: transport.size(), pendingRpc: 0 };

  const samples: LeakSample[] = [];

  for (let c = 0; c < cycles; c++) {
    const endpoints: AgentEndpoint[] = [];
    const peers: RpcPeer[] = [];

    // Create this cycle's endpoints + peers on the shared transport. Unique ids
    // per cycle so registration never collides with a (properly removed) prior one.
    for (let e = 0; e < endpointsPerCycle; e++) {
      const ep = new AgentEndpoint(
        { agentId: `c${c}-e${e}`, team: "leak" },
        transport,
        { idPrefix: `c${c}-e${e}` }
      );
      endpoints.push(ep);
      peers.push(new RpcPeer(ep));
    }

    // Endpoint 0 serves echo; the rest issue requests to it.
    const serverEp = endpoints[0];
    peers[0].serve((payload) => payload);
    const clientPeers = peers.slice(1);

    // Perform real echo round-trips, distributed round-robin across the clients.
    const inflight: Promise<unknown>[] = [];
    for (let w = 0; w < workPerCycle; w++) {
      const client = clientPeers[w % clientPeers.length];
      inflight.push(client.request(serverEp.address, { ping: w }, { timeoutMs: 0 }));
    }
    await Promise.all(inflight);

    // FULL teardown: close every peer (clears its pending map + drops its mailbox
    // listener) and every endpoint (removes its transport subscription).
    for (const peer of peers) peer.close();
    for (const ep of endpoints) ep.close();

    // Sample AFTER teardown: a clean lifecycle returns size to baseline and leaves
    // no in-flight requests.
    const pendingRpc = peers.reduce((sum, p) => sum + p.inFlight(), 0);
    samples.push({ cycle: c, transportSize: transport.size(), pendingRpc });
  }

  const final = samples[samples.length - 1] ?? baseline;

  const maxDrift = samples.reduce(
    (max, s) => Math.max(max, s.transportSize - baseline.transportSize),
    0
  );

  // Strictly-monotonic-increasing transportSize across cycles == a creeping leak,
  // even if no single cycle's absolute size looks alarming.
  let strictlyMonotonic = samples.length > 1;
  for (let i = 1; i < samples.length; i++) {
    if (samples[i].transportSize <= samples[i - 1].transportSize) {
      strictlyMonotonic = false;
      break;
    }
  }

  const leaked =
    final.transportSize > baseline.transportSize ||
    final.pendingRpc > 0 ||
    strictlyMonotonic;

  return { baseline, samples, final, leaked, maxDrift };
}
