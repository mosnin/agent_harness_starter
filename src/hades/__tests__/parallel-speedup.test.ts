import { describe, it, expect } from "vitest";
import { modelSpeedup, timed, benchmarkSpeedup } from "../parallel/speedup";

describe("modelSpeedup", () => {
  it("computes perfect scaling for balanced work", () => {
    // 4 tasks of 10ms across 4 agents → parallel 10ms, serial 40ms.
    const m = modelSpeedup([10, 10, 10, 10], 4);
    expect(m.serialMs).toBe(40);
    expect(m.parallelMs).toBe(10);
    expect(m.speedup).toBe(4);
    expect(m.efficiency).toBe(1);
  });

  it("greedy-schedules uneven work across agents", () => {
    // costs [8,4,4,4] on 2 agents: agent A gets 8, agent B gets 4+4+4=12 → makespan 12.
    const m = modelSpeedup([8, 4, 4, 4], 2);
    expect(m.serialMs).toBe(20);
    expect(m.parallelMs).toBe(12);
    expect(m.speedup).toBeCloseTo(20 / 12, 5);
    expect(m.efficiency).toBeCloseTo(20 / 12 / 2, 5);
  });

  it("single agent gives no speedup", () => {
    const m = modelSpeedup([5, 5, 5], 1);
    expect(m.speedup).toBe(1);
    expect(m.efficiency).toBe(1);
  });

  it("rejects zero agents", () => {
    expect(() => modelSpeedup([1], 0)).toThrow(/at least one agent/);
  });
});

describe("timed + benchmarkSpeedup", () => {
  it("measures elapsed with an injectable clock", async () => {
    let t = 100;
    const res = await timed(async () => "ok", () => (t += 25));
    expect(res.value).toBe("ok");
    expect(res.elapsedMs).toBe(25);
  });

  it("reports speedup from serial vs parallel timings", async () => {
    // Fake clock: serial takes 3 ticks of 30, parallel 2 ticks of 10.
    const ticks = [0, 60, 60, 70]; // start s, end s, start p, end p
    let i = 0;
    const now = () => ticks[i++];
    const report = await benchmarkSpeedup({
      agents: 4,
      serial: async () => undefined,
      parallel: async () => undefined,
      now,
    });
    expect(report.serialMs).toBe(60);
    expect(report.parallelMs).toBe(10);
    expect(report.speedup).toBe(6);
    expect(report.efficiency).toBe(1.5);
  });
});
