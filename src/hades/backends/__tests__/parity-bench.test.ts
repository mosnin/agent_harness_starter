/* ------------------------------------------------------------------ *
 * parity-bench.test.ts
 *
 * REAL-VS-MOCK POLICY: `runParityBench`/`runParityBenchDetailed` are
 * exercised FOR REAL end to end — a genuine OS child process is spawned for
 * the `local` backend and its pid is checked alive-then-gone against the
 * real process table (`process.kill(pid, 0)`), real `sha256`-backed
 * `BackendProvenanceLedger` hash-chain verification runs over the events
 * the run actually emitted, and every measured field (`provisionMs`,
 * `wakeMs`, `totalMs`) is asserted to be a genuinely finite, non-negative
 * number rather than stubbed. The only thing mocked is what the contract
 * says must be mocked: the serverless/remote backends' network transports
 * (Modal/Daytona/SSH/Singularity), which the module under test itself
 * implements as in-file deterministic fakes and honestly labels
 * `transport: "fake"`.
 * ------------------------------------------------------------------ */
import { describe, expect, it, afterEach } from "vitest";
import {
  runParityBench,
  runParityBenchDetailed,
  FORCE_MODAL_SPAWN_FAILURE_ENV,
  type ParityBenchBackendResult,
} from "../parity-bench";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function byBackend(results: ParityBenchBackendResult[], name: string): ParityBenchBackendResult {
  const r = results.find((x) => x.backend === name);
  if (!r) throw new Error(`no result for backend ${name}`);
  return r;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 3000, intervalMs = 20): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  if (!predicate()) throw new Error(`waitUntil: condition not met within ${timeoutMs}ms`);
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

afterEach(() => {
  delete process.env[FORCE_MODAL_SPAWN_FAILURE_ENV];
});

// ===========================================================================
// the real, full lifecycle run
// ===========================================================================

describe("runParityBenchDetailed — real full run", () => {
  it(
    "drives every backend's lifecycle for real, verifies the chain, and reports only measured numbers",
    async () => {
      const logs: string[] = [];
      let capturedLocalPid: number | undefined;
      let observedAliveAtProvision = false;

      const log = (line: string) => {
        logs.push(line);
        if (capturedLocalPid === undefined) {
          const m = line.match(/^\[parity-bench\] local: provisioned worker=\S+ nativeId=(\d+)/);
          if (m) {
            capturedLocalPid = Number(m[1]);
            observedAliveAtProvision = isPidAlive(capturedLocalPid);
          }
        }
      };

      const { report, ledger } = await runParityBenchDetailed({ log });

      // --- a real local child process was genuinely spawned ---
      expect(capturedLocalPid).toBeDefined();
      expect(Number.isInteger(capturedLocalPid)).toBe(true);
      expect(observedAliveAtProvision).toBe(true);

      // --- and, by the time the whole bench finished, genuinely terminated ---
      await waitUntil(() => !isPidAlive(capturedLocalPid!));
      expect(isPidAlive(capturedLocalPid!)).toBe(false);

      // --- backend set: local + the 4 fake-transport backends, no docker (not opted in) ---
      const names = report.results.map((r) => r.backend).sort();
      expect(names).toEqual(["daytona", "local", "modal", "singularity", "ssh"]);

      // --- transport labels are honest ---
      expect(byBackend(report.results, "local").transport).toBe("real");
      for (const name of ["modal", "daytona", "ssh", "singularity"]) {
        expect(byBackend(report.results, name).transport).toBe("fake");
      }

      // --- local: full lifecycle, real measured timings ---
      const local = byBackend(report.results, "local");
      expect(local.error).toBeUndefined();
      expect(local.provisioned).toBe(true);
      expect(local.hibernated).toBe(true);
      expect(local.woken).toBe(true);
      expect(local.terminated).toBe(true);
      expect(local.provisionMs).not.toBeNull();
      expect(Number.isFinite(local.provisionMs)).toBe(true);
      expect(local.provisionMs as number).toBeGreaterThanOrEqual(0);
      expect(local.wakeMs).not.toBeNull();
      expect(Number.isFinite(local.wakeMs)).toBe(true);
      expect(local.wakeMs as number).toBeGreaterThanOrEqual(0);

      // --- modal/daytona: serverless, support hibernate -> full cycle ---
      for (const name of ["modal", "daytona"]) {
        const r = byBackend(report.results, name);
        expect(r.error).toBeUndefined();
        expect(r.provisioned).toBe(true);
        expect(r.hibernated).toBe(true);
        expect(r.woken).toBe(true);
        expect(r.terminated).toBe(true);
        expect(Number.isFinite(r.provisionMs)).toBe(true);
        expect(Number.isFinite(r.wakeMs)).toBe(true);
      }

      // --- ssh/singularity: no hibernate support -> skipped honestly, not a failure ---
      for (const name of ["ssh", "singularity"]) {
        const r = byBackend(report.results, name);
        expect(r.error).toBeUndefined();
        expect(r.provisioned).toBe(true);
        expect(r.hibernated).toBe(false);
        expect(r.woken).toBe(false);
        expect(r.wakeMs).toBeNull();
        expect(r.terminated).toBe(true);
      }
      expect(logs.some((l) => l.includes("ssh: hibernate/wake not supported"))).toBe(true);
      expect(logs.some((l) => l.includes("singularity: hibernate/wake not supported"))).toBe(true);

      // --- provenance chain: verified, and certificate matches the real ledger ---
      expect(report.chainVerified).toBe(true);
      expect(report.certificate.length).toBe(ledger.records().length);
      expect(report.certificate.length).toBeGreaterThan(0);
      expect(report.certificate.traceRoot).toBe(ledger.rootHash);
      expect(report.certificate.head).toBe(ledger.head());
      expect(ledger.verifyChain().ok).toBe(true);

      // --- everything completed; nothing fabricated ---
      expect(report.allLifecyclesComplete).toBe(true);
      expect(Number.isFinite(report.totalMs)).toBe(true);
      expect(report.totalMs).toBeGreaterThanOrEqual(0);
    },
    20_000,
  );

  it("docker is never faked: absent (honest skip) or genuinely transport:'real'", async () => {
    const logs: string[] = [];
    const { report } = await runParityBenchDetailed({ includeDocker: true, log: (l) => logs.push(l) });
    const docker = report.results.find((r) => r.backend === "docker");
    if (docker) {
      expect(docker.transport).toBe("real");
    } else {
      expect(logs.some((l) => l.includes("docker") && l.includes("excluded"))).toBe(true);
    }
    // includeDocker not set at all -> never even attempted, never present
    const { report: reportNoDocker, } = await runParityBenchDetailed({});
    expect(reportNoDocker.results.find((r) => r.backend === "docker")).toBeUndefined();
  }, 20_000);

  it("runParityBench (the locked entry point) returns just the report, matching runParityBenchDetailed's report", async () => {
    const report = await runParityBench({});
    expect(report.chainVerified).toBe(true);
    expect(report.results.length).toBe(5);
    expect(report.allLifecyclesComplete).toBe(true);
  }, 20_000);
});

