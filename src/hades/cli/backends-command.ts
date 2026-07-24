/**
 * `hades backends <sub>` — inspect, provision, and drive the lifecycle of
 * the Phase C remote-compute fleet (`BackendManager`, `src/hades/backends/*`)
 * from the terminal.
 *
 *   hades backends list
 *   hades backends probe [name]
 *   hades backends provision --backend <name> --worker <id> [--cap a,b] [--image ref]
 *   hades backends status <workerId>
 *   hades backends hibernate <workerId>
 *   hades backends wake <workerId>
 *   hades backends terminate <workerId|--all>
 *   hades backends sweep
 *   hades backends logs <workerId> [--tail N]
 *   hades backends verify
 *   hades backends reconcile
 *   hades backends help
 *
 * Terminal-free (returns `{ code, lines }`) so it unit-tests without a shell
 * or real stdout, matching the rest of `src/hades/cli/*` (see
 * `tools-command.ts` / `memory-command.ts` for the house shape this
 * conforms to). Every failure path — unknown subcommand, unknown worker,
 * unavailable backend, missing flags, a backend that doesn't support
 * hibernate, a tampered provenance chain — returns `{ code: 1, lines }`
 * with a human-readable message; nothing here ever throws uncaught.
 *
 * INTEGRATION NOTE: wiring the `backends` case into `HadesCli`
 * (`src/hades/cli/cli.ts`) — constructing the real `BackendManager` +
 * `BackendProvenanceLedger` + registering the real backend classes — is
 * explicitly the central-integration pass's job, not this file's. This
 * module only exports `runBackendsCommand`/`BackendsCommandDeps`; it never
 * touches `cli.ts`, any barrel, or any other team's files.
 */
import type { CliResult } from "./cli";
import type { BackendManager } from "../backends/manager";
import type { RemoteSpec } from "../backends/backend";
import type { BackendRequirements } from "../backends/descriptor";
import type { HandleStore } from "../backends/handle-store";
import type { LifecycleState } from "../backends/lifecycle";
import type { BackendProvenanceLedger } from "../backends/provenance";
import { CostAwareRouteBandit, type RouteBanditState } from "../backends/route-bandit";
import { runReconcileAdoptCommand } from "./backends-adopt-command";

/** Persistence seam for the routing bandit's learned history (`hades backends
 *  route ...`). `load()` returns whatever was last saved (or `undefined`);
 *  the bandit's own `fromState` validates it defensively, so a corrupt file
 *  degrades to a fresh bandit, never a crash. */
export interface BanditStateStore {
  load(): unknown;
  save(state: RouteBanditState): void;
}

export interface BackendsCommandDeps {
  manager: BackendManager;
  /** STYX hash-chained lifecycle ledger for `hades backends verify`. Absent
   *  -> `verify` reports honestly that no ledger is configured (code 1)
   *  rather than fabricating a verdict. */
  ledger?: BackendProvenanceLedger;
  /** Crash-consistent fleet persistence. When present, every mutating
   *  subcommand (provision/hibernate/wake/terminate/sweep) atomically saves
   *  the live fleet after it succeeds (best-effort — a persistence failure
   *  is surfaced as a warning line, never a fabricated success), and
   *  `hades backends reconcile` loads the persisted fleet and probes every
   *  stored handle against runtime truth. */
  store?: HandleStore;
  /** Learned-history persistence for `hades backends route`. Absent, the
   *  route commands still work but the bandit's history lives only for this
   *  invocation — the output says so honestly. */
  banditStore?: BanditStateStore;
  now?: () => number;
}

const USAGE = [
  "Usage: hades backends <command>",
  "",
  "Commands:",
  "  list                                     List every registered backend",
  "  probe [name]                             Probe availability (all, or just <name>)",
  "  provision --backend <name> --worker <id>",
  "            [--cap a,b] [--image ref]      Provision a worker on a backend",
  "  status <workerId>                        Current lifecycle state",
  "  hibernate <workerId>                     Hibernate a running worker",
  "  wake <workerId>                          Wake a hibernated worker",
  "  terminate <workerId|--all>               Tear a worker down (or every worker)",
  "  sweep                                    Hibernate every idle-too-long worker",
  "  logs <workerId> [--tail N]               Recent logs for a worker",
  "  verify                                   Verify the provenance chain",
  "  reconcile [--adopt|--dry-run] [--json]   Probe the persisted fleet against runtime truth;",
  "                                           --adopt re-attaches every trustworthy handle to",
  "                                           the live registry (default is a dry run)",
  "  route choose [--cap a,b] [--max-usd N]",
  "               [--require-hibernate]",
  "               [--exclude a,b]             Pick a backend via the cost-aware UCB1 bandit",
  "  route record <backend> --verified|--unverified",
  "               --elapsed-ms N --usd N      Record a measured routing outcome",
  "  route arms                               Show the bandit's learned per-backend history",
  "  help                                     Show this help",
];

