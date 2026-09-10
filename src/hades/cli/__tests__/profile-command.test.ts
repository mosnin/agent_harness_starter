/* ------------------------------------------------------------------ *
 * profile-command.test.ts
 *
 * REAL-VS-MOCK POLICY: unlike memory-command.ts (a structural-seam module),
 * profile-command.ts is central-integration glue whose whole job is driving
 * the REAL Phase-5 engines — extraction, the dialectic store, the guarded
 * memory bridge, the independent auditor, and the convergence bench. So
 * these tests run the real thing end to end: a real UserModelStore persisted
 * to a temp dir, a real ProfileMemoryBridge over a real GuardedMemoryStore,
 * a real InMemorySessionStore, real regex extraction over real transcripts,
 * and (for the tamper test) a real on-disk perturbation of the persisted
 * profile that the real auditor must catch. Nothing is stubbed.
 * ------------------------------------------------------------------ */
import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProfileCommand } from "../profile-command";
import type { ProfileCommandDeps } from "../profile-command";
import { HadesCli } from "../cli";
import { UserModelStore, ProfileMemoryBridge } from "../../memory/user-model-store";
import type { PersistedProfile } from "../../memory/user-model-store";
import { GuardedMemoryStore } from "../../memory/guard";
import { InMemoryMemoryStore } from "../../memory/store";
import { InMemorySessionStore } from "../../memory/session-store";

function makeDeps(opts: { bridgeFloor?: number; path?: string } = {}): {
  deps: ProfileCommandDeps;
  store: UserModelStore;
  memory: GuardedMemoryStore;
  sessions: InMemorySessionStore;
  path: string;
} {
  const path = opts.path ?? join(mkdtempSync(join(tmpdir(), "hades-profile-cmd-")), "user-model.json");
  const store = new UserModelStore({ path });
  const memory = new GuardedMemoryStore(new InMemoryMemoryStore());
  const bridge = new ProfileMemoryBridge({ store, memory, assertFloor: opts.bridgeFloor ?? 0.5 });
  const sessions = new InMemorySessionStore();
  return { deps: { store, bridge, sessions }, store, memory, sessions, path };
}

/** Append `content` as one real user message (plus an assistant ack so the
 *  transcript looks like a genuine exchange) and return the session id. */
function addSession(sessions: InMemorySessionStore, content: string, at: number): string {
  const s = sessions.create({ title: "test session" });
  sessions.append(s.id, { role: "user", content, at });
  sessions.append(s.id, { role: "assistant", content: "Noted.", at: at + 1000 });
  return s.id;
}

/** Drive two real learn passes (two sessions restating the same facts) so
 *  the beliefs clear the model's assert floor via genuine reinforcement. */
async function learnTwice(deps: ProfileCommandDeps, sessions: InMemorySessionStore): Promise<void> {
  const now = Date.now();
  const s1 = addSession(sessions, "My name is Alice.\nI live in Berlin.", now - 60 * 60 * 1000);
  const s2 = addSession(sessions, "My name is Alice.\nI live in Berlin.", now - 30 * 60 * 1000);
  const r1 = await runProfileCommand(deps, ["learn", s1]);
  const r2 = await runProfileCommand(deps, ["learn", s2]);
  expect(r1.code).toBe(0);
  expect(r2.code).toBe(0);
}

// ===========================================================================
// help / dispatch
// ===========================================================================

describe("help / dispatch", () => {
  it("prints usage on no args, help, --help, -h", async () => {
    const { deps } = makeDeps();
    for (const args of [[], ["help"], ["--help"], ["-h"]]) {
      const res = await runProfileCommand(deps, args);
      expect(res.code).toBe(0);
      const text = res.lines.join("\n");
      for (const sub of ["show", "why", "learn", "sync", "audit", "bench"]) {
        expect(text).toContain(sub);
      }
    }
  });

  it("rejects an unknown subcommand with code 1", async () => {
    const { deps } = makeDeps();
    const res = await runProfileCommand(deps, ["frobnicate"]);
    expect(res.code).toBe(1);
    expect(res.lines[0]).toContain("Unknown profile command");
  });
});

// ===========================================================================
// show
// ===========================================================================

