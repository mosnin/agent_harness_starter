import { describe, it, expect } from "vitest";
import { deriveConflictsLane, extractPlaceholderNotice } from "../core/fleet-conflicts";
import type { AdoptionReport } from "../../hades/backends/adoption";
import type { ReconcileReport } from "../../hades/backends/handle-store";
import type { RemoteHandle } from "../../hades/backends/backend";
import type { FleetRestoredDrop, FleetProvisionRouting } from "../ipc/fleet-provision-contract";
import { validateWorkerId } from "../core/worker-id-suggest";

// ---------------------------------------------------------------------------
// Real-shape builders
// ---------------------------------------------------------------------------

function handle(workerId: string, overrides: Partial<RemoteHandle> = {}): RemoteHandle {
  return {
    workerId,
    backend: "docker",
    nativeId: `native-${workerId}`,
    state: "running",
    startedAt: 1_700_000_000_000,
    ...overrides,
  };
}

function emptyAdoption(): AdoptionReport {
  return { adopted: [], corrected: [], conflicts: [], dropped: [] };
}

function emptyReconcile(): ReconcileReport {
  return { restored: [], corrected: [], dropped: [] };
}

// ---------------------------------------------------------------------------
// deriveConflictsLane
// ---------------------------------------------------------------------------

describe("deriveConflictsLane — empty input", () => {
  it("yields an explicit no-conflicts model for completely empty input", () => {
    const model = deriveConflictsLane({ liveIds: [] });
    expect(model).toEqual({
      items: [],
      counts: { conflict: 0, dropped: 0, corrected: 0 },
      notices: [],
    });
  });

  it("yields an empty model when reports are present but themselves empty", () => {
    const model = deriveConflictsLane({
      adoption: emptyAdoption(),
      reconcile: emptyReconcile(),
      drops: [],
      liveIds: ["worker-1", "worker-2"],
    });
    expect(model.items).toEqual([]);
    expect(model.counts).toEqual({ conflict: 0, dropped: 0, corrected: 0 });
  });
});

describe("deriveConflictsLane — conflicts", () => {
  it("maps adoption.conflicts to a conflict item with a rename suggestion", () => {
    const adoption: AdoptionReport = {
      ...emptyAdoption(),
      conflicts: [{ workerId: "worker-1", reason: "workerId already live in the registry (backend=docker)" }],
    };
    const model = deriveConflictsLane({ adoption, liveIds: ["worker-1"] });

    expect(model.items).toHaveLength(1);
    const item = model.items[0];
    expect(item.workerId).toBe("worker-1");
    expect(item.severity).toBe("conflict");
    expect(item.reason).toContain("already live");
    expect(item.suggestedAction).toBe("rename-and-provision");
    expect(item.suggestedWorkerId).toBeDefined();
    expect(validateWorkerId(item.suggestedWorkerId!)).toEqual({ ok: true });
    expect(item.suggestedWorkerId).not.toBe("worker-1");
    expect(model.counts).toEqual({ conflict: 1, dropped: 0, corrected: 0 });
  });

  it("suggested id avoids collision with every id mentioned anywhere in the input, not just liveIds", () => {
    const adoption: AdoptionReport = {
      adopted: [handle("worker-1-2")],
      corrected: [],
      conflicts: [{ workerId: "worker-1", reason: "already live" }],
      dropped: [{ workerId: "worker-1-1", reason: "some other reason" }],
    };
    const model = deriveConflictsLane({ adoption, liveIds: ["worker-1"] });
    const item = model.items[0];
    // suggestWorkerId against base "worker-1" would normally propose
    // "worker-1-1" first, but that id is mentioned (dropped) in the input,
    // and "worker-1-2" is mentioned too (adopted) — both must be skipped.
    expect(item.suggestedWorkerId).toBe("worker-1-3");
  });
});

