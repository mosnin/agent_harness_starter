// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkGoalsView } from "../ui/work-goals";

const context = { profile: "owner", root: "/project", profiles: [{ id: "owner", name: "Planner" }, { id: "writer", name: "Writer" }] };
let host: HTMLElement;
let view: WorkGoalsView;
let rpc = vi.fn<(method: string, args?: any) => Promise<any>>();
let open = vi.fn<(id: string) => void>();
let goals: any[];
const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
const click = (action: string) => host.querySelector<HTMLButtonElement>(`[data-work="${action}"]`)!.click();
function fill(selector: string, value: string) { const field = host.querySelector<HTMLInputElement>(selector)!; field.value = value; field.dispatchEvent(new Event("input")); }
beforeEach(async () => {
  document.body.innerHTML = "<main></main>"; host = document.querySelector("main")!;
  goals = []; open = vi.fn();
  rpc = vi.fn(async (method: string, args: any) => {
    if (method === "work.list") return structuredClone(goals);
    if (method === "work.get") return structuredClone(goals.find(goal => goal.id === args.id));
    if (method === "work.create") { const goal = { id: "g", ...args, tokens: 0, status: "draft", tasks: args.tasks.map((task: any) => ({ ...task, status: "queued" })) }; goals.push(goal); return structuredClone(goal); }
    return {};
  });
  view = new WorkGoalsView(rpc, id => open(id)); await view.open(context); view.mount(host);
});
describe("native work goal workflows", () => {
  it("saves an explicit two-agent dependent plan and output check without starting it", async () => {
    click("new"); fill('[name="objective"]', "Produce a checked report");
    fill('[name="title"][data-task="task1"]', "Research"); fill('[name="prompt"][data-task="task1"]', "Read the input files");
    click("add");
    fill('[name="title"][data-task="task2"]', "Write report"); fill('[name="prompt"][data-task="task2"]', "Write report.md using the research"); fill('[name="profile"][data-task="task2"]', "writer");
    const dependency = host.querySelector<HTMLInputElement>('[name="dependsOn"]')!; dependency.checked = true; dependency.dispatchEvent(new Event("input")); dependency.dispatchEvent(new Event("change"));
    fill('[name="expected"]', "report.md"); fill('[name="contains"]', "Findings");
    host.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true })); await settle();
    const args = rpc.mock.calls.find(call => call[0] === "work.create")![1];
    expect(args).toMatchObject({ profile: "owner", root: "/project", objective: "Produce a checked report", maxTokens: 300000, maxMinutes: 60, acceptance: [{ path: "report.md", contains: "Findings" }] });
    expect(args.tasks[1]).toMatchObject({ profile: "writer", dependsOn: ["task1"] });
    expect(rpc.mock.calls.some(call => call[0] === "work.run")).toBe(false);
    expect(host.textContent).toContain("Run work"); expect(host.textContent).toContain("After Research");
  });
  it("keeps draft inputs and focus through an incoming goal refresh", async () => {
    click("new"); fill('[name="objective"]', "My draft");
    const input = host.querySelector<HTMLTextAreaElement>('[name="objective"]')!; input.focus(); input.setSelectionRange(2, 5);
    await view.refresh();
    const restored = host.querySelector<HTMLTextAreaElement>('[name="objective"]')!;
    expect(restored.value).toBe("My draft"); expect(document.activeElement).toBe(restored); expect(restored.selectionStart).toBe(2);
  });
  it("opens the actual task conversation and queues steering without implying immediate control", async () => {
    goals = [{ id: "g", objective: "Report", status: "running", maxTokens: 10000, maxMinutes: 5, tasks: [{ id: "t", title: "Write", profile: "writer", status: "running", session: "session-t", dependsOn: [] }] }];
    await view.refresh(); click("open"); await settle(); click("session"); expect(open).toHaveBeenCalledWith("session-t");
    fill('[data-steering="t"]', "Include sources"); click("message"); await settle();
    expect(rpc).toHaveBeenCalledWith("work.message", { id: "g", task: "t", input: "Include sources", profile: "owner" });
    expect(host.textContent).toContain("next task turn");
    click("stop"); await settle(); expect(rpc).toHaveBeenCalledWith("work.stop", { id: "g", profile: "owner" });
  });
  it("clears selected goal and steering when switching profiles", async () => {
    goals = [{ id: "g", objective: "Private report", status: "draft", maxTokens: 10000, maxMinutes: 5, tasks: [] }];
    await view.refresh(); click("open"); await settle();
    goals = []; await view.open({ ...context, profile: "writer" });
    expect(host.textContent).not.toContain("Private report");
    expect(rpc.mock.calls.at(-1)).toEqual(["work.list", { profile: "writer" }]);
  });
  it("resumes a budget-limited goal with the explicitly edited total limits", async () => {
    goals = [{ id: "g", objective: "Report", status: "budget_exhausted", tokens: 10000, elapsedMs: 300000, maxTokens: 10000, maxMinutes: 5, tasks: [] }];
    await view.refresh(); click("open"); await settle();
    fill('[name="resumeTokens"]', "25000"); fill('[name="resumeMinutes"]', "20");
    click("resume"); await settle();
    expect(rpc).toHaveBeenCalledWith("work.resume", { id: "g", profile: "owner", maxTokens: 25000, maxMinutes: 20 });
  });
  it("saves every output check, preserves per-check drafts, and does not transfer removed text", async () => {
    click("new"); fill('[name="objective"]', "Deliver two files");
    fill('[name="title"][data-task="task1"]', "Write files"); fill('[name="prompt"][data-task="task1"]', "Write both requested files");
    fill('[name="expected"][data-check="check1"]', "first.md"); fill('[name="contains"][data-check="check1"]', "First result");
    click("check-add"); fill('[name="expected"][data-check="check2"]', "remove.md"); fill('[name="contains"][data-check="check2"]', "Remove this text");
    click("check-add"); fill('[name="expected"][data-check="check3"]', "second.md"); fill('[name="contains"][data-check="check3"]', "Second result");
    host.querySelector<HTMLButtonElement>('[data-work="check-remove"][data-check="check2"]')!.click();
    const input = host.querySelector<HTMLInputElement>('[name="contains"][data-check="check3"]')!; input.focus(); input.setSelectionRange(1, 4);
    await view.refresh();
    const restored = host.querySelector<HTMLInputElement>('[name="contains"][data-check="check3"]')!;
    expect(document.activeElement).toBe(restored); expect(restored.selectionStart).toBe(1); expect(restored.value).toBe("Second result");
    expect(host.querySelector('[data-check="check2"]')).toBeNull();
    host.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true })); await settle();
    const args = rpc.mock.calls.find(call => call[0] === "work.create")![1];
    expect(args.acceptance).toEqual([{ path: "first.md", contains: "First result" }, { path: "second.md", contains: "Second result" }]);
    expect(host.textContent).toContain("Output checks"); expect(host.textContent).toContain("Must contain: Second result");
    expect(host.querySelector('[name="expected"]')).toBeNull();
  });
  it("caps output checks at32 and rejects required text without a file", async () => {
    click("new"); for (let i = 1; i < 33; i++) click("check-add");
    expect(host.querySelectorAll('[name="expected"]')).toHaveLength(32);
    expect(host.querySelector<HTMLButtonElement>('[data-work="check-add"]')!.disabled).toBe(true);
    fill('[name="contains"][data-check="check1"]', "Cannot verify without a path");
    host.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true })); await settle();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Choose an output file");
    expect(rpc.mock.calls.some(call => call[0] === "work.create")).toBe(false);
  });
  it("shows current approval attention and identifies recorded file contents without editable checks", async () => {
    goals = [{ id: "g", objective: "Report", status: "running", maxTokens: 10000, maxMinutes: 5,
      acceptance: [{ path: "first.md", contains: "First" }, { path: "second.md" }], evidence: [{ path: "first.md", bytes: 5, sha256: "a".repeat(64) }],
      tasks: [{ id: "t", title: "Write", profile: "writer", status: "running", session: "session-t", dependsOn: [], pendingApproval: true }] }];
    await view.refresh(); click("open"); await settle();
    expect(host.textContent).toContain("Waiting for approval"); expect(host.textContent).toContain("Review approval");
    expect(host.textContent).toContain("SHA-256 " + "a".repeat(64)); expect(host.querySelector('[name="expected"]')).toBeNull();
    click("session"); expect(open).toHaveBeenCalledWith("session-t");
    goals[0].tasks[0].pendingApproval = false; await view.refresh();
    expect(host.textContent).not.toContain("Waiting for approval");
  });
});

