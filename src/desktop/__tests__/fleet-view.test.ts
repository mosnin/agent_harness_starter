import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  initialFleetState,
  applyFleetEvent,
  renderFleetView,
  renderBackendTable,
  renderWorkerRow,
  formatUsd,
  formatDurationMs,
  lifecycleBadgeClass,
  type FleetViewState,
  type BackendView,
  type FleetWorkerView,
  type FleetLifecycleState,
  type FleetEvent,
} from "../ui/fleet-view";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CSS_PATH = join(__dirname, "../ui/fleet-view.css");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function backend(overrides: Partial<BackendView> = {}): BackendView {
  return {
    name: "local-docker",
    kind: "docker",
    capabilities: ["gpu", "linux"],
    locality: "local",
    supportsHibernate: true,
    available: true,
    cost: {
      perRunningHourUsd: 0.42,
      perHibernatedHourUsd: 0.05,
      perProvisionUsd: 0.01,
      source: "configured",
    },
    telemetry: {
      provisions: 12,
      failures: 1,
      provisionLatencyEmaMs: 850,
      runningMs: 3_600_000,
      hibernatedMs: 60_000,
      accruedUsd: 1.2345,
    },
    ...overrides,
  };
}

function worker(overrides: Partial<FleetWorkerView> = {}): FleetWorkerView {
  return {
    workerId: "w-1",
    backend: "local-docker",
    nativeId: "native-1",
    state: "running",
    startedAt: 1_700_000_000_000,
    idleMs: 5_000,
    ...overrides,
  };
}

/** Recursively freezes an object graph so any mutation attempt throws (strict mode). */
function deepFreeze<T>(obj: T): T {
  if (obj !== null && (typeof obj === "object" || typeof obj === "function")) {
    for (const key of Object.getOwnPropertyNames(obj)) {
      const value = (obj as Record<string, unknown>)[key];
      if (value !== null && (typeof value === "object" || typeof value === "function") && !Object.isFrozen(value)) {
        deepFreeze(value);
      }
    }
    Object.freeze(obj);
  }
  return obj;
}

const ALL_STATES: FleetLifecycleState[] = [
  "provisioning",
  "running",
  "hibernating",
  "hibernated",
  "waking",
  "failed",
  "stopped",
];

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

describe("initialFleetState", () => {
  it("starts empty with no error and no snapshot time", () => {
    const state = initialFleetState();
    expect(state).toEqual({ backends: [], workers: [], lastSnapshotAt: null, error: null });
  });
});

describe("applyFleetEvent — fleet.snapshot", () => {
  it("replaces backends and workers wholesale and clears any prior error", () => {
    const prior: FleetViewState = deepFreeze({
      backends: [backend({ name: "stale" })],
      workers: [worker({ workerId: "stale-worker" })],
      lastSnapshotAt: 1,
      error: { message: "boom", at: 1 },
    });

    const event: FleetEvent = deepFreeze({
      kind: "fleet.snapshot",
      backends: [backend({ name: "fresh" })],
      workers: [worker({ workerId: "fresh-worker" })],
      at: 42,
    });

    const next = applyFleetEvent(prior, event);

    expect(next.backends).toEqual([backend({ name: "fresh" })]);
    expect(next.workers).toEqual([worker({ workerId: "fresh-worker" })]);
    expect(next.lastSnapshotAt).toBe(42);
    expect(next.error).toBeNull();
  });

  it("handles an empty snapshot (fleet with nothing registered)", () => {
    const state = applyFleetEvent(initialFleetState(), { kind: "fleet.snapshot", backends: [], workers: [], at: 5 });
    expect(state.backends).toEqual([]);
    expect(state.workers).toEqual([]);
    expect(state.lastSnapshotAt).toBe(5);
  });
});

