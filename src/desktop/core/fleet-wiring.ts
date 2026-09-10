/**
 * Central wiring for the desktop fleet surface: composes the REAL
 * remote-compute stack (`src/hades/backends/*`) behind a `FleetService`
 * (`./fleet-service.ts`) and a `FleetProvisionService`
 * (`./fleet-provision-service.ts`) the sidecar can hand `fleet.*` commands to.
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
 * - A real `BanditRoutedProvisioner` (`src/hades/backends/bandit-provisioner.ts`)
 *   injected as the supervisor's provision driver: backend selection for
 *   `fleet.provision` is learned (cost-aware UCB1 over MEASURED outcomes via
 *   `CostAwareRouteBandit`), with the manager's own static scoring as the
 *   automatic fallback when the bandit has no candidate. Its learned history
 *   persists to `<dataDir>/route-bandit.json` — the SAME file
 *   `hades backends route` reads/writes, so both surfaces share one learned
 *   history. Construction is lazy: no file is read and no bandit exists until
 *   the first provision actually runs.
 * - Registry adoption (`src/hades/backends/adoption.ts`): `restore()` now
 *   runs `FleetSupervisor.restore()`'s `restoreWithAdoption` path, so a
 *   worker provisioned by a PREVIOUS process is probed against the real
 *   backend and re-attached to the live registry — resurrected, not just
 *   reported. The result feeds `FleetProvisionService.restoredSnapshot()`
 *   as the `fleet.restored` event the provision panel renders; before a
 *   restore has actually run it stays honestly `undefined` (no event).
 * - The `FleetPort` adapter maps reads to the manager and mutations +
 *   `lifecycleMap()` to the supervisor, which is exactly the "richer
 *   lifecycle supervisor layered on top" hook `FleetService` was built for.
 */

import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { BackendManager } from "../../hades/backends/manager";
import type { BackendDescriptor } from "../../hades/backends/descriptor";
import type { RemoteSpec } from "../../hades/backends/backend";
import { LocalProcessBackend } from "../../hades/backends/local";
import { DockerBackend } from "../../hades/backends/docker";
import { BackendProvenanceLedger, ledgerEventSink } from "../../hades/backends/provenance";
import { HandleStore } from "../../hades/backends/handle-store";
import { FleetSupervisor, type ProvisionDriver } from "../../hades/backends/fleet-supervisor";
import { CostAwareRouteBandit, type RouteBanditState, type BanditArm } from "../../hades/backends/route-bandit";
import {
  BanditRoutedProvisioner,
  type BanditSnapshotStore,
  type ProvisionDecision,
} from "../../hades/backends/bandit-provisioner";
import { WorkerAttributionRegistry, resolveBackendForTask } from "../../hades/backends/worker-attribution";
import { AttributedContainerProvider } from "../../hades/backends/fleet-provider";
import { SwarmLearningLoop, type SwarmLearningEvent } from "../../hades/backends/swarm-learning";
import type { SwarmManagerLike } from "../../hades/backends/outcome-feed";
import type { ContainerProvider } from "../../swarm-runtime/types";
import { loadConfig } from "../../hades/config/config";
import { FleetService } from "./fleet-service";
import type { FleetPort } from "./fleet-service";
import { FleetProvisionService } from "./fleet-provision-service";
import type { FleetProvisionPort } from "./fleet-provision-service";
import type { FleetWorkerView } from "../ipc/fleet-contract";

/** Env vars `fleet.provision` reads a real managerUrl/authToken from —
 *  the SAME env vars `hades backends provision` uses (own copies of the
 *  constants, per the house no-cross-command-internal-imports convention).
 *  Absent -> explicitly-labeled placeholders; the provisioned event's
 *  routing reason says so honestly rather than passing them off as real. */
const MANAGER_URL_ENV = "HADES_BACKEND_MANAGER_URL";
const AUTH_TOKEN_ENV = "HADES_BACKEND_AUTH_TOKEN";
const PLACEHOLDER_MANAGER_URL = "http://127.0.0.1:4790/placeholder-manager";
const PLACEHOLDER_AUTH_TOKEN = "placeholder-auth-token";

export interface RealFleetOptions {
  /** Root directory for durable fleet state. Defaults to the resolved Hades
   *  config's `dataDir` (env `HADES_DATA_DIR`, else `.hades`). */
  dataDir?: string;
  /** Persist the fleet to `<dataDir>/fleet.json` (and the routing bandit's
   *  learned history to `<dataDir>/route-bandit.json`). Default true. Tests
   *  pass false to keep everything in memory. */
  persist?: boolean;
  /** Clock override for deterministic tests. */
  now?: () => number;
}

