/* ------------------------------------------------------------------ *
 * backends-learn-command.test.ts
 *
 * REAL-VS-MOCK POLICY: exercises `runBackendsLearnCommand` against a REAL
 * `FileLearningStatusStore` (`../../backends/learning-status-store`) over an
 * injected in-memory fs, and against the REAL `renderLearningReport`
 * (`../../backends/swarm-learning`) -- report text is asserted against the
 * genuine function's output, never re-derived or hand-written. `deps.loop`
 * is a minimal structural fake exposing only the `.status()` method the
 * locked contract actually calls, since constructing a real
 * `SwarmLearningLoop.attach()` requires a full `BackendManager` + swarm +
 * outcome feed wiring out of scope for this command's own tests (that
 * integration is covered by `swarm-learning.test.ts`).
 * ------------------------------------------------------------------ */
import { describe, it, expect } from "vitest";
import { runBackendsLearnCommand, type BackendsLearnCommandDeps } from "../backends-learn-command";
import { FileLearningStatusStore, type LearningStatusFs, LEARNING_STATUS_VERSION, type PersistedLearningStatus } from "../../backends/learning-status-store";
import { renderLearningReport, type SwarmLearningLoop, type SwarmLearningStatus } from "../../backends/swarm-learning";
import type { BanditArm } from "../../backends/route-bandit";

// ===========================================================================
// Fixtures
// ===========================================================================

function makeArm(overrides: Partial<BanditArm> = {}): BanditArm {
  return {
    pulls: 5,
    verified: 4,
    totalElapsedMs: 30000,
    totalUsd: 1.5,
    meanReward: 0.8,
    ucb: 2.1,
    ...overrides,
  };
}

function makeStatus(overrides: Partial<SwarmLearningStatus> = {}): SwarmLearningStatus {
  return {
    attached: true,
    counts: { recorded: 5, skipped: 2, duplicate: 1 },
    arms: {
      docker: makeArm(),
      modal: makeArm({ pulls: 0, verified: 0, totalElapsedMs: 0, totalUsd: 0, meanReward: 0, ucb: null }),
    },
    recent: [
      { type: "recorded", at: 10, taskId: "t1", backend: "docker", detail: { elapsedMsNote: "measured directly" } },
    ],
    ...overrides,
  };
}

/** Minimal structural fake -- only `.status()` is called by this command. */
function makeLoop(status: SwarmLearningStatus): SwarmLearningLoop {
  return { status: () => status } as unknown as SwarmLearningLoop;
}

class MemoryFs implements LearningStatusFs {
  files = new Map<string, string>();
  async mkdir(): Promise<unknown> {
    return undefined;
  }
  async writeFile(path: string, data: string): Promise<void> {
    this.files.set(path, data);
  }
  async rename(from: string, to: string): Promise<void> {
    const data = this.files.get(from);
    if (data === undefined) throw new Error(`ENOENT ${from}`);
    this.files.set(to, data);
    this.files.delete(from);
  }
  async readFile(path: string): Promise<string> {
    const data = this.files.get(path);
    if (data === undefined) throw new Error(`ENOENT ${path}`);
    return data;
  }
}

function makeStore(fs = new MemoryFs(), now?: () => number): FileLearningStatusStore {
  return new FileLearningStatusStore({ path: "/state/learning.json", fs, now });
}

const NOTHING_RECORDED_LINE = "No learning status recorded yet — run a swarm with the learning loop attached.";

// ===========================================================================
// show
// ===========================================================================

