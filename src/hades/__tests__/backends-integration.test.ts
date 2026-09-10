/**
 * Central-integration tests for the Phase-6 backend fleet: proves the new
 * modules are wired into the REAL product surfaces, not dead code.
 *
 *  1. `buildHadesCli` (the exact composition the `hades` bin uses) routes
 *     `hades backends <sub>` to a real BackendManager carrying the REAL
 *     LocalProcessBackend + DockerBackend, with the STYX provenance ledger
 *     attached — and a full provision→hibernate→wake→terminate walk through
 *     the CLI drives a GENUINE OS child process (SIGSTOP/SIGCONT for real).
 *  2. `toolVerifiers()` / `calibrationTable()` — the ONE registry the product
 *     consults — carry `verify.backends`, consistently with
 *     `backendsFleetCalibration()`.
 *  3. A genuine fleet report built from a real manager+ledger walk passes
 *     `verify.backends` at exactly its calibrated prior; a tampered record
 *     fails it. No fabricated hashes anywhere — the chain is really walked.
 *  4. `hades bench parity` is reachable and honest about real-vs-fake
 *     transports.
 *
 * REAL vs FAKE in this file: the local backend runs genuine child processes
 * (real transport); docker availability is whatever the real `docker version`
 * probe says (asserted only as "an honest yes/no", never assumed); the
 * serverless/remote rows inside `bench parity` are in-file fakes and are
 * asserted to be LABELED as such.
 */
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { buildHadesCli } from "../cli/build";
import { loadConfig } from "../config/config";
import { runBenchCommand } from "../cli/bench-command";
import { toolVerifiers, calibrationTable } from "../tools/verifiers";
import { backendsFleetCalibration } from "../backends/verifier";
import type { BackendFleetReport } from "../backends/verifier";
import { BackendManager } from "../backends/manager";
import { LocalProcessBackend } from "../backends/local";
import { BackendProvenanceLedger, ledgerEventSink } from "../backends/provenance";
import type { BackendLifecycleRecord } from "../backends/provenance";

