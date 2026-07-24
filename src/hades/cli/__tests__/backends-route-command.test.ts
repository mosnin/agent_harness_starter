/**
 * `hades backends route <choose|record|arms>` — the CLI surface over the
 * cost-aware UCB1 routing bandit (`../../backends/route-bandit.ts`), added by
 * the central-integration pass.
 *
 * Everything here drives the REAL `runBackendsCommand` dispatcher over a REAL
 * `BackendManager` registered with real `FakeBackend`s under a fake clock —
 * the only fakes are the backend transport (FakeBackend, by design) and an
 * in-memory `BanditStateStore` standing in for the file-backed store
 * `build.ts` wires (same `load()/save()` seam, no disk).
 */
import { describe, expect, it } from "vitest";
import { runBackendsCommand } from "../backends-command";
import type { BackendsCommandDeps, BanditStateStore } from "../backends-command";
import { BackendManager } from "../../backends/manager";
import { FakeBackend } from "../../backends/fake-backend";
import type { BackendDescriptor } from "../../backends/descriptor";
import type { RouteBanditState } from "../../backends/route-bandit";

function makeClock(start = 5_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
      return t;
    },
  };
}

function descriptor(overrides: Partial<BackendDescriptor> = {}): BackendDescriptor {
  return {
    name: "alpha",
    kind: "fake",
    capabilities: ["shell"],
    cost: { perRunningHourUsd: 1, perHibernatedHourUsd: 0.1, perProvisionUsd: 0.05, source: "configured" },
    supportsHibernate: true,
    locality: "remote",
    ...overrides,
  };
}

function memoryBanditStore(initial?: RouteBanditState): BanditStateStore & { saved: RouteBanditState[] } {
  let state: unknown = initial;
  const saved: RouteBanditState[] = [];
  return {
    saved,
    load: () => state,
    save(s: RouteBanditState) {
      state = s;
      saved.push(s);
    },
  };
}

interface Fixture {
  deps: BackendsCommandDeps;
  manager: BackendManager;
  store: ReturnType<typeof memoryBanditStore>;
  clock: ReturnType<typeof makeClock>;
}

function makeFixture(): Fixture {
  const clock = makeClock();
  const manager = new BackendManager({ now: clock.now });
  manager.register(
    new FakeBackend({ name: "alpha", now: clock.now, supportsHibernate: true }),
    descriptor({ name: "alpha" }),
  );
  manager.register(
    new FakeBackend({ name: "beta", now: clock.now, supportsHibernate: false }),
    descriptor({ name: "beta", supportsHibernate: false, capabilities: ["shell", "gpu"] }),
  );
  const store = memoryBanditStore();
  return { deps: { manager, banditStore: store }, manager, store, clock };
}

describe("route usage / unknown sub", () => {
  it("bare `route` prints usage with code 1", async () => {
    const { deps } = makeFixture();
    const result = await runBackendsCommand(["route"], deps);
    expect(result.code).toBe(1);
    expect(result.lines.join("\n")).toContain("route <choose|record|arms>");
  });

  it("unknown route sub prints usage with code 1", async () => {
    const { deps } = makeFixture();
    const result = await runBackendsCommand(["route", "bogus"], deps);
    expect(result.code).toBe(1);
    expect(result.lines.join("\n")).toContain("route <choose|record|arms>");
  });
});