describe("deriveConflictsLane — dropped", () => {
  it("maps adoption.dropped to a dropped item with the verbatim reason and no action", () => {
    const adoption: AdoptionReport = {
      ...emptyAdoption(),
      dropped: [{ workerId: "worker-2", reason: "unknown backend: modal" }],
    };
    const model = deriveConflictsLane({ adoption, liveIds: [] });
    expect(model.items).toEqual([
      { workerId: "worker-2", severity: "dropped", reason: "unknown backend: modal", suggestedAction: "none" },
    ]);
    expect(model.counts).toEqual({ conflict: 0, dropped: 1, corrected: 0 });
  });

  it("maps reconcile.dropped to a dropped item", () => {
    const reconcile: ReconcileReport = {
      ...emptyReconcile(),
      dropped: [{ workerId: "worker-3", reason: "status probe threw: ECONNREFUSED" }],
    };
    const model = deriveConflictsLane({ reconcile, liveIds: [] });
    expect(model.items[0]).toMatchObject({
      workerId: "worker-3",
      severity: "dropped",
      reason: "status probe threw: ECONNREFUSED",
      suggestedAction: "none",
    });
  });

  it("maps FleetRestoredDrop[] to dropped items", () => {
    const drops: FleetRestoredDrop[] = [{ workerId: "worker-4", reason: "malformed handle entry" }];
    const model = deriveConflictsLane({ drops, liveIds: [] });
    expect(model.items[0]).toMatchObject({
      workerId: "worker-4",
      severity: "dropped",
      reason: "malformed handle entry",
    });
  });

  it("merges duplicate dropped reasons across adoption/reconcile/drops for the same workerId", () => {
    const adoption: AdoptionReport = { ...emptyAdoption(), dropped: [{ workerId: "worker-5", reason: "reason A" }] };
    const reconcile: ReconcileReport = { ...emptyReconcile(), dropped: [{ workerId: "worker-5", reason: "reason B" }] };
    const drops: FleetRestoredDrop[] = [{ workerId: "worker-5", reason: "reason A" }]; // duplicate of adoption's
    const model = deriveConflictsLane({ adoption, reconcile, drops, liveIds: [] });

    expect(model.items).toHaveLength(1);
    expect(model.items[0].severity).toBe("dropped");
    expect(model.items[0].reason).toBe("reason A; reason B"); // deduped, joined, insertion order
    expect(model.notices.length).toBeGreaterThan(0);
    expect(model.notices[0]).toContain("worker-5");
  });
});

describe("deriveConflictsLane — corrected", () => {
  it("maps adoption.corrected to a 'stored X ≠ probed Y' reason with no action", () => {
    const adoption: AdoptionReport = {
      ...emptyAdoption(),
      adopted: [handle("worker-6", { state: "running" })],
      corrected: [{ workerId: "worker-6", stored: "hibernated", probed: "running" }],
    };
    const model = deriveConflictsLane({ adoption, liveIds: ["worker-6"] });
    expect(model.items).toEqual([
      {
        workerId: "worker-6",
        severity: "corrected",
        reason: "stored hibernated ≠ probed running",
        suggestedAction: "none",
      },
    ]);
    expect(model.counts).toEqual({ conflict: 0, dropped: 0, corrected: 1 });
  });

  it("maps reconcile.corrected the same way", () => {
    const reconcile: ReconcileReport = {
      restored: [handle("worker-7")],
      corrected: [{ workerId: "worker-7", stored: "failed", probed: "hibernated" }],
      dropped: [],
    };
    const model = deriveConflictsLane({ reconcile, liveIds: [] });
    expect(model.items[0].reason).toBe("stored failed ≠ probed hibernated");
  });

  it("a corrected entry also present in restored still surfaces as corrected (restored contributes no items itself)", () => {
    const reconcile: ReconcileReport = {
      restored: [handle("worker-8", { state: "running" }), handle("worker-9", { state: "hibernated" })],
      corrected: [{ workerId: "worker-8", stored: "hibernated", probed: "running" }],
      dropped: [],
    };
    const model = deriveConflictsLane({ reconcile, liveIds: [] });
    // Only worker-8 (corrected) produces an item; worker-9 (clean restore) does not.
    expect(model.items).toHaveLength(1);
    expect(model.items[0].workerId).toBe("worker-8");
    expect(model.items[0].severity).toBe("corrected");
  });
});