export interface RealFleet {
  service: FleetService;
  /** `fleet.provision` handler + `fleet.restored` snapshot source. */
  provision: FleetProvisionService;
  manager: BackendManager;
  supervisor: FleetSupervisor;
  ledger: BackendProvenanceLedger;
  /** Durable workerId -> backend attribution, populated by
   *  {@link RealFleet.decorateProvider}'s real spawn-path decoration and
   *  consumed by {@link RealFleet.attachLearning}'s `resolveBackend`. */
  attribution: WorkerAttributionRegistry;
  /**
   * Decorate a REAL swarm `ContainerProvider` (LocalProcessProvider /
   * DockerProvider — see `src/swarm-runtime/server/build-swarm.ts`'s
   * `decorateProvider` seam) with `AttributedContainerProvider`, so every
   * worker the swarm actually spawns is (a) attributed to its backend in
   * {@link RealFleet.attribution} and (b) adopted into the manager's live
   * registry alongside remotely-provisioned workers. The inner provider's
   * spawn/stop/liveness behavior is unchanged.
   */
  decorateProvider(inner: ContainerProvider, mode: "process" | "docker"): ContainerProvider;
  /**
   * Attach the self-improving routing loop to a real swarm: the SAME
   * `CostAwareRouteBandit` instance the bandit-routed provisioner uses (one
   * shared learned history — outcomes recorded here immediately influence
   * the next `fleet.provision` routing decision, and persist to the shared
   * `<dataDir>/route-bandit.json`). Task -> backend attribution comes from
   * {@link RealFleet.attribution} via `resolveBackendForTask` — an
   * unattributed task is honestly skipped, never guessed.
   */
  attachLearning(swarm: SwarmManagerLike, onEvent?: (e: SwarmLearningEvent) => void): Promise<SwarmLearningLoop>;
  /** The route bandit's live `arms()` snapshot (hydrates the shared bandit
   *  lazily, exactly like the first provision would). */
  routeBanditArms(): Promise<Record<string, BanditArm>>;
  /** Best-effort crash recovery: load + probe the persisted fleet and ADOPT
   *  every trustworthy handle back into the live registry (see
   *  `src/hades/backends/adoption.ts`). Never throws (a failed restore
   *  leaves an empty in-memory fleet). */
  restore(): Promise<void>;
}

/**
 * File-backed persistence for the routing bandit's learned history — the
 * async sibling of `src/hades/cli/build.ts`'s `fileBanditStore` (same path,
 * same atomic temp-file-then-rename write, same "absent/unreadable loads as
 * undefined -> fresh history" semantics), shaped to the Promise-returning
 * `BanditSnapshotStore` seam `BanditRoutedProvisioner` requires.
 */
function fileBanditSnapshotStore(path: string): BanditSnapshotStore {
  return {
    async load(): Promise<unknown> {
      try {
        return JSON.parse(await readFile(path, "utf8")) as unknown;
      } catch {
        return undefined; // absent or unreadable -> fresh history
      }
    },
    async save(state: RouteBanditState): Promise<void> {
      try {
        await mkdir(dirname(path), { recursive: true });
      } catch {
        /* exists */
      }
      const tmp = `${path}.tmp`;
      await writeFile(tmp, JSON.stringify(state));
      await rename(tmp, path);
    },
  };
}

/** env-or-placeholder: real value when the env var is set and non-blank. */
function envOrPlaceholder(envKey: string, placeholder: string): { value: string; placeholder: boolean } {
  const value = process.env[envKey];
  if (value !== undefined && value.trim().length > 0) return { value, placeholder: false };
  return { value: placeholder, placeholder: true };
}

