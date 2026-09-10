/**
 * Cycle-4 CENTRAL INTEGRATION tests for the desktop conflicts lane: the
 * `conflicts` field added to the `fleet.restored` wire event, the
 * `FleetProvisionService` pass-through, the `deriveConflictsLaneFromRestored`
 * wire-event adapter, and the renderer's conflicts-panel host plumbing.
 *
 * Real components everywhere: the real IPC codecs, the real
 * `FleetProvisionService`, the real `deriveConflictsLane` +
 * `suggestWorkerId` derivation, the real `createApp` renderer controller.
 */
import { describe, expect, it } from "vitest";

import { decodeEvent, encodeEvent } from "../ipc/contract";
import type { FleetProvisionEvent } from "../ipc/contract";
import {
  isFleetProvisionEvent,
  parseFleetProvisionEvent,
  serializeFleetProvisionEvent,
} from "../ipc/fleet-provision-contract";
import { FleetProvisionService, type FleetProvisionPort } from "../core/fleet-provision-service";
import { deriveConflictsLaneFromRestored, extractPlaceholderNotice } from "../core/fleet-conflicts";
import { createApp } from "../ui/renderer";
import type { Bridge } from "../ui/bridge";

const WORKER = {
  workerId: "alpha",
  backend: "local",
  nativeId: "pid-1",
  state: "running" as const,
  startedAt: 100,
  idleMs: 0,
};

// ---------------------------------------------------------------------------
// Wire contract: fleet.restored carries an optional conflicts lane
// ---------------------------------------------------------------------------

describe("fleet.restored `conflicts` field on the wire", () => {
  it("round-trips through both the provision codecs and the main IPC codecs", () => {
    const ev: FleetProvisionEvent = {
      kind: "fleet.restored",
      workers: [WORKER],
      adoptedIds: ["alpha"],
      dropped: [{ workerId: "beta", reason: "adopt: workerId already live in the registry: beta" }],
      conflicts: [{ workerId: "beta", reason: "adopt: workerId already live in the registry: beta" }],
      at: 7,
    };
    expect(parseFleetProvisionEvent(serializeFleetProvisionEvent(ev))).toEqual(ev);
    expect(decodeEvent(encodeEvent(ev))).toEqual(ev);
  });

  it("stays optional: an event without conflicts still validates (older sidecars)", () => {
    const ev = { kind: "fleet.restored", workers: [], adoptedIds: [], dropped: [], at: 1 };
    expect(isFleetProvisionEvent(ev)).toBe(true);
  });

  it("rejects a malformed conflicts entry (empty workerId) like any other guard", () => {
    const bad = {
      kind: "fleet.restored",
      workers: [],
      adoptedIds: [],
      dropped: [],
      conflicts: [{ workerId: "", reason: "nope" }],
      at: 1,
    };
    expect(isFleetProvisionEvent(bad)).toBe(false);
    expect(() => parseFleetProvisionEvent(JSON.stringify(bad))).toThrow(/missing or invalid fields/);
  });
});

// ---------------------------------------------------------------------------
// FleetProvisionService pass-through
// ---------------------------------------------------------------------------

function portWith(restored: Awaited<ReturnType<FleetProvisionPort["restoredView"]>>): FleetProvisionPort {
  return {
    async provision() {
      throw new Error("not under test");
    },
    async restoredView() {
      return restored;
    },
    isTracked() {
      return false;
    },
  };
}