it("shows pending steering and distinguishes unknown from interrupted without implying success", async () => {
  goals = [{ id: "g", objective: "Inspect recovery", status: "needs_review", maxTokens: 10000, maxMinutes: 5, tasks: [
    { id: "unknown", title: "Unknown operation", profile: "writer", status: "unknown", messages: [{ id: "m", input: "Inspect output first", at: 1 }] },
    { id: "interrupted", title: "Interrupted operation", profile: "writer", status: "interrupted" },
  ] }];
  await view.refresh(); click("open"); await settle();
  expect(host.textContent).toContain("Outcome unknown");
  expect(host.textContent).toContain("Interrupted");
  expect(host.textContent).toContain("1 pending instruction");
  expect(host.textContent).toContain("Inspect output first");
  expect(host.querySelector('[aria-label="Work team summary"]')?.textContent).toContain("Needs attention2");
  expect(host.textContent).toContain("The last action may have happened");
});

it("hides advanced budget controls initially and clears old project drafts", async () => {
  click("new"); fill('[name="objective"]', "Old project instructions");
  const budget = host.querySelector('[name="maxTokens"]')!.closest("details")!;
  expect(budget.open).toBe(false);
  await view.open({ ...context, root: "/other-project" }); click("new");
  expect(host.querySelector<HTMLTextAreaElement>('[name="objective"]')!.value).toBe("");
  expect(host.textContent).not.toContain("Old project instructions");
});