describe("deriveConflictsLane — overlap / dedup across severities", () => {
  it("same workerId simultaneously in conflicts and dropped collapses to a single conflict item with merged reason", () => {
    const adoption: AdoptionReport = {
      adopted: [],
      corrected: [],
      conflicts: [{ workerId: "worker-10", reason: "workerId already live in the registry (backend=docker)" }],
      dropped: [],
    };
    const reconcile: ReconcileReport = {
      restored: [],
      corrected: [],
      dropped: [{ workerId: "worker-10", reason: "status probe threw: timeout" }],
    };
    const model = deriveConflictsLane({ adoption, reconcile, liveIds: ["worker-10"] });

    expect(model.items).toHaveLength(1);
    const item = model.items[0];
    expect(item.workerId).toBe("worker-10");
    expect(item.severity).toBe("conflict");
    expect(item.reason).toContain("already live");
    expect(item.reason).toContain("timeout");
    expect(item.suggestedAction).toBe("rename-and-provision");
    expect(item.suggestedWorkerId).toBeDefined();
    expect(model.counts).toEqual({ conflict: 1, dropped: 0, corrected: 0 });

    expect(model.notices.some((n) => n.includes("worker-10"))).toBe(true);
  });

  it("conflict beats corrected when the same workerId appears in both", () => {
    const adoption: AdoptionReport = {
      adopted: [handle("worker-11")],
      corrected: [{ workerId: "worker-11", stored: "hibernated", probed: "running" }],
      conflicts: [{ workerId: "worker-11", reason: "already live" }],
      dropped: [],
    };
    const model = deriveConflictsLane({ adoption, liveIds: ["worker-11"] });
    expect(model.items).toHaveLength(1);
    expect(model.items[0].severity).toBe("conflict");
  });

  it("dropped beats corrected when the same workerId appears in both", () => {
    const adoption: AdoptionReport = {
      adopted: [],
      corrected: [{ workerId: "worker-12", stored: "hibernated", probed: "running" }],
      conflicts: [],
      dropped: [{ workerId: "worker-12", reason: "registry.adopt rejected: race" }],
    };
    const model = deriveConflictsLane({ adoption, liveIds: [] });
    expect(model.items).toHaveLength(1);
    expect(model.items[0].severity).toBe("dropped");
  });
});

describe("deriveConflictsLane — ordering", () => {
  it("orders items severity (conflict > dropped > corrected) then workerId lexicographically", () => {
    const adoption: AdoptionReport = {
      adopted: [handle("worker-z"), handle("worker-a")],
      corrected: [
        { workerId: "worker-z", stored: "hibernated", probed: "running" },
        { workerId: "worker-a", stored: "failed", probed: "hibernated" },
      ],
      conflicts: [
        { workerId: "worker-m", reason: "already live" },
        { workerId: "worker-b", reason: "already live" },
      ],
      dropped: [
        { workerId: "worker-y", reason: "unknown backend" },
        { workerId: "worker-c", reason: "unknown backend" },
      ],
    };
    const model = deriveConflictsLane({ adoption, liveIds: ["worker-m", "worker-b"] });
    const order = model.items.map((i) => `${i.severity}:${i.workerId}`);
    expect(order).toEqual([
      "conflict:worker-b",
      "conflict:worker-m",
      "dropped:worker-c",
      "dropped:worker-y",
      "corrected:worker-a",
      "corrected:worker-z",
    ]);
  });
});

describe("deriveConflictsLane — determinism and non-mutation", () => {
  it("returns deep-equal output for the same input across two calls", () => {
    const adoption: AdoptionReport = {
      adopted: [handle("worker-20")],
      corrected: [{ workerId: "worker-20", stored: "hibernated", probed: "running" }],
      conflicts: [{ workerId: "worker-21", reason: "already live" }],
      dropped: [{ workerId: "worker-22", reason: "unknown backend" }],
    };
    const reconcile: ReconcileReport = {
      restored: [handle("worker-23")],
      corrected: [],
      dropped: [{ workerId: "worker-24", reason: "status probe threw" }],
    };
    const input = { adoption, reconcile, drops: [{ workerId: "worker-25", reason: "x" }], liveIds: ["worker-21"] };

    const first = deriveConflictsLane(input);
    const second = deriveConflictsLane(input);
    expect(first).toEqual(second);
  });

  it("never mutates the input reports or arrays", () => {
    const adoption: AdoptionReport = {
      adopted: [handle("worker-30")],
      corrected: [{ workerId: "worker-30", stored: "hibernated", probed: "running" }],
      conflicts: [{ workerId: "worker-31", reason: "already live" }],
      dropped: [{ workerId: "worker-32", reason: "unknown backend" }],
    };
    const reconcile: ReconcileReport = {
      restored: [handle("worker-33")],
      corrected: [],
      dropped: [],
    };
    const drops: FleetRestoredDrop[] = [{ workerId: "worker-34", reason: "x" }];
    const liveIds = ["worker-31"];

    const adoptionBefore = JSON.parse(JSON.stringify(adoption));
    const reconcileBefore = JSON.parse(JSON.stringify(reconcile));
    const dropsBefore = JSON.parse(JSON.stringify(drops));
    const liveIdsBefore = [...liveIds];

    deriveConflictsLane({ adoption, reconcile, drops, liveIds });

    expect(adoption).toEqual(adoptionBefore);
    expect(reconcile).toEqual(reconcileBefore);
    expect(drops).toEqual(dropsBefore);
    expect(liveIds).toEqual(liveIdsBefore);
  });
});