describe("show", () => {
  it("reports an empty model honestly", async () => {
    const { deps } = makeDeps();
    const res = await runProfileCommand(deps, ["show"]);
    expect(res.code).toBe(0);
    expect(res.lines.join("\n")).toContain("No verified model of the user yet.");
  });

  it("rejects unexpected extra arguments", async () => {
    const { deps } = makeDeps();
    const res = await runProfileCommand(deps, ["show", "extra"]);
    expect(res.code).toBe(1);
  });

  it("after real learning, lists asserted beliefs with status and evidence counts", async () => {
    const { deps, sessions } = makeDeps();
    await learnTwice(deps, sessions);
    const res = await runProfileCommand(deps, ["show"]);
    expect(res.code).toBe(0);
    const text = res.lines.join("\n");
    expect(text).toContain("identity.name");
    expect(text).toContain("alice");
    expect(text).toContain("identity.location");
    expect(text).toContain("berlin");
    expect(text).toContain("asserted");
  });

  it("--json exposes beliefs, ledger root, and load issues as parseable JSON", async () => {
    const { deps, sessions, store } = makeDeps();
    await learnTwice(deps, sessions);
    const res = await runProfileCommand(deps, ["show", "--json"]);
    expect(res.code).toBe(0);
    const payload = JSON.parse(res.lines.join("\n")) as {
      beliefs: Array<{ attribute: string; value: string | null; status: string; evidenceCount: number }>;
      ledgerRoot: string;
      loadIssues: string[];
    };
    expect(payload.ledgerRoot).toBe(store.ledger.root());
    expect(payload.loadIssues).toEqual([]);
    const name = payload.beliefs.find((b) => b.attribute === "identity.name");
    expect(name).toBeDefined();
    expect(name!.status).toBe("asserted");
    expect(name!.value).toBe("alice");
    expect(name!.evidenceCount).toBe(2);
  });
});

// ===========================================================================
// learn
// ===========================================================================

describe("learn", () => {
  it("requires a session id", async () => {
    const { deps } = makeDeps();
    const res = await runProfileCommand(deps, ["learn"]);
    expect(res.code).toBe(1);
    expect(res.lines[0]).toContain("Usage:");
  });

  it("errors on a nonexistent session", async () => {
    const { deps } = makeDeps();
    const res = await runProfileCommand(deps, ["learn", "no-such-session"]);
    expect(res.code).toBe(1);
    expect(res.lines[0]).toContain("No such session");
  });

  it("extracts real assertions and reports dialectic decisions (created, then reinforced)", async () => {
    const { deps, sessions } = makeDeps();
    const now = Date.now();
    const s1 = addSession(sessions, "My name is Alice.", now - 60_000);
    const r1 = await runProfileCommand(deps, ["learn", s1]);
    expect(r1.code).toBe(0);
    expect(r1.lines.join("\n")).toContain("created");

    const s2 = addSession(sessions, "My name is Alice.", now - 30_000);
    const r2 = await runProfileCommand(deps, ["learn", s2]);
    expect(r2.code).toBe(0);
    expect(r2.lines.join("\n")).toContain("reinforced");
  });

  it("reports honestly when a session yields no assertions (assistant-only transcript)", async () => {
    const { deps, sessions } = makeDeps();
    const s = sessions.create({ title: "assistant only" });
    sessions.append(s.id, { role: "assistant", content: "My name is HAL and I live in Space.", at: Date.now() });
    const res = await runProfileCommand(deps, ["learn", s.id]);
    expect(res.code).toBe(0);
    expect(res.lines.join("\n")).toContain("No belief assertions extracted");
  });

  it("--sync runs the guarded memory bridge in the same invocation", async () => {
    const { deps, sessions, memory } = makeDeps();
    const now = Date.now();
    const s1 = addSession(sessions, "My name is Alice.", now - 60_000);
    await runProfileCommand(deps, ["learn", s1]);
    const s2 = addSession(sessions, "My name is Alice.", now - 30_000);
    const res = await runProfileCommand(deps, ["learn", s2, "--sync"]);
    expect(res.code).toBe(0);
    expect(res.lines.join("\n")).toMatch(/Sync: \d+ written/);
    const written = memory.all().filter((r) => r.tags.includes("user-model"));
    expect(written.length).toBe(1);
    expect(written[0].fact).toBe("The user's identity.name is alice.");
  });
});

// ===========================================================================
// why
// ===========================================================================

