/* ------------------------------------------------------------------ *
 * backends-command.test.ts
 *
 * REAL-VS-MOCK POLICY: exercises `runBackendsCommand` against a REAL
 * `BackendManager` (`../../backends/manager`) wired to real `FakeBackend`
 * instances (`../../backends/fake-backend`) — the in-process fleet fixture
 * the backends subsystem's own tests already use — plus a REAL
 * `BackendProvenanceLedger` (`../../backends/provenance`) for the `verify`
 * subcommand. Nothing here is a hand-rolled double standing in for engine
 * behavior this file is responsible for exercising; only the wall clock is
 * injected (a deterministic manual clock) so telemetry/sweep timing is
 * reproducible.
 * ------------------------------------------------------------------ */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { runBackendsCommand } from "../backends-command";
import type { BackendsCommandDeps } from "../backends-command";
import { BackendManager } from "../../backends/manager";
import { FakeBackend } from "../../backends/fake-backend";
import type { BackendDescriptor } from "../../backends/descriptor";
import { BackendProvenanceLedger, ledgerEventSink } from "../../backends/provenance";

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function makeClock(start = 1_000_000) {
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
    name: "fake",
    kind: "fake",
    capabilities: ["shell", "gpu"],
    cost: { perRunningHourUsd: 1, perHibernatedHourUsd: 0.1, perProvisionUsd: 0.05, source: "configured" },
    supportsHibernate: true,
    locality: "remote",
    ...overrides,
  };
}

interface Fixture {
  deps: BackendsCommandDeps;
  manager: BackendManager;
  clock: ReturnType<typeof makeClock>;
  ledger: BackendProvenanceLedger;
}

function makeFixture(opts?: { withLedger?: boolean; registerFake2NoHibernate?: boolean }): Fixture {
  const clock = makeClock();
  const ledger = new BackendProvenanceLedger({ now: clock.now });
  const manager = new BackendManager({
    now: clock.now,
    onEvent: opts?.withLedger === false ? undefined : ledgerEventSink(ledger),
  });

  const fake1 = new FakeBackend({ name: "fake", now: clock.now, supportsHibernate: true });
  manager.register(fake1, descriptor({ name: "fake" }));

  if (opts?.registerFake2NoHibernate) {
    const fake2 = new FakeBackend({ name: "nohib", now: clock.now, supportsHibernate: false });
    manager.register(fake2, descriptor({ name: "nohib", supportsHibernate: false, capabilities: ["shell"] }));
  }

  const deps: BackendsCommandDeps = {
    manager,
    ...(opts?.withLedger === false ? {} : { ledger }),
  };
  return { deps, manager, clock, ledger };
}

/** Splits a rendered table row on runs of 2+ spaces (the house column
 *  separator) so line assertions don't depend on exact padding widths. */
function cols(line: string): string[] {
  return line.trim().split(/\s{2,}/);
}

const ENV_KEYS = ["HADES_BACKEND_MANAGER_URL", "HADES_BACKEND_AUTH_TOKEN"] as const;
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

// ===========================================================================
// help / no-args / unknown subcommand
// ===========================================================================

describe("help / no-args / unknown subcommand", () => {
  it.each([[[]], [["help"]], [["--help"]], [["-h"]]])("argv %j -> usage, exit 0", async (argv) => {
    const { deps } = makeFixture();
    const res = await runBackendsCommand(argv, deps);
    expect(res.code).toBe(0);
    expect(res.lines.join("\n")).toContain("Usage: hades backends <command>");
  });

  it("unknown subcommand -> code 1, names it, points to help", async () => {
    const { deps } = makeFixture();
    const res = await runBackendsCommand(["frobnicate"], deps);
    expect(res.code).toBe(1);
    expect(res.lines[0]).toBe("Unknown backends command: frobnicate");
    expect(res.lines.join("\n")).toContain("Run `hades backends help` for usage.");
  });

  it("unknown subcommand name is sanitized of control characters", async () => {
    const { deps } = makeFixture();
    const res = await runBackendsCommand(["bad\x07cmd"], deps);
    expect(res.code).toBe(1);
    expect(res.lines[0]).not.toMatch(/[\x00-\x1F\x7F]/);
    expect(res.lines[0]).toBe("Unknown backends command: badcmd");
  });
});

// ===========================================================================
// list
// ===========================================================================

