/**
 * `runScheduleCommand` — exercised exclusively through its public CLI
 * surface with fully injected deps (a `ManualClock` pinned to a fixed
 * epoch, an `InMemoryJobStore` with a deterministic id generator), so every
 * printed line — including next-fire ISO timestamps — is an exact
 * assertion, never a regex shrug.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runScheduleCommand, defaultScheduleDeps, BuiltinNoteExecutor } from "../schedule-command";
import type { ScheduleCommandDeps } from "../schedule-command";

import { InMemoryJobStore, JsonFileJobStore } from "../../schedule/store";
import { ManualClock } from "../../schedule/clock";
import { describeCron, nextFireTime, nextFireTimes, parseCron } from "../../schedule/cron";
import type { JobExecutionContext, JobExecutionResult, JobExecutor } from "../../schedule/runner";
import { VerifiedDeliveryRouter } from "../../schedule/delivery";
import type { OutboundSender } from "../../schedule/delivery";
import { CertificateAuthority, generatePrivateKeyHex, sha256Hex } from "../../styx/certificate";

const T0 = Date.UTC(2026, 0, 1, 0, 0, 0);

function fixedRng(fill: number): (bytes: number) => Uint8Array {
  return (bytes: number) => new Uint8Array(bytes).fill(fill);
}

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

class RecordingSender implements OutboundSender {
  readonly platform: string;
  readonly calls: { target: { user: string; channel?: string }; text: string }[] = [];
  constructor(platform: string) {
    this.platform = platform;
  }
  async send(target: { user: string; channel?: string }, text: string): Promise<void> {
    this.calls.push({ target: { ...target }, text });
  }
}

/** Attaches a REAL gate decision + REAL ed25519 certificate over its exact
 *  output text, so a `run` against it proves a genuinely verified delivery. */
class VerifiedEvidenceExecutor implements JobExecutor {
  constructor(
    private readonly ca: CertificateAuthority,
    private readonly outputText: string,
  ) {}

  async execute(_job: unknown, ctx: JobExecutionContext): Promise<JobExecutionResult> {
    const cert = await this.ca.issue({
      outputSha256: sha256Hex(this.outputText),
      taskId: "cli-run-test",
      verifierTier: "T2-genrm",
      ensembleScore: 0.95,
      pCorrect: 0.98,
      epsilon: 0.02,
      traceSha256: sha256Hex(JSON.stringify({ scheduledFor: ctx.scheduledFor })),
      verifierVersions: ["exec-oracle@1.0.0"],
      issuedAt: ctx.firedAt,
    });
    return {
      ok: true,
      output: this.outputText,
      detail: "executed",
      verification: {
        decision: { emit: true, score: 0.95, threshold: 0.9, pCorrectEstimate: 0.98 },
        certificate: cert,
      },
    };
  }
}

function makeDeps(overrides: Partial<ScheduleCommandDeps> = {}): {
  deps: ScheduleCommandDeps;
  clock: ManualClock;
  store: InMemoryJobStore;
} {
  const clock = new ManualClock(T0);
  let counter = 0;
  const store = new InMemoryJobStore(clock, () => `job-${++counter}`);
  const executor: JobExecutor = new BuiltinNoteExecutor();
  const deliverer = new VerifiedDeliveryRouter({ senders: [], clock });
  return {
    deps: { store, clock, executor, deliverer, ...overrides },
    clock,
    store,
  };
}

// ===========================================================================
// add
// ===========================================================================

