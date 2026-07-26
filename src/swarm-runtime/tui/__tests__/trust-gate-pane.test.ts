/**
 * TRUST GATE pane tests — pure rendering and key handling.
 *
 * The pane's whole job is to report a gate that often, and correctly,
 * refuses to certify anything. These tests exist mainly to pin the cases
 * where a naive renderer would make that look like success.
 */

import { describe, expect, it } from "vitest";

import {
  initTrustGatePane,
  trustGatePaneKey,
  renderTrustGatePane,
  domainNote,
  SEPARATION_FLOOR,
  type TrustGatePaneBudget,
  type TrustGatePaneDomainRow,
} from "../trust-gate-pane";

function row(over: Partial<TrustGatePaneDomainRow> = {}): TrustGatePaneDomainRow {
  return {
    domain: "memory",
    verifiers: 2,
    calibrated: true,
    points: 60,
    threshold: 0.9,
    epsilon: 0.05,
    auc: 1,
    admitted: 3,
    abstained: 1,
    ...over,
  };
}

const budget: TrustGatePaneBudget = {
  totalRisk: 1,
  spentRisk: 0.25,
  remainingRisk: 0.75,
  exhausted: false,
  entries: 3,
  chainOk: true,
};

function text(lines: string[]): string {
  return lines.join("\n");
}

describe("domainNote — the consequence, not just the state", () => {
  it("says 'abstains' for an uncalibrated domain", () => {
    expect(domainNote(row({ calibrated: false, threshold: null }))).toBe("uncalibrated: abstains");
  });

  it("says 'nothing clears' for an admit-nothing threshold", () => {
    expect(domainNote(row({ threshold: Number.POSITIVE_INFINITY }))).toBe("abstains: nothing clears");
  });

  it("flags NO SEPARATION at or below the floor, however tidy the threshold looks", () => {
    expect(domainNote(row({ auc: 0.5 }))).toContain("NO SEPARATION");
    expect(domainNote(row({ auc: SEPARATION_FLOOR }))).toContain("NO SEPARATION");
    expect(domainNote(row({ auc: SEPARATION_FLOOR + 0.01 }))).toBe("weak separation");
  });

  it("grades real separation without overstating it", () => {
    expect(domainNote(row({ auc: 0.95 }))).toBe("strong separation");
    expect(domainNote(row({ auc: 0.75 }))).toBe("usable separation");
    expect(domainNote(row({ auc: null }))).toBe("one-class sample: bound untested");
  });
});

describe("renderTrustGatePane", () => {
  it("never exceeds the requested width, at any width", () => {
    const state = initTrustGatePane(
      [row(), row({ domain: "procedure", verifiers: 1, calibrated: false, threshold: null, auc: null })],
      budget,
    );
    for (const w of [24, 40, 72, 120]) {
      for (const line of renderTrustGatePane(state, w)) {
        expect([...line].length).toBeLessThanOrEqual(w);
      }
    }
  });

  it("renders an explicit empty line rather than a bare box", () => {
    const out = renderTrustGatePane(initTrustGatePane([]));
    expect(text(out)).toContain("no trust domains reported");
    expect(out.length).toBeGreaterThan(3);
  });

  it("prints +Inf, never a tidy number, for an admit-nothing threshold", () => {
    const out = renderTrustGatePane(initTrustGatePane([row({ threshold: Number.POSITIVE_INFINITY })]));
    const body = text(out);
    expect(body).toContain("+Inf");
    expect(body).toContain("abstains: nothing clears");
    expect(body).not.toContain("Infinity");
  });

  it("prints an em dash for a null AUC — never 'null' or 'NaN'", () => {
    const body = text(renderTrustGatePane(initTrustGatePane([row({ auc: null, threshold: null, calibrated: false })])));
    expect(body).toContain("—");
    expect(body).not.toContain("null");
    expect(body).not.toContain("NaN");
  });

  it("renders a failed budget chain as an explicit refusal", () => {
    const body = text(
      renderTrustGatePane(
        initTrustGatePane([row()], { ...budget, chainOk: false, chainReason: "hash_mismatch", exhausted: true }),
      ),
    );
    expect(body).toContain("CHAIN   FAILED (hash_mismatch)");
    expect(body).toContain("spending refused");
    expect(body).toContain("EXHAUSTED");
  });

  it("strips control characters so upstream text cannot inject escape sequences", () => {
    const hostile = row({ domain: "mem\u001b[2Jory\u0007" });
    const body = text(renderTrustGatePane(initTrustGatePane([hostile])));
    expect(body).not.toContain("\u001b");
    expect(body).not.toContain("\u0007");
    expect(body).toContain("mem[2Jory");
  });

  it("marks the selected row and shows detail only when asked", () => {
    let state = initTrustGatePane([row(), row({ domain: "tool" })], budget);
    expect(text(renderTrustGatePane(state))).not.toContain("DETAIL");

    state = trustGatePaneKey(state, "j");
    state = trustGatePaneKey(state, "enter");
    const body = text(renderTrustGatePane(state));
    expect(body).toContain("DETAIL  tool");
    expect(body).toContain("›tool");
    expect(body).toContain("labeled observations  60");
  });

  it("omits the budget block entirely when there is no ledger", () => {
    const body = text(renderTrustGatePane(initTrustGatePane([row()], null)));
    expect(body).not.toContain("BUDGET");
    expect(body).not.toContain("CHAIN");
  });

  it("emits no HTML — this product's front end is the terminal", () => {
    const body = text(renderTrustGatePane(initTrustGatePane([row()], budget)));
    expect(body).not.toMatch(/<\/?[a-z]+[\s>]/i);
  });
});

describe("trustGatePaneKey", () => {
  it("clamps navigation at both ends and returns the SAME object for a no-op", () => {
    const state = initTrustGatePane([row(), row({ domain: "tool" })]);
    expect(trustGatePaneKey(state, "k")).toBe(state); // already at 0
    const down = trustGatePaneKey(state, "j");
    expect(down.selected).toBe(1);
    expect(trustGatePaneKey(down, "j")).toBe(down); // already at the end
    expect(trustGatePaneKey(down, "g").selected).toBe(0);
    expect(trustGatePaneKey(state, "G").selected).toBe(1);
    expect(trustGatePaneKey(state, "zzz")).toBe(state);
  });

  it("toggles detail and closes it on escape", () => {
    let state = initTrustGatePane([row()]);
    state = trustGatePaneKey(state, "enter");
    expect(state.showDetail).toBe(true);
    state = trustGatePaneKey(state, "enter");
    expect(state.showDetail).toBe(false);
    state = trustGatePaneKey(state, "l");
    expect(state.showDetail).toBe(true);
    state = trustGatePaneKey(state, "escape");
    expect(state.showDetail).toBe(false);
    expect(trustGatePaneKey(state, "escape")).toBe(state);
  });

  it("survives navigation on an empty pane", () => {
    const empty = initTrustGatePane([]);
    for (const key of ["j", "k", "g", "G", "enter", "escape"]) {
      const next = trustGatePaneKey(empty, key);
      expect(next.selected).toBe(0);
      expect(() => renderTrustGatePane(next)).not.toThrow();
    }
  });
});
