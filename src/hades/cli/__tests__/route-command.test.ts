import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runRouteCommand, ROUTE_USAGE, defaultRouteDeps, type RouteCommandDeps } from "../route-command";
import { openRouter, type RouterStack } from "../../routing/wiring";
import { ModelRegistry } from "../../models/registry";
import { HadesCli } from "../cli";
import type { EvalTask, AgentRunResult } from "../../bench/vtph";

// ---------------------------------------------------------------------------
// Fixtures — a REAL stack over a temp dir, with one deliberately UNPRICED arm.
// ---------------------------------------------------------------------------

function registry(): ModelRegistry {
  return new ModelRegistry()
    .register({ id: "claude-haiku-4-5-20251001", provider: "anthropic", displayName: "Haiku", contextWindow: 200_000, tags: ["cheap"] })
    .register({ id: "claude-opus-4-1", provider: "anthropic", displayName: "Opus", contextWindow: 200_000, tags: ["frontier"] })
    .register({ id: "totally-unknown-model", provider: "mystery", displayName: "Unknown", contextWindow: 8_000 });
}

const HAIKU = "anthropic/claude-haiku-4-5-20251001";
const UNPRICED = "mystery/totally-unknown-model";

let dir: string;
let stack: RouterStack;
let deps: RouteCommandDeps;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hades-route-cli-"));
  stack = openRouter({ dataDir: dir, env: { NODE_ENV: "test" }, registry: registry(), budgetUsd: 5, seed: 3 });
  deps = { stack: () => stack, bench: () => null, env: { NODE_ENV: "test" } };
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const text = (lines: string[]): string => lines.join("\n");

// ===========================================================================

describe("hades route — routing", () => {
  it("prints usage for no args, help and unknown subcommands", async () => {
    expect((await runRouteCommand([], deps)).lines).toEqual(ROUTE_USAGE);
    expect((await runRouteCommand(["help"], deps)).lines).toEqual(ROUTE_USAGE);
    const unknown = await runRouteCommand(["nonsense"], deps);
    expect(unknown.code).toBe(1);
    expect(unknown.lines[0]).toMatch(/Unknown route command/);
  });

  it("is reachable from the top-level `hades route` router", async () => {
    const cli = new HadesCli({ route: () => deps });
    const res = await cli.run(["route", "status"]);
    expect(res.code).toBe(0);
    expect(text(res.lines)).toMatch(/ROUTE — the budget-constrained/);
  });

  it("is listed in `hades help`", async () => {
    const cli = new HadesCli({});
    const help = await cli.run(["help"]);
    expect(text(help.lines)).toMatch(/route <sub>/);
  });

  it("defaultRouteDeps never touches the data dir until a subcommand runs", () => {
    const probe = join(dir, "lazy");
    defaultRouteDeps({ NODE_ENV: "test", HADES_DATA_DIR: probe });
    expect(existsSync(join(probe, "routing"))).toBe(false);
  });
});

describe("hades route status", () => {
  it("renders the budget, chain verdict and every arm", async () => {
    const res = await runRouteCommand(["status"], deps);
    expect(res.code).toBe(0);
    const out = text(res.lines);
    expect(out).toMatch(/budget\s+\$5\.0000/);
    expect(out).toMatch(/chain VERIFIED/);
    expect(out).toContain(HAIKU);
    expect(out).toContain(UNPRICED);
  });

  it("prints an UNPRICED arm's cost as n/a, never $0", async () => {
    const res = await runRouteCommand(["status"], deps);
    const row = res.lines.find((l) => l.includes(UNPRICED))!;
    expect(row).toMatch(/\bn\/a\b/);
    expect(row).not.toMatch(/0\.000000/);
    expect(text(res.lines)).toMatch(/NO published price/);
  });

  it("--json emits the machine view", async () => {
    const res = await runRouteCommand(["status", "--json"], deps);
    const parsed = JSON.parse(text(res.lines));
    expect(parsed.totalArms).toBe(3);
    expect(parsed.arms.find((a: { armId: string }) => a.armId === UNPRICED).costSource).toBe("unpriced");
  });

  it("rejects a bad --tier and a non-numeric token count", async () => {
    expect((await runRouteCommand(["status", "--tier", "T9-fake"], deps)).code).toBe(1);
    const bad = await runRouteCommand(["status", "--prompt-tokens", "banana"], deps);
    expect(bad.code).toBe(1);
    expect(bad.lines[0]).toMatch(/finite number/);
  });

  it("quotes costs at the requested token context", async () => {
    const small = JSON.parse(text((await runRouteCommand(["status", "--json", "--prompt-tokens", "100", "--output-tokens", "10"], deps)).lines));
    const big = JSON.parse(text((await runRouteCommand(["status", "--json", "--prompt-tokens", "100000", "--output-tokens", "10000"], deps)).lines));
    const pick = (v: { arms: Array<{ armId: string; usdMean: number }> }): number =>
      v.arms.find((a) => a.armId === HAIKU)!.usdMean;
    expect(pick(big)).toBeGreaterThan(pick(small));
  });
});