describe("route choose", () => {
  it("forced exploration picks the lexicographically first unpulled survivor", async () => {
    const { deps } = makeFixture();
    const result = await runBackendsCommand(["route", "choose"], deps);
    expect(result.code).toBe(0);
    expect(result.lines[0]).toBe("Route: alpha (forced-exploration)");
    // Both candidates listed with zero pulls.
    const joined = result.lines.join("\n");
    expect(joined).toContain("alpha");
    expect(joined).toContain("beta");
  });

  it("--require-hibernate filters out the non-hibernate backend", async () => {
    const { deps } = makeFixture();
    const result = await runBackendsCommand(["route", "choose", "--require-hibernate"], deps);
    expect(result.code).toBe(0);
    expect(result.lines[0]).toBe("Route: alpha (forced-exploration)");
    expect(result.lines.join("\n")).not.toMatch(/^.*\bbeta\b.*$/m);
  });

  it("--cap gpu filters down to beta", async () => {
    const { deps } = makeFixture();
    const result = await runBackendsCommand(["route", "choose", "--cap", "gpu"], deps);
    expect(result.code).toBe(0);
    expect(result.lines[0]).toBe("Route: beta (forced-exploration)");
  });

  it("no surviving candidate is an honest code-1 miss, not an invented pick", async () => {
    const { deps } = makeFixture();
    const result = await runBackendsCommand(["route", "choose", "--cap", "quantum"], deps);
    expect(result.code).toBe(1);
    expect(result.lines.join("\n")).toContain("No backend survives");
  });

  it("invalid --max-usd is rejected", async () => {
    const { deps } = makeFixture();
    const result = await runBackendsCommand(["route", "choose", "--max-usd", "banana"], deps);
    expect(result.code).toBe(1);
    expect(result.lines.join("\n")).toContain("Invalid --max-usd");
  });

  it("after every arm is pulled, choose switches to a ucb-best decision", async () => {
    const { deps } = makeFixture();
    await runBackendsCommand(
      ["route", "record", "alpha", "--verified", "--elapsed-ms", "1000", "--usd", "0"],
      deps,
    );
    await runBackendsCommand(
      ["route", "record", "beta", "--unverified", "--elapsed-ms", "1000", "--usd", "0.5"],
      deps,
    );
    const result = await runBackendsCommand(["route", "choose"], deps);
    expect(result.code).toBe(0);
    // alpha has the strictly better measured history (verified, free).
    expect(result.lines[0]).toMatch(/^Route: alpha \(ucb-best, ucb=/);
  });
});

describe("route record", () => {
  it("requires exactly one of --verified/--unverified", async () => {
    const { deps } = makeFixture();
    const neither = await runBackendsCommand(
      ["route", "record", "alpha", "--elapsed-ms", "10", "--usd", "0"],
      deps,
    );
    expect(neither.code).toBe(1);
    const both = await runBackendsCommand(
      ["route", "record", "alpha", "--verified", "--unverified", "--elapsed-ms", "10", "--usd", "0"],
      deps,
    );
    expect(both.code).toBe(1);
  });

  it("requires --elapsed-ms and --usd", async () => {
    const { deps } = makeFixture();
    const noElapsed = await runBackendsCommand(["route", "record", "alpha", "--verified", "--usd", "0"], deps);
    expect(noElapsed.code).toBe(1);
    expect(noElapsed.lines.join("\n")).toContain("--elapsed-ms");
    const noUsd = await runBackendsCommand(
      ["route", "record", "alpha", "--verified", "--elapsed-ms", "10"],
      deps,
    );
    expect(noUsd.code).toBe(1);
    expect(noUsd.lines.join("\n")).toContain("--usd");
  });

  it("non-finite / negative measurements are rejected by the bandit's own validation", async () => {
    const { deps, store } = makeFixture();
    const bad = await runBackendsCommand(
      ["route", "record", "alpha", "--verified", "--elapsed-ms", "-5", "--usd", "0"],
      deps,
    );
    expect(bad.code).toBe(1);
    expect(bad.lines.join("\n")).toContain("elapsedMs");
    // Nothing was persisted for the failed record.
    expect(store.saved).toHaveLength(0);
  });

  it("a valid record persists the snapshot and reports the arm honestly", async () => {
    const { deps, store } = makeFixture();
    const result = await runBackendsCommand(
      ["route", "record", "alpha", "--verified", "--elapsed-ms", "2000", "--usd", "0"],
      deps,
    );
    expect(result.code).toBe(0);
    expect(result.lines.join("\n")).toContain("caller-measured");
    expect(store.saved).toHaveLength(1);
    expect(store.saved[0].arms.alpha).toEqual({ pulls: 1, verified: 1, totalElapsedMs: 2000, totalUsd: 0 });
  });

  it("history persists across invocations through the store (fresh dispatcher call each time)", async () => {
    const { deps, store } = makeFixture();
    await runBackendsCommand(["route", "record", "alpha", "--verified", "--elapsed-ms", "1000", "--usd", "0"], deps);
    await runBackendsCommand(["route", "record", "alpha", "--unverified", "--elapsed-ms", "3000", "--usd", "0.25"], deps);
    expect(store.saved).toHaveLength(2);
    expect(store.saved[1].arms.alpha).toEqual({
      pulls: 2,
      verified: 1,
      totalElapsedMs: 4000,
      totalUsd: 0.25,
    });
  });
});

describe("route arms", () => {
  it("empty history says so instead of rendering a blank table", async () => {
    const { deps } = makeFixture();
    const result = await runBackendsCommand(["route", "arms"], deps);
    expect(result.code).toBe(0);
    expect(result.lines.join("\n")).toContain("No routing outcomes recorded yet");
  });

  it("renders each arm's measured totals and labels derived columns", async () => {
    const { deps } = makeFixture();
    await runBackendsCommand(["route", "record", "alpha", "--verified", "--elapsed-ms", "1000", "--usd", "0"], deps);
    await runBackendsCommand(["route", "record", "beta", "--unverified", "--elapsed-ms", "500", "--usd", "0.1"], deps);
    const result = await runBackendsCommand(["route", "arms"], deps);
    expect(result.code).toBe(0);
    const joined = result.lines.join("\n");
    expect(joined).toContain("BACKEND");
    expect(joined).toMatch(/alpha\s+1\s+1\s+1000\s+0\.0000/);
    expect(joined).toMatch(/beta\s+1\s+0\s+500\s+0\.1000/);
    expect(joined).toContain("mean-reward/ucb are derived");
  });
});

describe("no bandit store configured", () => {
  it("route still works but is honest that nothing persists", async () => {
    const clock = makeClock();
    const manager = new BackendManager({ now: clock.now });
    manager.register(
      new FakeBackend({ name: "alpha", now: clock.now, supportsHibernate: true }),
      descriptor({ name: "alpha" }),
    );
    const deps: BackendsCommandDeps = { manager };
    const result = await runBackendsCommand(["route", "choose"], deps);
    expect(result.code).toBe(0);
    expect(result.lines[0]).toContain("(not persisted)");
    expect(result.lines[1]).toBe("Route: alpha (forced-exploration)");
  });
});