// ---------------------------------------------------------------------------
// extractPlaceholderNotice
// ---------------------------------------------------------------------------

describe("extractPlaceholderNotice", () => {
  // The exact literal template fleet-wiring.ts builds:
  //   ` (placeholder manager credentials — set ${MANAGER_URL_ENV}/${AUTH_TOKEN_ENV} for real ones)`
  // reproduced here verbatim (not paraphrased) with fleet-wiring.ts's own
  // env var name constants, for an exact-suffix round trip.
  const MANAGER_URL_ENV = "HADES_BACKEND_MANAGER_URL";
  const AUTH_TOKEN_ENV = "HADES_BACKEND_AUTH_TOKEN";
  const PLACEHOLDER_SUFFIX = ` (placeholder manager credentials — set ${MANAGER_URL_ENV}/${AUTH_TOKEN_ENV} for real ones)`;

  it("round-trips the exact suffix fleet-wiring.ts builds", () => {
    const baseReason = "picked backend=docker via bandit UCB1";
    const routing: FleetProvisionRouting = { source: "bandit", reason: baseReason + PLACEHOLDER_SUFFIX };

    const result = extractPlaceholderNotice(routing);
    expect(result.reason).toBe(baseReason);
    expect(result.notice).toBe(
      `placeholder manager credentials — set ${MANAGER_URL_ENV}/${AUTH_TOKEN_ENV} for real ones`
    );
  });

  it("passes non-placeholder reasons through byte-identical", () => {
    const reason = "picked backend=local via manager's static scoring (only candidate)";
    const routing: FleetProvisionRouting = { source: "manager", reason };
    expect(extractPlaceholderNotice(routing)).toEqual({ reason });
  });

  it("does not false-positive on a reason that merely contains the word 'placeholder' mid-text", () => {
    const reason = "backend chosen because the previous placeholder image was retired";
    const routing: FleetProvisionRouting = { source: "manager", reason };
    expect(extractPlaceholderNotice(routing)).toEqual({ reason });
  });

  it("does not false-positive when the reason ends with an unrelated parenthetical", () => {
    const reason = "picked backend=docker (placeholder image only, not credentials)";
    const routing: FleetProvisionRouting = { source: "manager", reason };
    expect(extractPlaceholderNotice(routing)).toEqual({ reason });
  });

  it("does not trigger when the marker text appears but the string does not end in the closing paren", () => {
    const reason = `something${PLACEHOLDER_SUFFIX} and then more text after`;
    const routing: FleetProvisionRouting = { source: "manager", reason };
    expect(extractPlaceholderNotice(routing)).toEqual({ reason });
  });

  it("handles a routing with an empty reason", () => {
    const routing: FleetProvisionRouting = { source: "manager", reason: "" };
    expect(extractPlaceholderNotice(routing)).toEqual({ reason: "" });
  });

  it("handles a routing with no reason field at all", () => {
    const routing: FleetProvisionRouting = { source: "manager" };
    expect(extractPlaceholderNotice(routing)).toEqual({ reason: "" });
  });

  it("is undefined-safe: an undefined routing returns an empty reason, never throws", () => {
    expect(extractPlaceholderNotice(undefined)).toEqual({ reason: "" });
  });

  it("round-trips when the placeholder suffix is the entire reason (no base reason text)", () => {
    const routing: FleetProvisionRouting = { source: "manager", reason: PLACEHOLDER_SUFFIX };
    const result = extractPlaceholderNotice(routing);
    expect(result.reason).toBe("");
    expect(result.notice).toBe(
      `placeholder manager credentials — set ${MANAGER_URL_ENV}/${AUTH_TOKEN_ENV} for real ones`
    );
  });
});