describe("why", () => {
  it("requires an attribute", async () => {
    const { deps } = makeDeps();
    const res = await runProfileCommand(deps, ["why"]);
    expect(res.code).toBe(1);
  });

  it("errors with the known-attribute list on a miss", async () => {
    const { deps, sessions } = makeDeps();
    await learnTwice(deps, sessions);
    const res = await runProfileCommand(deps, ["why", "identity.timezone"]);
    expect(res.code).toBe(1);
    expect(res.lines.join("\n")).toContain("identity.name");
  });

  it("prints the full evidence trail for a real belief", async () => {
    const { deps, sessions } = makeDeps();
    await learnTwice(deps, sessions);
    const res = await runProfileCommand(deps, ["why", "identity.name"]);
    expect(res.code).toBe(0);
    const text = res.lines.join("\n");
    expect(text).toContain("attribute:   identity.name");
    expect(text).toContain("alice");
    expect(text).toContain("T4-consistency");
    expect(text).toContain("My name is Alice.");
    expect(text).toContain("supports");
  });

  it("--json exposes evidence with polarity/tier/weight per entry", async () => {
    const { deps, sessions } = makeDeps();
    await learnTwice(deps, sessions);
    const res = await runProfileCommand(deps, ["why", "identity.name", "--json"]);
    expect(res.code).toBe(0);
    const payload = JSON.parse(res.lines.join("\n")) as {
      attribute: string;
      status: string;
      evidence: Array<{ polarity: string; tier: string; weight: number; excerpt: string; certificateValid: boolean }>;
    };
    expect(payload.attribute).toBe("identity.name");
    expect(payload.status).toBe("asserted");
    expect(payload.evidence.length).toBe(2);
    for (const e of payload.evidence) {
      expect(e.polarity).toBe("supports");
      expect(e.tier).toBe("T4-consistency");
      expect(e.weight).toBeGreaterThan(0);
      expect(e.weight).toBeLessThanOrEqual(0.6);
      expect(e.excerpt).toBe("My name is Alice.");
      expect(e.certificateValid).toBe(false);
    }
  });
});

// ===========================================================================
// sync
// ===========================================================================

describe("sync", () => {
  it("is idempotent: second sync skips what the first wrote", async () => {
    const { deps, sessions, memory } = makeDeps();
    await learnTwice(deps, sessions);

    const first = await runProfileCommand(deps, ["sync", "--json"]);
    expect(first.code).toBe(0);
    const firstOutcomes = JSON.parse(first.lines.join("\n")) as Array<{ attribute: string; action: string; reason: string | null }>;
    expect(firstOutcomes.filter((o) => o.action === "written").length).toBe(2);

    const second = await runProfileCommand(deps, ["sync", "--json"]);
    const secondOutcomes = JSON.parse(second.lines.join("\n")) as Array<{ attribute: string; action: string; reason: string | null }>;
    expect(secondOutcomes.every((o) => o.action === "skipped")).toBe(true);
    expect(secondOutcomes.some((o) => o.reason === "already written to memory")).toBe(true);

    const written = memory.all().filter((r) => r.tags.includes("user-model"));
    expect(written.length).toBe(2);
  });

  it("reports below-floor beliefs as skipped with the real reason", async () => {
    const { deps, sessions } = makeDeps({ bridgeFloor: 0.99 });
    await learnTwice(deps, sessions);
    const res = await runProfileCommand(deps, ["sync"]);
    expect(res.code).toBe(0);
    const text = res.lines.join("\n");
    expect(text).toMatch(/Sync: 0 written, 0 quarantined, \d+ skipped/);
    expect(text).toContain("below assertFloor");
  });
});

// ===========================================================================
// audit
// ===========================================================================