describe("runBackendsLearnCommand show", () => {
  it("is the default subcommand (empty args)", async () => {
    const status = makeStatus();
    const deps: BackendsLearnCommandDeps = { store: makeStore(), loop: makeLoop(status) };
    const result = await runBackendsLearnCommand([], deps);
    expect(result.code).toBe(0);
    expect(result.lines[0]).toBe("source: live");
  });

  it("renders the REAL renderLearningReport verbatim after the live header", async () => {
    const status = makeStatus();
    const deps: BackendsLearnCommandDeps = { store: makeStore(), loop: makeLoop(status) };
    const result = await runBackendsLearnCommand(["show"], deps);
    const expectedReport = renderLearningReport(status);
    expect(result.lines).toEqual(["source: live", ...expectedReport]);
  });

  it("a never-pulled arm renders 'never pulled' via the real report", async () => {
    const status = makeStatus();
    const deps: BackendsLearnCommandDeps = { store: makeStore(), loop: makeLoop(status) };
    const result = await runBackendsLearnCommand(["show"], deps);
    expect(result.lines.some((l) => l.includes("modal: never pulled"))).toBe(true);
  });

  it("prefers the live loop over any on-disk snapshot", async () => {
    const fs = new MemoryFs();
    const store = makeStore(fs);
    await store.save(makeStatus({ counts: { recorded: 999, skipped: 0, duplicate: 0 } }));

    const liveStatus = makeStatus({ counts: { recorded: 1, skipped: 0, duplicate: 0 } });
    const deps: BackendsLearnCommandDeps = { store, loop: makeLoop(liveStatus) };
    const result = await runBackendsLearnCommand(["show"], deps);
    expect(result.lines[0]).toBe("source: live");
    expect(result.lines.join("\n")).toContain("recorded=1");
    expect(result.lines.join("\n")).not.toContain("recorded=999");
  });

  it("falls back to the persisted snapshot when no live loop is present, with a verbatim source header including age", async () => {
    const fs = new MemoryFs();
    const savedAt = 1_000_000;
    const store = makeStore(fs, () => savedAt);
    const status = makeStatus();
    await store.save(status);

    const nowMs = savedAt + 65_000; // 65s later -> "1m"
    const deps: BackendsLearnCommandDeps = { store: makeStore(fs), now: () => nowMs };
    const result = await runBackendsLearnCommand(["show"], deps);

    expect(result.code).toBe(0);
    const expectedIso = new Date(savedAt).toISOString();
    expect(result.lines[0]).toBe(`source: snapshot (saved ${expectedIso}, 1m ago)`);
    expect(result.lines.slice(1)).toEqual(renderLearningReport(status));
  });

  it("computes snapshot age from the injected clock, not the real wall clock", async () => {
    const fs = new MemoryFs();
    const savedAt = 0;
    const store = makeStore(fs, () => savedAt);
    await store.save(makeStatus());

    const deps: BackendsLearnCommandDeps = { store: makeStore(fs), now: () => 3 * 3600 * 1000 }; // 3h later
    const result = await runBackendsLearnCommand(["show"], deps);
    expect(result.lines[0]).toContain("3h ago");
  });

  it("exits 0 with the exact honest line when nothing has ever been recorded", async () => {
    const deps: BackendsLearnCommandDeps = { store: makeStore() };
    const result = await runBackendsLearnCommand(["show"], deps);
    expect(result).toEqual({ code: 0, lines: [NOTHING_RECORDED_LINE] });
  });

  it("exits 0 with the honest line when the on-disk snapshot fails validation", async () => {
    const fs = new MemoryFs();
    fs.files.set("/state/learning.json", JSON.stringify({ version: 999, at: 1, status: makeStatus() }));
    const deps: BackendsLearnCommandDeps = { store: makeStore(fs) };
    const result = await runBackendsLearnCommand(["show"], deps);
    expect(result).toEqual({ code: 0, lines: [NOTHING_RECORDED_LINE] });
  });

  it("sanitizes raw control bytes (ESC, CR/LF) injected via arm names, matching backends-command.ts's control-character-only convention", async () => {
    const status = makeStatus({
      arms: {
        "\x1b[31mevil\x1b[0m\r\ninjected": makeArm(),
      },
    });
    const deps: BackendsLearnCommandDeps = { store: makeStore(), loop: makeLoop(status) };
    const result = await runBackendsLearnCommand(["show"], deps);
    // No raw control byte (0x00-0x1F, 0x7F) survives anywhere in the
    // output -- this is a control-character strip, not a full ANSI-sequence
    // stripper (same convention as backends-command.ts's `sanitize`), so
    // printable remnants of an escape sequence (e.g. "[31m") legitimately
    // remain; only the actual control bytes must be gone.
    for (const line of result.lines) {
      // eslint-disable-next-line no-control-regex
      expect(line).not.toMatch(/[\x00-\x1F\x7F]/);
    }
    const joined = result.lines.join("\n");
    expect(joined).toContain("evil");
    expect(joined).toContain("injected");
  });

  it("sanitizes control characters injected via a recent event's usdNote/elapsedMsNote", async () => {
    const status = makeStatus({
      recent: [
        {
          type: "recorded",
          at: 1,
          taskId: "t\x07x",
          backend: "docker",
          detail: { usdNote: "free\x1b[31m\r\nlunch", elapsedMsNote: "measured\x00directly" },
        },
      ],
    });
    const deps: BackendsLearnCommandDeps = { store: makeStore(), loop: makeLoop(status) };
    const result = await runBackendsLearnCommand(["show"], deps);
    for (const line of result.lines) {
      // eslint-disable-next-line no-control-regex
      expect(line).not.toMatch(/[\x00-\x1F\x7F]/);
    }
    const joined = result.lines.join("\n");
    expect(joined).toContain("free");
    expect(joined).toContain("lunch");
    expect(joined).toContain("measured");
    expect(joined).toContain("directly");
  });
});

// ===========================================================================
// json
// ===========================================================================