describe("applyFleetEvent — fleet.worker.upsert", () => {
  it("inserts a new worker keeping the list sorted by workerId", () => {
    const state: FleetViewState = deepFreeze({
      ...initialFleetState(),
      workers: [worker({ workerId: "a" }), worker({ workerId: "c" })],
    });

    const next = applyFleetEvent(state, {
      kind: "fleet.worker.upsert",
      worker: worker({ workerId: "b" }),
    });

    expect(next.workers.map((w) => w.workerId)).toEqual(["a", "b", "c"]);
  });

  it("inserts at the front and the back correctly", () => {
    const state: FleetViewState = { ...initialFleetState(), workers: [worker({ workerId: "m" })] };
    const withFront = applyFleetEvent(state, { kind: "fleet.worker.upsert", worker: worker({ workerId: "a" }) });
    expect(withFront.workers.map((w) => w.workerId)).toEqual(["a", "m"]);
    const withBack = applyFleetEvent(state, { kind: "fleet.worker.upsert", worker: worker({ workerId: "z" }) });
    expect(withBack.workers.map((w) => w.workerId)).toEqual(["m", "z"]);
  });

  it("updates an existing worker in place, preserving sort position and array length", () => {
    const state: FleetViewState = deepFreeze({
      ...initialFleetState(),
      workers: [worker({ workerId: "a", state: "running" }), worker({ workerId: "b", state: "running" })],
    });

    const next = applyFleetEvent(state, {
      kind: "fleet.worker.upsert",
      worker: worker({ workerId: "a", state: "hibernated" }),
    });

    expect(next.workers).toHaveLength(2);
    expect(next.workers.map((w) => w.workerId)).toEqual(["a", "b"]);
    expect(next.workers[0].state).toBe("hibernated");
  });

  it("leaves backends, lastSnapshotAt and error untouched", () => {
    const state: FleetViewState = deepFreeze({
      backends: [backend()],
      workers: [],
      lastSnapshotAt: 99,
      error: { message: "prior error", at: 3 },
    });

    const next = applyFleetEvent(state, { kind: "fleet.worker.upsert", worker: worker() });

    expect(next.backends).toEqual(state.backends);
    expect(next.lastSnapshotAt).toBe(99);
    expect(next.error).toEqual({ message: "prior error", at: 3 });
  });
});

describe("applyFleetEvent — fleet.error", () => {
  it("sets the error while keeping existing backends/workers/lastSnapshotAt (data retention)", () => {
    const state: FleetViewState = deepFreeze({
      backends: [backend()],
      workers: [worker()],
      lastSnapshotAt: 10,
      error: null,
    });

    const next = applyFleetEvent(state, { kind: "fleet.error", message: "hibernate failed", workerId: "w-1", at: 20 });

    expect(next.error).toEqual({ message: "hibernate failed", workerId: "w-1", at: 20 });
    expect(next.backends).toEqual(state.backends);
    expect(next.workers).toEqual(state.workers);
    expect(next.lastSnapshotAt).toBe(10);
  });

  it("omits workerId when the event carries none", () => {
    const next = applyFleetEvent(initialFleetState(), { kind: "fleet.error", message: "probe failed", at: 7 });
    expect(next.error).toEqual({ message: "probe failed", at: 7 });
    expect(next.error && "workerId" in next.error).toBe(false);
  });

  it("survives multiple upserts (error retention across upserts) until a fresh snapshot clears it", () => {
    let state = applyFleetEvent(initialFleetState(), { kind: "fleet.error", message: "wake failed", at: 1 });
    expect(state.error?.message).toBe("wake failed");

    state = applyFleetEvent(state, { kind: "fleet.worker.upsert", worker: worker({ workerId: "x" }) });
    expect(state.error?.message).toBe("wake failed");

    state = applyFleetEvent(state, { kind: "fleet.worker.upsert", worker: worker({ workerId: "y" }) });
    expect(state.error?.message).toBe("wake failed");

    state = applyFleetEvent(state, { kind: "fleet.snapshot", backends: [], workers: [], at: 2 });
    expect(state.error).toBeNull();
  });
});