/** Env vars `provision` reads a real managerUrl/authToken from. Absent ->
 *  an explicitly-labeled placeholder is used and the output says so. */
const MANAGER_URL_ENV = "HADES_BACKEND_MANAGER_URL";
const AUTH_TOKEN_ENV = "HADES_BACKEND_AUTH_TOKEN";
const PLACEHOLDER_MANAGER_URL = "http://127.0.0.1:4790/placeholder-manager";
const PLACEHOLDER_AUTH_TOKEN = "placeholder-auth-token";

// ---------------------------------------------------------------------------
// small local formatting/parsing helpers (own copies, matching the house
// convention documented in memory-command.ts — this file never imports
// another CLI command module's internals)
// ---------------------------------------------------------------------------

/** Strips ASCII control characters (0x00-0x1F, 0x7F) from any user-supplied
 *  string before it is echoed into an output line, so a crafted workerId /
 *  backend name / flag value can never inject control sequences into the
 *  CLI's output stream. */
function sanitize(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\x00-\x1F\x7F]/g, "");
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

function renderTable(headers: string[], rows: string[][]): string[] {
  if (rows.length === 0) return [];
  const widths = headers.map((h, col) => Math.max(h.length, ...rows.map((r) => r[col].length)));
  const renderRow = (cols: string[]): string => cols.map((c, i) => pad(c, widths[i])).join("  ").trimEnd();
  return [renderRow(headers), ...rows.map(renderRow)];
}

/** Pulls a boolean `--flag` out of `args`, removing every occurrence. */
function extractBoolFlag(args: string[], flag: string): { present: boolean; rest: string[] } {
  let present = false;
  const rest: string[] = [];
  for (const a of args) {
    if (a === flag) {
      present = true;
      continue;
    }
    rest.push(a);
  }
  return { present, rest };
}

/** Pulls a `--flag value` pair out of `args`, removing every occurrence. A
 *  repeated flag is hardened deterministically: the LAST occurrence's value
 *  wins (a later flag on the command line overrides an earlier one), same
 *  convention as most Unix CLIs. `present` is true whenever the flag token
 *  itself was seen at least once, even if its value was missing (the flag
 *  was the last token), so callers can tell "absent" from "malformed". */
function extractValueFlag(args: string[], flag: string): { present: boolean; value: string | undefined; rest: string[] } {
  let present = false;
  let value: string | undefined;
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag) {
      present = true;
      if (i + 1 < args.length) {
        value = args[i + 1];
        i += 1;
      } else {
        value = undefined;
      }
      continue;
    }
    rest.push(args[i]);
  }
  return { present, value, rest };
}