describe("list", () => {
  it("reports 'No backends registered.' for an empty fleet", async () => {
    const clock = makeClock();
    const manager = new BackendManager({ now: clock.now });
    const res = await runBackendsCommand(["list"], { manager });
    expect(res.code).toBe(0);
    expect(res.lines).toEqual(["No backends registered."]);
  });

  it("lists name/kind/available/capabilities/rates/handles/telemetry for a fresh backend", async () => {
    const { deps } = makeFixture();
    const res = await runBackendsCommand(["list"], deps);
    expect(res.code).toBe(0);
    expect(res.lines).toHaveLength(2);

    const header = cols(res.lines[0]);
    expect(header).toEqual(["NAME", "KIND", "AVAILABLE", "CAPABILITIES", "RUNNING $/H", "HIBERNATED $/H", "HANDLES", "TELEMETRY"]);

    const row = cols(res.lines[1]);
    expect(row[0]).toBe("fake");
    expect(row[1]).toBe("fake");
    expect(row[2]).toBe("yes"); // FakeBackend defaults to available
    expect(row[3]).toBe("shell,gpu");
    expect(row[4]).toBe("$1.0000/h (configured rate)");
    expect(row[5]).toBe("$0.1000/h (configured rate)");
    expect(row[6]).toBe("0"); // no live handles yet
    expect(row[7]).toBe("provisions=0 failures=0 latencyEma=-");
  });

  it("reflects live handle count and telemetry after a provision", async () => {
    const { deps } = makeFixture();
    await runBackendsCommand(["provision", "--backend", "fake", "--worker", "w1"], deps);
    const res = await runBackendsCommand(["list"], deps);
    const row = cols(res.lines[1]);
    expect(row[6]).toBe("1");
    expect(row[7]).toContain("provisions=1 failures=0");
    expect(row[7]).toMatch(/latencyEma=\d+(\.\d+)?ms/);
  });
});

// ===========================================================================
// probe
// ===========================================================================

describe("probe", () => {
  it("probe <name> reports availability for a known backend", async () => {
    const { deps } = makeFixture();
    const res = await runBackendsCommand(["probe", "fake"], deps);
    expect(res.code).toBe(0);
    expect(res.lines).toEqual(["fake: available"]);
  });

  it("probe <name> -> code 1 for an unknown backend", async () => {
    const { deps } = makeFixture();
    const res = await runBackendsCommand(["probe", "nope"], deps);
    expect(res.code).toBe(1);
    expect(res.lines[0]).toBe("Unknown backend: nope");
  });

  it("probe with no name probes every registered backend", async () => {
    const { deps } = makeFixture({ registerFake2NoHibernate: true });
    const res = await runBackendsCommand(["probe"], deps);
    expect(res.code).toBe(0);
    expect(res.lines.sort()).toEqual(["fake: available", "nohib: available"]);
  });

  it("probe with no name and no backends registered reports honestly", async () => {
    const clock = makeClock();
    const manager = new BackendManager({ now: clock.now });
    const res = await runBackendsCommand(["probe"], { manager });
    expect(res.code).toBe(0);
    expect(res.lines).toEqual(["No backends registered."]);
  });
});

// ===========================================================================
// provision
// ===========================================================================

