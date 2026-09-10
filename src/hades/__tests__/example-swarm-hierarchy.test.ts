import { describe, it, expect } from "vitest";
import { demoSwarmHierarchy } from "../examples/swarm-hierarchy";

describe("demoSwarmHierarchy example", () => {
  it("runs a 27-worker distributed hierarchy over A2A and aggregates correctly", async () => {
    const summary = await demoSwarmHierarchy();
    expect(summary.workers).toBe(27);
    expect(summary.coordinationHops).toBe(3);
    // Sum of squares 1²..27² = 6930.
    expect(summary.result).toBe(6930);
    expect(summary.routeScansPerSend).toBe(1); // O(1) direct routing invariant
  });
});