describe("hades backends through the real built CLI", () => {
  it("routes `backends list` to a fleet with the REAL local + docker adapters", async () => {
    const cli = buildHadesCli(loadConfig(), { persist: false });
    const res = await cli.run(["backends", "list"]);
    expect(res.code).toBe(0);
    const out = res.lines.join("\n");
    // Both real adapters are registered.
    expect(out).toContain("local");
    expect(out).toContain("docker");
    // Availability is an honest probe result: local is always yes; docker is
    // whatever the real `docker version` probe said (yes OR no — never assumed).
    const localRow = res.lines.find((l) => l.startsWith("local"));
    const dockerRow = res.lines.find((l) => l.startsWith("docker"));
    expect(localRow).toMatch(/\byes\b/);
    expect(dockerRow).toMatch(/\b(yes|no)\b/);
    // Cost columns are explicitly labeled as configured rates, never measured prices.
    expect(out).toContain("(configured rate)");
  });

  it("`backends help` and the top-level help both surface the subcommand", async () => {
    const cli = buildHadesCli(loadConfig(), { persist: false });
    const help = await cli.run(["backends", "help"]);
    expect(help.code).toBe(0);
    expect(help.lines.join("\n")).toContain("hades backends <command>");
    const top = await cli.run(["help"]);
    expect(top.lines.join("\n")).toContain("backends <sub>");
  });

  it("drives a GENUINE local child process through provision→hibernate→wake→terminate, ledgered end to end", async () => {
    const cli = buildHadesCli(loadConfig(), { persist: false });
    const worker = "it-worker-1";
    try {
      const prov = await cli.run(["backends", "provision", "--backend", "local", "--worker", worker]);
      expect(prov.code).toBe(0);
      const provOut = prov.lines.join("\n");
      // No HADES_BACKEND_MANAGER_URL/AUTH_TOKEN in the test env — the CLI must
      // say so honestly rather than passing a placeholder off as real.
      expect(provOut).toContain("(placeholder)");
      expect(provOut).toContain(`Provisioned ${worker} on local`);
      // The nativeId is a real OS pid of a really-spawned child.
      const pid = Number(/nativeId=(\d+)/.exec(provOut)?.[1]);
      expect(Number.isInteger(pid) && pid > 0).toBe(true);
      expect(() => process.kill(pid, 0)).not.toThrow(); // genuinely alive

      const st1 = await cli.run(["backends", "status", worker]);
      expect(st1.lines[0]).toContain("running");

      const hib = await cli.run(["backends", "hibernate", worker]);
      expect(hib.code).toBe(0);
      const st2 = await cli.run(["backends", "status", worker]);
      expect(st2.lines[0]).toContain("hibernated");

      const wake = await cli.run(["backends", "wake", worker]);
      expect(wake.code).toBe(0);
      const st3 = await cli.run(["backends", "status", worker]);
      expect(st3.lines[0]).toContain("running");
    } finally {
      const term = await cli.run(["backends", "terminate", worker]);
      expect(term.code).toBe(0);
    }

    // Every lifecycle event above landed in the hash-chained ledger, and the
    // chain re-verifies through the same CLI surface.
    const verify = await cli.run(["backends", "verify"]);
    expect(verify.code).toBe(0);
    const vOut = verify.lines.join("\n");
    expect(vOut).toContain("ok:     true");
    const length = Number(/length: (\d+)/.exec(vOut)?.[1]);
    expect(length).toBeGreaterThanOrEqual(4); // provision+hibernate+wake+terminate at minimum
  }, 30_000);

  it("persists the fleet crash-consistently and `reconcile` probes stored handles against runtime truth", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "hades-backends-"));
    const worker = "persist-worker-1";
    const config = loadConfig({ overrides: { dataDir } });
    const cli1 = buildHadesCli(config);
    try {
      const prov = await cli1.run(["backends", "provision", "--backend", "local", "--worker", worker]);
      expect(prov.code).toBe(0);

      // The mutating subcommand atomically saved the live fleet to disk.
      const fleetPath = join(dataDir, "fleet.json");
      expect(existsSync(fleetPath)).toBe(true);
      const persisted = JSON.parse(readFileSync(fleetPath, "utf8")) as {
        version: number;
        handles: Array<{ workerId: string; state: string }>;
      };
      expect(persisted.version).toBe(1);
      expect(persisted.handles).toHaveLength(1);
      expect(persisted.handles[0].workerId).toBe(worker);
      expect(persisted.handles[0].state).toBe("running");

      // A separately-built CLI (fresh-process simulation) reconciles the
      // stored belief against runtime truth: its own fresh local backend never
      // tracked that worker, but the child process is GENUINELY still alive,
      // so the pid probe must report "running" — not blanket-claim "stopped"
      // for a live orphan (the exact lie the cycle-1 audit fixed).
      const cli2 = buildHadesCli(config);
      const rec = await cli2.run(["backends", "reconcile"]);
      expect(rec.code).toBe(0);
      const out = rec.lines.join("\n");
      expect(out).toContain("restored:  1");
      expect(out).toContain(`${worker}: running (backend=local)`);
      expect(out).toContain("corrected: 0");
    } finally {
      // Tear the real child process down through the CLI that owns it.
      const term = await cli1.run(["backends", "terminate", worker]);
      expect(term.code).toBe(0);
      // Termination is itself persisted: the stored fleet is now empty.
      const persisted = JSON.parse(readFileSync(join(dataDir, "fleet.json"), "utf8")) as { handles: unknown[] };
      expect(persisted.handles).toHaveLength(0);
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("verify on a fresh build reports a valid chain carrying exactly the two registration events", async () => {
    const cli = buildHadesCli(loadConfig(), { persist: false });
    const res = await cli.run(["backends", "verify"]);
    expect(res.code).toBe(0);
    // Registering local + docker is itself ledgered (2 records) — the chain
    // is never silently empty when real registration events occurred.
    expect(res.lines.join("\n")).toContain("length: 2");
    expect(res.lines.join("\n")).toContain("ok:     true");
  });
});