describe("applyFleetEvent — immutability", () => {
  it("never mutates a deep-frozen input state or event, and always returns a new object", () => {
    const state: FleetViewState = deepFreeze({
      backends: [backend()],
      workers: [worker({ workerId: "a" }), worker({ workerId: "c" })],
      lastSnapshotAt: 1,
      error: null,
    });

    const snapshotEvent: FleetEvent = deepFreeze({
      kind: "fleet.snapshot",
      backends: [backend({ name: "x" })],
      workers: [worker({ workerId: "b" })],
      at: 2,
    });
    expect(() => applyFleetEvent(state, snapshotEvent)).not.toThrow();
    const afterSnapshot = applyFleetEvent(state, snapshotEvent);
    expect(afterSnapshot).not.toBe(state);

    const upsertEvent: FleetEvent = deepFreeze({ kind: "fleet.worker.upsert", worker: worker({ workerId: "b" }) });
    expect(() => applyFleetEvent(state, upsertEvent)).not.toThrow();
    const afterUpsert = applyFleetEvent(state, upsertEvent);
    expect(afterUpsert).not.toBe(state);
    expect(afterUpsert.workers).not.toBe(state.workers);
    // Original untouched.
    expect(state.workers.map((w) => w.workerId)).toEqual(["a", "c"]);

    const errorEvent: FleetEvent = deepFreeze({ kind: "fleet.error", message: "boom", at: 3 });
    expect(() => applyFleetEvent(state, errorEvent)).not.toThrow();
    const afterError = applyFleetEvent(state, errorEvent);
    expect(afterError).not.toBe(state);
    expect(state.error).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// formatUsd / formatDurationMs
// ---------------------------------------------------------------------------

describe("formatUsd", () => {
  it("formats zero", () => {
    expect(formatUsd(0)).toBe("$0.0000");
  });

  it("formats a sub-cent amount without rounding away to zero", () => {
    expect(formatUsd(0.0007)).toBe("$0.0007");
  });

  it("formats a thousands-scale amount", () => {
    expect(formatUsd(1234.5678)).toBe("$1234.5678");
  });

  it("renders a non-finite input as the no-data marker, never a fabricated dollar figure", () => {
    // Tightened by the central-integration audit: NaN/Infinity used to render
    // "$0.0000", which presents a number that was never measured. The em-dash
    // no-data marker is the only honest rendering.
    expect(formatUsd(Number.NaN)).toBe("—");
    expect(formatUsd(Number.POSITIVE_INFINITY)).toBe("—");
  });
});

describe("formatDurationMs", () => {
  it("renders whole milliseconds below the 1s boundary", () => {
    expect(formatDurationMs(0)).toBe("0ms");
    expect(formatDurationMs(999)).toBe("999ms");
  });

  it("renders whole seconds at and above the 1s boundary, below the 1m boundary", () => {
    expect(formatDurationMs(1000)).toBe("1s");
    expect(formatDurationMs(59_999)).toBe("59s");
  });

  it("renders whole minutes at and above the 1m boundary, below the 1h boundary", () => {
    expect(formatDurationMs(60_000)).toBe("1m");
    expect(formatDurationMs(3_599_999)).toBe("59m");
  });

  it("renders whole hours at and above the 1h boundary", () => {
    expect(formatDurationMs(3_600_000)).toBe("1h");
    expect(formatDurationMs(7_200_000)).toBe("2h");
  });

  it("clamps a negative (clock-skew) input to 0ms but renders non-finite as the no-data marker", () => {
    expect(formatDurationMs(-5)).toBe("0ms");
    // Tightened by the central-integration audit: NaN used to render "0ms",
    // a fabricated duration for a value that was never measured.
    expect(formatDurationMs(Number.NaN)).toBe("—");
  });
});

// ---------------------------------------------------------------------------
// XSS escaping
// ---------------------------------------------------------------------------

describe("XSS escaping", () => {
  const evilName = '<script>alert("x")</script>\'quoted\'';

  it("escapes a hostile backend name everywhere it appears in renderBackendTable", () => {
    const html = renderBackendTable([backend({ name: evilName })]);
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&quot;x&quot;");
    expect(html).toContain("&#39;quoted&#39;");
  });

  it("escapes a hostile backend capability", () => {
    const html = renderBackendTable([backend({ capabilities: [evilName] })]);
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;script&gt;");
  });

  it("escapes a hostile worker id everywhere it appears in renderWorkerRow (cell text, data-worker-id attribute)", () => {
    const html = renderWorkerRow(worker({ workerId: evilName }), true);
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;script&gt;");
    expect(html.match(/data-worker-id="/g)).not.toBeNull();
    expect(html).not.toMatch(/data-worker-id="[^"]*<script/);
  });

  it("escapes a hostile worker backend/nativeId in the full fleet view", () => {
    const state: FleetViewState = {
      backends: [backend({ name: "b1" })],
      workers: [worker({ backend: evilName, nativeId: evilName })],
      lastSnapshotAt: 1,
      error: null,
    };
    const html = renderFleetView(state);
    expect(html).not.toContain("<script");
  });

  it("escapes a hostile error message and workerId in the error banner", () => {
    const state: FleetViewState = {
      backends: [],
      workers: [],
      lastSnapshotAt: null,
      error: { message: evilName, workerId: evilName, at: 1 },
    };
    const html = renderFleetView(state);
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;script&gt;");
  });
});

// ---------------------------------------------------------------------------
// Action-button decision table
// ---------------------------------------------------------------------------

describe("renderWorkerRow — action button decision table", () => {
  it("running + backend supports hibernate -> hibernate button present", () => {
    const html = renderWorkerRow(worker({ state: "running" }), true);
    expect(html).toContain('data-cmd="fleet.hibernate"');
  });

  it("running + backend does NOT support hibernate -> no hibernate button", () => {
    const html = renderWorkerRow(worker({ state: "running" }), false);
    expect(html).not.toContain('data-cmd="fleet.hibernate"');
  });

  it("hibernated -> wake button present, no hibernate button", () => {
    const html = renderWorkerRow(worker({ state: "hibernated" }), true);
    expect(html).toContain('data-cmd="fleet.wake"');
    expect(html).not.toContain('data-cmd="fleet.hibernate"');
  });

  it.each<FleetLifecycleState>(["hibernating", "waking"])(
    "%s is transient -> no action buttons at all",
    (state) => {
      const html = renderWorkerRow(worker({ state }), true);
      expect(html).not.toContain('data-cmd="fleet.hibernate"');
      expect(html).not.toContain('data-cmd="fleet.wake"');
      expect(html).not.toContain('data-cmd="fleet.terminate"');
    },
  );

  it.each<FleetLifecycleState>(["failed", "provisioning"])(
    "%s -> no hibernate/wake button (terminate may still be offered)",
    (state) => {
      const html = renderWorkerRow(worker({ state }), true);
      expect(html).not.toContain('data-cmd="fleet.hibernate"');
      expect(html).not.toContain('data-cmd="fleet.wake"');
    },
  );

  it("stopped -> no hibernate/wake/terminate buttons (nothing left to do)", () => {
    const html = renderWorkerRow(worker({ state: "stopped" }), true);
    expect(html).not.toContain('data-cmd="fleet.hibernate"');
    expect(html).not.toContain('data-cmd="fleet.wake"');
    expect(html).not.toContain('data-cmd="fleet.terminate"');
  });

  it("transient states render an animated badge with the transient modifier class", () => {
    const html = renderWorkerRow(worker({ state: "hibernating" }));
    expect(html).toContain("fleet-badge--hibernating");
    expect(html).toContain("fleet-badge--transient");
  });

  it("non-transient states never carry the transient modifier class", () => {
    for (const state of ALL_STATES.filter((s) => s !== "hibernating" && s !== "waking")) {
      const html = renderWorkerRow(worker({ state }));
      expect(html).not.toContain("fleet-badge--transient");
    }
  });
});

// ---------------------------------------------------------------------------
// data-cmd / data-worker-id attribute counts
// ---------------------------------------------------------------------------

describe("renderFleetView — data-cmd / data-worker-id attribute counts", () => {
  it("global refresh/probe affordances are present exactly once each", () => {
    const html = renderFleetView({ ...initialFleetState(), backends: [backend()], workers: [] });
    expect((html.match(/data-cmd="fleet\.refresh"/g) ?? []).length).toBe(1);
    expect((html.match(/data-cmd="fleet\.probe"/g) ?? []).length).toBe(1);
  });

  it("counts hibernate/wake/terminate data-cmd and data-worker-id attributes exactly across a mixed fleet", () => {
    const backends = [backend({ name: "b1", supportsHibernate: true }), backend({ name: "b2", supportsHibernate: false })];
    const workers = [
      worker({ workerId: "w-running-supported", backend: "b1", state: "running" }), // hibernate + terminate
      worker({ workerId: "w-running-unsupported", backend: "b2", state: "running" }), // terminate only
      worker({ workerId: "w-hibernated", backend: "b1", state: "hibernated" }), // wake + terminate
      worker({ workerId: "w-hibernating", backend: "b1", state: "hibernating" }), // none
      worker({ workerId: "w-waking", backend: "b1", state: "waking" }), // none
      worker({ workerId: "w-failed", backend: "b1", state: "failed" }), // terminate only
      worker({ workerId: "w-stopped", backend: "b1", state: "stopped" }), // none
      worker({ workerId: "w-provisioning", backend: "b1", state: "provisioning" }), // terminate only
    ];
    const state: FleetViewState = { backends, workers, lastSnapshotAt: 1, error: null };
    const html = renderFleetView(state);

    expect((html.match(/data-cmd="fleet\.hibernate"/g) ?? []).length).toBe(1);
    expect((html.match(/data-cmd="fleet\.wake"/g) ?? []).length).toBe(1);
    // Terminate is offered for every non-transient, non-stopped worker:
    // w-running-supported, w-running-unsupported, w-hibernated, w-failed, w-provisioning.
    expect((html.match(/data-cmd="fleet\.terminate"/g) ?? []).length).toBe(5);

    // One data-worker-id on the <tr> per worker, plus one per action button rendered.
    const buttonAttrCount = 1 + 1 + 5; // hibernate + wake + terminate buttons
    const rowAttrCount = workers.length;
    expect((html.match(/data-worker-id="/g) ?? []).length).toBe(rowAttrCount + buttonAttrCount);
  });
});

// ---------------------------------------------------------------------------
// configured / measured labels + null latency marker
// ---------------------------------------------------------------------------

describe("renderBackendTable — honest numbers", () => {
  it("labels cost rows 'configured' and telemetry rows 'measured'", () => {
    const html = renderBackendTable([backend()]);
    expect(html).toContain("fleet-tag--configured");
    expect(html).toContain(">configured<");
    expect(html).toContain("fleet-tag--measured");
    expect(html).toContain(">measured<");
  });

  it("renders a null provisionLatencyEmaMs as an explicit no-data marker, never 0", () => {
    const html = renderBackendTable([
      backend({ telemetry: { provisions: 0, failures: 0, provisionLatencyEmaMs: null, runningMs: 0, hibernatedMs: 0, accruedUsd: 0 } }),
    ]);
    expect(html).toContain("latency EMA —");
    expect(html).not.toMatch(/latency EMA 0(?!\S)/);
  });

  it("renders a real provisionLatencyEmaMs as a formatted duration, not the raw number", () => {
    const html = renderBackendTable([backend({ telemetry: { ...backend().telemetry, provisionLatencyEmaMs: 850 } })]);
    expect(html).toContain("latency EMA 850ms");
  });
});

// ---------------------------------------------------------------------------
// Empty state / error banner branches
// ---------------------------------------------------------------------------

describe("renderBackendTable — empty state", () => {
  it("renders an explicit empty state, never a blank table", () => {
    const html = renderBackendTable([]);
    expect(html).not.toContain("<table");
    expect(html).toContain("fleet-backends--empty");
    expect(html.trim().length).toBeGreaterThan(0);
  });
});

describe("renderFleetView — empty fleet / error banner", () => {
  it("renders one explicit empty state when there are no backends and no workers", () => {
    const html = renderFleetView(initialFleetState());
    expect(html).toContain("fleet-view__empty");
    expect(html).not.toContain("<table");
  });

  it("does not render the empty state once backends or workers are present", () => {
    const html = renderFleetView({ ...initialFleetState(), backends: [backend()] });
    expect(html).not.toContain("fleet-view__empty");
    expect(html).toContain("<table");
  });

  it("renders the error banner when state.error is set, alongside real data", () => {
    const state: FleetViewState = {
      backends: [backend()],
      workers: [worker()],
      lastSnapshotAt: 1,
      error: { message: "hibernate failed: backend offline", workerId: "w-1", at: 2 },
    };
    const html = renderFleetView(state);
    expect(html).toContain("fleet-error");
    expect(html).toContain("hibernate failed: backend offline");
    expect(html).toContain("w-1");
  });

  it("renders no error banner when state.error is null", () => {
    const html = renderFleetView({ ...initialFleetState(), backends: [backend()] });
    expect(html).not.toContain('class="fleet-error"');
  });
});

// ---------------------------------------------------------------------------
// lifecycleBadgeClass <-> fleet-view.css selector coverage
// ---------------------------------------------------------------------------

describe("lifecycleBadgeClass / fleet-view.css coverage", () => {
  it("returns a distinct class per state", () => {
    const classes = ALL_STATES.map(lifecycleBadgeClass);
    expect(new Set(classes).size).toBe(ALL_STATES.length);
    for (const cls of classes) expect(cls.startsWith("fleet-badge--")).toBe(true);
  });

  it("every lifecycleBadgeClass return value has a matching selector in fleet-view.css (TS and CSS cannot drift)", () => {
    const css = readFileSync(CSS_PATH, "utf8");
    // Sanity check the file is real CSS, not empty/garbage.
    expect(css).toContain("{");
    expect(css).toContain("}");

    for (const state of ALL_STATES) {
      const cls = lifecycleBadgeClass(state);
      const selectorRe = new RegExp(`\\.${cls}\\b`);
      expect(css, `expected fleet-view.css to define a selector for .${cls} (state "${state}")`).toMatch(selectorRe);
    }

    // The transient-state animation modifier used by renderWorkerRow must
    // also exist as a real selector, not just be referenced in TS.
    expect(css).toMatch(/\.fleet-badge--transient\b/);
  });
});
