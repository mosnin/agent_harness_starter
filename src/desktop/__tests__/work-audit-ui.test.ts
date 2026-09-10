// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WorkAuditView, type AuditScope } from "../ui/work-audit";
import { WorkGoalsView } from "../ui/work-goals";
const s: AuditScope = { goalId: "g", profile: "p", root: "/project" };
const hash = (n: number) => n.toString(16).padStart(64, "0");
const point = (n: number) => ({ sequence: n, hash: hash(n) }),
  head = (n: number) => ({ ...point(n), scope: s });
const event = (n: number) => ({
  version: 1,
  scope: s,
  sequence: n,
  kind: "work.updated",
  at: 1700000000000,
  revision: n,
  taskId: "task-1",
  attemptId: "attempt-1",
  actor: { kind: "system", id: "runtime" },
  metadata: { status: "running" },
  hash: hash(n),
  previousHash: hash(n - 1),
  beforeHash: n === 1 ? null : hash(n + 1000),
  afterHash: hash(n + 1001),
});
const page = (from: number, to: number, total: number) => ({
  schema: "hades.work-audit.v1",
  scope: s,
  predecessor: point(from),
  events: Array.from({ length: to - from }, (_, i) => event(from + i + 1)),
  end: point(to),
  head: point(total),
  hasMore: to < total,
});
const bundle = (n = 1) => ({
  schema: "hades.work-audit-bundle.v1",
  scope: s,
  head: head(n),
  pages: [page(0, n, n)],
});
const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
let host: HTMLElement, view: WorkAuditView, total: number;
let rpc =
  vi.fn<(method: string, args: Record<string, unknown>) => Promise<unknown>>();
let download = vi.fn<(name: string, content: string) => void>();
const click = (name: string) =>
  [...host.querySelectorAll<HTMLButtonElement>("button")]
    .find((b) => b.textContent === name)!
    .click();
function expand() {
  view.element.open = true;
  view.element.dispatchEvent(new Event("toggle"));
}
beforeEach(() => {
  document.body.innerHTML = "<main></main>";
  host = document.querySelector("main")!;
  total = 1;
  download = vi.fn();
  rpc = vi.fn(async (method: string, args: Record<string, unknown>) =>
    method === "work.audit.head"
      ? head(total)
      : method === "work.audit.export"
        ? bundle(total)
        : page(
            Number(args.afterSequence),
            Math.min(
              Number(args.afterSequence) + 100,
              (args.expectedHead as { sequence: number }).sequence,
            ),
            (args.expectedHead as { sequence: number }).sequence,
          ),
  );
  view = new WorkAuditView(rpc, s, download);
  view.mount(host);
});
afterEach(() => view.dispose());
it("loads only when opened, renders operational references and keeps hash detail quiet", async () => {
  expect(rpc).not.toHaveBeenCalled();
  expand();
  await settle();
  expect(rpc.mock.calls.map((c) => c[0])).toEqual([
    "work.audit.head",
    "work.audit.read",
  ]);
  expect(host.textContent).toContain("Work updated");
  expect(host.textContent).toContain("Task task-1");
  expect(host.textContent).toContain("Attempt attempt-1");
  expect(host.querySelector("time")?.getAttribute("datetime")).toBe(
    "2023-11-14T22:13:20.000Z",
  );
  expect(
    host.querySelector<HTMLDetailsElement>(".work-audit-event-details")!.open,
  ).toBe(false);
  expect(
    host.querySelector<HTMLDetailsElement>(".work-audit-advanced")!.open,
  ).toBe(false);
  view.element.open = false;
  view.element.open = true;
  view.element.dispatchEvent(new Event("toggle"));
  await settle();
  expect(rpc).toHaveBeenCalledTimes(2);
});
it("loads 100-event pages against a frozen head; Refresh gets new activity", async () => {
  total = 101;
  expand();
  await settle();
  expect(host.querySelectorAll("li")).toHaveLength(100);
  total = 102;
  click("Load more");
  await settle();
  expect(host.querySelectorAll("li")).toHaveLength(101);
  expect(host.textContent).toContain("101 of 101");
  expect(rpc.mock.calls.at(-1)?.[1]).toMatchObject({
    afterSequence: 100,
    expectedHead: head(101),
  });
  click("Refresh");
  await settle();
  expect(host.textContent).toContain("100 of 102");
});
it("preserves same DOM, disclosure, focus and loaded pages across shell rerender", async () => {
  expand();
  await settle();
  const detail = host.querySelector<HTMLDetailsElement>(
    ".work-audit-event-details",
  )!;
  detail.open = true;
  const summary = detail.querySelector("summary")!;
  summary.focus();
  view.captureViewState();
  host.replaceChildren();
  view.mount(host);
  await settle();
  expect(view.element.open).toBe(true);
  expect(host.querySelector(".work-audit-event-details")).toBe(detail);
  expect(detail.open).toBe(true);
  expect(document.activeElement).toBe(summary);
  expect(rpc).toHaveBeenCalledTimes(2);
});
it("does not restore stale response or download after a profile switch/disposal", async () => {
  let finish!: (v: unknown) => void;
  rpc.mockImplementationOnce(
    () => new Promise((resolve) => (finish = resolve)),
  );
  expand();
  view.dispose();
  finish(head(1));
  await settle();
  expect(rpc).toHaveBeenCalledTimes(1);
  expect(host.textContent).toBe("");
  view = new WorkAuditView(rpc, s, download);
  view.mount(host);
  rpc.mockImplementationOnce(
    () => new Promise((resolve) => (finish = resolve)),
  );
  click("Export history");
  view.dispose();
  finish(bundle());
  await settle();
  expect(download).not.toHaveBeenCalled();
});
it("invalidates a pending export when its parent is unmounted", async () => {
  let finish!: (v: unknown) => void;
  rpc.mockImplementationOnce(
    () => new Promise((resolve) => (finish = resolve)),
  );
  click("Export history");
  host.remove();
  await settle();
  finish(bundle());
  await settle();
  expect(download).not.toHaveBeenCalled();
  expect(view.disposed).toBe(true);
});
it("uses captured scope for export and rejects mismatched event scopes", async () => {
  click("Export history");
  await settle();
  expect(rpc.mock.calls[0]).toEqual([
    "work.audit.export",
    { id: "g", profile: "p" },
  ]);
  expect(download).toHaveBeenCalledWith(
    "work-history-g.json",
    expect.stringContaining('"hades.work-audit-bundle.v1"'),
  );
  download.mockClear();
  const wrong = bundle();
  wrong.pages[0].events[0].scope = { ...s, profile: "other" };
  rpc.mockResolvedValueOnce(wrong);
  click("Export history");
  await settle();
  expect(download).not.toHaveBeenCalled();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    "different goal or profile",
  );
});
it("renders returned strings as text instead of markup", async () => {
  const response = page(0, 1, 1);
  response.events[0].kind = '<img src=x onerror="alert(1)">';
  rpc.mockImplementation(async (method: string) =>
    method === "work.audit.head" ? head(1) : response,
  );
  expand();
  await settle();
  expect(host.querySelector("img")).toBeNull();
  expect(host.textContent).toContain("<img");
});
it("explains empty legacy history without inventing events", async () => {
  total = 0;
  expand();
  await settle();
  expect(host.querySelectorAll("li")).toHaveLength(0);
  expect(host.textContent).toContain("next recorded change");
  expect(host.textContent).toContain(
    "Earlier activity has not been reconstructed",
  );
});
it("keeps prior page after pagination error and enables explicit retry", async () => {
  total = 101;
  expand();
  await settle();
  rpc.mockRejectedValueOnce(new Error("History is temporarily unavailable"));
  click("Load more");
  await settle();
  expect(host.querySelectorAll("li")).toHaveLength(100);
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    "temporarily unavailable",
  );
  click("Load more");
  await settle();
  expect(host.querySelectorAll("li")).toHaveLength(101);
});
it("rejects malformed sequence, frozen head and oversized responses without showing events", async () => {
  const response = page(0, 1, 1);
  response.events[0].sequence = 2;
  rpc.mockImplementation(async (method: string) =>
    method === "work.audit.head" ? head(1) : response,
  );
  expand();
  await settle();
  expect(host.querySelectorAll("li")).toHaveLength(0);
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    "incomplete",
  );
});