describe("verify.backends in the ONE verifier registry", () => {
  it("toolVerifiers()/calibrationTable() carry verify.backends, consistently", () => {
    const v = toolVerifiers().get("verify.backends");
    expect(v).toBeDefined();
    expect(v!.verifierId).toBe("verify.backends");
    expect(v!.toolName).toBe("backends");
    expect(calibrationTable()["verify.backends"]).toEqual(backendsFleetCalibration());
  });

  it("a GENUINE report from a real manager+ledger lifecycle walk passes at exactly its prior; a tampered record fails", async () => {
    const ledger = new BackendProvenanceLedger();
    const manager = new BackendManager({ onEvent: ledgerEventSink(ledger) });
    manager.register(new LocalProcessBackend({ name: "local", graceMs: 100 }), {
      name: "local",
      kind: "local",
      capabilities: ["shell"],
      cost: { perRunningHourUsd: 0, perHibernatedHourUsd: 0, perProvisionUsd: 0, source: "configured" },
      supportsHibernate: true,
      locality: "local",
    });
    const spec = {
      workerId: "verifier-walk-1",
      capabilities: [],
      managerUrl: "http://127.0.0.1:0/test",
      authToken: "test-token",
    };
    await manager.provision(spec);
    await manager.hibernate(spec.workerId);
    await manager.wake(spec.workerId);
    await manager.terminate(spec.workerId);

    const availability = await manager.probeAll();
    const report: BackendFleetReport = {
      backends: manager.descriptors().map((d) => ({ name: d.name, kind: d.kind, available: availability[d.name] })),
      handles: manager.list().map(({ handle }) => ({ workerId: handle.workerId, backend: handle.backend, state: handle.state })),
      certificate: ledger.toCertificateFields(),
      records: ledger.records() as BackendLifecycleRecord[],
    };

    const verifier = toolVerifiers().get("verify.backends")!;
    const verdict = verifier.verify("fleet status", { ok: true, output: JSON.stringify(report) });
    expect(verdict.passed).toBe(true);
    expect(verdict.reasons).toEqual([]);
    expect(Math.abs(verdict.confidence - backendsFleetCalibration().prior)).toBeLessThan(1e-12);

    // Tamper with one record's detail post-hoc: the same registry entry must catch it.
    const tampered: BackendFleetReport = JSON.parse(JSON.stringify(report));
    const target = tampered.records[Math.floor(tampered.records.length / 2)];
    target.workerId = "forged-worker";
    const bad = verifier.verify("fleet status", { ok: true, output: JSON.stringify(tampered) });
    expect(bad.passed).toBe(false);
    expect(bad.reasons).toContain("chain-recompute");
  }, 30_000);
});

describe("hades bench parity route", () => {
  it("runs the real parity bench and stays honest about real-vs-fake transports", async () => {
    const res = await runBenchCommand(["parity"]);
    const out = res.lines.join("\n");
    expect(res.code).toBe(0);
    // Real local child process row.
    expect(out).toMatch(/local\s+local\s+real/);
    // Fake-transport rows are labeled fake, never real.
    expect(out).toMatch(/modal\s+serverless\s+fake/);
    expect(out).toMatch(/ssh\s+ssh\s+fake/);
    // Docker was not opted in — it must be skipped without probing, not faked.
    expect(out).toContain("includeDocker not set");
    expect(out).not.toMatch(/docker\s+container/);
    // The provenance chain over the whole run really verified.
    expect(out).toContain("verified=true");
    expect(out).toContain("all lifecycles complete: true");
  }, 60_000);

  it("bench help lists the parity subcommand", async () => {
    const res = await runBenchCommand(["help"]);
    expect(res.lines.join("\n")).toContain("parity [--docker]");
  });
});