describe("hades route arms", () => {
  it("lists eligible arms AND why every rejected arm was rejected", async () => {
    const res = await runRouteCommand(["arms"], deps);
    expect(res.code).toBe(0);
    const out = text(res.lines);
    expect(out).toMatch(/REJECTED \(1\)/);
    expect(out).toContain(UNPRICED);
    expect(out).toMatch(/unpriced/);
  });

  it("--allow-unpriced surfaces the unpriced arm, still labelled", async () => {
    const res = await runRouteCommand(["arms", "--allow-unpriced", "--json"], deps);
    const parsed = JSON.parse(text(res.lines));
    const arm = parsed.eligible.find((a: { armId: string }) => a.armId === UNPRICED);
    expect(arm).toBeDefined();
    expect(arm.unpriced).toBe(true);
    expect(arm.costSource).toBe("unpriced");
  });

  it("--provider narrows the space and reports provider-excluded rejections", async () => {
    const res = await runRouteCommand(["arms", "--provider", "anthropic", "--json"], deps);
    const parsed = JSON.parse(text(res.lines));
    expect(parsed.eligible.every((a: { provider: string }) => a.provider === "anthropic")).toBe(true);
    expect(parsed.rejected.some((r: { code: string }) => r.code === "provider-excluded")).toBe(true);
  });

  it("--max-usd rejects arms over the cap with an explicit code", async () => {
    const res = await runRouteCommand(["arms", "--max-usd", "0.005", "--json"], deps);
    const parsed = JSON.parse(text(res.lines));
    expect(parsed.rejected.some((r: { code: string }) => r.code === "over-usd-cap")).toBe(true);
  });

  it("rejects a non-numeric --max-usd", async () => {
    const res = await runRouteCommand(["arms", "--max-usd", "cheap"], deps);
    expect(res.code).toBe(1);
  });
});

describe("hades route explain", () => {
  it("requires --category", async () => {
    const res = await runRouteCommand(["explain"], deps);
    expect(res.code).toBe(1);
    expect(res.lines[0]).toMatch(/--category/);
  });

  it("ranks the eligible arms and says it changed nothing", async () => {
    const res = await runRouteCommand(["explain", "--category", "code"], deps);
    expect(res.code).toBe(0);
    const out = text(res.lines);
    expect(out).toMatch(/ROUTE EXPLAIN/);
    expect(out).toMatch(/recorded no outcome and saved nothing/);
  });

  it("is a PURE READ: no ledger entry, no spend, nothing persisted", async () => {
    await runRouteCommand(["explain", "--category", "code"], deps);
    expect(stack.ledger.entries()).toHaveLength(0);
    expect(stack.bandit.spentUsd()).toBe(0);
    expect(existsSync(join(dir, "routing"))).toBe(false);
  });

  it("rejects an out-of-range --difficulty", async () => {
    const res = await runRouteCommand(["explain", "--category", "code", "--difficulty", "2"], deps);
    expect(res.code).toBe(1);
  });

  it("never chooses an arm outside the eligible set", async () => {
    const res = await runRouteCommand(["explain", "--category", "code", "--json"], deps);
    const parsed = JSON.parse(text(res.lines));
    expect(parsed.chosen).not.toBe(UNPRICED);
    expect(parsed.ranked.every((r: { armId: string }) => r.armId !== UNPRICED)).toBe(true);
  });
});

