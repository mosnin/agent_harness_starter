/**
 * CLUSTER pane (`../cluster-pane.ts`) — purity, honesty and terminal-safety.
 *
 * The pane is the operator's read on whether distributed work actually
 * completed, so these tests are written to fail if it ever lets an incomplete,
 * uncertified or exactly-once-breached run read as a healthy one, and if a
 * node id gossiped from another machine can ever reach the terminal
 * unsanitized.
 */

import { describe, expect, it } from "vitest";

import {
  CLUSTER_PANE_DEFAULT_WIDTH,
  clusterPaneKey,
  initClusterPane,
  leaderCell,
  nodeNote,
  renderClusterPane,
  type ClusterPaneNodeRow,
  type ClusterPaneSummary,
} from "../cluster-pane";

function nodeRow(over: Partial<ClusterPaneNodeRow> = {}): ClusterPaneNodeRow {
  return {
    nodeId: "node-0",
    health: "alive",
    inFlight: 1,
    liveWorkers: 2,
    load: 0.5,
    completed: 4,
    handedBack: 0,
    abandoned: 0,
    epoch: 3,
    leaderId: "controller",
    ...over,
  };
}

function summary(over: Partial<ClusterPaneSummary> = {}): ClusterPaneSummary {
  return {
    tasksSubmitted: 6,
    tasksVerified: 6,
    tasksFailed: 0,
    pending: 0,
    leased: 0,
    reassignments: 1,
    staleReportsRejected: 0,
    conflicts: 0,
    duplicateVerifications: 0,
    certificatesValid: 6,
    certificatesInvalid: 0,
    makespanMs: 812,
    ...over,
  };
}

function joined(lines: string[]): string {
  return lines.join("\n");
}

describe("cluster pane — width discipline", () => {
  it("never emits a line wider than the requested width, at any width", () => {
    const rows = [
      nodeRow({ nodeId: "a-very-long-node-identifier-from-another-machine" }),
      nodeRow({ nodeId: "node-1", health: "crashed", abandoned: 2 }),
    ];
    for (const w of [24, 40, 72, 120]) {
      const lines = renderClusterPane({ ...initClusterPane(rows, summary()), showDetail: true }, w);
      for (const line of lines) {
        expect([...line].length).toBeLessThanOrEqual(w);
      }
    }
  });

  it("renders an explicit empty-case line rather than a bare box", () => {
    const lines = renderClusterPane(initClusterPane([]));
    expect(joined(lines)).toContain("no cluster nodes");
    expect(lines.length).toBeGreaterThan(3);
  });

  it("is pure: the same state renders identically twice and the state is not mutated", () => {
    const state = initClusterPane([nodeRow()], summary());
    const snapshot = JSON.stringify(state);
    const a = renderClusterPane(state);
    const b = renderClusterPane(state);
    expect(a).toEqual(b);
    expect(JSON.stringify(state)).toBe(snapshot);
  });
});

describe("cluster pane — terminal-injection safety", () => {
  it("strips ESC / C0 / C1 from a gossiped node id before it reaches a line", () => {
    const hostile = "node-[2J[Hevil31m";
    const lines = renderClusterPane({ ...initClusterPane([nodeRow({ nodeId: hostile })]), showDetail: true });
    const text = joined(lines);
    expect(text).not.toContain("");
    expect(text).not.toContain("");
    expect(text).not.toContain("");
    expect(text).toContain("node-");
  });

  it("strips control characters out of a hostile leaderId too", () => {
    const lines = renderClusterPane(initClusterPane([nodeRow({ leaderId: "ctl[31m" })]));
    expect(joined(lines)).not.toContain("");
  });
});