describe("FleetProvisionService.restoredSnapshot conflicts pass-through", () => {
  it("carries the port's conflicts verbatim into the fleet.restored event", async () => {
    const service = new FleetProvisionService(
      portWith({
        workers: [WORKER],
        adoptedIds: ["alpha"],
        dropped: [{ workerId: "beta", reason: "already live" }],
        conflicts: [{ workerId: "beta", reason: "already live" }],
      }),
      { now: () => 42 }
    );
    const ev = await service.restoredSnapshot();
    expect(ev).toMatchObject({
      kind: "fleet.restored",
      conflicts: [{ workerId: "beta", reason: "already live" }],
      at: 42,
    });
    // Still a valid wire event end to end.
    expect(isFleetProvisionEvent(ev)).toBe(true);
  });

  it("omits the field entirely when the port reports no conflicts lane", async () => {
    const service = new FleetProvisionService(
      portWith({ workers: [], adoptedIds: [], dropped: [] }),
      { now: () => 42 }
    );
    const ev = await service.restoredSnapshot();
    expect(ev && "conflicts" in ev).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// deriveConflictsLaneFromRestored — the renderer's wire-event adapter
// ---------------------------------------------------------------------------

describe("deriveConflictsLaneFromRestored", () => {
  const restored = {
    workers: [{ workerId: "alpha" }],
    dropped: [
      { workerId: "beta", reason: "adopt: workerId already live in the registry: beta" },
      { workerId: "gamma", reason: "unknown backend: gone" },
    ],
    conflicts: [{ workerId: "beta", reason: "adopt: workerId already live in the registry: beta" }],
  };

  it("classifies conflicts as actionable rename-and-provision with a collision-free suggestion", () => {
    const lane = deriveConflictsLaneFromRestored(restored, ["beta-1"]);
    const conflict = lane.items.find((i) => i.workerId === "beta");
    expect(conflict).toBeDefined();
    expect(conflict?.severity).toBe("conflict");
    expect(conflict?.suggestedAction).toBe("rename-and-provision");
    // "beta-1" is taken via extraLiveIds, so the suggestion must move on.
    expect(conflict?.suggestedWorkerId).toBe("beta-2");
    expect(lane.counts).toEqual({ conflict: 1, dropped: 1, corrected: 0 });
  });

  it("filters conflict ids out of the drops list so back-compat double-carry never double-lists", () => {
    const lane = deriveConflictsLaneFromRestored(restored);
    // beta appears exactly once (as a conflict), gamma once (as dropped) —
    // and no merge notice fires, because nothing actually merged.
    expect(lane.items.map((i) => `${i.severity}:${i.workerId}`)).toEqual([
      "conflict:beta",
      "dropped:gamma",
    ]);
    expect(lane.notices).toEqual([]);
  });

  it("an event without a conflicts field yields only dropped rows (no invented conflicts)", () => {
    const lane = deriveConflictsLaneFromRestored({
      workers: [],
      dropped: [{ workerId: "gamma", reason: "unknown backend: gone" }],
    });
    expect(lane.counts).toEqual({ conflict: 0, dropped: 1, corrected: 0 });
    expect(lane.items[0].suggestedAction).toBe("none");
  });

  it("suggestions never collide with any id mentioned in the event itself", () => {
    const lane = deriveConflictsLaneFromRestored({
      workers: [{ workerId: "beta-1" }, { workerId: "beta-2" }],
      dropped: [],
      conflicts: [{ workerId: "beta", reason: "already live" }],
    });
    expect(lane.items[0].suggestedWorkerId).toBe("beta-3");
  });
});

// ---------------------------------------------------------------------------
// extractPlaceholderNotice feeds the lane's credential banner
// ---------------------------------------------------------------------------

describe("placeholder credential notice extraction (renderer feed)", () => {
  it("splits the exact fleet-wiring suffix into reason + notice", () => {
    const routing = {
      source: "bandit",
      reason:
        "ucb pick (placeholder manager credentials — set HADES_BACKEND_MANAGER_URL/HADES_BACKEND_AUTH_TOKEN for real ones)",
    };
    const split = extractPlaceholderNotice(routing);
    expect(split.reason).toBe("ucb pick");
    expect(split.notice).toContain("placeholder manager credentials");
  });

  it("never false-positives on a reason that merely mentions placeholder", () => {
    const routing = { source: "bandit", reason: "chose the placeholder-named backend" };
    expect(extractPlaceholderNotice(routing)).toEqual({ reason: "chose the placeholder-named backend" });
  });
});

// ---------------------------------------------------------------------------
// Renderer plumbing
// ---------------------------------------------------------------------------

describe("renderer fleet surface hosts the conflicts lane", () => {
  it("the fleet nav content renders the stable conflicts host node", () => {
    const bridge: Bridge = {
      send() {},
      onEvent() {
        return () => {};
      },
      async start() {},
      async stop() {},
    };
    const app = createApp(bridge, { initialNav: "fleet" });
    expect(app.html()).toContain('id="fleet-conflicts-host"');
    app.destroy();
  });
});
