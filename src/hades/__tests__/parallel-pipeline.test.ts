import { describe, it, expect } from "vitest";
import { pipeline } from "../parallel/pipeline";

describe("pipeline", () => {
  it("flows items through role stages, results in input order", async () => {
    const { results, byStage } = await pipeline<number>(
      [1, 2, 3],
      [
        { role: "researcher", handle: async (n: number) => n + 1 },
        { role: "coder", handle: async (n: number) => n * 10 },
        { role: "reviewer", handle: async (n: number) => n - 1 },
      ]
    );
    expect(results).toEqual([19, 29, 39]); // ((n+1)*10)-1
    expect(byStage).toEqual({ researcher: 3, coder: 3, reviewer: 3 });
  });

  it("overlaps stages (no barrier between them)", async () => {
    const timeline: string[] = [];
    await pipeline(
      [1, 2],
      [
        {
          name: "s1",
          handle: async (n: number) => {
            timeline.push(`s1-start-${n}`);
            await new Promise((r) => setTimeout(r, 5));
            timeline.push(`s1-end-${n}`);
            return n;
          },
        },
        {
          name: "s2",
          handle: async (n: number) => {
            timeline.push(`s2-start-${n}`);
            return n;
          },
        },
      ]
    );
    // Item 1 enters s2 while item 2 is still moving through s1 — assembly line.
    const s2Start1 = timeline.indexOf("s2-start-1");
    const s1End2 = timeline.indexOf("s1-end-2");
    expect(s2Start1).toBeLessThan(s1End2);
  });

  it("respects per-stage concurrency", async () => {
    let inStage = 0;
    let maxInStage = 0;
    await pipeline(
      [1, 2, 3, 4, 5, 6],
      [
        {
          name: "bounded",
          concurrency: 2,
          handle: async (n: number) => {
            inStage++;
            maxInStage = Math.max(maxInStage, inStage);
            await new Promise((r) => setTimeout(r, 2));
            inStage--;
            return n;
          },
        },
      ]
    );
    expect(maxInStage).toBeLessThanOrEqual(2);
  });

  it("rejects on a stage error by default, collects with continueOnError", async () => {
    const stages = [
      { name: "s", handle: async (n: number) => {
        if (n === 2) throw new Error("bad n");
        return n;
      } },
    ];
    await expect(pipeline([1, 2, 3], stages)).rejects.toThrow(/item 1 failed: bad n/);

    const { results } = await pipeline<number>([1, 2, 3], stages, { continueOnError: true });
    expect(results).toEqual([1, 3]);
  });
});