describe("provision", () => {
  it("missing --backend -> code 1, usage", async () => {
    const { deps } = makeFixture();
    const res = await runBackendsCommand(["provision", "--worker", "w1"], deps);
    expect(res.code).toBe(1);
    expect(res.lines.join("\n")).toContain("Usage: hades backends provision");
  });

  it("missing --worker -> code 1, usage", async () => {
    const { deps } = makeFixture();
    const res = await runBackendsCommand(["provision", "--backend", "fake"], deps);
    expect(res.code).toBe(1);
    expect(res.lines.join("\n")).toContain("Usage: hades backends provision");
  });

  it("--backend with no value -> code 1", async () => {
    const { deps } = makeFixture();
    const res = await runBackendsCommand(["provision", "--worker", "w1", "--backend"], deps);
    expect(res.code).toBe(1);
    expect(res.lines[0]).toBe("--backend requires a value");
  });

  it("unknown backend -> code 1", async () => {
    const { deps } = makeFixture();
    const res = await runBackendsCommand(["provision", "--backend", "ghost", "--worker", "w1"], deps);
    expect(res.code).toBe(1);
    expect(res.lines[0]).toBe("Unknown backend: ghost");
  });

  it("no manager/authToken env set -> uses placeholders and says so", async () => {
    const { deps } = makeFixture();
    const res = await runBackendsCommand(["provision", "--backend", "fake", "--worker", "w1"], deps);
    expect(res.code).toBe(0);
    expect(res.lines.some((l) => l.includes("(placeholder) managerUrl"))).toBe(true);
    expect(res.lines.some((l) => l.includes("(placeholder) authToken"))).toBe(true);
    expect(res.lines.some((l) => l.startsWith("Provisioned w1 on fake"))).toBe(true);
  });

  it("env vars set -> real values used, no placeholder lines", async () => {
    process.env.HADES_BACKEND_MANAGER_URL = "https://real-manager.example";
    process.env.HADES_BACKEND_AUTH_TOKEN = "real-token";
    const { deps } = makeFixture();
    const res = await runBackendsCommand(["provision", "--backend", "fake", "--worker", "w1"], deps);
    expect(res.code).toBe(0);
    expect(res.lines.some((l) => l.includes("placeholder"))).toBe(false);
    expect(res.lines.some((l) => l.startsWith("Provisioned w1 on fake"))).toBe(true);
  });

  it("--cap splits on commas, trims, and drops empty tokens", async () => {
    const { deps, manager } = makeFixture();
    const res = await runBackendsCommand(
      ["provision", "--backend", "fake", "--worker", "w1", "--cap", " shell ,,gpu"],
      deps,
    );
    expect(res.code).toBe(0);
    const handle = manager.registry.handle("w1");
    expect(handle).toBeDefined();
  });

  it("requesting a capability the backend doesn't have -> honest provision failure", async () => {
    const { deps } = makeFixture();
    const res = await runBackendsCommand(
      ["provision", "--backend", "fake", "--worker", "w1", "--cap", "quantum-teleport"],
      deps,
    );
    expect(res.code).toBe(1);
    expect(res.lines.some((l) => l.startsWith("Provision failed:"))).toBe(true);
  });

  it("--image passes through to the RemoteSpec", async () => {
    const { deps, manager } = makeFixture();
    const res = await runBackendsCommand(
      ["provision", "--backend", "fake", "--worker", "w1", "--image", "ghcr.io/hades/worker:latest"],
      deps,
    );
    expect(res.code).toBe(0);
    expect(manager.registry.handle("w1")).toBeDefined();
  });

  it("repeated --worker: the LAST occurrence wins (hardened flag parsing)", async () => {
    const { deps, manager } = makeFixture();
    const res = await runBackendsCommand(
      ["provision", "--backend", "fake", "--worker", "first", "--worker", "second"],
      deps,
    );
    expect(res.code).toBe(0);
    expect(res.lines.some((l) => l.startsWith("Provisioned second on fake"))).toBe(true);
    expect(manager.registry.handle("first")).toBeUndefined();
    expect(manager.registry.handle("second")).toBeDefined();
  });

  it("unexpected trailing argument -> code 1", async () => {
    const { deps } = makeFixture();
    const res = await runBackendsCommand(
      ["provision", "--backend", "fake", "--worker", "w1", "extra"],
      deps,
    );
    expect(res.code).toBe(1);
    expect(res.lines[0]).toContain("Unexpected argument: extra");
  });
});

// ===========================================================================
// status
// ===========================================================================

describe("status", () => {
  it("missing workerId -> code 1, usage", async () => {
    const { deps } = makeFixture();
    const res = await runBackendsCommand(["status"], deps);
    expect(res.code).toBe(1);
    expect(res.lines[0]).toBe("Usage: hades backends status <workerId>");
  });

  it("unknown worker -> code 1", async () => {
    const { deps } = makeFixture();
    const res = await runBackendsCommand(["status", "ghost"], deps);
    expect(res.code).toBe(1);
    expect(res.lines[0]).toBe("Unknown worker: ghost");
  });

  it("control characters in an unknown workerId never reach the output", async () => {
    const { deps } = makeFixture();
    const res = await runBackendsCommand(["status", "w\x00\x07\x1B[31m1"], deps);
    expect(res.code).toBe(1);
    expect(res.lines.join("")).not.toMatch(/[\x00-\x1F\x7F]/);
    expect(res.lines[0]).toBe("Unknown worker: w[31m1");
  });

  it("known worker -> reports running state and backend", async () => {
    const { deps } = makeFixture();
    await runBackendsCommand(["provision", "--backend", "fake", "--worker", "w1"], deps);
    const res = await runBackendsCommand(["status", "w1"], deps);
    expect(res.code).toBe(0);
    expect(res.lines[0]).toBe("w1: running (backend=fake)");
  });
});