describe("runScheduleCommand — add", () => {
  it("happy path: minimal flags, prints id + describeCron + next 3 fires", async () => {
    const { deps } = makeDeps();
    const result = await runScheduleCommand(["add", "--name", "daily-report", "--cron", "*/5 * * * *"], deps);

    expect(result.code).toBe(0);
    const schedule = parseCron("*/5 * * * *");
    expect(result.lines).toEqual([
      `Added job job-1 "daily-report"`,
      `  cron:      */5 * * * *  (${describeCron(schedule)})`,
      "  timezone:  UTC",
      "  task:      note:daily-report",
      "  delivery:  (none)",
      "  misfire:   skip",
      "  next fires:",
      "    2026-01-01T00:05:00.000Z",
      "    2026-01-01T00:10:00.000Z",
      "    2026-01-01T00:15:00.000Z",
    ]);

    const jobs = deps.store.list();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].task).toEqual({ kind: "note", input: "daily-report" });
    expect(jobs[0].timeZone).toBe("UTC");
    expect(jobs[0].misfire).toBe("skip");
    expect(jobs[0].catchUpLimit).toBe(5);
  });

  it("every flag: --tz, --task, --deliver, --misfire catch-up, --catch-up-limit", async () => {
    const { deps } = makeDeps();
    const result = await runScheduleCommand(
      [
        "add",
        "--name",
        "nightly-backup",
        "--cron",
        "0 3 * * *",
        "--tz",
        "America/New_York",
        "--task",
        "note:back up the vault, please: nightly",
        "--deliver",
        "slack:U123:C456",
        "--misfire",
        "catch-up",
        "--catch-up-limit",
        "3",
      ],
      deps,
    );

    expect(result.code).toBe(0);
    const schedule = parseCron("0 3 * * *");
    const next3 = nextFireTimes(schedule, T0, "America/New_York", 3);
    expect(next3).toHaveLength(3);
    expect(result.lines).toEqual([
      `Added job job-1 "nightly-backup"`,
      `  cron:      0 3 * * *  (${describeCron(schedule)})`,
      "  timezone:  America/New_York",
      "  task:      note:back up the vault, please: nightly",
      "  delivery:  slack:U123:C456",
      "  misfire:   catch-up (catch-up limit 3)",
      "  next fires:",
      ...next3.map((t) => `    ${new Date(t).toISOString()}`),
    ]);

    const job = deps.store.list()[0];
    expect(job.task).toEqual({ kind: "note", input: "back up the vault, please: nightly" });
    expect(job.timeZone).toBe("America/New_York");
    expect(job.delivery).toEqual({ platform: "slack", user: "U123", channel: "C456" });
    expect(job.misfire).toBe("catch-up");
    expect(job.catchUpLimit).toBe(3);
  });

  it("--deliver with no channel omits DeliverySpec.channel", async () => {
    const { deps } = makeDeps();
    const result = await runScheduleCommand(
      ["add", "--name", "x", "--cron", "* * * * *", "--deliver", "telegram:bob"],
      deps,
    );
    expect(result.code).toBe(0);
    expect(deps.store.list()[0].delivery).toEqual({ platform: "telegram", user: "bob" });
    expect(result.lines).toContain("  delivery:  telegram:bob");
  });

  it("bad cron: exit 1, field named in the message, nothing persisted", async () => {
    const { deps } = makeDeps();
    const result = await runScheduleCommand(["add", "--name", "x", "--cron", "99 * * * *"], deps);

    expect(result.code).toBe(1);
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]).toContain("minute field");
    expect(deps.store.list()).toHaveLength(0);
  });

  it("bad cron field count: exit 1, nothing persisted", async () => {
    const { deps } = makeDeps();
    const result = await runScheduleCommand(["add", "--name", "x", "--cron", "* * * *"], deps);
    expect(result.code).toBe(1);
    expect(result.lines[0]).toContain("exactly 5 space-separated fields");
    expect(deps.store.list()).toHaveLength(0);
  });

  it("bad tz: exit 1, nothing persisted", async () => {
    const { deps } = makeDeps();
    const result = await runScheduleCommand(
      ["add", "--name", "x", "--cron", "* * * * *", "--tz", "Not/AZone"],
      deps,
    );
    expect(result.code).toBe(1);
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]).toMatch(/^Invalid IANA time zone "Not\/AZone":/);
    expect(deps.store.list()).toHaveLength(0);
  });

  it("bad --deliver shape (no colon): exit 1, nothing persisted", async () => {
    const { deps } = makeDeps();
    const result = await runScheduleCommand(
      ["add", "--name", "x", "--cron", "* * * * *", "--deliver", "justtext"],
      deps,
    );
    expect(result.code).toBe(1);
    expect(result.lines).toEqual([
      'Invalid --deliver value "justtext": expected <platform>:<user>[:<channel>]',
    ]);
    expect(deps.store.list()).toHaveLength(0);
  });

  it("bad --deliver shape (too many colons): exit 1, nothing persisted", async () => {
    const { deps } = makeDeps();
    const result = await runScheduleCommand(
      ["add", "--name", "x", "--cron", "* * * * *", "--deliver", "a:b:c:d"],
      deps,
    );
    expect(result.code).toBe(1);
    expect(result.lines[0]).toContain("Invalid --deliver value");
    expect(deps.store.list()).toHaveLength(0);
  });

  it("bad --deliver shape (empty user): exit 1, nothing persisted", async () => {
    const { deps } = makeDeps();
    const result = await runScheduleCommand(
      ["add", "--name", "x", "--cron", "* * * * *", "--deliver", "slack:"],
      deps,
    );
    expect(result.code).toBe(1);
    expect(result.lines[0]).toContain("Invalid --deliver value");
    expect(deps.store.list()).toHaveLength(0);
  });

  it("bad --misfire value: exit 1, nothing persisted", async () => {
    const { deps } = makeDeps();
    const result = await runScheduleCommand(
      ["add", "--name", "x", "--cron", "* * * * *", "--misfire", "whenever"],
      deps,
    );
    expect(result.code).toBe(1);
    expect(result.lines).toEqual(['Invalid misfire policy: "whenever"']);
    expect(deps.store.list()).toHaveLength(0);
  });

  it("bad --task value (no colon): exit 1, nothing persisted", async () => {
    const { deps } = makeDeps();
    const result = await runScheduleCommand(
      ["add", "--name", "x", "--cron", "* * * * *", "--task", "notask"],
      deps,
    );
    expect(result.code).toBe(1);
    expect(result.lines[0]).toContain("Invalid --task value");
    expect(deps.store.list()).toHaveLength(0);
  });

  it("missing --name: usage, exit 1", async () => {
    const { deps } = makeDeps();
    const result = await runScheduleCommand(["add", "--cron", "* * * * *"], deps);
    expect(result.code).toBe(1);
    expect(result.lines[0]).toMatch(/^Usage: hades schedule add/);
    expect(deps.store.list()).toHaveLength(0);
  });

  it("missing --cron: usage, exit 1", async () => {
    const { deps } = makeDeps();
    const result = await runScheduleCommand(["add", "--name", "x"], deps);
    expect(result.code).toBe(1);
    expect(result.lines[0]).toMatch(/^Usage: hades schedule add/);
  });

  it("unknown flag: exit 1, nothing persisted", async () => {
    const { deps } = makeDeps();
    const result = await runScheduleCommand(
      ["add", "--name", "x", "--cron", "* * * * *", "--bogus", "y"],
      deps,
    );
    expect(result.code).toBe(1);
    expect(result.lines[0]).toBe('Unknown flag "--bogus".');
    expect(deps.store.list()).toHaveLength(0);
  });
});

