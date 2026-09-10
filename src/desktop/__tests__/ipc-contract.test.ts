import { describe, it, expect } from "vitest";
import {
  encodeCommand,
  decodeCommand,
  encodeEvent,
  decodeEvent,
  isCommand,
  isAppEvent,
  type Command,
  type AppEvent,
  type WorkerView,
  type TaskView,
  type VerificationView,
  type CertificateView,
  type MetricsView,
  type RunView,
} from "../ipc/contract";

const worker: WorkerView = {
  id: "w-1",
  status: "busy",
  capabilities: ["code", "shell"],
  killReason: undefined,
};

const task: TaskView = {
  id: "t-1",
  description: "do the thing",
  status: "dispatched",
  requiredCapabilities: ["code"],
  attempts: 1,
  maxAttempts: 3,
  dependsOn: ["t-0"],
};

const run: RunView = {
  goalId: "g-1",
  objective: "ship the feature",
  status: "running",
};

const report: VerificationView = {
  taskId: "t-1",
  workerId: "w-1",
  verdict: "accept",
  score: 0.92,
  checks: [{ name: "lint", passed: true, detail: "no issues" }],
};

const cert: CertificateView = {
  taskId: "t-1",
  tier: "gold",
  pCorrect: 0.99,
  epsilon: 0.01,
  signature: "sig-abc",
  issuedAt: 1_700_000_000_000,
};

const metrics: MetricsView = {
  goalsCompleted: 2,
  goalsTotal: 5,
  groundingRate: 0.87,
  costUsd: 1.23,
  verifiedTasks: 4,
  rejectedTasks: 1,
};

describe("Command round-trip", () => {
  const commands: Command[] = [
    { kind: "runtime.start", mode: "inline", poolSize: 4 },
    { kind: "runtime.stop" },
    { kind: "goal.dispatch", objective: "ship the feature" },
    { kind: "goal.cancel", goalId: "g-1" },
    { kind: "pool.scale", size: 8 },
    { kind: "worker.kill", workerId: "w-1" },
    { kind: "skills.list" },
    { kind: "skills.save", name: "my-skill", content: "# skill body" },
  ];

  it.each(commands)("round-trips %j", (cmd) => {
    const decoded = decodeCommand(encodeCommand(cmd));
    expect(decoded).toEqual(cmd);
  });

  it("encodes with a trailing newline", () => {
    const line = encodeCommand({ kind: "runtime.stop" });
    expect(line.endsWith("\n")).toBe(true);
    expect(line).toBe('{"kind":"runtime.stop"}\n');
  });
});

describe("AppEvent round-trip", () => {
  const events: AppEvent[] = [
    { kind: "runtime.status", running: true, mode: "process", poolSize: 4 },
    { kind: "worker.upsert", worker },
    { kind: "task.upsert", task },
    { kind: "run.upsert", run },
    { kind: "verification", report },
    { kind: "certificate", cert },
    { kind: "metrics", metrics },
    { kind: "skills.list", skills: [{ name: "s1", description: "does a thing" }] },
    { kind: "log", line: "hello world", at: 1_700_000_000_000 },
  ];

  it.each(events)("round-trips %j", (evt) => {
    const decoded = decodeEvent(encodeEvent(evt));
    expect(decoded).toEqual(evt);
  });
});

describe("decodeCommand error handling", () => {
  it("throws on unknown kind", () => {
    expect(() => decodeCommand(JSON.stringify({ kind: "bogus.kind" }))).toThrow(
      /bad command/,
    );
  });

  it("throws on missing required field", () => {
    expect(() =>
      decodeCommand(JSON.stringify({ kind: "goal.dispatch" })),
    ).toThrow(/bad command/);
  });

  it("throws on non-JSON input", () => {
    expect(() => decodeCommand("not json at all {{{")).toThrow(/bad command/);
  });

  it("throws on empty line", () => {
    expect(() => decodeCommand("")).toThrow(/bad command/);
    expect(() => decodeCommand("   \n")).toThrow(/bad command/);
  });

  it("handles a trailing newline from encodeCommand output", () => {
    const line = encodeCommand({ kind: "pool.scale", size: 3 });
    expect(decodeCommand(line)).toEqual({ kind: "pool.scale", size: 3 });
  });
});

describe("decodeEvent error handling", () => {
  it("throws on unknown kind", () => {
    expect(() => decodeEvent(JSON.stringify({ kind: "bogus.kind" }))).toThrow(
      /bad event/,
    );
  });

  it("throws on missing required field", () => {
    expect(() => decodeEvent(JSON.stringify({ kind: "log" }))).toThrow(/bad event/);
  });

  it("throws on non-JSON input", () => {
    expect(() => decodeEvent("{not valid")).toThrow(/bad event/);
  });

  it("throws on empty line", () => {
    expect(() => decodeEvent("")).toThrow(/bad event/);
  });

  it("handles a trailing newline from encodeEvent output", () => {
    const line = encodeEvent({ kind: "log", line: "hi", at: 5 });
    expect(decodeEvent(line)).toEqual({ kind: "log", line: "hi", at: 5 });
  });
});

describe("isCommand", () => {
  it("returns true for valid commands", () => {
    expect(isCommand({ kind: "worker.kill", workerId: "w-1" })).toBe(true);
    expect(isCommand({ kind: "runtime.start", mode: "docker", poolSize: 2 })).toBe(
      true,
    );
  });

  it("returns false for invalid or unrelated shapes", () => {
    expect(isCommand({ kind: "worker.kill" })).toBe(false);
    expect(isCommand({ kind: "runtime.start", mode: "bad-mode", poolSize: 2 })).toBe(
      false,
    );
    expect(isCommand(null)).toBe(false);
    expect(isCommand("runtime.stop")).toBe(false);
    expect(isCommand({ kind: "log", line: "x", at: 1 })).toBe(false);
  });
});

describe("isAppEvent", () => {
  it("returns true for valid events", () => {
    expect(isAppEvent({ kind: "log", line: "hi", at: 1 })).toBe(true);
    expect(isAppEvent({ kind: "worker.upsert", worker })).toBe(true);
  });

  it("returns false for invalid or unrelated shapes", () => {
    expect(isAppEvent({ kind: "log", line: "hi" })).toBe(false);
    expect(isAppEvent({ kind: "worker.upsert", worker: { id: "w-1" } })).toBe(false);
    expect(isAppEvent(undefined)).toBe(false);
    expect(isAppEvent({ kind: "goal.dispatch", objective: "x" })).toBe(false);
  });
});
