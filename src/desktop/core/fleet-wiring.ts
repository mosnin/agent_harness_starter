/**
 * Central wiring for the desktop fleet surface: composes the REAL
 * remote-compute stack (`src/hades/backends/*`) behind a `FleetService`
 * (`./fleet-service.ts`) the sidecar can hand `fleet.*` commands to.
 *
 * What gets composed (nothing here is a stub):
 *
 * - A real `BackendManager` registered with the same two real backends the
 *   `hades backends` CLI wires (`src/hades/cli/build.ts`): `LocalProcessBackend`
 *   (genuine OS child processes) and `DockerBackend` (shells out to the real
 *   `docker` CLI; availability decided by a real `docker version` probe).
 *   Cost rates are all-zero and tagged `source: "configured"` — your own
 *   machine, no fabricated prices.
 * - A real `BackendProvenanceLedger`: every manager lifecycle event lands in
 *   the same STYX hash-chained ledger `hades backends verify` re-walks.
 * - A real `FleetSupervisor` (`src/hades/backends/fleet-supervisor.ts`)
 *   layered on top: hibernate/wake/terminate go through its LifecycleMachine
 *   (legality, idempotency, wake retry/backoff, concurrent-wake guard) and
 *   every mutation is crash-consistently persisted via a `HandleStore` at
 *   `<dataDir>/fleet.json` — the SAME file the CLI persists to, so the
 *   desktop and the terminal see one fleet.
 * - The `FleetPort` adapter maps reads to the manager and mutations +
 *   `lifecycleMap()` to the supervisor, which is exactly the "richer
 *   lifecycle supervisor layered on top" hook `FleetService` was built for.
 *
 * KNOWN LIMIT (honest): `RemoteBackendRegistry` has no public way to adopt a
 * handle that was provisioned by a previous process, so `restore()` can
 * re-track lifecycle states but cannot re-attach those workers to the live
 * registry — workers provisioned in an earlier session are reconciled and
 * reported, not resurrected. Registry adoption is a next-cycle item.
 */

import { BackendManager } from "../../hades/backends/manager";
import type { BackendDescriptor } from "../../hades/backends/descriptor";
import { LocalProcessBackend } from "../../hades/backends/local";
import { DockerBackend } from "../../hades/backends/docker";
import { BackendProvenanceLedger, ledgerEventSink } from "../../hades/backends/provenance";
import { HandleStore } from "../../hades/backends/handle-store";
import { FleetSupervisor } from "../../hades/backends/fleet-supervisor";
import { loadConfig } from "../../hades/config/config";
import { FleetService } from "./fleet-service";
import type { FleetPort } from "./fleet-service";

export interface RealFleetOptions {
  /** Root directory for durable fleet state. Defaults to the resolved Hades
   *  config's `dataDir` (env `HADES_DATA_DIR`, else `.hades`). */
  dataDir?: string;
  /** Persist the fleet to `<dataDir>/fleet.json`. Default true. Tests pass
   *  false to keep everything in memory. */
  persist?: boolean;
  /** Clock override for deterministic tests. */
  now?: () => number;
}

export interface RealFleet {
  service: FleetService;
  manager: BackendManager;
  supervisor: FleetSupervisor;
  ledger: BackendProvenanceLedger;
  /** Best-effort crash recovery: load + reconcile the persisted fleet.
   *  Never throws (a failed restore leaves an empty in-memory fleet). */
  restore(): Promise<void>;
}

/**
 * Build the real fleet stack for the desktop sidecar. Construction is cheap
 * and side-effect free: no probe runs, no file is read or written until a
 * `fleet.*` command (or `restore()`) actually asks for it.
 */
export function createRealFleet(opts: RealFleetOptions = {}): RealFleet {
  const now = opts.now ?? (() => Date.now());
  const persist = opts.persist ?? true;
  const dataDir = opts.dataDir ?? loadConfig({ env: process.env }).dataDir;

  const ledger = new BackendProvenanceLedger();
  const manager = new BackendManager({ now, onEvent: ledgerEventSink(ledger) });

  // Same descriptors as `src/hades/cli/build.ts` — one fleet, two surfaces.
  const zeroCost = {
    perRunningHourUsd: 0,
    perHibernatedHourUsd: 0,
    perProvisionUsd: 0,
    source: "configured" as const,
  };
  const localDescriptor: BackendDescriptor = {
    name: "local",
    kind: "local",
    capabilities: ["shell", "local", "node"],
    cost: zeroCost,
    supportsHibernate: true,
    locality: "local",
  };
  const dockerDescriptor: BackendDescriptor = {
    name: "docker",
    kind: "container",
    capabilities: ["docker", "container"],
    cost: zeroCost,
    supportsHibernate: true,
    locality: "local",
  };
  manager.register(new LocalProcessBackend({ name: "local" }), localDescriptor);
  manager.register(new DockerBackend({ name: "docker" }), dockerDescriptor);

  const supervisor = new FleetSupervisor({
    manager,
    now,
    ...(persist ? { store: new HandleStore({ path: `${dataDir}/fleet.json`, now }) } : {}),
  });

  // Reads come straight from the manager; mutations and the richer lifecycle
  // view go through the supervisor so its machine + persistence stay live.
  const port: FleetPort = {
    descriptors: () => manager.descriptors(),
    telemetry: (name) => manager.telemetry(name),
    list: () => manager.list(),
    probeAll: () => manager.probeAll(),
    hibernate: (workerId) => supervisor.hibernate(workerId),
    wake: (workerId) => supervisor.wake(workerId),
    terminate: (workerId) => supervisor.terminate(workerId),
    lifecycleMap: () => supervisor.lifecycleMap(),
  };

  const service = new FleetService(port, { now });

  return {
    service,
    manager,
    supervisor,
    ledger,
    async restore() {
      try {
        await supervisor.restore();
      } catch {
        // Best-effort: a corrupt/unreadable persisted fleet must never stop
        // the sidecar from starting; HandleStore already quarantines corrupt
        // files itself, this is belt-and-braces.
      }
    },
  };
}