// ===========================================================================
// list
// ===========================================================================

describe("runScheduleCommand — list", () => {
  it("empty store: honest empty line, code 0", async () => {
    const { deps } = makeDeps();
    const result = await runScheduleCommand(["list"], deps);
    expect(result).toEqual({ code: 0, lines: ["No scheduled jobs."] });
  });

  it("aligned table after adding jobs", async () => {
    const { deps, clock } = makeDeps();
    await runScheduleCommand(["add", "--name", "a", "--cron", "*/5 * * * *"], deps);
    clock.advance(60_000);
    await runScheduleCommand(
      ["add", "--name", "much-longer-job-name", "--cron", "0 9 * * *", "--tz", "America/New_York"],
      deps,
    );

    const result = await runScheduleCommand(["list"], deps);
    expect(result.code).toBe(0);
    expect(result.lines).toHaveLength(3);

    const jobs = deps.store.list();
    const schedule0 = parseCron("*/5 * * * *");
    const schedule1 = parseCron("0 9 * * *");
    const next0 = new Date(nextFireTime(schedule0, clock.now(), jobs[0].timeZone)!).toISOString();
    const next1 = new Date(nextFireTime(schedule1, clock.now(), jobs[1].timeZone)!).toISOString();

    // Compute the expected aligned table with the exact same padding
    // algorithm the CLI uses (left-align, 2-space gaps, trailing whitespace
    // trimmed) — an independent-but-equivalent computation from the real
    // job/next-fire data, not a re-invocation of the CLI's own renderer.
    const headers = ["ID", "NAME", "CRON", "TZ", "ENABLED", "LAST FIRE", "NEXT FIRE"];
    const rows = [
      [jobs[0].id.slice(0, 8), "a", "*/5 * * * *", "UTC", "true", "-", next0],
      [jobs[1].id.slice(0, 8), "much-longer-job-name", "0 9 * * *", "America/New_York", "true", "-", next1],
    ];
    const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
    const fmt = (cells: string[]): string => cells.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd();
    expect(result.lines).toEqual([fmt(headers), fmt(rows[0]), fmt(rows[1])]);
  });

  it("shows lastFireAt as an ISO string once a job has fired", async () => {
    const { deps, clock } = makeDeps();
    await runScheduleCommand(["add", "--name", "a", "--cron", "* * * * *"], deps);
    const job = deps.store.list()[0];
    deps.store.recordRun(job.id, {
      firedAt: clock.now(),
      scheduledFor: clock.now(),
      outcome: "delivered",
      detail: "ok",
      durationMs: 5,
    });

    const result = await runScheduleCommand(["list"], deps);
    expect(result.lines[1]).toContain(new Date(clock.now()).toISOString());
  });
});