it("keeps activity subtree and focus through the real WorkGoals refresh integration", async () => {
  view.dispose();
  const goal = {
    id: "g",
    profile: "p",
    root: "/project",
    objective: "Checked delivery",
    status: "draft",
    tokens: 0,
    maxTokens: 10000,
    maxMinutes: 5,
    tasks: [],
  };
  const api = vi.fn(
    async (method: string, args?: Record<string, unknown>): Promise<unknown> =>
      method === "work.list"
        ? [goal]
        : method === "work.get"
          ? goal
          : rpc(method, args ?? {}),
  );
  const goalsView = new WorkGoalsView(api, () => {});
  await goalsView.open({
    profile: "p",
    root: "/project",
    profiles: [{ id: "p", name: "Planner" }],
  });
  goalsView.mount(host);
  host.querySelector<HTMLButtonElement>('[data-work="open"]')!.click();
  await settle();
  const history = host.querySelector<HTMLDetailsElement>(".work-audit")!;
  history.open = true;
  history.dispatchEvent(new Event("toggle"));
  await settle();
  const detail = history.querySelector<HTMLDetailsElement>(
    ".work-audit-event-details",
  )!;
  detail.open = true;
  const summary = detail.querySelector("summary")!;
  summary.focus();
  await goalsView.refresh();
  await settle();
  expect(host.querySelector(".work-audit")).toBe(history);
  expect(detail.open).toBe(true);
  expect(document.activeElement).toBe(summary);
  expect(rpc).toHaveBeenCalledTimes(2);
  const range = document.createRange();
  range.selectNodeContents(history.querySelector("strong")!);
  document.getSelection()!.removeAllRanges();
  document.getSelection()!.addRange(range);
  const selected = document.getSelection()!.toString();
  await goalsView.refresh();
  expect(document.getSelection()!.toString()).toBe(selected);
  await goalsView.open({ profile: "other", root: "/project", profiles: [] });
  await settle();
  expect(history.isConnected).toBe(false);
});