describe("runBackendsLearnCommand json", () => {
  it("prints a parseable envelope labelled source:'live' for a live loop", async () => {
    const status = makeStatus();
    const nowMs = 555;
    const deps: BackendsLearnCommandDeps = { store: makeStore(), loop: makeLoop(status), now: () => nowMs };
    const result = await runBackendsLearnCommand(["json"], deps);
    expect(result.code).toBe(0);
    expect(result.lines).toHaveLength(1);
    const parsed = JSON.parse(result.lines[0]);
    expect(parsed).toEqual({ version: LEARNING_STATUS_VERSION, at: nowMs, status, source: "live" });
  });

  it("prints a parseable envelope labelled source:'snapshot' for a persisted snapshot", async () => {
    const fs = new MemoryFs();
    const savedAt = 777;
    const store = makeStore(fs, () => savedAt);
    const status = makeStatus();
    await store.save(status);

    const deps: BackendsLearnCommandDeps = { store: makeStore(fs) };
    const result = await runBackendsLearnCommand(["json"], deps);
    const parsed = JSON.parse(result.lines[0]) as PersistedLearningStatus & { source: string };
    expect(parsed.source).toBe("snapshot");
    expect(parsed.version).toBe(LEARNING_STATUS_VERSION);
    expect(parsed.at).toBe(savedAt);
    expect(parsed.status).toEqual(status);
  });

  it("prefers the live loop's json over the on-disk snapshot", async () => {
    const fs = new MemoryFs();
    const store = makeStore(fs);
    await store.save(makeStatus({ counts: { recorded: 42, skipped: 0, duplicate: 0 } }));

    const liveStatus = makeStatus({ counts: { recorded: 7, skipped: 0, duplicate: 0 } });
    const deps: BackendsLearnCommandDeps = { store, loop: makeLoop(liveStatus) };
    const result = await runBackendsLearnCommand(["json"], deps);
    const parsed = JSON.parse(result.lines[0]);
    expect(parsed.source).toBe("live");
    expect(parsed.status.counts.recorded).toBe(7);
  });

  it("reports the honest empty line when nothing recorded and no live loop", async () => {
    const deps: BackendsLearnCommandDeps = { store: makeStore() };
    const result = await runBackendsLearnCommand(["json"], deps);
    expect(result).toEqual({ code: 0, lines: [NOTHING_RECORDED_LINE] });
  });
});

// ===========================================================================
// help / unknown
// ===========================================================================

describe("runBackendsLearnCommand help/unknown", () => {
  it("help exits 0 with usage lines", async () => {
    const deps: BackendsLearnCommandDeps = { store: makeStore() };
    const result = await runBackendsLearnCommand(["help"], deps);
    expect(result.code).toBe(0);
    expect(result.lines.join("\n")).toContain("Usage: hades backends learn");
  });

  it("an unknown subcommand exits 1 with usage lines", async () => {
    const deps: BackendsLearnCommandDeps = { store: makeStore() };
    const result = await runBackendsLearnCommand(["bogus"], deps);
    expect(result.code).toBe(1);
    expect(result.lines[0]).toContain("Unknown subcommand: bogus");
    expect(result.lines.join("\n")).toContain("Usage: hades backends learn");
  });

  it("sanitizes control characters in an unknown subcommand name before echoing it back", async () => {
    const deps: BackendsLearnCommandDeps = { store: makeStore() };
    const result = await runBackendsLearnCommand(["bo\x1b[31mgus"], deps);
    expect(result.code).toBe(1);
    // eslint-disable-next-line no-control-regex
    expect(result.lines[0]).not.toMatch(/[\x00-\x1F\x7F]/);
  });
});

// ===========================================================================
// end-to-end: real save -> real load -> real report, no live loop
// ===========================================================================

describe("runBackendsLearnCommand end-to-end durability", () => {
  it("a status saved through FileLearningStatusStore.save is fully recoverable through show and json after a fresh store instance (simulating a new process)", async () => {
    const fs = new MemoryFs();
    const savedAt = 100_000;
    const writerStore = makeStore(fs, () => savedAt);
    const status = makeStatus({
      counts: { recorded: 12, skipped: 3, duplicate: 1 },
      arms: { docker: makeArm({ pulls: 10, verified: 9, meanReward: 0.9, ucb: 1.9 }) },
    });
    const saveResult = await writerStore.save(status);
    expect(saveResult.saved).toBe(true);

    // Fresh store instance over the SAME fs, simulating a new process
    // reading what a previous one wrote -- no `loop` present.
    const readerDeps: BackendsLearnCommandDeps = { store: makeStore(fs), now: () => savedAt + 1000 };
    const showResult = await runBackendsLearnCommand(["show"], readerDeps);
    expect(showResult.code).toBe(0);
    expect(showResult.lines.slice(1)).toEqual(renderLearningReport(status));

    const jsonResult = await runBackendsLearnCommand(["json"], readerDeps);
    const parsed = JSON.parse(jsonResult.lines[0]);
    expect(parsed.source).toBe("snapshot");
    expect(parsed.status).toEqual(status);
  });
});