// ===========================================================================
// remove
// ===========================================================================

describe("runScheduleCommand — remove", () => {
  it("removes by full id", async () => {
    const { deps } = makeDeps();
    await runScheduleCommand(["add", "--name", "a", "--cron", "* * * * *"], deps);
    const id = deps.store.list()[0].id;

    const result = await runScheduleCommand(["remove", id], deps);
    expect(result).toEqual({ code: 0, lines: [`Removed job ${id} "a"`] });
    expect(deps.store.list()).toHaveLength(0);
  });

  it("removes by unambiguous prefix", async () => {
    const { deps } = makeDeps();
    await runScheduleCommand(["add", "--name", "a", "--cron", "* * * * *"], deps);
    const id = deps.store.list()[0].id; // "job-1"

    const result = await runScheduleCommand(["remove", "job-"], deps);
    expect(result).toEqual({ code: 0, lines: [`Removed job ${id} "a"`] });
    expect(deps.store.list()).toHaveLength(0);
  });

  it("ambiguous prefix: lists candidates, code 1, nothing removed", async () => {
    const { deps } = makeDeps();
    await runScheduleCommand(["add", "--name", "a", "--cron", "* * * * *"], deps);
    await runScheduleCommand(["add", "--name", "b", "--cron", "* * * * *"], deps);
    const [j1, j2] = deps.store.list();

    const result = await runScheduleCommand(["remove", "job-"], deps);
    expect(result.code).toBe(1);
    expect(result.lines).toEqual([
      'Ambiguous id/prefix "job-" matches 2 jobs:',
      `  ${j1.id}  ${j1.name}`,
      `  ${j2.id}  ${j2.name}`,
    ]);
    expect(deps.store.list()).toHaveLength(2);
  });

  it("missing id: code 1, nothing removed", async () => {
    const { deps } = makeDeps();
    await runScheduleCommand(["add", "--name", "a", "--cron", "* * * * *"], deps);

    const result = await runScheduleCommand(["remove", "no-such-id"], deps);
    expect(result).toEqual({ code: 1, lines: ['No job matches id/prefix "no-such-id".'] });
    expect(deps.store.list()).toHaveLength(1);
  });

  it("missing argument: usage, code 1", async () => {
    const { deps } = makeDeps();
    const result = await runScheduleCommand(["remove"], deps);
    expect(result).toEqual({ code: 1, lines: ["Usage: hades schedule remove <id>"] });
  });
});

// ===========================================================================
// run
// ===========================================================================

