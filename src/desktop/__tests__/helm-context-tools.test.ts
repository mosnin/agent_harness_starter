import { afterEach, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HelmContextStore } from "../core/helm-context";
import { helmTools } from "../core/helm-tools";
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })));
function setup() { const path = mkdtempSync(join(tmpdir(), "helm-context-")); roots.push(path); const a = join(path, "a"), b = join(path, "b"); mkdirSync(a); mkdirSync(b); return { path, a, b, store: new HelmContextStore(join(path, "store")) }; }
it("isolates projects and freezes selected nodes with ancestor context and revision", () => {
  const { a, b, store } = setup();
  const parent = store.save(a, { title: "Architecture", body: "Use cents", kind: "decision" });
  const child = store.save(a, { parentId: parent.id, title: "Invoices", body: "Round once", kind: "constraint" });
  const snapshot = store.snapshot(a, [child.id]);
  expect(snapshot.nodes).toHaveLength(2); expect(snapshot.text).toContain("Use cents");
  store.save(a, { ...parent, body: "Use bigint cents", expectedUpdatedAt: parent.updatedAt });
  expect(snapshot.text).not.toContain("bigint"); expect(store.snapshot(a, [child.id]).revision).not.toBe(snapshot.revision);
  expect(store.list(b)).toEqual([]); expect(() => store.snapshot(b, [child.id])).toThrow();
});
it("rejects context cycles and stale updates and keeps children on parent deletion", () => {
  const { a, store } = setup(); const parent = store.save(a, { title: "A", body: "A" });
  const child = store.save(a, { title: "B", body: "B", parentId: parent.id });
  expect(() => store.save(a, { ...parent, parentId: child.id })).toThrow(/contain themselves/);
  store.save(a, { ...parent, body: "new" });
  expect(() => store.save(a, { ...parent, expectedUpdatedAt: parent.updatedAt })).toThrow(/changed/);
  store.delete(a, parent.id); expect(store.list(a)).toMatchObject([{ id: child.id }]); expect(store.list(a)[0].parentId).toBeUndefined();
});
it("never silently truncates a task's selected context", () => {
  const { a, store } = setup(); for (let i = 0; i < 6; i++) store.save(a, { title: String(i), body: "x".repeat(12000) });
  expect(() => store.snapshot(a)).toThrow(/64 KB/); expect(store.snapshot(a, []).nodes).toEqual([]);
});
it("prevents model-supplied execution authority and child redelegation", async () => {
  let starts = 0;
  const scope = { signal: new AbortController().signal, canDelegate: true, agents: async () => [], context: () => ({}), start: async () => { starts++; return {}; }, get: () => { throw new Error("not owned"); }, cancel: () => ({}), diff: async () => ({}) };
  const tools = helmTools(scope), delegate = tools.find(tool => tool.name === "helm_delegate")!;
  for (const field of ["root", "profile", "owner", "executable", "env", "checks"]) {
    const input = JSON.stringify({ agent: "codex", prompt: "Fix code", model: "tool-capable-model", [field]: "escape" });
    expect(delegate.validate!(input)).toMatch(/Unexpected/); expect((await delegate.run(input)).ok).toBe(false);
  }
  expect(starts).toBe(0); expect(helmTools({ ...scope, canDelegate: false }).map(t => t.name)).not.toContain("helm_delegate");
  expect((await tools.find(t => t.name === "helm_status")!.run('{"id":"another-run"}')).ok).toBe(false);
});

it("passes a bounded model choice while rejecting invalid model values", async () => {
  let captured: Record<string, unknown> | undefined;
  const delegate = helmTools({ signal: new AbortController().signal, canDelegate: true, agents: async () => [], context: () => ({}), start: async input => { captured = input; return {}; }, get: () => ({}), cancel: () => ({}), diff: async () => ({}) }).find(t => t.name === "helm_delegate")!;
  for (const model of ["", "   ", "x".repeat(201), "--help", "bad\0model", null, 7, {}]) {
    const input = JSON.stringify({ agent: "opencode", prompt: "Fix code", model });
    expect(delegate.validate!(input)).toMatch(/model/);
    expect((await delegate.run(input)).ok).toBe(false);
  }
  expect(captured).toBeUndefined();
  const input = JSON.stringify({ agent: "opencode", prompt: "Fix code", model: "provider/tool-capable-model" });
  expect(delegate.validate!(input)).toBeUndefined(); expect((await delegate.run(input)).ok).toBe(true);
  expect(captured?.model).toBe("provider/tool-capable-model");
});