it("ignores a late goal selection after switching profile", async () => {
  goals = [{ id: "g", objective: "Private goal", status: "draft", tasks: [] }];
  await view.refresh();
  let finish!: (value: any) => void;
  rpc.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  click("open");
  goals = []; await view.open({ ...context, profile: "writer" });
  finish({ id: "g", objective: "Private goal", status: "draft", tasks: [] }); await settle();
  expect(host.textContent).not.toContain("Private goal");
});

it("preserves new steering typed while the previous instruction is saving", async () => {
  goals = [{ id: "g", objective: "Report", status: "running", maxTokens: 10000, maxMinutes: 5, tasks: [{ id: "t", title: "Write", profile: "writer", status: "running" }] }];
  await view.refresh(); click("open"); await settle();
  fill('[data-steering="t"]', "First instruction");
  let finish!: (value: any) => void;
  rpc.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  click("message"); fill('[data-steering="t"]', "New instruction draft");
  finish({}); await settle();
  expect(host.querySelector<HTMLTextAreaElement>('[data-steering="t"]')!.value).toBe("New instruction draft");
});

it("saves team concurrency, declared edit paths, and per-task checks without changing tool authority", async () => {
  click("new"); fill('[name="objective"]', "Checked team delivery");
  fill('[name="title"][data-task="task1"]', "Write summary"); fill('[name="prompt"][data-task="task1"]', "Write and check summary");
  fill('[name="maxConcurrent"]', "4"); fill('[name="writeMode"]', "declared"); fill('[name="writes"]', "reports\nsrc/summary.ts\n");
  click("task-check-add"); fill('[name="taskExpected"]', "reports/summary.md"); fill('[name="taskContains"]', "Sources");
  host.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true })); await settle();
  const args = rpc.mock.calls.find(call => call[0] === "work.create")![1];
  expect(args.maxConcurrent).toBe(4);
  expect(args.tasks[0]).toMatchObject({ writes: ["reports", "src/summary.ts"], acceptance: [{ path: "reports/summary.md", contains: "Sources" }] });
  expect(args.tasks[0]).not.toHaveProperty("writeMode");
  expect(host.textContent).toContain("Tool permissions still apply");
  expect(host.textContent).toContain("4 at once");
});