/**
 * Build the real fleet stack for the desktop sidecar. Construction is cheap
 * and side-effect free: no probe runs, no file is read or written until a
 * `fleet.*` command (or `restore()`) actually asks for it — including the
 * routing bandit, which is only built (and its persisted history only
 * loaded) when the first `fleet.provision` runs.
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

  // Lazy shared bandit rig: ONE `CostAwareRouteBandit` (and its persisted
  // learned history at <dataDir>/route-bandit.json — the SAME file
  // `hades backends route` uses) shared between the bandit-routed provision
  // driver and the swarm learning loop, only constructed on first use so
  // building the fleet never reads a file unasked. Sharing the instance is
  // what actually closes the loop: an outcome the learning feed records is
  // visible to the very next provision's routing decision.
  let banditRigPromise:
    | Promise<{ bandit: CostAwareRouteBandit; store?: BanditSnapshotStore; provisioner: BanditRoutedProvisioner }>
    | undefined;
  const getBanditRig = (): NonNullable<typeof banditRigPromise> => {
    banditRigPromise ??= (async () => {
      const store = persist ? fileBanditSnapshotStore(`${dataDir}/route-bandit.json`) : undefined;
      const persisted = store ? await store.load() : undefined;
      // fromState validates defensively: a corrupt file degrades to a fresh
      // (empty-history) bandit, never a crash.
      const bandit = CostAwareRouteBandit.fromState({ manager }, persisted);
      const provisioner = new BanditRoutedProvisioner({
        manager,
        bandit,
        ...(store ? { store } : {}),
        now,
      });
      return { bandit, store, provisioner };
    })();
    return banditRigPromise;
  };
  const provisionDriver: ProvisionDriver = {
    provision: async (spec, r) => (await getBanditRig()).provisioner.provision(spec, r),
  };

  // Real worker attribution (workerId -> backend), fed by decorateProvider's
  // spawn-path decoration and read by attachLearning's resolveBackend.
  const attribution = new WorkerAttributionRegistry({ now });

  const supervisor = new FleetSupervisor({
    manager,
    provisioner: provisionDriver,
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

  // What the last real restore() pass actually found — undefined until one
  // runs, never fabricated as an empty restore (see FleetProvisionPort's
  // restoredView contract).
  let restoredView:
    | {
        workers: FleetWorkerView[];
        adoptedIds: string[];
        dropped: Array<{ workerId: string; reason: string }>;
        conflicts: Array<{ workerId: string; reason: string }>;
      }
    | undefined;

  const provisionPort: FleetProvisionPort = {
    async provision(spec, requirements) {
      const managerUrl = envOrPlaceholder(MANAGER_URL_ENV, PLACEHOLDER_MANAGER_URL);
      const authToken = envOrPlaceholder(AUTH_TOKEN_ENV, PLACEHOLDER_AUTH_TOKEN);
      const remoteSpec: RemoteSpec = {
        workerId: spec.workerId,
        capabilities: spec.capabilities,
        managerUrl: managerUrl.value,
        authToken: authToken.value,
        ...(spec.image !== undefined ? { image: spec.image } : {}),
      };
      // Through the supervisor (machine tracking + crash-consistent persist),
      // which delegates the actual backend choice to the bandit-routed driver.
      const result = await supervisor.provision(remoteSpec, requirements);
      // The bandit driver decorates its ProvisionResult with the routing
      // decision; the supervisor passes the object through unchanged.
      const routing = (result as { routing?: ProvisionDecision }).routing;
      const placeholderNote =
        managerUrl.placeholder || authToken.placeholder
          ? ` (placeholder manager credentials — set ${MANAGER_URL_ENV}/${AUTH_TOKEN_ENV} for real ones)`
          : "";
      return {
        backend: result.backend,
        handle: {
          workerId: result.handle.workerId,
          backend: result.handle.backend,
          nativeId: result.handle.nativeId,
          state: result.handle.state,
          startedAt: result.handle.startedAt,
        },
        ...(routing !== undefined
          ? {
              routing: {
                source: routing.source,
                reason:
                  (routing.source === "bandit" ? routing.decision.reason : routing.reason) + placeholderNote,
              },
            }
          : {}),
      };
    },
    async restoredView() {
      return restoredView;
    },
    isTracked(workerId: string): boolean {
      return manager.registry.handle(workerId) !== undefined;
    },
  };

  const provision = new FleetProvisionService(provisionPort, { now });

  return {
    service,
    provision,
    manager,
    supervisor,
    ledger,
    attribution,
    decorateProvider(inner: ContainerProvider, mode: "process" | "docker"): ContainerProvider {
      return new AttributedContainerProvider({
        inner,
        // The swarm's process mode runs on the same "local" backend the
        // manager registers above; docker mode on "docker" — real names of
        // real registered backends, never invented labels.
        backendName: mode === "docker" ? "docker" : "local",
        registry: attribution,
        tracking: manager.registry,
        now,
      });
    },
    async attachLearning(swarm: SwarmManagerLike, onEvent?: (e: SwarmLearningEvent) => void): Promise<SwarmLearningLoop> {
      const rig = await getBanditRig();
      return SwarmLearningLoop.attach({
        manager,
        swarm,
        resolveBackend: resolveBackendForTask(attribution),
        bandit: rig.bandit,
        ...(rig.store ? { store: rig.store } : {}),
        now,
        ...(onEvent ? { onEvent } : {}),
      });
    },
    async routeBanditArms(): Promise<Record<string, BanditArm>> {
      return (await getBanditRig()).bandit.arms();
    },
    async restore() {
      try {
        const report = await supervisor.restore();
        if (report) {
          restoredView = {
            workers: report.restored.map(
              (h): FleetWorkerView => ({
                workerId: h.workerId,
                backend: h.backend,
                nativeId: h.nativeId,
                // RemoteState is a strict subset of FleetLifecycleState.
                state: h.state,
                startedAt: h.startedAt,
                idleMs: 0,
              })
            ),
            adoptedIds: report.adoption.adopted.map((h) => h.workerId),
            // Everything probed-but-not-adopted, with its verbatim reason:
            // genuinely dropped handles plus already-live conflicts (kept in
            // `dropped` for wire back-compat with older provision panels).
            dropped: [
              ...report.adoption.dropped.map((d) => ({ workerId: d.workerId, reason: d.reason })),
              ...report.adoption.conflicts.map((c) => ({ workerId: c.workerId, reason: c.reason })),
            ],
            // Conflicts ALSO surfaced as their own lane so the desktop's
            // conflicts view can offer the real rename-and-provision
            // remediation (see `./fleet-conflicts.ts`).
            conflicts: report.adoption.conflicts.map((c) => ({ workerId: c.workerId, reason: c.reason })),
          };
        }
      } catch {
        // Best-effort: a corrupt/unreadable persisted fleet must never stop
        // the sidecar from starting; HandleStore already quarantines corrupt
        // files itself, this is belt-and-braces.
      }
    },
  };
}