function splitCaps(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** env-or-placeholder: reads `envKey`; falls back to `placeholder` and
 *  pushes an honest "this is a placeholder" line into `lines` when the env
 *  var is absent/blank. Never silently passes off a placeholder as real. */
function envOrPlaceholder(envKey: string, placeholder: string, label: string, lines: string[]): string {
  const value = process.env[envKey];
  if (value !== undefined && value.trim().length > 0) return value;
  lines.push(`(placeholder) ${label} not set via ${envKey}; using a placeholder value, not a real endpoint/credential.`);
  return placeholder;
}

/**
 * Best-effort crash-consistent persistence: after a mutating subcommand
 * succeeds, snapshot every live handle (plus its lifecycle state) into the
 * configured {@link HandleStore}. A persistence failure never fails the
 * command that already really happened — it is surfaced as an honest
 * warning line instead. No store configured -> silent no-op.
 */
async function persistFleet(deps: BackendsCommandDeps, lines: string[]): Promise<void> {
  if (!deps.store) return;
  try {
    const handles = deps.manager.registry.list();
    const lifecycle: Record<string, LifecycleState> = {};
    for (const h of handles) lifecycle[h.workerId] = h.state;
    await deps.store.save(handles, lifecycle);
  } catch (err) {
    lines.push(`(warning) fleet persistence failed: ${errMsg(err)}`);
  }
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

function formatUsd(n: number): string {
  return `$${n.toFixed(4)}`;
}

async function cmdList(deps: BackendsCommandDeps): Promise<CliResult> {
  const descriptors = deps.manager.descriptors();
  if (descriptors.length === 0) return { code: 0, lines: ["No backends registered."] };

  const availability = await deps.manager.probeAll();
  const handles = deps.manager.list();

  const rows = descriptors.map((d) => {
    const tel = deps.manager.telemetry(d.name);
    const liveCount = handles.filter((h) => h.handle.backend === d.name).length;
    const latency = tel.provisionLatencyEmaMs == null ? "-" : `${tel.provisionLatencyEmaMs.toFixed(1)}ms`;
    return [
      sanitize(d.name),
      d.kind,
      availability[d.name] ? "yes" : "no",
      d.capabilities.length > 0 ? d.capabilities.map(sanitize).join(",") : "-",
      `${formatUsd(d.cost.perRunningHourUsd)}/h (configured rate)`,
      `${formatUsd(d.cost.perHibernatedHourUsd)}/h (configured rate)`,
      String(liveCount),
      `provisions=${tel.provisions} failures=${tel.failures} latencyEma=${latency}`,
    ];
  });

  const table = renderTable(
    ["NAME", "KIND", "AVAILABLE", "CAPABILITIES", "RUNNING $/H", "HIBERNATED $/H", "HANDLES", "TELEMETRY"],
    rows,
  );
  return { code: 0, lines: table };
}

// ---------------------------------------------------------------------------
// probe
// ---------------------------------------------------------------------------

async function cmdProbe(deps: BackendsCommandDeps, args: string[]): Promise<CliResult> {
  const name = args[0];

  if (name !== undefined) {
    if (!deps.manager.descriptor(name)) {
      return { code: 1, lines: [`Unknown backend: ${sanitize(name)}`, "Run `hades backends list` to see registered backends."] };
    }
    try {
      const available = await deps.manager.probe(name);
      return { code: 0, lines: [`${sanitize(name)}: ${available ? "available" : "unavailable"}`] };
    } catch (err) {
      return { code: 1, lines: [`probe ${sanitize(name)} failed: ${errMsg(err)}`] };
    }
  }

  const descriptors = deps.manager.descriptors();
  if (descriptors.length === 0) return { code: 0, lines: ["No backends registered."] };

  try {
    const availability = await deps.manager.probeAll();
    const lines = descriptors.map((d) => `${sanitize(d.name)}: ${availability[d.name] ? "available" : "unavailable"}`);
    return { code: 0, lines };
  } catch (err) {
    return { code: 1, lines: [`probe failed: ${errMsg(err)}`] };
  }
}

// ---------------------------------------------------------------------------
// provision
// ---------------------------------------------------------------------------

async function cmdProvision(deps: BackendsCommandDeps, args: string[]): Promise<CliResult> {
  const usage = "Usage: hades backends provision --backend <name> --worker <id> [--cap a,b] [--image ref]";

  let rest = args;
  const backendFlag = extractValueFlag(rest, "--backend");
  rest = backendFlag.rest;
  const workerFlag = extractValueFlag(rest, "--worker");
  rest = workerFlag.rest;
  const capFlag = extractValueFlag(rest, "--cap");
  rest = capFlag.rest;
  const imageFlag = extractValueFlag(rest, "--image");
  rest = imageFlag.rest;

  if (!backendFlag.present) return { code: 1, lines: [usage] };
  if (backendFlag.value === undefined) return { code: 1, lines: ["--backend requires a value", usage] };
  if (!workerFlag.present) return { code: 1, lines: [usage] };
  if (workerFlag.value === undefined) return { code: 1, lines: ["--worker requires a value", usage] };
  if (capFlag.present && capFlag.value === undefined) return { code: 1, lines: ["--cap requires a value", usage] };
  if (imageFlag.present && imageFlag.value === undefined) return { code: 1, lines: ["--image requires a value", usage] };
  if (rest.length > 0) return { code: 1, lines: [`Unexpected argument: ${sanitize(rest[0])}`, usage] };

  const backendName = backendFlag.value;
  const workerId = workerFlag.value;

  const descriptor = deps.manager.descriptor(backendName);
  if (!descriptor) {
    return { code: 1, lines: [`Unknown backend: ${sanitize(backendName)}`, "Run `hades backends list` to see registered backends."] };
  }

  const capabilities = splitCaps(capFlag.value);
  const lines: string[] = [];
  const managerUrl = envOrPlaceholder(MANAGER_URL_ENV, PLACEHOLDER_MANAGER_URL, "managerUrl", lines);
  const authToken = envOrPlaceholder(AUTH_TOKEN_ENV, PLACEHOLDER_AUTH_TOKEN, "authToken", lines);

  const spec: RemoteSpec = {
    workerId,
    capabilities,
    managerUrl,
    authToken,
    ...(imageFlag.value !== undefined ? { image: imageFlag.value } : {}),
  };

  // Force selection of exactly the requested backend: exclude every other
  // registered backend from BackendManager.select()'s candidate pool rather
  // than trusting whatever scores highest.
  const otherNames = deps.manager.descriptors().map((d) => d.name).filter((n) => n !== backendName);
  const requirements = {
    exclude: otherNames,
    ...(capabilities.length > 0 ? { capabilities } : {}),
  };

  try {
    const result = await deps.manager.provision(spec, requirements);
    lines.push(
      `Provisioned ${sanitize(workerId)} on ${sanitize(result.backend)} (nativeId=${sanitize(result.handle.nativeId)}, state=${result.handle.state}).`,
    );
    await persistFleet(deps, lines);
    return { code: 0, lines };
  } catch (err) {
    lines.push(`Provision failed: ${errMsg(err)}`);
    return { code: 1, lines };
  }
}

// ---------------------------------------------------------------------------
// status / hibernate / wake / logs (share the "unknown worker" guard)
// ---------------------------------------------------------------------------

async function cmdStatus(deps: BackendsCommandDeps, args: string[]): Promise<CliResult> {
  const workerId = args[0];
  if (!workerId) return { code: 1, lines: ["Usage: hades backends status <workerId>"] };
  const handle = deps.manager.registry.handle(workerId);
  if (!handle) return { code: 1, lines: [`Unknown worker: ${sanitize(workerId)}`] };

  try {
    const state = await deps.manager.status(workerId);
    return { code: 0, lines: [`${sanitize(workerId)}: ${state ?? "unknown"} (backend=${sanitize(handle.backend)})`] };
  } catch (err) {
    return { code: 1, lines: [`status failed for ${sanitize(workerId)}: ${errMsg(err)}`] };
  }
}

async function cmdHibernate(deps: BackendsCommandDeps, args: string[]): Promise<CliResult> {
  const workerId = args[0];
  if (!workerId) return { code: 1, lines: ["Usage: hades backends hibernate <workerId>"] };
  const handle = deps.manager.registry.handle(workerId);
  if (!handle) return { code: 1, lines: [`Unknown worker: ${sanitize(workerId)}`] };

  try {
    const result = await deps.manager.hibernate(workerId);
    const lines = [`Hibernated ${sanitize(workerId)} (state=${result?.state ?? "unknown"}).`];
    await persistFleet(deps, lines);
    return { code: 0, lines };
  } catch (err) {
    return { code: 1, lines: [`Hibernate failed for ${sanitize(workerId)}: ${errMsg(err)}`] };
  }
}

async function cmdWake(deps: BackendsCommandDeps, args: string[]): Promise<CliResult> {
  const workerId = args[0];
  if (!workerId) return { code: 1, lines: ["Usage: hades backends wake <workerId>"] };
  const handle = deps.manager.registry.handle(workerId);
  if (!handle) return { code: 1, lines: [`Unknown worker: ${sanitize(workerId)}`] };

  try {
    const result = await deps.manager.wake(workerId);
    const lines = [`Woke ${sanitize(workerId)} (state=${result?.state ?? "unknown"}).`];
    await persistFleet(deps, lines);
    return { code: 0, lines };
  } catch (err) {
    return { code: 1, lines: [`Wake failed for ${sanitize(workerId)}: ${errMsg(err)}`] };
  }
}

async function cmdLogs(deps: BackendsCommandDeps, args: string[]): Promise<CliResult> {
  let rest = args;
  const tailFlag = extractValueFlag(rest, "--tail");
  rest = tailFlag.rest;

  const workerId = rest[0];
  if (!workerId) return { code: 1, lines: ["Usage: hades backends logs <workerId> [--tail N]"] };
  if (rest.length > 1) return { code: 1, lines: [`Unexpected argument: ${sanitize(rest[1])}`] };

  let tail = 100;
  if (tailFlag.present) {
    if (tailFlag.value === undefined) return { code: 1, lines: ["--tail requires a value"] };
    const n = Number(tailFlag.value);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
      return { code: 1, lines: [`Invalid --tail value: ${sanitize(tailFlag.value)}`] };
    }
    tail = n;
  }

  const handle = deps.manager.registry.handle(workerId);
  if (!handle) return { code: 1, lines: [`Unknown worker: ${sanitize(workerId)}`] };
  const backend = deps.manager.registry.get(handle.backend);
  if (!backend) return { code: 1, lines: [`Backend gone: ${sanitize(handle.backend)}`] };

  try {
    const text = await backend.logs(handle, tail);
    if (!text || text.trim().length === 0) return { code: 0, lines: ["(no logs)"] };
    return { code: 0, lines: text.split(/\r?\n/) };
  } catch (err) {
    return { code: 1, lines: [`logs failed for ${sanitize(workerId)}: ${errMsg(err)}`] };
  }
}

// ---------------------------------------------------------------------------
// terminate
// ---------------------------------------------------------------------------

async function cmdTerminate(deps: BackendsCommandDeps, args: string[]): Promise<CliResult> {
  const allFlag = extractBoolFlag(args, "--all");
  const rest = allFlag.rest;

  if (allFlag.present) {
    if (rest.length > 0) return { code: 1, lines: [`Unexpected argument: ${sanitize(rest[0])}`] };
    const handles = deps.manager.list();
    if (handles.length === 0) return { code: 0, lines: ["No workers to terminate."] };

    const lines: string[] = [];
    let anyFailed = false;
    for (const { handle } of handles) {
      try {
        await deps.manager.terminate(handle.workerId);
        lines.push(`Terminated ${sanitize(handle.workerId)}.`);
      } catch (err) {
        anyFailed = true;
        lines.push(`Terminate failed for ${sanitize(handle.workerId)}: ${errMsg(err)}`);
      }
    }
    await persistFleet(deps, lines);
    return { code: anyFailed ? 1 : 0, lines };
  }

  const workerId = rest[0];
  if (!workerId) return { code: 1, lines: ["Usage: hades backends terminate <workerId|--all>"] };
  if (rest.length > 1) return { code: 1, lines: [`Unexpected argument: ${sanitize(rest[1])}`] };

  const handle = deps.manager.registry.handle(workerId);
  if (!handle) return { code: 1, lines: [`Unknown worker: ${sanitize(workerId)}`] };

  try {
    await deps.manager.terminate(workerId);
    const lines = [`Terminated ${sanitize(workerId)}.`];
    await persistFleet(deps, lines);
    return { code: 0, lines };
  } catch (err) {
    return { code: 1, lines: [`Terminate failed for ${sanitize(workerId)}: ${errMsg(err)}`] };
  }
}

// ---------------------------------------------------------------------------
// sweep
// ---------------------------------------------------------------------------

async function cmdSweep(deps: BackendsCommandDeps): Promise<CliResult> {
  try {
    const hibernatedIds = await deps.manager.sweepIdle();
    if (hibernatedIds.length === 0) return { code: 0, lines: ["No idle workers to hibernate."] };
    const lines = hibernatedIds.map((id) => `Hibernated (idle): ${sanitize(id)}`);
    await persistFleet(deps, lines);
    return { code: 0, lines };
  } catch (err) {
    return { code: 1, lines: [`sweep failed: ${errMsg(err)}`] };
  }
}

// ---------------------------------------------------------------------------
// verify
// ---------------------------------------------------------------------------

function cmdVerify(deps: BackendsCommandDeps): CliResult {
  if (!deps.ledger) {
    return { code: 1, lines: ["No provenance ledger configured for this build.", "Run with a --ledger-backed build to use `hades backends verify`."] };
  }

  const verdict = deps.ledger.verifyChain();
  const cert = deps.ledger.toCertificateFields();

  const lines = [
    `root:   ${cert.traceRoot}`,
    `head:   ${cert.head}`,
    `length: ${cert.length}`,
    `ok:     ${verdict.ok}`,
    ...(verdict.ok
      ? []
      : [`brokenAt: ${verdict.brokenAt ?? "-"}`, `reason:   ${verdict.reason ?? "unknown"}`]),
  ];
  return { code: verdict.ok ? 0 : 1, lines };
}

// ---------------------------------------------------------------------------
// reconcile
// ---------------------------------------------------------------------------

/**
 * Load the persisted fleet (if any) and probe every stored handle against
 * the live backend behind it, printing what was restored (probed truth),
 * corrected (stored state disagreed with the probe), and dropped (unknown
 * backend / probe threw / malformed entry). Purely a read + probe — this
 * never mutates the live registry or the persisted file.
 */
async function cmdReconcile(deps: BackendsCommandDeps): Promise<CliResult> {
  if (!deps.store) {
    return { code: 1, lines: ["No fleet store configured for this build (nothing is persisted to reconcile)."] };
  }

  try {
    const fleet = await deps.store.load();
    if (!fleet) {
      return { code: 0, lines: ["No persisted fleet found (nothing saved yet, or the file was quarantined)."] };
    }

    const report = await deps.store.reconcile(fleet, deps.manager.registry);
    const lines: string[] = [
      `Persisted fleet from ${new Date(fleet.savedAt).toISOString()} — ${fleet.handles.length} handle(s):`,
      `restored:  ${report.restored.length}`,
      ...report.restored.map((h) => `  ${sanitize(h.workerId)}: ${h.state} (backend=${sanitize(h.backend)})`),
      `corrected: ${report.corrected.length}`,
      ...report.corrected.map((c) => `  ${sanitize(c.workerId)}: stored=${c.stored} -> probed=${c.probed}`),
      `dropped:   ${report.dropped.length}`,
      ...report.dropped.map((d) => `  ${sanitize(d.workerId)}: ${sanitize(d.reason)}`),
    ];
    return { code: 0, lines };
  } catch (err) {
    return { code: 1, lines: [`reconcile failed: ${errMsg(err)}`] };
  }
}

// ---------------------------------------------------------------------------
// route — cost-aware UCB1 routing bandit (see ../backends/route-bandit.ts)
// ---------------------------------------------------------------------------

const ROUTE_USAGE = [
  "Usage: hades backends route <choose|record|arms>",
  "  route choose [--cap a,b] [--max-usd N] [--require-hibernate] [--exclude a,b]",
  "  route record <backend> --verified|--unverified --elapsed-ms N --usd N",
  "  route arms",
];

/** Rebuild the bandit from persisted state (defensively validated by
 *  `CostAwareRouteBandit.fromState` — a corrupt file degrades to a fresh
 *  bandit, never a crash). No store configured -> fresh bandit + an honest
 *  note that nothing persists across invocations. */
function loadBandit(deps: BackendsCommandDeps, lines: string[]): CostAwareRouteBandit {
  const opts = { manager: deps.manager };
  if (!deps.banditStore) {
    lines.push("(not persisted) no bandit store configured; routing history lives only for this invocation.");
    return new CostAwareRouteBandit(opts);
  }
  try {
    return CostAwareRouteBandit.fromState(opts, deps.banditStore.load());
  } catch (err) {
    lines.push(`(warning) bandit state load failed (${errMsg(err)}); starting from an empty history.`);
    return new CostAwareRouteBandit(opts);
  }
}

function saveBandit(deps: BackendsCommandDeps, bandit: CostAwareRouteBandit, lines: string[]): void {
  if (!deps.banditStore) return;
  try {
    deps.banditStore.save(bandit.snapshot());
  } catch (err) {
    lines.push(`(warning) bandit state persistence failed: ${errMsg(err)}`);
  }
}

function fmtUcb(ucb: number | null): string {
  return ucb === null ? "-" : ucb.toFixed(4);
}

async function cmdRouteChoose(deps: BackendsCommandDeps, args: string[]): Promise<CliResult> {
  let rest = args;
  const capFlag = extractValueFlag(rest, "--cap");
  rest = capFlag.rest;
  const maxUsdFlag = extractValueFlag(rest, "--max-usd");
  rest = maxUsdFlag.rest;
  const hibernateFlag = extractBoolFlag(rest, "--require-hibernate");
  rest = hibernateFlag.rest;
  const excludeFlag = extractValueFlag(rest, "--exclude");
  rest = excludeFlag.rest;

  if (capFlag.present && capFlag.value === undefined) return { code: 1, lines: ["--cap requires a value", ...ROUTE_USAGE] };
  if (excludeFlag.present && excludeFlag.value === undefined) return { code: 1, lines: ["--exclude requires a value", ...ROUTE_USAGE] };
  if (rest.length > 0) return { code: 1, lines: [`Unexpected argument: ${sanitize(rest[0])}`, ...ROUTE_USAGE] };

  const requirements: BackendRequirements = {};
  const caps = splitCaps(capFlag.value);
  if (caps.length > 0) requirements.capabilities = caps;
  const excludes = splitCaps(excludeFlag.value);
  if (excludes.length > 0) requirements.exclude = excludes;
  if (hibernateFlag.present) requirements.requireHibernate = true;
  if (maxUsdFlag.present) {
    if (maxUsdFlag.value === undefined) return { code: 1, lines: ["--max-usd requires a value", ...ROUTE_USAGE] };
    const n = Number(maxUsdFlag.value);
    if (!Number.isFinite(n) || n < 0) {
      return { code: 1, lines: [`Invalid --max-usd value: ${sanitize(maxUsdFlag.value)}`] };
    }
    requirements.maxRunningHourUsd = n;
  }

  const lines: string[] = [];
  const bandit = loadBandit(deps, lines);

  try {
    const decision = await bandit.choose(requirements);
    if (!decision) {
      lines.push("No backend survives the requirements (or none is currently available).");
      return { code: 1, lines };
    }
    lines.push(
      `Route: ${sanitize(decision.name)} (${decision.reason}${decision.ucb === null ? "" : `, ucb=${decision.ucb.toFixed(4)}`})`,
    );
    const table = renderTable(
      ["CANDIDATE", "PULLS", "UCB"],
      decision.candidates.map((c) => [sanitize(c.name), String(c.pulls), fmtUcb(c.ucb)]),
    );
    lines.push(...table);
    return { code: 0, lines };
  } catch (err) {
    lines.push(`route choose failed: ${errMsg(err)}`);
    return { code: 1, lines };
  }
}

async function cmdRouteRecord(deps: BackendsCommandDeps, args: string[]): Promise<CliResult> {
  let rest = args;
  const verifiedFlag = extractBoolFlag(rest, "--verified");
  rest = verifiedFlag.rest;
  const unverifiedFlag = extractBoolFlag(rest, "--unverified");
  rest = unverifiedFlag.rest;
  const elapsedFlag = extractValueFlag(rest, "--elapsed-ms");
  rest = elapsedFlag.rest;
  const usdFlag = extractValueFlag(rest, "--usd");
  rest = usdFlag.rest;

  const backendName = rest[0];
  if (!backendName) return { code: 1, lines: ROUTE_USAGE };
  if (rest.length > 1) return { code: 1, lines: [`Unexpected argument: ${sanitize(rest[1])}`, ...ROUTE_USAGE] };
  if (verifiedFlag.present === unverifiedFlag.present) {
    return { code: 1, lines: ["Exactly one of --verified or --unverified is required.", ...ROUTE_USAGE] };
  }
  if (!elapsedFlag.present || elapsedFlag.value === undefined) {
    return { code: 1, lines: ["--elapsed-ms <N> is required (the real measured wall-clock duration).", ...ROUTE_USAGE] };
  }
  if (!usdFlag.present || usdFlag.value === undefined) {
    return { code: 1, lines: ["--usd <N> is required (the real measured cost; 0 for your own machine).", ...ROUTE_USAGE] };
  }
  const elapsedMs = Number(elapsedFlag.value);
  const usd = Number(usdFlag.value);

  const lines: string[] = [];
  const bandit = loadBandit(deps, lines);

  try {
    bandit.recordOutcome(backendName, { verified: verifiedFlag.present, elapsedMs, usd });
  } catch (err) {
    lines.push(`route record failed: ${errMsg(err)}`);
    return { code: 1, lines };
  }

  saveBandit(deps, bandit, lines);
  const arm = bandit.arm(backendName);
  lines.push(
    `Recorded ${verifiedFlag.present ? "verified" : "unverified"} outcome for ${sanitize(backendName)} ` +
      `(elapsedMs=${elapsedMs}, usd=${usd} — caller-measured).`,
    `${sanitize(backendName)}: pulls=${arm.pulls} verified=${arm.verified} meanReward=${arm.meanReward.toFixed(4)} ucb=${fmtUcb(arm.ucb)} (derived from measured outcomes)`,
  );
  return { code: 0, lines };
}

async function cmdRouteArms(deps: BackendsCommandDeps): Promise<CliResult> {
  const lines: string[] = [];
  const bandit = loadBandit(deps, lines);
  const arms = bandit.arms();
  const names = Object.keys(arms);
  if (names.length === 0) {
    lines.push("No routing outcomes recorded yet. Use `hades backends route record` after measuring one.");
    return { code: 0, lines };
  }
  const table = renderTable(
    ["BACKEND", "PULLS", "VERIFIED", "ELAPSED-MS", "USD", "MEAN-REWARD", "UCB"],
    names.map((name) => {
      const a = arms[name];
      return [
        sanitize(name),
        String(a.pulls),
        String(a.verified),
        String(a.totalElapsedMs),
        a.totalUsd.toFixed(4),
        a.meanReward.toFixed(4),
        fmtUcb(a.ucb),
      ];
    }),
  );
  lines.push(...table, "(pulls/verified/elapsed/usd are caller-measured; mean-reward/ucb are derived)");
  return { code: 0, lines };
}

async function cmdRoute(deps: BackendsCommandDeps, args: string[]): Promise<CliResult> {
  const [sub, ...rest] = args;
  switch (sub) {
    case "choose":
      return cmdRouteChoose(deps, rest);
    case "record":
      return cmdRouteRecord(deps, rest);
    case "arms":
      return cmdRouteArms(deps);
    default:
      return { code: 1, lines: ROUTE_USAGE };
  }
}

// ---------------------------------------------------------------------------
// dispatcher
// ---------------------------------------------------------------------------

export async function runBackendsCommand(args: string[], deps: BackendsCommandDeps): Promise<CliResult> {
  const [sub, ...rest] = args;

  if (sub === undefined || sub === "help" || sub === "--help" || sub === "-h") {
    return { code: 0, lines: USAGE };
  }

  try {
    switch (sub) {
      case "list":
        return await cmdList(deps);
      case "probe":
        return await cmdProbe(deps, rest);
      case "provision":
        return await cmdProvision(deps, rest);
      case "status":
        return await cmdStatus(deps, rest);
      case "hibernate":
        return await cmdHibernate(deps, rest);
      case "wake":
        return await cmdWake(deps, rest);
      case "terminate":
        return await cmdTerminate(deps, rest);
      case "sweep":
        return await cmdSweep(deps);
      case "logs":
        return await cmdLogs(deps, rest);
      case "verify":
        return cmdVerify(deps);
      case "reconcile":
        // Bare `reconcile` keeps its original read-only probe report;
        // any flag (`--adopt`/`--dry-run`/`--json`) routes to the
        // adoption-capable sibling command (./backends-adopt-command.ts),
        // whose registry seam is satisfied by the real
        // `RemoteBackendRegistry.adopt` (../backends/backend.ts).
        return rest.length === 0
          ? await cmdReconcile(deps)
          : await runReconcileAdoptCommand(rest, {
              ...(deps.store ? { store: deps.store } : {}),
              registry: deps.manager.registry,
              ...(deps.now ? { now: deps.now } : {}),
            });
      case "route":
        return await cmdRoute(deps, rest);
      default:
        return { code: 1, lines: [`Unknown backends command: ${sanitize(sub)}`, "Run `hades backends help` for usage."] };
    }
  } catch (err) {
    // Belt-and-braces: every subcommand above already catches its own
    // fallible calls, but nothing here is ever allowed to throw uncaught.
    return { code: 1, lines: [`Unexpected error: ${errMsg(err)}`] };
  }
}