it("keeps entire-project default distinct from explicitly declaring no edits", async () => {
  click("new"); fill('[name="objective"]', "Inspect project");
  fill('[name="title"]', "Inspect"); fill('[name="prompt"]', "Inspect files");
  click("add"); fill('[name="title"][data-task="task2"]', "Review"); fill('[name="prompt"][data-task="task2"]', "Review results"); fill('[name="writeMode"][data-task="task2"]', "declared");
  host.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true })); await settle();
  const args = rpc.mock.calls.find(call => call[0] === "work.create")![1];
  expect(args.tasks[0]).not.toHaveProperty("writes"); expect(args.tasks[1].writes).toEqual([]);
  expect(host.textContent).toContain("Entire project reserved"); expect(host.textContent).toContain("No edits declared");
  expect(host.textContent).not.toContain("Read-only");
});

it("shows attempt usage uncertainty, checked output hashes, and opens the exact attempt session", async () => {
  goals = [{ id: "g", objective: "Checked output", status: "needs_review", maxTokens: 10000, maxMinutes: 5, maxConcurrent: 3, tasks: [{ id: "t", title: "Writer", profile: "writer", status: "interrupted", writes: ["reports"], acceptance: [{ path: "reports/result.md" }], evidence: [{ path: "reports/result.md", bytes: 10, sha256: "c".repeat(64) }], attempts: [{ id: "a", number: 1, status: "interrupted", startedAt: 1, session: "attempt-session", reservedTokens: 1200 }] }] }];
  await view.refresh(); click("open"); await settle();
  expect(host.textContent).toContain("Usage unknown"); expect(host.textContent).toContain("1,200 reserved tokens");
  expect(host.textContent).toContain("SHA-256 " + "c".repeat(64));
  click("session"); expect(open).toHaveBeenCalledWith("attempt-session");
});

it("does not duplicate a pending steering dispatch", async () => {
  goals = [{ id: "g", objective: "Report", status: "running", maxTokens: 10000, maxMinutes: 5, tasks: [{ id: "t", title: "Write", profile: "writer", status: "running" }] }];
  await view.refresh(); click("open"); await settle(); fill('[data-steering="t"]', "One instruction");
  let finish!: (value: any) => void;
  rpc.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  click("message"); click("message");
  expect(rpc.mock.calls.filter(call => call[0] === "work.message")).toHaveLength(1);
  finish({}); await settle();
});

it("ignores a late create failure after switching project", async () => {
  click("new"); fill('[name="objective"]', "Old project");
  let reject!: (reason: Error) => void;
  rpc.mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
  host.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
  await view.open({ ...context, root: "/new-project" });
  reject(new Error("Old private error")); await settle();
  expect(host.textContent).not.toContain("Old private error");
  click("new"); expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(false);
});

it("saves explicit Orca selection without starting a provider and discloses review limits", async () => {
  click("new"); fill('[name="objective"]', "Build a fixture");
  fill('[name="title"][data-task="task1"]', "Build"); fill('[name="prompt"][data-task="task1"]', "Build output");
  expect((host.querySelector('[name="engineChoice"]') as HTMLSelectElement).value).toBe("hades");
  fill('[name="engineChoice"]', "codex");
  expect(host.textContent).toContain("Provider token usage is unmeasured");
  host.querySelector("form")!.dispatchEvent(new Event("submit", {cancelable:true})); await settle();
  expect(rpc.mock.calls.find(c=>c[0]==="work.create")![1].tasks[0].engine).toEqual({kind:"orca",agent:"codex"});
  expect(rpc.mock.calls.some(c=>c[0]==="work.run"||c[0]==="helm.orca.start")).toBe(false);
});