describe("audit", () => {
  it("passes (exit 0) on a clean, really-learned model", async () => {
    const { deps, sessions } = makeDeps();
    await learnTwice(deps, sessions);
    const res = await runProfileCommand(deps, ["audit"]);
    expect(res.code).toBe(0);
    const text = res.lines.join("\n");
    expect(text).toMatch(/passed:\s+true/);
    expect(text).toContain("No findings");
  });

  it("--json returns the full verifier report", async () => {
    const { deps, sessions } = makeDeps();
    await learnTwice(deps, sessions);
    const res = await runProfileCommand(deps, ["audit", "--json"]);
    expect(res.code).toBe(0);
    const report = JSON.parse(res.lines.join("\n")) as {
      verifierId: string;
      passed: boolean;
      findings: unknown[];
      beliefsAudited: number;
      evidenceAudited: number;
    };
    expect(report.verifierId).toBe("verify.user-model");
    expect(report.passed).toBe(true);
    expect(report.findings).toEqual([]);
    expect(report.beliefsAudited).toBe(2);
    expect(report.evidenceAudited).toBe(4);
  });

  it("fails (exit 1) when the persisted evidence is tampered upward on disk — caught via the ledger cross-check", async () => {
    const { deps, sessions, path } = makeDeps();
    await learnTwice(deps, sessions);

    // Real on-disk perturbation: inflate one snapshot evidence weight. The
    // model honestly re-derives confidence from the tampered weight on load,
    // so only the hash-chained ledger cross-check can catch the lie.
    const profile = JSON.parse(readFileSync(path, "utf8")) as PersistedProfile;
    profile.snapshot.beliefs[0].evidence[0].weight = 0.99;
    writeFileSync(path, JSON.stringify(profile), "utf8");

    const fresh = makeDeps({ path });
    const res = await runProfileCommand(fresh.deps, ["audit"]);
    expect(res.code).toBe(1);
    expect(res.lines.join("\n")).toContain("ledger-mismatch");
  });
});

// ===========================================================================
// bench
// ===========================================================================

describe("bench", () => {
  it("runs the real convergence bench and reports convergence + audit honestly", async () => {
    const { deps } = makeDeps();
    const workDir = mkdtempSync(join(tmpdir(), "hades-profile-bench-test-"));
    const res = await runProfileCommand({ ...deps, benchWorkDir: () => workDir }, ["bench"]);
    expect(res.code).toBe(0);
    const text = res.lines.join("\n");
    expect(text).toContain("scripted");
    expect(text).toMatch(/converged:\s+true/);
    expect(text).toMatch(/audit passed:\s+true/);
    expect(text).toContain("identity.name");
    expect(text).toContain("lisbon");
  });

  it("--json returns the full measured report", async () => {
    const { deps } = makeDeps();
    const workDir = mkdtempSync(join(tmpdir(), "hades-profile-bench-json-"));
    const res = await runProfileCommand({ ...deps, benchWorkDir: () => workDir }, ["bench", "--json"]);
    expect(res.code).toBe(0);
    const report = JSON.parse(res.lines.join("\n")) as {
      sessionsRun: number;
      converged: boolean;
      quarantines: number;
      audit: { passed: boolean };
      durationMs: number;
    };
    expect(report.sessionsRun).toBe(9);
    expect(report.converged).toBe(true);
    expect(report.audit.passed).toBe(true);
    expect(report.durationMs).toBeGreaterThan(0);
  });
});

// ===========================================================================
// HadesCli routing (lazy profile factory)
// ===========================================================================

describe("HadesCli profile routing", () => {
  it("reports an unconfigured profile honestly", async () => {
    const cli = new HadesCli({});
    const res = await cli.run(["profile", "show"]);
    expect(res.code).toBe(1);
    expect(res.lines[0]).toContain("not configured");
  });

  it("builds the profile deps lazily, once, and routes subcommands to the real command", async () => {
    const { deps } = makeDeps();
    const factory = vi.fn(() => deps);
    const cli = new HadesCli({ profile: factory });

    expect(factory).not.toHaveBeenCalled();
    const help = await cli.run(["help"]);
    expect(help.code).toBe(0);
    expect(factory).not.toHaveBeenCalled();

    const show = await cli.run(["profile", "show"]);
    expect(show.code).toBe(0);
    expect(show.lines.join("\n")).toContain("No verified model of the user yet.");
    await cli.run(["profile", "show"]);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("surfaces a throwing profile factory as an error result, not a crash", async () => {
    const cli = new HadesCli({ profile: () => { throw new Error("profile store unavailable"); } });
    const res = await cli.run(["profile", "show"]);
    expect(res.code).toBe(1);
    expect(res.lines[0]).toContain("profile store unavailable");
  });

  it("lists profile in the top-level help", async () => {
    const cli = new HadesCli({});
    const res = await cli.run(["help"]);
    expect(res.lines.join("\n")).toContain("profile <sub>");
  });
});
