/**
 * Runnable A2A performance measurements: object pooling vs fresh allocation, and
 * batched (coalesced) publishing vs direct publishing. Uses `performance.now()`
 * for wall-clock timing. These are throughput sanity checks, not statistical
 * micro-benchmarks — the point is a reproducible, fast ops/sec signal.
 */

import { InMemoryA2ATransport, AgentEndpoint } from "../a2a/bus";
import { MessagePool } from "../a2a/pool";
import { BatchedA2ATransport } from "../a2a/batched";
import type { A2AMessage } from "../a2a/types";

/** A reusable envelope-shaped record used by the pooling benchmark. */
interface Envelope {
  id: number;
  topic: string;
  payload: { n: number };
}

function makeEnvelope(): Envelope {
  return { id: 0, topic: "", payload: { n: 0 } };
}

function resetEnvelope(e: Envelope): void {
  e.id = 0;
  e.topic = "";
  e.payload.n = 0;
}

/**
 * Measure acquire→mutate→release throughput on a {@link MessagePool} against
 * allocating a fresh object every iteration.
 */
export async function benchPooling(
  opts: { iterations?: number } = {}
): Promise<{ pooledOpsPerSec: number; unpooledOpsPerSec: number; reuseRatio: number }> {
  const iterations = opts.iterations ?? 200_000;
  const pool = new MessagePool<Envelope>(makeEnvelope, resetEnvelope);

  // Pooled path.
  const pooledStart = performance.now();
  for (let i = 0; i < iterations; i++) {
    const e = pool.acquire();
    e.id = i;
    e.topic = "bench";
    e.payload.n = i;
    pool.release(e);
  }
  const pooledMs = performance.now() - pooledStart;

  // Unpooled path — fresh allocation each iteration.
  const unpooledStart = performance.now();
  for (let i = 0; i < iterations; i++) {
    const e: Envelope = { id: i, topic: "bench", payload: { n: i } };
    // Touch the object so the allocation isn't optimized away.
    if (e.id < 0) throw new Error("unreachable");
  }
  const unpooledMs = performance.now() - unpooledStart;

  const s = pool.stats();
  return {
    pooledOpsPerSec: iterations / (pooledMs / 1000),
    unpooledOpsPerSec: iterations / (unpooledMs / 1000),
    reuseRatio: s.acquired === 0 ? 0 : s.reused / s.acquired,
  };
}

/**
 * Measure direct vs batched publish throughput over an in-memory transport.
 * Two endpoints; the sender fires N point-to-point messages at the receiver.
 */
export async function benchBatchedThroughput(
  opts: { messages?: number; maxBatch?: number } = {}
): Promise<{ batchedMsgsPerSec: number; directMsgsPerSec: number; flushes: number; messages: number }> {
  const messages = opts.messages ?? 50_000;
  const maxBatch = opts.maxBatch ?? 256;

  // --- Direct publish baseline ---
  {
    const transport = new InMemoryA2ATransport();
    const sender = new AgentEndpoint({ agentId: "sender", team: "b" }, transport, { idPrefix: "s" });
    const receiver = new AgentEndpoint({ agentId: "receiver", team: "b" }, transport, { idPrefix: "r" });
    let received = 0;
    receiver.on(() => {
      received++;
    });

    const directStart = performance.now();
    for (let i = 0; i < messages; i++) {
      void sender.emit(receiver.address, { n: i });
    }
    const directMs = performance.now() - directStart;
    if (received !== messages) throw new Error(`direct dropped: ${received}/${messages}`);

    // --- Batched publish ---
    const batTransport = new InMemoryA2ATransport();
    let flushes = 0;
    const batched = new BatchedA2ATransport(batTransport, {
      maxBatch,
      onFlush: () => {
        flushes++;
      },
    });
    const batReceiver = new AgentEndpoint({ agentId: "receiver", team: "b" }, batTransport, { idPrefix: "r" });
    const batFactory = new AgentEndpoint({ agentId: "sender", team: "b" }, batTransport, { idPrefix: "s" }).factory;
    let batReceived = 0;
    batReceiver.on(() => {
      batReceived++;
    });

    const batchedStart = performance.now();
    for (let i = 0; i < messages; i++) {
      const msg: A2AMessage = batFactory.event(batReceiver.address, { n: i });
      batched.publish(msg);
    }
    batched.flush();
    const batchedMs = performance.now() - batchedStart;
    if (batReceived !== messages) throw new Error(`batched dropped: ${batReceived}/${messages}`);

    return {
      batchedMsgsPerSec: messages / (batchedMs / 1000),
      directMsgsPerSec: messages / (directMs / 1000),
      flushes,
      messages,
    };
  }
}

/** Run every benchmark and return a flat record of the measured numbers. */
export async function runBatchBenchmarks(): Promise<Record<string, unknown>> {
  const pooling = await benchPooling();
  const batched = await benchBatchedThroughput();
  return {
    pooledOpsPerSec: Math.round(pooling.pooledOpsPerSec),
    unpooledOpsPerSec: Math.round(pooling.unpooledOpsPerSec),
    reuseRatio: pooling.reuseRatio,
    batchedMsgsPerSec: Math.round(batched.batchedMsgsPerSec),
    directMsgsPerSec: Math.round(batched.directMsgsPerSec),
    flushes: batched.flushes,
    messages: batched.messages,
  };
}
