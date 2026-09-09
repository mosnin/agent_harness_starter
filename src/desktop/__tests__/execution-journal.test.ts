import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ExecutionJournal } from "../core/execution-journal";
const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });
function setup() { const root = mkdtempSync(join(tmpdir(), "hades-journal-")); roots.push(root); const path = join(root, "journal.sqlite"); return { path, journal: new ExecutionJournal(path) }; }
it("restores bounded review history and usage, never approval capabilities or screenshots", () => {
  const { path, journal } = setup();
  journal.record("p", { kind: "desktop.started", session: "s" });
  journal.record("p", { kind: "desktop.tool", session: "s", tool: "shell", input: "echo hello", status: "running" });
  journal.record("p", { kind: "desktop.approval", session: "s", id: "LIVE-CAPABILITY", input: "echo hello", images: ["data:private"] });
  journal.record("p", { kind: "desktop.usage", session: "s", tokensIn: 123, tokensOut: 45 });
  journal.checkpointStream("p", "s", "Partial progress");
  journal.close();
  const reopened = new ExecutionJournal(path);
  try {
    const restored = reopened.restore("p", "s")!;
    expect(restored).toMatchObject({ stream: "Partial progress", interrupted: true, running: false, usage: { tokensIn: 123, tokensOut: 45 } });
    expect(restored.tools[0].status).toBe("interrupted");
    expect(restored.approval).toBeUndefined();
    expect(JSON.stringify(restored)).not.toContain("LIVE-CAPABILITY");
    expect(JSON.stringify(restored)).not.toContain("data:private");
    expect(reopened.restore("other", "s")).toBeUndefined();
    expect(statSync(path).mode & 0o777).toBe(0o600);
  } finally { reopened.close(); }
});
it("retains successful tools over turns, clears completed streams and redacts known credentials", () => {
  const { journal } = setup();
  try {
    const event = (e: any) => journal.record("p", { session: "s", ...e }, ["private-fixture-value"]);
    event({ kind: "desktop.started" });
    event({ kind: "desktop.tool", status: "done", ok: true, input: "private-fixture-value", output: 'Bearer abc.secret token password="mypassword"' });
    journal.checkpointStream("p", "s", "old text");
    event({ kind: "desktop.done" });
    event({ kind: "desktop.started" });
    event({ kind: "desktop.error", message: "provider failed" });
    event({ kind: "desktop.done" });
    const state = journal.restore("p", "s")!;
    expect(state.tools).toHaveLength(1);
    expect(state.error).toBe("provider failed");
    expect(state.stream).toBe("");
    expect(state.interrupted).toBe(false);
    expect(JSON.stringify(state)).not.toMatch(/private-fixture-value|abc.secret|mypassword/);
  } finally { journal.close(); }
});
// Exercises 1,200 synchronous FULL durability commits, not a latency contract.
it("evicts old excerpts within the global byte bound", () => {
  const { path, journal } = setup();
  try {
    for (let n = 0; n < 1200; n++) journal.record(`profile-${n % 3}`, { kind: "desktop.tool", session: `s${n % 4}`, status: "done", input: "x".repeat(8000), output: "y".repeat(16000) });
    const db = new DatabaseSync(path);
    try {
      expect((db.prepare("SELECT SUM(bytes) AS n FROM events").get() as any).n).toBeLessThanOrEqual(8 * 1024 * 1024);
      expect((db.prepare("SELECT MAX(bytes) AS n FROM events").get() as any).n).toBeLessThan(13000);
      const retained = db.prepare("SELECT COUNT(*) AS count, MIN(id) AS oldest FROM events").get() as {count: number; oldest: number};
      expect(retained.count).toBeGreaterThan(0);
      expect(retained.count).toBeLessThan(1200);
      expect(retained.oldest).toBeGreaterThan(1);
    } finally { db.close(); }
  } finally { journal.close(); }
}, 20000);

it("clears prior-turn usage and preserves measured cached input tokens", () => {
  const { journal } = setup();
  try {
    journal.record("p", { kind: "desktop.started", session: "s" });
    journal.record("p", { kind: "desktop.usage", session: "s", tokensIn: 90, tokensOut: 10, cachedInputTokens: 80, usageComplete: false });
    journal.record("p", { kind: "desktop.done", session: "s" });
    expect(journal.restore("p", "s")?.usage).toMatchObject({ tokensIn: 90, cachedInputTokens: 80, usageComplete: false });
    journal.record("p", { kind: "desktop.started", session: "s" });
    expect(journal.restore("p", "s")?.usage).toBeUndefined();
  } finally { journal.close(); }
});
