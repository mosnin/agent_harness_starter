import { describe, it, expect } from "vitest";
import { mapReduce } from "../parallel/mapreduce";

describe("mapReduce", () => {
  it("scatters a map across the team and reduces to one value", async () => {
    // Sum of squares, mapped in parallel across 3 agents.
    const { result, mapped, byAgent } = await mapReduce(
      ["a", "b", "c"],
      [1, 2, 3, 4],
      {
        map: async (_agent, n: number) => n * n,
        reduce: (acc, sq) => acc + sq,
        initial: 0,
      }
    );
    expect(mapped).toEqual([1, 4, 9, 16]);
    expect(result).toBe(30);
    expect(Object.values(byAgent).reduce((a, b) => a + b, 0)).toBe(4);
  });

  it("supports a word-count style reduce into a map", async () => {
    const docs = ["a b a", "b c", "a"];
    const { result } = await mapReduce<string, string[], Record<string, number>>(
      ["w1", "w2"],
      docs,
      {
        map: async (_agent, doc) => doc.split(" "),
        reduce: (acc, words) => {
          for (const w of words) acc[w] = (acc[w] ?? 0) + 1;
          return acc;
        },
        initial: {},
      }
    );
    expect(result).toEqual({ a: 3, b: 2, c: 1 });
  });

  it("keeps gather order regardless of completion order", async () => {
    const { mapped } = await mapReduce(
      ["fast", "slow"],
      [1, 2, 3, 4],
      {
        map: async (agent, n: number) => {
          if (agent === "slow") await new Promise((r) => setTimeout(r, 3));
          return n * 10;
        },
        reduce: (acc: number[], m) => [...acc, m],
        initial: [] as number[],
      }
    );
    expect(mapped).toEqual([10, 20, 30, 40]); // input order preserved
  });
});
