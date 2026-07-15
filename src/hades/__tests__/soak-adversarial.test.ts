import { describe, it, expect } from "vitest";
import { runSoak } from "../bench/soak";
import type { SoakResult, SoakWindow } from "../bench/soak";
import { probeLeaks } from "../bench/leak-probe";
import type { LeakReport, LeakSample } from "../bench/leak-probe";
import { InMemoryA2ATransport, AgentEndpoint } from "../a2a/bus";
import type { AgentAddress } from "../a2a/types";

/**
 * ADVERSARIAL VERIFIER for the soak / leak-probe harnesses.
 *
 * Goal: prove these harnesses are NOT vacuous (do real work), NOT rigged
 * (leaked=false / stability=1 are computed, not hardcoded), and NOT wrong
 * (in-flight counted correctly, throughput measured correctly, a real leak
 * would actually register). Where the contract is violated we assert the
 * CORRECT behavior and let the test fail — we do not weaken to green.
 */

const isFinitePos = (n: number) => Number.isFinite(n) && n > 0;

/* ================================================================== */
/* 1. SOAK IS NON-VACUOUS                                              */
/* ================================================================== */
describe("soak — non-vacuous structure & concurrency", () => {
  it("does the full amount of work and respects the concurrency bound", async () => {
    const concurrency = 32;
    const r: SoakResult = await runSoak({
      windows: 6,
      messagesPerWindow: 1000,
      concurrency,
    });

    // Structure: exactly the requested number of windows, each full.
    expect(r.windows.length).toBe(6);
    for (const w of r.windows) {
      expect(w.messages).toBe(1000);
      // throughput must be a real, positive, finite measurement per window.
      expect(isFinitePos(w.throughputPerSec)).toBe(true);
      expect(Number.isFinite(w.elapsedMs)).toBe(true);
    }
    expect(r.totalMessages).toBe(6000);
    expect(isFinitePos(r.meanThroughput)).toBe(true);

    // Concurrency bound: peak must be observed (>=1) and must NEVER exceed the
    // limiter's cap. Exceeding => limiter broken. (See separate "real
    // concurrency" assertion below for the always-1 / rigged cases.)
    expect(r.peakInFlight).toBeGreaterThanOrEqual(1);
    expect(r.peakInFlight).toBeLessThanOrEqual(concurrency);

    // Stability is a ratio in (0, 1].
    expect(r.throughputStability).toBeGreaterThan(0);
    expect(r.throughputStability).toBeLessThanOrEqual(1);
  });

  it("actually runs work concurrently (peakInFlight > 1 with concurrency 32)", async () => {
    // With 1000 messages/window and a cap of 32, a genuinely concurrent
    // harness must observe more than one in-flight at some point. peakInFlight
    // stuck at exactly 1 means the "soak" is serial and stresses nothing.
    const r = await runSoak({ windows: 3, messagesPerWindow: 1000, concurrency: 32 });
    expect(r.peakInFlight).toBeGreaterThan(1);
  });
});

/* ================================================================== */
/* 2. LEAK CHECK IS REAL, NOT HARDCODED                               */
/*    First prove the underlying signal (transport.size()) is a       */
/*    truthful live counter by leaking endpoints ourselves.           */
/* ================================================================== */
describe("leak probe — the leak signal is real, not a hardcoded false", () => {
  it("transport.size() GROWS by N when N endpoints are registered without close()", () => {
    const transport = new InMemoryA2ATransport();
    const baseline = transport.size();
    expect(baseline).toBe(0);

    const N = 8;
    const endpoints: AgentEndpoint[] = [];
    for (let i = 0; i < N; i++) {
      const addr: AgentAddress = { agentId: `leak-probe-${i}` };
      // Intentionally LEAK: register, never close.
      endpoints.push(new AgentEndpoint(addr, transport));
      // Monotonic growth as we add — proves size() tracks live registrations.
      expect(transport.size()).toBe(baseline + i + 1);
    }
    // The un-closed endpoints are still resident: size() reflects the leak.
    expect(transport.size()).toBe(baseline + N);

    // Now clean up: closing each endpoint must return size() to baseline.
    for (const ep of endpoints) ep.close();
    expect(transport.size()).toBe(baseline);
  });

  it("register-and-close leaves no residue (proves size() is a true live counter)", () => {
    const transport = new InMemoryA2ATransport();
    const baseline = transport.size();
    for (let i = 0; i < 25; i++) {
      const ep = new AgentEndpoint({ agentId: `cycle-${i}` }, transport);
      expect(transport.size()).toBe(baseline + 1);
      ep.close();
      expect(transport.size()).toBe(baseline);
    }
    expect(transport.size()).toBe(baseline);
  });

  it("probeLeaks reports a genuinely clean lifecycle (no drift, no residue)", async () => {
    const report: LeakReport = await probeLeaks({
      cycles: 20,
      endpointsPerCycle: 8,
      workPerCycle: 100,
    });

    // Exact structure determined by opts.
    expect(report.samples.length).toBe(20);

    // Clean lifecycle: no leak, zero drift, no pending RPCs at the end.
    expect(report.leaked).toBe(false);
    expect(report.maxDrift).toBe(0);
    expect(report.final.pendingRpc).toBe(0);

    // The transport size must NOT trend upward across the run: the first and
    // last samples must be equal. A rising trend = a real accumulating leak
    // that a hardcoded leaked:false would mask.
    const first: LeakSample = report.samples[0];
    const last: LeakSample = report.samples[report.samples.length - 1];
    expect(last.transportSize).toBe(first.transportSize);

    // And every sample sits at the baseline (no partial residue mid-run).
    for (const s of report.samples) {
      expect(s.transportSize).toBe(report.baseline.transportSize);
      expect(s.pendingRpc).toBe(0);
    }
    expect(report.final.transportSize).toBe(report.baseline.transportSize);
  });
});

