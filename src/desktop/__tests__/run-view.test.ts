import { describe, it, expect } from "vitest";
import { renderRunView, renderTaskDag, renderWorkerGrid, statusColor } from "../ui/run-view";
import { initialState, type AppState } from "../core/app-store";
import type { TaskView, WorkerView } from "../ipc/contract";

function task(overrides: Partial<TaskView>): TaskView {
  return {
    id: "t-0",
    description: "do the thing",
    status: "pending",
    requiredCapabilities: [],
    attempts: 0,
    maxAttempts: 3,
    ...overrides,
  };
}

function worker(overrides: Partial<WorkerView>): WorkerView {
  return {
    id: "w-0",
    status: "idle",
    capabilities: ["code"],
    ...overrides,
  };
}

function state(overrides: Partial<AppState>): AppState {
  return { ...initialState(), ...overrides };
}

describe("renderRunView", () => {
  it("renders the goal composer with a dispatch affordance", () => {
    const html = renderRunView(state({}));
    expect(html).toContain("<textarea");
    expect(html).toContain('data-cmd="goal.dispatch"');
    expect(html).toMatch(/<button[^>]*data-cmd="goal.dispatch"[^>]*>/);
  });

  it("shows a calm empty state when there are no tasks", () => {
    const html = renderRunView(state({ tasks: [] }));
    expect(html).toContain("Dispatch a goal to begin.");
  });

  it("escapes dynamic task text", () => {
    const html = renderRunView(
      state({ tasks: [task({ id: "t-1", description: "<b>inject</b>" })] })
    );
    expect(html).not.toContain("<b>inject</b>");
    expect(html).toContain("&lt;b&gt;inject&lt;/b&gt;");
  });

  it("renders task attempts in the task list", () => {
    const html = renderRunView(
      state({ tasks: [task({ id: "t-1", attempts: 2, maxAttempts: 5 })] })
    );
    expect(html).toContain("2/5 attempts");
  });
});

describe("renderTaskDag", () => {
  it("groups tasks into columns by dependency level", () => {
    const tasks: TaskView[] = [
      task({ id: "a", description: "root task" }),
      task({ id: "b", description: "child task", dependsOn: ["a"] }),
    ];
    const html = renderTaskDag(state({ tasks }));
    const l0Index = html.indexOf(">L0<");
    const l1Index = html.indexOf(">L1<");
    expect(l0Index).toBeGreaterThan(-1);
    expect(l1Index).toBeGreaterThan(-1);
    expect(l0Index).toBeLessThan(l1Index);
    // "a" (level 0) should appear before "b" (level 1) in the markup.
    expect(html.indexOf(">a<")).toBeLessThan(html.indexOf(">b<"));
  });

  it("shows an empty state when there are no tasks", () => {
    const html = renderTaskDag(state({ tasks: [] }));
    expect(html).toContain("Dispatch a goal to begin.");
  });
});

describe("renderWorkerGrid", () => {
  it("renders one card per worker with a status pill", () => {
    const workers: WorkerView[] = [
      worker({ id: "w-1", status: "busy", capabilities: ["code", "shell"] }),
      worker({ id: "w-2", status: "idle", capabilities: [] }),
    ];
    const html = renderWorkerGrid(state({ workers }));
    expect((html.match(/run-worker-card"/g) ?? []).length).toBe(2);
    expect(html).toContain(">w-1<");
    expect(html).toContain(">w-2<");
    expect(html).toContain('class="status-pill" data-status="busy"');
    expect(html).toContain('class="status-pill" data-status="idle"');
    expect(html).toContain(">code<");
    expect(html).toContain(">shell<");
  });
});

describe("statusColor", () => {
  it("maps verified, rejected, and dispatched to distinct semantic tokens", () => {
    const verified = statusColor("verified");
    const rejected = statusColor("rejected");
    const dispatched = statusColor("dispatched");
    expect(verified).toBe("--color-ok");
    expect(rejected).toBe("--color-bad");
    expect(dispatched).toBe("--color-accent");
    expect(new Set([verified, rejected, dispatched]).size).toBe(3);
  });

  it("falls back to a neutral token for unknown statuses", () => {
    expect(statusColor("some-unknown-status")).toBe("--color-ink-tertiary");
  });
});
