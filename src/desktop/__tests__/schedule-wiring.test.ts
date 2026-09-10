/**
 * Central-integration tests for the desktop schedule lane: the schedule
 * contract is merged into the composed IPC contract (`../ipc/contract.ts`),
 * the Sidecar routes `schedule.*` commands to a wired handler (with an honest
 * `schedule.error` when none is configured), and `runSidecar`'s DEFAULT
 * wiring answers over the REAL stack — the same `<dataDir>/schedule.json`
 * `hades schedule` writes, a real `SchedulerRunner` for `schedule.job.run`,
 * and every delivery receipt appended to the real hash-chained ledger at
 * `<dataDir>/schedule-receipts.json`.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  decodeCommand,
  encodeCommand,
  decodeEvent,
  encodeEvent,
  isAppEvent,
  isCommand,
} from "../ipc/contract";
import type { AppEvent, ScheduleEvent, ScheduleJobView } from "../ipc/contract";
import { Sidecar } from "../core/sidecar";
import { ScheduleService } from "../core/schedule-service";
import { runSidecar } from "../sidecar-entry";
import { InMemoryJobStore, JsonFileJobStore } from "../../hades/schedule/store";
import { ManualClock, systemClock } from "../../hades/schedule/clock";
import { nextFireTime, parseCron } from "../../hades/schedule/cron";
import { DeliveryReceiptLedger } from "../../hades/schedule/receipt-ledger";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function* fakeInput(lines: string[]): AsyncGenerator<string> {
  for (const line of lines) yield line;
}

const savedEnv = { ...process.env };
let isolatedDataDir: string;
// Handler overrides do not replace runSidecar's real WorkbenchService.
beforeEach(() => {
  isolatedDataDir = mkdtempSync(join(tmpdir(),"hades-sidecar-schedule-wiring-"));
  process.env = {...savedEnv,HADES_DATA_DIR:isolatedDataDir,HADES_WEBHOOK_PORT:"0",HADES_BROWSER_RUNTIME:"0"};
});
afterEach(() => {
  process.env = { ...savedEnv };
  rmSync(isolatedDataDir,{recursive:true,force:true});
});

const JOB_VIEW: ScheduleJobView = {
  id: "sj-1",
  name: "nightly digest",
  cron: "0 3 * * *",
  timeZone: "UTC",
  enabled: true,
  taskKind: "note",
  taskInput: "digest",
  delivery: null,
  misfire: "skip",
  nextFireAt: null,
  lastFireAt: null,
  runCount: 0,
  failCount: 0,
  abstainCount: 0,
  revision: 0,
};

// ---------------------------------------------------------------------------
// Contract merge
// ---------------------------------------------------------------------------

describe("ipc contract: schedule kinds are merged into Command/AppEvent", () => {
  it("decodeCommand accepts every schedule command kind and rejects malformed fields", () => {
    expect(decodeCommand('{"kind":"schedule.status.get"}')).toEqual({ kind: "schedule.status.get" });
    expect(decodeCommand('{"kind":"schedule.job.get","id":"sj-1"}')).toEqual({ kind: "schedule.job.get", id: "sj-1" });
    expect(
      decodeCommand('{"kind":"schedule.job.toggle","id":"sj-1","enabled":false,"revision":3}'),
    ).toEqual({ kind: "schedule.job.toggle", id: "sj-1", enabled: false, revision: 3 });
    expect(decodeCommand('{"kind":"schedule.job.run","id":"sj-1"}')).toEqual({ kind: "schedule.job.run", id: "sj-1" });
    expect(() => decodeCommand('{"kind":"schedule.job.toggle","id":"sj-1","enabled":"yes","revision":3}')).toThrow(
      /bad command/,
    );
    expect(() => decodeCommand('{"kind":"schedule.job.get"}')).toThrow(/bad command/);
    expect(isCommand({ kind: "schedule.job.run", id: "x" })).toBe(true);
  });

  it("encodeEvent/decodeEvent round-trip every schedule event kind", () => {
    const events: AppEvent[] = [
      { kind: "schedule.status", status: { jobs: [JOB_VIEW], runnerAttached: true, at: 9 } },
      { kind: "schedule.job", job: JOB_VIEW, history: [{ firedAt: 1, scheduledFor: 1, outcome: "failed", detail: "d", durationMs: 0 }] },
      {
        kind: "schedule.run.receipt",
        jobId: "sj-1",
        run: { firedAt: 2, scheduledFor: 2, outcome: "delivered", detail: "ok", durationMs: 1 },
        at: 9,
      },
      { kind: "schedule.error", message: "nope", at: 9 },
    ];
    for (const ev of events) {
      expect(isAppEvent(ev)).toBe(true);
      expect(decodeEvent(encodeEvent(ev))).toEqual(ev);
    }
  });
});

// ---------------------------------------------------------------------------
// Sidecar routing
// ---------------------------------------------------------------------------

function minimalFactory() {
  return { dispatchGoal: () => ({ goalId: "g" }), snapshot: () => ({ workers: [], tasks: [] }) };
}

describe("Sidecar: schedule command routing", () => {
  it("routes schedule.status.get through a wired ScheduleService over a REAL job store", async () => {
    const clock = new ManualClock(1_700_000_000_000);
    const store = new InMemoryJobStore(clock);
    store.add({ name: "digest", cron: "0 3 * * *", timeZone: "UTC", task: { kind: "note", input: "d" } });
    const service = new ScheduleService({
      jobs: store,
      nextFire: (cron, after, tz) => nextFireTime(parseCron(cron), after, tz),
      now: () => clock.now(),
    });

    const events: AppEvent[] = [];
    const sidecar = new Sidecar({ factory: minimalFactory, emit: (e) => events.push(e), schedule: service });

    await sidecar.handle({ kind: "schedule.status.get" });

    const status = events.filter((e) => e.kind === "schedule.status");
    expect(status).toHaveLength(1);
    const s = (status[0] as Extract<ScheduleEvent, { kind: "schedule.status" }>).status;
    expect(s.jobs).toHaveLength(1);
    expect(s.jobs[0].name).toBe("digest");
    // Real cron engine computed the next 03:00 UTC after the manual clock.
    expect(s.jobs[0].nextFireAt).toBe(nextFireTime(parseCron("0 3 * * *"), clock.now(), "UTC"));
    expect(s.runnerAttached).toBe(false); // no runner wired in this construction — reported honestly
  });

  it("without a schedule handler, a schedule command gets an honest schedule.error — never silence", async () => {
    const events: AppEvent[] = [];
    const sidecar = new Sidecar({ factory: minimalFactory, emit: (e) => events.push(e) });

    await sidecar.handle({ kind: "schedule.status.get" });
    await sidecar.handle({ kind: "schedule.job.run", id: "sj-1" });

    expect(events).toHaveLength(2);
    for (const ev of events) {
      expect(ev.kind).toBe("schedule.error");
      expect((ev as Extract<ScheduleEvent, { kind: "schedule.error" }>).message).toBe(
        "schedule is not configured in this build",
      );
    }
  });
});

// ---------------------------------------------------------------------------
// runSidecar default wiring — the real end-to-end lane
// ---------------------------------------------------------------------------

describe("runSidecar: default schedule wiring answers over the real stack", () => {
  it("schedule.status.get + schedule.job.run round-trip the whole pipe against the REAL durable store + receipt ledger", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "hades-sidecar-sched-"));
    process.env = { ...savedEnv, HADES_DATA_DIR: dataDir };
    delete process.env.HADES_GATEWAY_ENGINE;

    // Seed the SAME durable file the CLI writes, through the REAL store.
    const seedStore = new JsonFileJobStore(join(dataDir, "schedule.json"), systemClock);
    const job = seedStore.add({
      name: "sidecar-run job",
      cron: "0 3 * * *",
      timeZone: "UTC",
      task: { kind: "note", input: "hello from the desktop" },
    });

    const outputLines: string[] = [];
    await runSidecar(
      fakeInput([
        encodeCommand({ kind: "schedule.status.get" }),
        encodeCommand({ kind: "schedule.job.run", id: job.id }),
      ]),
      (line) => outputLines.push(line),
      {
        factory: minimalFactory,
        fleet: { handle: async () => [] },
        inference: { kind: "mock", detail: "test" },
      },
    );

    const events = outputLines.map((l) => decodeEvent(l));

    const statusEv = events.find((e) => e.kind === "schedule.status") as
      | Extract<ScheduleEvent, { kind: "schedule.status" }>
      | undefined;
    expect(statusEv).toBeDefined();
    expect(statusEv!.status.runnerAttached).toBe(true);
    expect(statusEv!.status.jobs.map((j) => j.id)).toEqual([job.id]);
    expect(statusEv!.status.jobs[0].taskKind).toBe("note");

    const receiptEv = events.find((e) => e.kind === "schedule.run.receipt") as
      | Extract<ScheduleEvent, { kind: "schedule.run.receipt" }>
      | undefined;
    expect(receiptEv).toBeDefined();
    expect(receiptEv!.jobId).toBe(job.id);
    // A note task with no delivery target resolves ok — the run record is
    // the REAL one the runner persisted, cross-checked against the store.
    const persisted = new JsonFileJobStore(join(dataDir, "schedule.json"), systemClock).get(job.id);
    expect(persisted?.history).toHaveLength(1);
    expect(persisted?.history[0].outcome).toBe(receiptEv!.run.outcome);
    expect(persisted?.history[0].firedAt).toBe(receiptEv!.run.firedAt);
  });

  it("a delivery-bearing run lands honestly in the hash-chained receipt ledger (zero senders -> never 'delivered')", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "hades-sidecar-sched-ledger-"));
    process.env = { ...savedEnv, HADES_DATA_DIR: dataDir };
    delete process.env.HADES_GATEWAY_ENGINE;

    const seedStore = new JsonFileJobStore(join(dataDir, "schedule.json"), systemClock);
    const job = seedStore.add({
      name: "ledgered job",
      cron: "0 3 * * *",
      timeZone: "UTC",
      task: { kind: "note", input: "note text that must never appear in the ledger" },
      delivery: { platform: "telegram", user: "U1" },
    });

    const outputLines: string[] = [];
    await runSidecar(
      fakeInput([encodeCommand({ kind: "schedule.job.run", id: job.id })]),
      (line) => outputLines.push(line),
      {
        factory: minimalFactory,
        fleet: { handle: async () => [] },
        inference: { kind: "mock", detail: "test" },
      },
    );

    const events = outputLines.map((l) => decodeEvent(l));
    const receiptEv = events.find((e) => e.kind === "schedule.run.receipt") as
      | Extract<ScheduleEvent, { kind: "schedule.run.receipt" }>
      | undefined;
    expect(receiptEv).toBeDefined();
    // No verification evidence + zero registered senders: the outcome can
    // never be "delivered" — that would be a fabricated success.
    expect(receiptEv!.run.outcome).not.toBe("delivered");

    // The REAL ledger file exists, its chain re-verifies from the bytes, and
    // it records the honest outcome for this job — with certFingerprint null
    // (no verified delivery ever happened) and no raw note text on disk.
    const ledgerPath = join(dataDir, "schedule-receipts.json");
    expect(existsSync(ledgerPath)).toBe(true);
    const ledger = new DeliveryReceiptLedger({ path: ledgerPath });
    expect(ledger.loadReport().recovered).toBe(false);
    const verification = ledger.verifyChain();
    expect(verification.ok).toBe(true);
    const records = ledger.records({ jobId: job.id });
    expect(records).toHaveLength(1);
    expect(records[0].outcome).toBe(receiptEv!.run.outcome);
    expect(records[0].certFingerprint).toBeNull();
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(ledgerPath, "utf8")).not.toContain("note text that must never appear in the ledger");
  });

  it("an injected schedule handler overrides the default wiring", async () => {
    const outputLines: string[] = [];
    await runSidecar(
      fakeInput([encodeCommand({ kind: "schedule.status.get" })]),
      (line) => outputLines.push(line),
      {
        factory: minimalFactory,
        fleet: { handle: async () => [] },
        inference: { kind: "mock", detail: "test" },
        schedule: { handle: async () => ({ kind: "schedule.error", message: "injected", at: 1 }) },
      },
    );

    const events = outputLines.map((l) => decodeEvent(l));
    expect(events).toEqual([{ kind: "schedule.error", message: "injected", at: 1 }]);
  });
});

it("keeps the real schedule pipe responsive to approvals while a native agent is running", async () => {
  const { createServer } = await import("node:http");
  const { writeFileSync, readFileSync, rmSync } = await import("node:fs");
  const { vi } = await import("vitest");
  const dataDir = mkdtempSync(join(tmpdir(), "hades-schedule-approval-pipe-"));
  process.env = { ...savedEnv, HADES_DATA_DIR: join(dataDir, "data") };
  const server = createServer((req, res) => {
    let body = ""; req.on("data", chunk => body += chunk); req.on("end", () => {
      const input = JSON.parse(body).messages.at(-1).content;
      const content = /^TOOL_(RESULT|ERROR):/.test(input) ? "ANSWER: The operation was declined."
        : 'TOOL: file_ops\nINPUT: {"op":"write","path":"sentinel.txt","content":"CHANGED"}';
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const store = new JsonFileJobStore(join(dataDir, "data", "schedule.json"), systemClock);
  const job = store.add({ name: "Protected write", cron: "0 9 * * *", task: { kind: "swarm.goal", input: "Write sentinel.txt", root: dataDir, profile: "default" } });
  writeFileSync(join(dataDir, "sentinel.txt"), "KEEP");
  const events: any[] = [];
  const desktop = (id: string, method: string, args: any) => JSON.stringify({ kind: "desktop.request", id, method, args }) + "\n";
  async function* commands() {
    yield desktop("project", "project.add", { path: dataDir });
    await vi.waitFor(() => expect(events.some(e => e.kind === "desktop.response" && e.id === "project")).toBe(true));
    yield desktop("profile", "profile.save", { id: "default", name: "Fixture", provider: "local", model: "fixture", baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1` });
    await vi.waitFor(() => expect(events.some(e => e.kind === "desktop.response" && e.id === "profile")).toBe(true));
    yield encodeCommand({ kind: "schedule.job.run", id: job.id });
    await vi.waitFor(() => expect(events.some(e => e.kind === "desktop.approval")).toBe(true), { timeout: 3000 });
    const approval = events.find(e => e.kind === "desktop.approval");
    yield desktop("decline", "approval.reply", { id: approval.id, allow: false });
    await vi.waitFor(() => expect(events.some(e => e.kind === "schedule.run.receipt")).toBe(true), { timeout: 3000 });
  }
  try {
    await runSidecar(commands(), line => events.push(JSON.parse(line)), { factory: minimalFactory, fleet: { handle: async () => [] }, inference: { kind: "mock", detail: "fixture" } });
    expect(events.some(e => e.kind === "desktop.response" && e.id === "decline")).toBe(true);
    expect(readFileSync(join(dataDir, "sentinel.txt"), "utf8")).toBe("KEEP");
    expect(events.find(e => e.kind === "schedule.run.receipt").run.outcome).toBe("delivered");
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(dataDir, { recursive: true, force: true }); }
}, 10_000);