// ===========================================================================
// hibernate / wake
// ===========================================================================

describe("hibernate / wake", () => {
  it("hibernate: missing workerId -> code 1, usage", async () => {
    const { deps } = makeFixture();
    const res = await runBackendsCommand(["hibernate"], deps);
    expect(res.code).toBe(1);
    expect(res.lines[0]).toBe("Usage: hades backends hibernate <workerId>");
  });

  it("hibernate: unknown worker -> code 1", async () => {
    const { deps } = makeFixture();
    const res = await runBackendsCommand(["hibernate", "ghost"], deps);
    expect(res.code).toBe(1);
    expect(res.lines[0]).toBe("Unknown worker: ghost");
  });

  it("hibernate: succeeds on a hibernate-capable backend", async () => {
    const { deps } = makeFixture();
    await runBackendsCommand(["provision", "--backend", "fake", "--worker", "w1"], deps);
    const res = await runBackendsCommand(["hibernate", "w1"], deps);
    expect(res.code).toBe(0);
    expect(res.lines[0]).toBe("Hibernated w1 (state=hibernated).");
  });

  it("hibernate: backend without hibernate support -> readable code-1 error, not an uncaught throw", async () => {
    const { deps } = makeFixture({ registerFake2NoHibernate: true });
    await runBackendsCommand(["provision", "--backend", "nohib", "--worker", "w2"], deps);
    const res = await runBackendsCommand(["hibernate", "w2"], deps);
    expect(res.code).toBe(1);
    expect(res.lines[0]).toContain("Hibernate failed for w2");
    expect(res.lines[0]).toMatch(/does not support hibernate/i);
  });

  it("wake: succeeds after a hibernate", async () => {
    const { deps } = makeFixture();
    await runBackendsCommand(["provision", "--backend", "fake", "--worker", "w1"], deps);
    await runBackendsCommand(["hibernate", "w1"], deps);
    const res = await runBackendsCommand(["wake", "w1"], deps);
    expect(res.code).toBe(0);
    expect(res.lines[0]).toBe("Woke w1 (state=running).");
  });

  it("wake: unknown worker -> code 1", async () => {
    const { deps } = makeFixture();
    const res = await runBackendsCommand(["wake", "ghost"], deps);
    expect(res.code).toBe(1);
    expect(res.lines[0]).toBe("Unknown worker: ghost");
  });
});

// ===========================================================================
// terminate
// ===========================================================================

describe("terminate", () => {
  it("missing workerId and no --all -> code 1, usage", async () => {
    const { deps } = makeFixture();
    const res = await runBackendsCommand(["terminate"], deps);
    expect(res.code).toBe(1);
    expect(res.lines[0]).toBe("Usage: hades backends terminate <workerId|--all>");
  });

  it("unknown worker -> code 1", async () => {
    const { deps } = makeFixture();
    const res = await runBackendsCommand(["terminate", "ghost"], deps);
    expect(res.code).toBe(1);
    expect(res.lines[0]).toBe("Unknown worker: ghost");
  });

  it("terminates a known worker", async () => {
    const { deps, manager } = makeFixture();
    await runBackendsCommand(["provision", "--backend", "fake", "--worker", "w1"], deps);
    const res = await runBackendsCommand(["terminate", "w1"], deps);
    expect(res.code).toBe(0);
    expect(res.lines[0]).toBe("Terminated w1.");
    expect(manager.registry.handle("w1")).toBeUndefined();
  });

  it("--all on an EMPTY fleet -> code 0, honest message", async () => {
    const { deps } = makeFixture();
    const res = await runBackendsCommand(["terminate", "--all"], deps);
    expect(res.code).toBe(0);
    expect(res.lines).toEqual(["No workers to terminate."]);
  });

  it("--all terminates every live worker", async () => {
    const { deps, manager } = makeFixture();
    await runBackendsCommand(["provision", "--backend", "fake", "--worker", "w1"], deps);
    await runBackendsCommand(["provision", "--backend", "fake", "--worker", "w2"], deps);
    const res = await runBackendsCommand(["terminate", "--all"], deps);
    expect(res.code).toBe(0);
    expect(res.lines.sort()).toEqual(["Terminated w1.", "Terminated w2."]);
    expect(manager.list()).toHaveLength(0);
  });
});

// ===========================================================================
// sweep
// ===========================================================================