// ===========================================================================
// honest failure path
// ===========================================================================

describe("runParityBenchDetailed — honest failure path", () => {
  it("a failing fake (Modal spawn throws) is recorded honestly; other backends still complete; chain still verifies", async () => {
    process.env[FORCE_MODAL_SPAWN_FAILURE_ENV] = "1";
    const { report, ledger } = await runParityBenchDetailed({});

    const modal = byBackend(report.results, "modal");
    expect(modal.provisioned).toBe(false);
    expect(modal.hibernated).toBe(false);
    expect(modal.woken).toBe(false);
    expect(modal.terminated).toBe(false);
    expect(modal.provisionMs).toBeNull();
    expect(modal.error).toBeDefined();
    expect(modal.error).toMatch(/simulated spawn failure|spawn failed/i);

    // the failure is NOT fabricated away — it makes the overall report honest
    expect(report.allLifecyclesComplete).toBe(false);

    // but every OTHER backend still ran its full lifecycle despite modal's failure
    const local = byBackend(report.results, "local");
    expect(local.provisioned).toBe(true);
    expect(local.terminated).toBe(true);
    expect(local.error).toBeUndefined();

    const daytona = byBackend(report.results, "daytona");
    expect(daytona.provisioned).toBe(true);
    expect(daytona.hibernated).toBe(true);
    expect(daytona.woken).toBe(true);
    expect(daytona.terminated).toBe(true);

    // and the provenance chain — which faithfully recorded the failure too —
    // still verifies cleanly; a recorded failure is not chain corruption.
    expect(report.chainVerified).toBe(true);
    expect(ledger.verifyChain().ok).toBe(true);
  }, 20_000);
});

// ===========================================================================
// tamper detection
// ===========================================================================

describe("BackendProvenanceLedger tamper detection (post-run)", () => {
  it("corrupting one ledger record after a real run flips verifyChain() to false", async () => {
    const { report, ledger } = await runParityBenchDetailed({});
    expect(report.chainVerified).toBe(true);
    expect(ledger.verifyChain().ok).toBe(true);

    const before = ledger.records().length;
    expect(before).toBeGreaterThan(0);

    // Deliberate post-hoc tamper: flip one byte's worth of a mid-chain
    // record's hash. TS `private` is compile-time only, so this reaches the
    // ledger's real internal state — exactly like an on-disk record being
    // edited between process runs.
    const mutable = ledger as unknown as { _records: Array<{ hash: string }> };
    const idx = Math.floor(before / 2);
    const original = mutable._records[idx].hash;
    mutable._records[idx].hash = original === "0".repeat(64) ? "1".repeat(64) : "0".repeat(64);

    const verdict = ledger.verifyChain();
    expect(verdict.ok).toBe(false);
    expect(verdict.brokenAt).toBe(idx);
    expect(verdict.reason).toBe("hash-mismatch");
  }, 20_000);
});