describe("hades route record", () => {
  const base = [
    "record",
    "--task",
    "t1",
    "--category",
    "extraction",
    "--arm",
    HAIKU,
    "--usd",
    "0.002",
    "--wall-ms",
    "1500",
  ];

  it("folds a real outcome into every component and persists it", async () => {
    const res = await runRouteCommand(
      [...base, "--tokens-in", "900", "--tokens-out", "200", "--claimed-verified", "--graded", "true", "--p-correct", "0.8", "--at", "1000"],
      deps,
    );
    expect(res.code).toBe(0);
    expect(stack.cost.samples(HAIKU)).toBe(1);
    expect(stack.bandit.spentUsd()).toBeCloseTo(0.002, 12);
    expect(stack.ledger.entries()).toHaveLength(1);
    expect(stack.riskPoints).toHaveLength(1);

    // Durable: a fresh stack over the same dir sees it.
    const reopened = openRouter({ dataDir: dir, env: { NODE_ENV: "test" }, registry: registry(), budgetUsd: 5, seed: 3 });
    expect(reopened.ledger.entries()).toHaveLength(1);
    expect(reopened.ledger.verifyChain().ok).toBe(true);
  });

  it("refuses an arm that is not in this install's catalog", async () => {
    const res = await runRouteCommand(["record", "--task", "t", "--category", "c", "--arm", "fake/arm", "--usd", "1", "--wall-ms", "1"], deps);
    expect(res.code).toBe(1);
    expect(res.lines[0]).toMatch(/unknown arm/);
    expect(stack.ledger.entries()).toHaveLength(0);
  });

  it.each([
    [["record", "--category", "c", "--arm", HAIKU, "--usd", "1", "--wall-ms", "1"], /--task/],
    [["record", "--task", "t", "--arm", HAIKU, "--usd", "1", "--wall-ms", "1"], /--category/],
    [["record", "--task", "t", "--category", "c", "--usd", "1", "--wall-ms", "1"], /--arm/],
    [["record", "--task", "t", "--category", "c", "--arm", HAIKU, "--wall-ms", "1"], /--usd/],
    [["record", "--task", "t", "--category", "c", "--arm", HAIKU, "--usd", "1"], /--wall-ms/],
    [["record", "--task", "t", "--category", "c", "--arm", HAIKU, "--usd", "-1", "--wall-ms", "1"], /--usd must be >= 0/],
    [["record", "--task", "t", "--category", "c", "--arm", HAIKU, "--usd", "1", "--wall-ms", "-1"], /--wall-ms must be >= 0/],
    [[...["record", "--task", "t", "--category", "c", "--arm", HAIKU, "--usd", "1", "--wall-ms", "1"], "--graded", "maybe"], /--graded/],
  ])("rejects malformed invocation %#", async (args, pattern) => {
    const res = await runRouteCommand(args as string[], deps);
    expect(res.code).toBe(1);
    expect(res.lines[0]).toMatch(pattern as RegExp);
    expect(stack.ledger.entries()).toHaveLength(0);
  });

  it("an ungraded record contributes NO conformal calibration evidence", async () => {
    await runRouteCommand([...base, "--claimed-verified", "--at", "1"], deps);
    expect(stack.ledger.entries()).toHaveLength(1);
    expect(stack.riskPoints).toHaveLength(0);
    expect(text((await runRouteCommand([...base, "--claimed-verified", "--at", "1"], deps)).lines)).toMatch(/ungraded/);
  });

  it("a claimed-but-wrong record lands in silent-wrong, not verified", async () => {
    await runRouteCommand([...base, "--claimed-verified", "--graded", "false", "--at", "1"], deps);
    const ledgerRes = await runRouteCommand(["ledger", "--json"], deps);
    const parsed = JSON.parse(text(ledgerRes.lines));
    const row = parsed.attribution.find((a: { armId: string }) => a.armId === HAIKU);
    expect(row.silentWrong).toBe(1);
    expect(row.verifiedCorrect).toBe(0);
  });
});