describe("cluster pane — honesty", () => {
  it("renders a node with no quorum-backed leader as NO LEADER, never as blank", () => {
    const row = nodeRow({ leaderId: null });
    expect(leaderCell(row)).toBe("NO LEADER");
    expect(nodeNote(row)).toContain("NO LEADER");
    expect(joined(renderClusterPane(initClusterPane([row])))).toContain("NO LEADER");
  });

  it("annotates every non-alive health with what it means for that node's leases", () => {
    expect(nodeNote(nodeRow({ health: "crashed", abandoned: 3 }))).toContain("3 lease(s) abandoned");
    expect(nodeNote(nodeRow({ health: "left", handedBack: 2 }))).toContain("2 lease(s) handed back");
    expect(nodeNote(nodeRow({ health: "draining", inFlight: 1 }))).toContain("accepting no new work");
    expect(nodeNote(nodeRow({ health: "suspect" }))).toContain("not yet reclaimed");
    expect(nodeNote(nodeRow({ health: "dead" }))).toContain("reclaimed and reassigned");
  });

  it("raises a full-width INCOMPLETE alert when not every submitted task verified", () => {
    const lines = renderClusterPane(
      initClusterPane([nodeRow()], summary({ tasksVerified: 4, tasksSubmitted: 6 })),
    );
    expect(joined(lines)).toContain("INCOMPLETE");
    // The alert must survive the default-width clamp intact — a truncated
    // completeness warning is a defeated one.
    expect(joined(lines)).toContain("not every submitted task was verified");
  });

  it("does NOT raise the incomplete alert for a genuinely complete run", () => {
    expect(joined(renderClusterPane(initClusterPane([nodeRow()], summary())))).not.toContain("INCOMPLETE");
  });

  it("raises an alert for an invalid certificate — a signature that does not bind its bytes is a trust failure", () => {
    const lines = renderClusterPane(initClusterPane([nodeRow()], summary({ certificatesInvalid: 1 })));
    expect(joined(lines)).toContain("INVALID SIGNATURE");
    expect(joined(lines)).toContain("NOT certified");
  });

  it("raises an alert for ANY duplicate verification — exactly-once is the whole point of the lease layer", () => {
    const lines = renderClusterPane(initClusterPane([nodeRow()], summary({ duplicateVerifications: 1 })));
    expect(joined(lines)).toContain("EXACTLY-ONCE BREACHED");
  });

  it("prints the summary counters verbatim — it never derives a metric of its own", () => {
    const s = summary({ tasksVerified: 5, tasksSubmitted: 6, tasksFailed: 1, reassignments: 7, conflicts: 2, staleReportsRejected: 3 });
    const text = joined(renderClusterPane(initClusterPane([nodeRow()], s), 120));
    expect(text).toContain("5/6 verified");
    expect(text).toContain("1 failed");
    expect(text).toContain("7 reassigned");
    expect(text).toContain("3 stale-fencing refused");
    expect(text).toContain("2 conflict(s)");
  });

  it("renders a non-finite load as — rather than NaN", () => {
    const text = joined(renderClusterPane(initClusterPane([nodeRow({ load: Number.NaN })])));
    expect(text).not.toContain("NaN");
    expect(text).toContain("—");
  });
});

describe("cluster pane — key handling", () => {
  const rows = [nodeRow({ nodeId: "node-0" }), nodeRow({ nodeId: "node-1" }), nodeRow({ nodeId: "node-2" })];

  it("moves, clamps at both ends, and jumps home/end", () => {
    let s = initClusterPane(rows);
    s = clusterPaneKey(s, "j");
    expect(s.selected).toBe(1);
    s = clusterPaneKey(clusterPaneKey(s, "j"), "j");
    expect(s.selected).toBe(2); // clamped at the last row
    s = clusterPaneKey(s, "g");
    expect(s.selected).toBe(0);
    s = clusterPaneKey(s, "k");
    expect(s.selected).toBe(0); // clamped at the first row
    s = clusterPaneKey(s, "G");
    expect(s.selected).toBe(2);
  });

  it("returns the SAME object for an unknown key or a no-op move, so a caller can skip re-rendering", () => {
    const s = initClusterPane(rows);
    expect(clusterPaneKey(s, "z")).toBe(s);
    expect(clusterPaneKey(s, "k")).toBe(s);
    expect(clusterPaneKey(s, "escape")).toBe(s);
  });

  it("toggles the detail block and closes it with escape", () => {
    let s = initClusterPane(rows);
    s = clusterPaneKey(s, "enter");
    expect(s.showDetail).toBe(true);
    expect(joined(renderClusterPane(s))).toContain("DETAIL");
    s = clusterPaneKey(s, "escape");
    expect(s.showDetail).toBe(false);
  });

  it("survives keys against an empty pane", () => {
    const s = initClusterPane([]);
    expect(clusterPaneKey(s, "j").selected).toBe(0);
    expect(clusterPaneKey(s, "G").selected).toBe(0);
  });
});

describe("cluster pane — default width", () => {
  it("uses 72 code points by default, matching the other panes", () => {
    expect(CLUSTER_PANE_DEFAULT_WIDTH).toBe(72);
    const lines = renderClusterPane(initClusterPane([nodeRow()], summary()));
    for (const line of lines) expect([...line].length).toBeLessThanOrEqual(72);
    expect([...lines[0]].length).toBe(72);
  });
});
