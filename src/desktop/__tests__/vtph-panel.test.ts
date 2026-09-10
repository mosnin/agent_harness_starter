import { describe, it, expect } from "vitest";
import {
  computeVtph,
  renderVtphPanel,
  type VtphInput,
} from "../ui/vtph-panel";
import { runVtph, type AgentRunner, type EvalTask } from "../../hades/bench/vtph";

function input(overrides: Partial<VtphInput>): VtphInput {
  return {
    verifiedTasks: 0,
    elapsedMs: 0,
    costUsd: 0,
    history: [],
    ...overrides,
  };
}

describe("computeVtph delegates to bench/vtph.ts", () => {
  it("matches runVtph's vtphPerDollar / vtph on the same numbers", async () => {
    // Build a realistic mixed batch through the REAL harness: 3 verified-correct,
    // 1 silent-wrong, 1 declined-correct. Only the 3 verified-correct score.
    const tasks: EvalTask[] = [
      { id: "a", prompt: "", category: "c", decomposable: false, grade: () => true },
      { id: "b", prompt: "", category: "c", decomposable: false, grade: () => true },
      { id: "c", prompt: "", category: "c", decomposable: false, grade: () => true },
      { id: "d", prompt: "", category: "c", decomposable: false, grade: () => false },
      { id: "e", prompt: "", category: "c", decomposable: false, grade: () => true },
    ];
    const usd: Record<string, number> = { a: 0.5, b: 0.5, c: 0.5, d: 0.25, e: 0.25 };
    const runner: AgentRunner = async (t) => ({
      output: "",
      // a,b,c: claimed & correct -> verifiedCorrect. d: claimed but wrong -> silentWrong.
      // e: not claimed -> declined (correctButUnclaimed).
      claimedVerified: t.id !== "e",
      tokensIn: 0,
      tokensOut: 0,
      usd: usd[t.id],
      provenance: [],
    });
    let sample = 0;
    const elapsedMs = 1_800_000; // 30 minutes
    const now = () => (sample++ === 0 ? 0 : elapsedMs);

    const report = await runVtph(runner, tasks, { now });
    expect(report.verifiedCorrect).toBe(3);
    expect(report.silentWrong).toBe(1);

    // Feed the harness's own aggregated numbers into computeVtph; it must
    // reproduce the identical figures because it runs the same harness.
    const computed = await computeVtph(
      input({
        verifiedTasks: report.verifiedCorrect,
        elapsedMs: report.wallClockMs,
        costUsd: report.totalUsd,
      })
    );

    expect(computed.vtphd).toBe(report.vtphPerDollar);
    expect(computed.vtph).toBe(report.vtph);
    expect(computed.reason).toBe("ok");
  });

  it("computes a known input to its exact value", async () => {
    // 2 verified in exactly 1 hour for $2 -> vtph = 2, vtphd = 2/2 = 1.
    const computed = await computeVtph(
      input({ verifiedTasks: 2, elapsedMs: 3_600_000, costUsd: 2 })
    );
    expect(computed.vtph).toBe(2);
    expect(computed.vtphd).toBe(1);

    const html = await renderVtphPanel(
      input({ verifiedTasks: 2, elapsedMs: 3_600_000, costUsd: 2 })
    );
    expect(html).toContain("1.00");
    expect(html).toContain("V-TPH$");
  });
});

describe("computeVtph never fabricates on insufficient data", () => {
  it("returns null (not 0) when cost is 0", async () => {
    const c = await computeVtph(input({ verifiedTasks: 5, elapsedMs: 1000, costUsd: 0 }));
    expect(c.vtphd).toBeNull();
    expect(c.vtph).toBeNull();
    expect(c.reason).toBe("no-cost");
  });

  it("returns null (not 0) when elapsed is 0", async () => {
    const c = await computeVtph(input({ verifiedTasks: 5, elapsedMs: 0, costUsd: 1 }));
    expect(c.vtphd).toBeNull();
    expect(c.reason).toBe("no-elapsed");
  });

  it("returns null (not 0) when nothing has been verified", async () => {
    const c = await computeVtph(input({ verifiedTasks: 0, elapsedMs: 1000, costUsd: 1 }));
    expect(c.vtphd).toBeNull();
    expect(c.reason).toBe("no-verified");
  });
});

describe("renderVtphPanel honesty", () => {
  it("shows an honest fallback (not a fake 0) when nothing is verified yet", async () => {
    const html = await renderVtphPanel(
      input({ verifiedTasks: 0, elapsedMs: 1000, costUsd: 1 })
    );
    expect(html).toContain("awaiting a verified run");
    expect(html).not.toContain("0.00");
  });

  it("shows n/a in the headline (not a fabricated figure) when cost is missing", async () => {
    const html = await renderVtphPanel(
      input({ verifiedTasks: 5, elapsedMs: 1000, costUsd: 0 })
    );
    // The headline is the honest n/a variant, not a computed value.
    expect(html).toContain("n/a (awaiting spend)");
    expect(html).toContain("vtph-value--na");
    // The reported $0.0000 spend is honest input echo, but there is no
    // fabricated V-TPH$ headline number.
    expect(html).not.toMatch(/vtph-value">\d/);
  });

  it("renders the pre-run empty state for null input", async () => {
    const html = await renderVtphPanel(null);
    expect(html).toContain("awaiting a verified run");
    expect(html).toContain("no samples yet");
  });

  it("labels V-TPH$ and states the metric cannot be gamed", async () => {
    const html = await renderVtphPanel(null);
    expect(html).toContain("V-TPH$");
    expect(html).toContain("cannot be gamed");
    expect(html).toContain("scores 0");
    // House rule: no em-dashes anywhere in rendered output.
    expect(html).not.toContain("—");
  });
});

describe("sparkline is deterministic", () => {
  it("produces the same block string for the same history", async () => {
    const history = [0.5, 1, 1.5, 2, 1.25];
    const a = await renderVtphPanel(input({ verifiedTasks: 1, elapsedMs: 1000, costUsd: 1, history }));
    const b = await renderVtphPanel(input({ verifiedTasks: 1, elapsedMs: 1000, costUsd: 1, history }));
    expect(a).toBe(b);
    // Contains block glyphs and scales the max to the tallest bar.
    expect(a).toMatch(/[▁-█]/);
    expect(a).toContain("█"); // the max value maps to the full block
  });

  it("shows an honest placeholder for empty history", async () => {
    const html = await renderVtphPanel(input({ verifiedTasks: 1, elapsedMs: 1000, costUsd: 1, history: [] }));
    expect(html).toContain("no samples yet");
  });
});