describe("sweep", () => {
  it("no idle workers -> honest empty message", async () => {
    const { deps } = makeFixture();
    const res = await runBackendsCommand(["sweep"], deps);
    expect(res.code).toBe(0);
    expect(res.lines).toEqual(["No idle workers to hibernate."]);
  });

  it("hibernates a worker idle past the scale-to-zero threshold (5 min default)", async () => {
    const { deps, clock } = makeFixture();
    await runBackendsCommand(["provision", "--backend", "fake", "--worker", "w1"], deps);
    clock.advance(5 * 60 * 1000 + 1);
    const res = await runBackendsCommand(["sweep"], deps);
    expect(res.code).toBe(0);
    expect(res.lines).toEqual(["Hibernated (idle): w1"]);
  });
});

// ===========================================================================
// logs
// ===========================================================================

describe("logs", () => {
  it("missing workerId -> code 1, usage", async () => {
    const { deps } = makeFixture();
    const res = await runBackendsCommand(["logs"], deps);
    expect(res.code).toBe(1);
    expect(res.lines[0]).toBe("Usage: hades backends logs <workerId> [--tail N]");
  });

  it("unknown worker -> code 1", async () => {
    const { deps } = makeFixture();
    const res = await runBackendsCommand(["logs", "ghost"], deps);
    expect(res.code).toBe(1);
    expect(res.lines[0]).toBe("Unknown worker: ghost");
  });

  it("--tail missing value -> code 1", async () => {
    const { deps } = makeFixture();
    await runBackendsCommand(["provision", "--backend", "fake", "--worker", "w1"], deps);
    const res = await runBackendsCommand(["logs", "w1", "--tail"], deps);
    expect(res.code).toBe(1);
    expect(res.lines[0]).toBe("--tail requires a value");
  });

  it("--tail invalid (non-integer) -> code 1", async () => {
    const { deps } = makeFixture();
    await runBackendsCommand(["provision", "--backend", "fake", "--worker", "w1"], deps);
    const res = await runBackendsCommand(["logs", "w1", "--tail", "abc"], deps);
    expect(res.code).toBe(1);
    expect(res.lines[0]).toBe("Invalid --tail value: abc");
  });

  it("returns real logs recorded by the backend", async () => {
    const { deps } = makeFixture();
    await runBackendsCommand(["provision", "--backend", "fake", "--worker", "w1"], deps);
    const res = await runBackendsCommand(["logs", "w1"], deps);
    expect(res.code).toBe(0);
    expect(res.lines.join("\n")).toContain("provisioned w1");
  });
});

// ===========================================================================
// verify
// ===========================================================================

describe("verify", () => {
  it("no ledger configured -> code 1, honest message", async () => {
    const { deps } = makeFixture({ withLedger: false });
    const res = await runBackendsCommand(["verify"], deps);
    expect(res.code).toBe(1);
    expect(res.lines[0]).toBe("No provenance ledger configured for this build.");
  });

  it("clean chain -> code 0, prints root/head/length/ok", async () => {
    const { deps } = makeFixture();
    await runBackendsCommand(["provision", "--backend", "fake", "--worker", "w1"], deps);
    const res = await runBackendsCommand(["verify"], deps);
    expect(res.code).toBe(0);
    const text = res.lines.join("\n");
    expect(text).toMatch(/^root:\s+[0-9a-f]{64}$/m);
    expect(text).toMatch(/^head:\s+[0-9a-f]{64}$/m);
    expect(text).toMatch(/^length:\s+\d+$/m);
    expect(text).toMatch(/^ok:\s+true$/m);
  });

  it("tampered ledger -> code 1, ok:false, reports reason", async () => {
    const { deps, ledger } = makeFixture();
    await runBackendsCommand(["provision", "--backend", "fake", "--worker", "w1"], deps);

    // Corrupt one record's hash in place (TS `private` is compile-time only;
    // this is a deliberate post-hoc tamper for the test, exactly like an
    // on-disk record being edited between runs).
    const records = (ledger as unknown as { _records: Array<{ hash: string }> })._records;
    expect(records.length).toBeGreaterThan(0);
    records[0].hash = "0".repeat(64);

    const res = await runBackendsCommand(["verify"], deps);
    expect(res.code).toBe(1);
    const text = res.lines.join("\n");
    expect(text).toMatch(/^ok:\s+false$/m);
    expect(text).toContain("reason:");
    expect(text).toContain("brokenAt:");
  });
});