describe("runScheduleCommand — run", () => {
  it("fires a job through the real runner + deliverer: verified evidence -> badge verified", async () => {
    const clock = new ManualClock(T0);
    let counter = 0;
    const store = new InMemoryJobStore(clock, () => `job-${++counter}`);
    const ca = new CertificateAuthority(generatePrivateKeyHex(fixedRng(7)));
    const executor = new VerifiedEvidenceExecutor(ca, "the verified answer");
    const sender = new RecordingSender("testchat");
    const deliverer = new VerifiedDeliveryRouter({ senders: [sender], clock });
    const deps: ScheduleCommandDeps = { store, clock, executor, deliverer };

    await runScheduleCommand(
      ["add", "--name", "verified-job", "--cron", "* * * * *", "--deliver", "testchat:alice"],
      deps,
    );
    const id = store.list()[0].id;

    const result = await runScheduleCommand(["run", id], deps);
    expect(result.code).toBe(0);
    expect(result.lines[0]).toBe(`Ran job ${id} "verified-job"`);
    expect(result.lines).toContain("  outcome:      delivered");
    expect(result.lines).toContain("  badge:        verified");
    expect(result.lines.find((l) => l.startsWith("  reason:"))).toContain("gate emitted");

    expect(sender.calls).toHaveLength(1);
    expect(sender.calls[0].text).toContain("the verified answer");

    const job = store.get(id)!;
    expect(job.runCount).toBe(1);
    expect(job.failCount).toBe(0);
    expect(job.abstainCount).toBe(0);
  });

  it("fires a builtin note job with no evidence -> abstains, output withheld from the notice", async () => {
    const { deps, store } = makeDeps({});
    const sender = new RecordingSender("testchat");
    const deliverer = new VerifiedDeliveryRouter({ senders: [sender], clock: deps.clock });
    const wired: ScheduleCommandDeps = { ...deps, deliverer };

    await runScheduleCommand(
      ["add", "--name", "note-job", "--cron", "* * * * *", "--task", "note:top secret payload", "--deliver", "testchat:bob"],
      wired,
    );
    const id = store.list()[0].id;

    const result = await runScheduleCommand(["run", id], wired);
    expect(result.code).toBe(0);
    expect(result.lines).toContain("  outcome:      abstained");
    expect(result.lines.find((l) => l.startsWith("  badge:"))).toMatch(/  badge:\s+(abstained|unverified)/);

    expect(sender.calls).toHaveLength(1);
    expect(sender.calls[0].text).not.toContain("top secret payload");
    expect(sender.calls[0].text).toContain('Job "note-job"');
    expect(sender.calls[0].text).toContain("withheld");

    const job = store.get(id)!;
    expect(job.abstainCount).toBe(1);
  });

  it("job with no delivery target: badge/reason reported as no delivery attempted", async () => {
    const { deps, store } = makeDeps();
    await runScheduleCommand(["add", "--name", "no-delivery", "--cron", "* * * * *"], deps);
    const id = store.list()[0].id;

    const result = await runScheduleCommand(["run", id], deps);
    expect(result.code).toBe(0);
    expect(result.lines).toContain("  outcome:      delivered");
    expect(result.lines).toContain("  badge:        (no delivery target configured)");
    expect(result.lines).toContain("  reason:       (no delivery target configured)");
  });

  it("unknown id: code 1", async () => {
    const { deps } = makeDeps();
    const result = await runScheduleCommand(["run", "nope"], deps);
    expect(result).toEqual({ code: 1, lines: ['No scheduled job with id "nope".'] });
  });

  it("missing argument: usage, code 1", async () => {
    const { deps } = makeDeps();
    const result = await runScheduleCommand(["run"], deps);
    expect(result).toEqual({ code: 1, lines: ["Usage: hades schedule run <id>"] });
  });
});

// ===========================================================================
// status
// ===========================================================================