describe("hades route ledger", () => {
  it("reports an empty ledger honestly", async () => {
    const res = await runRouteCommand(["ledger"], deps);
    expect(res.code).toBe(0);
    expect(text(res.lines)).toMatch(/no routing decisions recorded yet/);
  });

  it("shows per-arm attribution and flags silent-wrong prominently", async () => {
    await runRouteCommand(
      ["record", "--task", "t1", "--category", "c", "--arm", HAIKU, "--usd", "0.01", "--wall-ms", "1000", "--claimed-verified", "--graded", "false", "--at", "1"],
      deps,
    );
    const res = await runRouteCommand(["ledger", "--verify"], deps);
    const out = text(res.lines);
    expect(out).toMatch(/SILENT-WRONG: 1 decision/);
    expect(out).toMatch(/SEQ/); // --verify prints the raw chain rows
  });

  it("exits non-zero when the chain does not verify", async () => {
    await runRouteCommand(
      ["record", "--task", "t1", "--category", "c", "--arm", HAIKU, "--usd", "0.01", "--wall-ms", "1000", "--at", "1"],
      deps,
    );
    // Tamper in memory the way an attacker would tamper on disk.
    const entries = stack.ledger.entries().map((e) => ({ ...e }));
    entries[0].actualUsd = 0.0000001;
    const { RoutingLedger } = await import("../../routing/ledger");
    stack.ledger = new RoutingLedger(entries) as typeof stack.ledger;
    const res = await runRouteCommand(["ledger"], deps);
    expect(res.code).toBe(1);
    expect(text(res.lines)).toMatch(/BROKEN/);
  });
});

describe("hades route bench", () => {
  it("REFUSES to run (exit 2) when nothing real can be measured — it never simulates", async () => {
    const res = await runRouteCommand(["bench"], deps);
    expect(res.code).toBe(2);
    const out = text(res.lines);
    expect(out).toMatch(/NOTHING REAL TO MEASURE/);
    expect(out).toMatch(/will not\n?\s*substitute a simulation/);
  });

  it("runs the REAL harness when wiring is available and labels its provenance", async () => {
    const answers: Record<string, string> = {};
    const makeRunner = (correct: boolean) => async (t: EvalTask): Promise<AgentRunResult> => {
      const out = correct ? (answers[t.id] ?? "") : "definitely wrong";
      return { output: out, claimedVerified: true, tokensIn: 10, tokensOut: 5, usd: correct ? 0.001 : 0.01, provenance: ["fixture"] };
    };
    // A deterministic, explicitly LABELLED model run — never presented as measured.
    const benchDeps: RouteCommandDeps = {
      ...deps,
      bench: () => ({
        router: { route: async (t: EvalTask) => ({ ...(await makeRunner(true)(t)), armId: HAIKU, fannedOut: [], escalations: 0, pCorrect: 0.9 }) },
        baselines: [{ label: "fixed-haiku", armId: HAIKU, runner: makeRunner(false) }],
        provenance: "model",
        now: () => 0,
      }),
    };
    const res = await runRouteCommand(["bench", "--tasks", "2"], benchDeps);
    expect(res.lines[0]).toMatch(/provenance: model/);
    expect(text(res.lines)).toMatch(/V-TPH\$ comparison/);
  });

  it("rejects a non-numeric --tasks", async () => {
    expect((await runRouteCommand(["bench", "--tasks", "lots"], deps)).code).toBe(1);
  });
});

describe("hades route doctor", () => {
  it("passes on a healthy stack", async () => {
    const res = await runRouteCommand(["doctor"], deps);
    expect(res.code).toBe(0);
    expect(text(res.lines)).toMatch(/router wiring is healthy/);
  });

  it("--json reports every check", async () => {
    const res = await runRouteCommand(["doctor", "--json"], deps);
    const parsed = JSON.parse(text(res.lines));
    expect(parsed.ok).toBe(true);
    expect(parsed.checks.map((c: { name: string }) => c.name)).toContain("no unpriced arm is priced at $0");
    expect(parsed.checks.map((c: { name: string }) => c.name)).toContain("uncalibrated stratum abstains");
  });

  it("FAILS, and says why, when the stack cannot even open", async () => {
    const broken: RouteCommandDeps = {
      stack: () => {
        throw new Error("data dir is on fire");
      },
    };
    const res = await runRouteCommand(["doctor"], broken);
    expect(res.code).toBe(1);
    expect(text(res.lines)).toMatch(/data dir is on fire/);
  });

  it("FAILS when nothing is eligible (the router would decline every task)", async () => {
    const empty = openRouter({ dataDir: null, registry: new ModelRegistry(), env: { NODE_ENV: "test" } });
    const res = await runRouteCommand(["doctor", "--json"], { stack: () => empty });
    const parsed = JSON.parse(text(res.lines));
    expect(parsed.ok).toBe(false);
    expect(parsed.checks.find((c: { name: string }) => c.name === "arm space is non-empty").ok).toBe(false);
  });
});