/* ================================================================== */
/* 3. THROUGHPUT MEASUREMENT SANITY                                   */
/* ================================================================== */
describe("soak — throughput arithmetic is internally consistent", () => {
  it("min <= mean <= max, stability == min/max, and totals sum the windows", async () => {
    const r = await runSoak({ windows: 6, messagesPerWindow: 1000, concurrency: 16 });

    expect(r.minThroughput).toBeLessThanOrEqual(r.meanThroughput);
    expect(r.meanThroughput).toBeLessThanOrEqual(r.maxThroughput);

    // Recompute stability from the reported extremes — do not trust the field.
    // High-precision closeness guards against pure FP rounding only.
    expect(r.maxThroughput).toBeGreaterThan(0);
    expect(r.throughputStability).toBeCloseTo(r.minThroughput / r.maxThroughput, 10);

    // totalMessages must equal the sum of per-window message counts.
    const summed = r.windows.reduce((a, w: SoakWindow) => a + w.messages, 0);
    expect(r.totalMessages).toBe(summed);

    // min/max must actually be the extremes of the observed per-window values.
    const tps = r.windows.map((w) => w.throughputPerSec);
    expect(r.minThroughput).toBeCloseTo(Math.min(...tps), 6);
    expect(r.maxThroughput).toBeCloseTo(Math.max(...tps), 6);
  });
});

/* ================================================================== */
/* 4. STABILITY UNDER SUSTAINED LOAD                                  */
/* ================================================================== */
describe("soak — throughput does not collapse under sustained load", () => {
  it("last window keeps >=40% of the first window's throughput (no monotonic decay)", async () => {
    // Tolerance rationale: a genuine accumulating leak (unbounded subs / pending
    // RPC growth) makes per-op cost grow and throughput trend toward zero over
    // 12 windows. 40% is loose enough to absorb GC pauses / normal jitter yet
    // tight enough to catch a real downward trend (a 60%+ sustained drop is not
    // jitter). If this fails, throughput is collapsing => real degradation bug.
    const r = await runSoak({ windows: 12, messagesPerWindow: 3000 });
    expect(r.windows.length).toBe(12);
    const first = r.windows[0].throughputPerSec;
    const last = r.windows[r.windows.length - 1].throughputPerSec;
    expect(isFinitePos(first)).toBe(true);
    expect(isFinitePos(last)).toBe(true);
    expect(last).toBeGreaterThanOrEqual(first * 0.4);
  });
});

/* ================================================================== */
/* 5. RESULTS INTEGRITY                                               */
/* ================================================================== */
describe("soak — cleans up after itself", () => {
  it("endpointsAtEnd === endpointsAtStart and leaked === false", async () => {
    const r = await runSoak({ windows: 4, messagesPerWindow: 500, concurrency: 8 });
    expect(r.endpointsAtEnd).toBe(r.endpointsAtStart);
    expect(r.leaked).toBe(false);
  });
});

/* ================================================================== */
/* 6. DETERMINISM OF STRUCTURE                                        */
/*    Timing varies run-to-run; counts are fixed by opts.             */
/* ================================================================== */
describe("structure is deterministic across runs (only timing varies)", () => {
  it("soak window/total counts are fixed by opts", async () => {
    const opts = { windows: 5, messagesPerWindow: 200, concurrency: 8 };
    const a = await runSoak(opts);
    const b = await runSoak(opts);
    expect(a.windows.length).toBe(5);
    expect(b.windows.length).toBe(5);
    expect(a.totalMessages).toBe(1000);
    expect(b.totalMessages).toBe(1000);
    expect(a.windows.map((w) => w.messages)).toEqual(b.windows.map((w) => w.messages));
  });

  it("leak-probe sample count is fixed by opts", async () => {
    const a = await probeLeaks({ cycles: 6, endpointsPerCycle: 4, workPerCycle: 25 });
    const b = await probeLeaks({ cycles: 6, endpointsPerCycle: 4, workPerCycle: 25 });
    expect(a.samples.length).toBe(6);
    expect(b.samples.length).toBe(6);
    expect(a.leaked).toBe(false);
    expect(b.leaked).toBe(false);
  });
});