describe("runScheduleCommand — status", () => {
  it("in-memory store, builtin executor, zero-sender router (via defaultScheduleDeps): full honesty lines", async () => {
    const dir = mkdtempSync(join(tmpdir(), "schedule-cmd-status-"));
    try {
      const deps = defaultScheduleDeps({ ...process.env, HADES_DATA_DIR: dir });
      const result = await runScheduleCommand(["status"], deps);
      expect(result.code).toBe(0);
      expect(result.lines[0]).toBe(`Job store: ${join(dir, "schedule.json")}`);
      expect(result.lines).toContain("Jobs: 0");
      expect(result.lines).toContain("  (none)");
      expect(result.lines).toContain(
        'Executor: builtin "note" task executor — deterministic echo of task.input, ok:true, NO verification evidence attached. It delivers only as an honest abstention until the swarm engine is wired centrally.',
      );
      expect(result.lines).toContain(
        "Senders: no outbound senders configured — central integration attaches gateway connectors.",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reflects per-job counters after runs", async () => {
    const { deps, store } = makeDeps();
    const sender = new RecordingSender("testchat");
    const deliverer = new VerifiedDeliveryRouter({ senders: [sender], clock: deps.clock });
    const wired: ScheduleCommandDeps = { ...deps, deliverer };

    await runScheduleCommand(
      ["add", "--name", "counted", "--cron", "* * * * *", "--deliver", "testchat:carol"],
      wired,
    );
    const id = store.list()[0].id;
    await runScheduleCommand(["run", id], wired);
    await runScheduleCommand(["run", id], wired);

    const result = await runScheduleCommand(["status"], wired);
    expect(result.code).toBe(0);
    expect(result.lines).toContain("Jobs: 1");
    expect(result.lines).toContain(`  ${id.slice(0, 8)}  counted  runs=2 fails=0 abstains=2`);
  });

  it("surfaces a corrupt-recovery warning from a real JsonFileJobStore", async () => {
    const dir = mkdtempSync(join(tmpdir(), "schedule-cmd-corrupt-"));
    try {
      const storePath = join(dir, "schedule.json");
      writeFileSync(storePath, "{ not valid json at all", "utf8");
      const clock = new ManualClock(T0);
      const store = new JsonFileJobStore(storePath, clock);
      const deps: ScheduleCommandDeps = {
        store,
        clock,
        executor: new BuiltinNoteExecutor(),
        deliverer: new VerifiedDeliveryRouter({ senders: [], clock }),
      };

      const result = await runScheduleCommand(["status"], deps);
      expect(result.code).toBe(0);
      expect(result.lines[0]).toBe(`Job store: ${storePath}`);
      expect(result.lines[1]).toMatch(/^ {2}warning: invalid JSON in job store file/);
      expect(store.loadReport().recovered).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("custom executor/deliverer: generic honesty lines naming the constructor", async () => {
    const { deps } = makeDeps();
    class CustomExecutor implements JobExecutor {
      async execute(): Promise<JobExecutionResult> {
        return { ok: true, output: "x", detail: "x" };
      }
    }
    class CustomDeliverer {
      async deliver(): Promise<never> {
        throw new Error("unused");
      }
    }
    const wired: ScheduleCommandDeps = {
      ...deps,
      executor: new CustomExecutor(),
      deliverer: new CustomDeliverer() as unknown as ScheduleCommandDeps["deliverer"],
    };
    const result = await runScheduleCommand(["status"], wired);
    expect(result.lines).toContain("Executor: custom executor (CustomExecutor) injected by the caller.");
    expect(result.lines).toContain("Senders: custom deliverer (CustomDeliverer) injected by the caller.");
  });
});

// ===========================================================================
// unknown / missing subcommand
// ===========================================================================

describe("runScheduleCommand — usage", () => {
  it("missing subcommand: usage, code 1", async () => {
    const { deps } = makeDeps();
    const result = await runScheduleCommand([], deps);
    expect(result.code).toBe(1);
    expect(result.lines[0]).toBe("Usage: hades schedule <command>");
  });

  it("unknown subcommand: usage, code 1", async () => {
    const { deps } = makeDeps();
    const result = await runScheduleCommand(["bogus"], deps);
    expect(result.code).toBe(1);
    expect(result.lines[0]).toBe("Usage: hades schedule <command>");
  });
});

// ===========================================================================
// defaultScheduleDeps — real dataDir wiring
// ===========================================================================

describe("defaultScheduleDeps", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "schedule-cmd-defaultdeps-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("honors HADES_DATA_DIR, creates schedule.json on first add, and a fresh process sees the job", async () => {
    const deps1 = defaultScheduleDeps({ ...process.env, HADES_DATA_DIR: dir });
    const storePath = join(dir, "schedule.json");
    expect(existsSync(storePath)).toBe(false);

    const addResult = await runScheduleCommand(["add", "--name", "persisted", "--cron", "* * * * *"], deps1);
    expect(addResult.code).toBe(0);
    expect(existsSync(storePath)).toBe(true);

    // Fresh deps == a brand new process reading the same data dir.
    const deps2 = defaultScheduleDeps({ ...process.env, HADES_DATA_DIR: dir });
    const listResult = await runScheduleCommand(["list"], deps2);
    expect(listResult.code).toBe(0);
    expect(listResult.lines.some((l) => l.includes("persisted"))).toBe(true);
  });

  it("defaults to <HADES_DATA_DIR|.hades>/schedule.json when HADES_DATA_DIR is absent", () => {
    const { HADES_DATA_DIR: _unused, ...envWithoutDataDir } = process.env;
    const deps = defaultScheduleDeps(envWithoutDataDir as NodeJS.ProcessEnv);
    const report = deps.store.loadReport();
    expect(report.path).toBe(join(".hades", "schedule.json"));
  });

  it("runScheduleCommand's own default deps parameter reads process.env.HADES_DATA_DIR", async () => {
    const prev = process.env.HADES_DATA_DIR;
    process.env.HADES_DATA_DIR = dir;
    try {
      const result = await runScheduleCommand(["status"]);
      expect(result.lines[0]).toBe(`Job store: ${join(dir, "schedule.json")}`);
    } finally {
      if (prev === undefined) delete process.env.HADES_DATA_DIR;
      else process.env.HADES_DATA_DIR = prev;
    }
  });
});

// ===========================================================================
// receipts — the hash-chained delivery receipt ledger surface
// ===========================================================================

describe("runScheduleCommand — receipts", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "schedule-cmd-receipts-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("without a configured receiptsPath: honest error, code 1", async () => {
    const { deps } = makeDeps(); // makeDeps never sets receiptsPath
    const result = await runScheduleCommand(["receipts"], deps);
    expect(result.code).toBe(1);
    expect(result.lines).toEqual(["No receipt ledger configured (deps.receiptsPath is not set)."]);
  });

  it("empty ledger: chain verifies OK over 0 records, honest 'no receipts' line", async () => {
    const receiptsPath = join(dir, "receipts.json");
    const { deps } = makeDeps({ receiptsPath });
    const result = await runScheduleCommand(["receipts"], deps);
    expect(result.code).toBe(0);
    expect(result.lines[0]).toBe(`Receipt ledger: ${receiptsPath}`);
    expect(result.lines).toContain("Chain: verified OK (0 record(s), every hash recomputed independently)");
    expect(result.lines).toContain("Tally: delivered=0 abstained=0 withheld=0 failed=0");
    expect(result.lines).toContain("No receipts recorded yet.");
  });

  it("a REAL verified `run` is ledgered end-to-end: chain re-verifies, record carries badge=verified + the real cert fingerprint, delivered text stays off disk", async () => {
    const receiptsPath = join(dir, "receipts.json");
    const sender = new RecordingSender("telegram");
    const ca = new CertificateAuthority(generatePrivateKeyHex(fixedRng(11)));
    const outputText = "the verified secret answer is 42";
    const { deps, clock } = makeDeps({ receiptsPath, executor: new VerifiedEvidenceExecutor(ca, outputText) });
    deps.deliverer = new VerifiedDeliveryRouter({ senders: [sender], clock });

    await runScheduleCommand(
      ["add", "--name", "verified-job", "--cron", "0 3 * * *", "--task", "goal:answer", "--deliver", "telegram:U1"],
      deps,
    );
    const runResult = await runScheduleCommand(["run", "job-1"], deps);
    expect(runResult.code).toBe(0);
    expect(runResult.lines).toContain("  outcome:      delivered");
    expect(runResult.lines).toContain("  badge:        verified");
    expect(runResult.lines.some((l) => l.includes("receipt ledger append failed"))).toBe(false);
    expect(sender.calls).toHaveLength(1);

    const receiptsResult = await runScheduleCommand(["receipts"], deps);
    expect(receiptsResult.code).toBe(0);
    expect(receiptsResult.lines).toContain("Chain: verified OK (1 record(s), every hash recomputed independently)");
    expect(receiptsResult.lines).toContain("Tally: delivered=1 abstained=0 withheld=0 failed=0");
    const recordLine = receiptsResult.lines.find((l) => l.trimStart().startsWith("#0"));
    expect(recordLine).toBeDefined();
    expect(recordLine).toContain("verified-job");
    expect(recordLine).toContain("delivered");
    expect(recordLine).toContain("badge=verified");
    expect(recordLine).toContain("telegram:U1");
    // The fingerprint printed is lifted from the REAL delivered text's badge
    // line (never fabricated) — cross-check against what actually went out.
    const sentText = sender.calls[0].text;
    const fp = /certFingerprint:\s*([^\s|]+)/.exec(sentText)?.[1];
    expect(fp).toBeDefined();
    expect(recordLine).toContain(`cert=${fp!.slice(0, 16)}`);
    // Privacy: the delivered output text never lands in the ledger file.
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(receiptsPath, "utf8")).not.toContain(outputText);
  });

  it("an abstained note run is ledgered with certFingerprint null and --job filtering works", async () => {
    const receiptsPath = join(dir, "receipts.json");
    const sender = new RecordingSender("telegram");
    const { deps, clock } = makeDeps({ receiptsPath });
    deps.deliverer = new VerifiedDeliveryRouter({ senders: [sender], clock });

    await runScheduleCommand(
      ["add", "--name", "note-job", "--cron", "0 3 * * *", "--deliver", "telegram:U2"],
      deps,
    );
    await runScheduleCommand(["run", "job-1"], deps);

    const filtered = await runScheduleCommand(["receipts", "--job", "job-1", "--limit", "5"], deps);
    expect(filtered.code).toBe(0);
    expect(filtered.lines).toContain("Tally: delivered=0 abstained=1 withheld=0 failed=0");
    expect(filtered.lines).toContain("Last 1 receipt(s) for job job-1 (of 1 total):");
    const recordLine = filtered.lines.find((l) => l.trimStart().startsWith("#0"));
    expect(recordLine).toContain("abstained");
    expect(recordLine).not.toContain("cert="); // no fingerprint was ever lifted

    const noMatch = await runScheduleCommand(["receipts", "--job", "nope"], deps);
    expect(noMatch.lines).toContain('No receipts match job id "nope".');

    const badLimit = await runScheduleCommand(["receipts", "--limit", "-3"], deps);
    expect(badLimit.code).toBe(1);
    expect(badLimit.lines[0]).toContain("Invalid --limit value");
  });

  it("a tampered ledger file is quarantined at open and reported honestly — never silently accepted", async () => {
    const receiptsPath = join(dir, "receipts.json");
    const sender = new RecordingSender("telegram");
    const { deps, clock } = makeDeps({ receiptsPath });
    deps.deliverer = new VerifiedDeliveryRouter({ senders: [sender], clock });
    await runScheduleCommand(["add", "--name", "tamper-job", "--cron", "0 3 * * *", "--deliver", "telegram:U3"], deps);
    await runScheduleCommand(["run", "job-1"], deps);

    // Tamper: flip the recorded outcome on disk without recomputing hashes.
    const { readFileSync: rf, writeFileSync: wf } = await import("node:fs");
    const raw = JSON.parse(rf(receiptsPath, "utf8")) as { records: Array<{ outcome: string }> };
    raw.records[0].outcome = "delivered";
    wf(receiptsPath, JSON.stringify(raw), "utf8");

    const result = await runScheduleCommand(["receipts"], deps);
    expect(result.code).toBe(0); // the surviving (fresh, empty) chain verifies
    expect(result.lines.some((l) => l.includes("warning:") && l.includes("chain verification failed"))).toBe(true);
    expect(result.lines).toContain("Chain: verified OK (0 record(s), every hash recomputed independently)");
    expect(result.lines).toContain("No receipts recorded yet.");
    // The tampered bytes were preserved for forensics, not deleted.
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(dir).some((f) => f.includes("receipts.json.corrupt-"))).toBe(true);
  });

  it("usage line advertises receipts and unknown receipts flags fail honestly", async () => {
    const { deps } = makeDeps();
    const usage = await runScheduleCommand([], deps);
    expect(usage.lines.some((l) => l.includes("receipts [--job <id>] [--limit <n>]"))).toBe(true);

    const bad = await runScheduleCommand(["receipts", "--bogus", "x"], { ...deps, receiptsPath: join(dir, "r.json") });
    expect(bad.code).toBe(1);
    expect(bad.lines[0]).toBe('Unknown flag "--bogus".');
  });
});
