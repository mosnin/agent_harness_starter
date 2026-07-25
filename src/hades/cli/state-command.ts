/**
 * `hades state <sub>` — the terminal surface over the shared, hash-chained
 * `WorkspaceStore` every surface (CLI, desktop, TUI) reads and writes.
 *
 *   hades state status [--json]
 *   hades state list <domain> [--prefix P] [--json]
 *   hades state get <domain> <key> [--json]
 *   hades state set <domain> <key> <json-value>
 *   hades state delete <domain> <key>
 *   hades state export [--domain D]           engine -> store
 *   hades state import [--domain D] [--dry-run]  store -> engine
 *   hades state sync [--policy P] [--dry-run]    bidirectional reconcile
 *   hades state watch [--for MS] [--once] [--json]
 *   hades state doctor [--json]
 *   hades state help
 *
 * Terminal-free (returns `{ code, lines }`) so it unit-tests without a
 * shell or real stdout, matching the rest of `src/hades/cli/*`.
 *
 * `export`/`import` are the "dumb", one-directional operations: `export`
 * always makes the store match the engine for the selected domain(s)
 * (including tombstoning keys the engine no longer produces); `import`
 * always makes the engine match the store. `sync` is the CRDT-aware
 * bidirectional reconciliation, built on Team 2's real `SyncEngine` +
 * `InMemoryMirror` (`../state/sync`): it diffs each adapter's current
 * export against the store to decide what the "local" side has changed,
 * lets `SyncEngine` resolve genuine concurrent conflicts per `--policy`,
 * and then writes whatever it decided to pull back into the real engine
 * via the same adapters' `importRecords`.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import type { CliResult } from "./cli";
import {
  WORKSPACE_DOMAINS,
  canonicalJson,
  isWorkspaceDomain,
  type ActorId,
  type JsonValue,
  type WorkspaceDomain,
  type WorkspaceRecord,
} from "../state/record";
import { WorkspaceStore, type WorkspaceSnapshot } from "../state/store";
import { WorkspaceFeed, type WorkspaceChange } from "../state/feed";
import { InMemoryMirror, SyncEngine, type ConflictPolicy, type SyncReport } from "../state/sync";
import {
  allAdapters,
  exportToStore,
  importFromStore,
  type DomainAdapter,
  type DomainImportReport,
  type WorkspaceDeps,
} from "../state/domains";
import { fileConfigAccess, resolveWorkspaceActor, workspaceRoot } from "../state/wiring";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface StateCommandDeps {
  root: string;
  actor: ActorId;
  store?: WorkspaceStore;
  adapters?: DomainAdapter[];
  deps?: WorkspaceDeps;
  now?: () => number;
}

/**
 * Env-driven defaults for `hades state`, used when the CLI was built
 * without an injected `state` factory (mirrors `defaultScheduleDeps`).
 *
 * The root is the canonical `<dataDir>/state` every surface shares, and the
 * actor identity is the STABLE, persisted `cli` identity from
 * `../state/wiring.ts` — not a per-invocation id, which would make each
 * `hades state set` look like a brand-new causal participant. Engine
 * adapters cover `config` (file-backed at `<dataDir>/config.json`) and
 * `skills` (the on-disk skill library); `sessions`/`memory` are wired by
 * `buildHadesCli`, which owns the real stores — here they are honestly
 * absent rather than backed by a throwaway empty store that would export
 * "the engine has no sessions" as if it were a fact.
 */
export function defaultStateDeps(env: NodeJS.ProcessEnv = process.env): StateCommandDeps {
  const dataDir = env.HADES_DATA_DIR ?? ".hades";
  const root = workspaceRoot(dataDir);
  const actor = resolveWorkspaceActor({ root, kind: "cli", env });
  return {
    root,
    actor,
    deps: {
      dataDir,
      config: fileConfigAccess(dataDir, env),
      skillsDir: env.HADES_SKILLS_DIR ?? `${dataDir}/skills`,
    },
  };
}

export const STATE_USAGE: string[] = [
  "Usage: hades state <command>",
  "",
  "Commands:",
  "  status [--json]                        Journal head/seq + per-domain live/deleted counts",
  "  list <domain> [--prefix P] [--json]    List live records in a domain",
  "  get <domain> <key> [--json]            Show one record",
  "  set <domain> <key> <json-value>        Write a record (value must be valid JSON)",
  "  delete <domain> <key>                  Tombstone a record",
  "  export [--domain D]                    Engine -> store",
  "  import [--domain D] [--dry-run]        Store -> engine",
  "  sync [--policy P] [--dry-run]          Bidirectional reconcile",
  "                                            (last-writer-wins|prefer-local|prefer-remote|manual)",
  "  watch [--for MS] [--once] [--json]     Tail the journal for new writes",
  "  doctor [--json]                        Verify journal chain, quarantine, locks, cursors",
  "  help                                   Show this help",
];

const DOMAIN_LIST = WORKSPACE_DOMAINS.join(", ");

// ---------------------------------------------------------------------------
// small local helpers (own copies — see module doc / memory-command.ts)
// ---------------------------------------------------------------------------

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

function renderTable(headers: string[], rows: string[][]): string[] {
  if (rows.length === 0) return [];
  const widths = headers.map((h, col) => Math.max(h.length, ...rows.map((r) => r[col].length)));
  const renderRow = (cols: string[]): string => cols.map((c, i) => pad(c, widths[i])).join("  ").trimEnd();
  return [renderRow(headers), ...rows.map(renderRow)];
}

function extractBoolFlag(args: string[], flag: string): { present: boolean; rest: string[] } {
  const idx = args.indexOf(flag);
  if (idx === -1) return { present: false, rest: args };
  return { present: true, rest: [...args.slice(0, idx), ...args.slice(idx + 1)] };
}

function extractValueFlag(args: string[], flag: string): { present: boolean; value: string | undefined; rest: string[] } {
  const idx = args.indexOf(flag);
  if (idx === -1) return { present: false, value: undefined, rest: args };
  const value = args[idx + 1];
  const rest = value === undefined ? [...args.slice(0, idx), ...args.slice(idx + 1)] : [...args.slice(0, idx), ...args.slice(idx + 2)];
  return { present: true, value, rest };
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isoOf(ms: number): string {
  return new Date(ms).toISOString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function validDomainOrError(raw: string | undefined): { domain?: WorkspaceDomain; error?: string } {
  if (!raw) return { error: `domain is required (expected one of: ${DOMAIN_LIST})` };
  if (!isWorkspaceDomain(raw)) return { error: `invalid domain "${raw}" (expected one of: ${DOMAIN_LIST})` };
  return { domain: raw };
}

function resolveAdapters(adapters: DomainAdapter[] | undefined, domainRaw: string | undefined): { selected?: DomainAdapter[]; error?: string } {
  if (!adapters || adapters.length === 0) {
    return { error: "No domain adapters are configured for this build (pass `adapters` or `deps`)." };
  }
  if (domainRaw === undefined) return { selected: adapters };
  const { domain, error } = validDomainOrError(domainRaw);
  if (error) return { error };
  const selected = adapters.filter((a) => a.domain === domain);
  if (selected.length === 0) return { error: `No adapter is configured for domain "${domain}".` };
  return { selected };
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

function cmdStatus(store: WorkspaceStore, args: string[]): CliResult {
  const jsonFlag = extractBoolFlag(args, "--json");
  if (jsonFlag.rest.length > 0) {
    return { code: 1, lines: [`Unexpected argument: ${jsonFlag.rest[0]}`, "Usage: hades state status [--json]"] };
  }

  let snapshot: WorkspaceSnapshot;
  try {
    snapshot = store.snapshot();
  } catch (err) {
    return { code: 1, lines: [errMessage(err)] };
  }

  const perDomain: Record<string, { live: number; deleted: number }> = {};
  for (const d of WORKSPACE_DOMAINS) perDomain[d] = { live: 0, deleted: 0 };
  for (const r of snapshot.records) {
    const bucket = perDomain[r.domain];
    if (r.deleted) bucket.deleted++;
    else bucket.live++;
  }

  if (jsonFlag.present) {
    return {
      code: 0,
      lines: [JSON.stringify({ version: snapshot.version, journalSeq: snapshot.journalSeq, head: snapshot.head, domains: perDomain }, null, 2)],
    };
  }

  const lines = [`journal seq: ${snapshot.journalSeq}`, `head:        ${snapshot.head || "(empty)"}`, `version:     ${snapshot.version}`, ""];
  for (const d of WORKSPACE_DOMAINS) {
    lines.push(`  ${pad(d, 10)} live=${perDomain[d].live} deleted=${perDomain[d].deleted}`);
  }
  return { code: 0, lines };
}

// ---------------------------------------------------------------------------
// list / get / set / delete
// ---------------------------------------------------------------------------

function cmdList(store: WorkspaceStore, args: string[]): CliResult {
  let rest = args;
  const jsonFlag = extractBoolFlag(rest, "--json");
  rest = jsonFlag.rest;
  const prefixFlag = extractValueFlag(rest, "--prefix");
  rest = prefixFlag.rest;

  const [domainRaw, ...extra] = rest;
  if (extra.length > 0) return { code: 1, lines: [`Unexpected argument: ${extra[0]}`, "Usage: hades state list <domain> [--prefix P] [--json]"] };
  const { domain, error } = validDomainOrError(domainRaw);
  if (error) return { code: 1, lines: [error, "Usage: hades state list <domain> [--prefix P] [--json]"] };
  if (prefixFlag.present && prefixFlag.value === undefined) return { code: 1, lines: ["--prefix requires a value"] };

  let records: WorkspaceRecord[];
  try {
    records = store.list(domain!, prefixFlag.value !== undefined ? { prefix: prefixFlag.value } : {});
  } catch (err) {
    return { code: 1, lines: [errMessage(err)] };
  }

  if (jsonFlag.present) return { code: 0, lines: [JSON.stringify(records, null, 2)] };
  if (records.length === 0) return { code: 0, lines: [`No records in ${domain}.`] };
  const table = renderTable(
    ["KEY", "REV", "UPDATED", "ACTOR"],
    records.map((r) => [r.key, String(r.rev), isoOf(r.updatedAt), r.actor]),
  );
  return { code: 0, lines: table };
}

function cmdGet(store: WorkspaceStore, args: string[]): CliResult {
  let rest = args;
  const jsonFlag = extractBoolFlag(rest, "--json");
  rest = jsonFlag.rest;
  const [domainRaw, key, ...extra] = rest;
  if (extra.length > 0) return { code: 1, lines: [`Unexpected argument: ${extra[0]}`] };
  const { domain, error } = validDomainOrError(domainRaw);
  if (error || !key) return { code: 1, lines: [error ?? "key is required", "Usage: hades state get <domain> <key> [--json]"] };

  let record: WorkspaceRecord | undefined;
  try {
    record = store.get(domain!, key);
  } catch (err) {
    return { code: 1, lines: [errMessage(err)] };
  }
  if (!record) return { code: 1, lines: [`No such record: ${domain}/${key}`] };

  if (jsonFlag.present) return { code: 0, lines: [JSON.stringify(record, null, 2)] };
  return {
    code: 0,
    lines: [
      `domain:  ${record.domain}`,
      `key:     ${record.key}`,
      `rev:     ${record.rev}`,
      `deleted: ${record.deleted}`,
      `actor:   ${record.actor}`,
      `updated: ${isoOf(record.updatedAt)}`,
      `hash:    ${record.hash || "(tombstone)"}`,
      `value:   ${JSON.stringify(record.value)}`,
    ],
  };
}

function cmdSet(store: WorkspaceStore, args: string[]): CliResult {
  const [domainRaw, key, ...rest] = args;
  const { domain, error } = validDomainOrError(domainRaw);
  if (error) return { code: 1, lines: [error, "Usage: hades state set <domain> <key> <json-value>"] };
  if (!key) return { code: 1, lines: ["key is required", "Usage: hades state set <domain> <key> <json-value>"] };
  if (rest.length === 0) return { code: 1, lines: ["json-value is required", "Usage: hades state set <domain> <key> <json-value>"] };

  const raw = rest.join(" ");
  let value: JsonValue;
  try {
    value = JSON.parse(raw) as JsonValue;
  } catch (err) {
    return { code: 1, lines: [`Invalid JSON value: ${errMessage(err)}`] };
  }

  let record: WorkspaceRecord;
  try {
    record = store.put(domain!, key, value);
  } catch (err) {
    return { code: 1, lines: [errMessage(err)] };
  }
  return { code: 0, lines: [`Set ${domain}/${key} (rev ${record.rev}).`] };
}

function cmdDelete(store: WorkspaceStore, args: string[]): CliResult {
  const [domainRaw, key, ...extra] = args;
  if (extra.length > 0) return { code: 1, lines: [`Unexpected argument: ${extra[0]}`] };
  const { domain, error } = validDomainOrError(domainRaw);
  if (error || !key) return { code: 1, lines: [error ?? "key is required", "Usage: hades state delete <domain> <key>"] };

  let record: WorkspaceRecord | null;
  try {
    record = store.delete(domain!, key);
  } catch (err) {
    return { code: 1, lines: [errMessage(err)] };
  }
  if (!record) return { code: 0, lines: [`${domain}/${key} did not exist (no-op).`] };
  return { code: 0, lines: [`Deleted ${domain}/${key} (rev ${record.rev}).`] };
}

// ---------------------------------------------------------------------------
// export / import (engine <-> store, one direction each)
// ---------------------------------------------------------------------------

function cmdExport(store: WorkspaceStore, adapters: DomainAdapter[] | undefined, args: string[]): CliResult {
  const domainFlag = extractValueFlag(args, "--domain");
  if (domainFlag.rest.length > 0) return { code: 1, lines: [`Unexpected argument: ${domainFlag.rest[0]}`] };

  const { selected, error } = resolveAdapters(adapters, domainFlag.present ? domainFlag.value : undefined);
  if (error) return { code: 1, lines: [error] };

  let result: { written: number; perDomain: Record<string, number> };
  try {
    result = exportToStore(store, selected!);
  } catch (err) {
    return { code: 1, lines: [errMessage(err)] };
  }
  return {
    code: 0,
    lines: [`Exported ${result.written} record(s).`, ...Object.entries(result.perDomain).map(([d, n]) => `  ${d}: ${n}`)],
  };
}

function cmdImport(store: WorkspaceStore, adapters: DomainAdapter[] | undefined, args: string[]): CliResult {
  let rest = args;
  const dryFlag = extractBoolFlag(rest, "--dry-run");
  rest = dryFlag.rest;
  const domainFlag = extractValueFlag(rest, "--domain");
  rest = domainFlag.rest;
  if (rest.length > 0) return { code: 1, lines: [`Unexpected argument: ${rest[0]}`] };

  const { selected, error } = resolveAdapters(adapters, domainFlag.present ? domainFlag.value : undefined);
  if (error) return { code: 1, lines: [error] };

  if (dryFlag.present) {
    // Provably writes nothing: never calls `adapter.importRecords`, only
    // reads what the store already holds.
    const lines = ["Dry run — no writes performed."];
    for (const adapter of selected!) {
      let records: WorkspaceRecord[];
      try {
        records = store.list(adapter.domain, { includeDeleted: true });
      } catch (err) {
        return { code: 1, lines: [errMessage(err)] };
      }
      const live = records.filter((r) => !r.deleted).length;
      lines.push(`  ${adapter.domain}: would consider ${records.length} record(s) (${live} live, ${records.length - live} tombstoned)`);
    }
    return { code: 0, lines };
  }

  let reports: Record<string, DomainImportReport>;
  try {
    reports = importFromStore(store, selected!);
  } catch (err) {
    return { code: 1, lines: [errMessage(err)] };
  }

  const lines: string[] = [];
  let hadErrors = false;
  for (const [domain, report] of Object.entries(reports)) {
    lines.push(`${domain}: applied=${report.applied} skipped=${report.skipped} errors=${report.errors.length}`);
    for (const e of report.errors) {
      hadErrors = true;
      lines.push(`    error: ${e.key}: ${e.reason}`);
    }
  }
  return { code: hadErrors ? 1 : 0, lines };
}

// ---------------------------------------------------------------------------
// sync (bidirectional, via the real SyncEngine)
// ---------------------------------------------------------------------------

const CONFLICT_POLICIES: readonly ConflictPolicy[] = ["last-writer-wins", "prefer-local", "prefer-remote", "manual"];

/**
 * Builds a fresh `InMemoryMirror` representing "what the engine currently
 * has" relative to the store, for exactly the domains `adapters` cover.
 *
 * Deliberately does NOT seed from the store's full current view — only
 * from what each adapter's `exportRecords()` says the ENGINE actually
 * holds right now. For a key whose engine content already matches the
 * store's recorded value byte-for-byte, the store's own record (its exact
 * clock/rev/hash) is adopted verbatim via `mirror.apply` so it compares as
 * truly `"identical"` (no needless churn on every sync). For a key whose
 * engine content differs (or is new), `mirror.stage` mints a fresh local
 * draft so `SyncEngine` treats it as push-worthy. A key the store has live
 * but that the engine's `exportRecords()` doesn't currently produce is
 * left OUT of the mirror entirely — that absence is exactly what makes
 * `SyncEngine`'s own diff (`!local && remote`) recognize it as a PULL
 * candidate, so a fresh/empty engine's first `sync` correctly pulls the
 * store's content in rather than mistaking "never had it yet" for "engine
 * explicitly deleted it" (which plain absence is fundamentally ambiguous
 * with, absent persistent cross-call bookkeeping this stateless
 * per-invocation mirror doesn't keep). Real deletions (e.g. a forgotten
 * memory fact) are propagated the honest way: via `export`, whose
 * tombstone diffing (`exportToStore`) IS keyed off comparing against the
 * store's own PRIOR state, not mere absence in a throwaway mirror.
 */
function buildEngineMirror(store: WorkspaceStore, adapters: DomainAdapter[]): InMemoryMirror {
  const mirror = new InMemoryMirror();

  for (const adapter of adapters) {
    const exported = adapter.exportRecords();
    const storeRecords = store.list(adapter.domain, { includeDeleted: true });
    const storeByKey = new Map(storeRecords.map((r) => [r.key, r]));

    for (const { key, value } of exported) {
      const existing = storeByKey.get(key);
      const unchanged = existing && !existing.deleted && canonicalJson(existing.value ?? null) === canonicalJson(value);
      if (unchanged) {
        mirror.apply([existing!]);
      } else {
        mirror.stage(adapter.domain, key, value);
      }
    }
  }
  return mirror;
}

function formatSyncReport(header: string, report: SyncReport): string[] {
  const lines = [
    header,
    `  pushed:    ${report.pushed.length}`,
    `  pulled:    ${report.pulled.length}`,
    `  conflicts: ${report.conflicts.length}`,
    `  deleted:   ${report.deleted.length}`,
    `  skipped:   ${report.skipped}`,
  ];
  for (const c of report.conflicts) lines.push(`    conflict ${c.domain}/${c.key}: resolved ${c.resolution} — ${c.reason}`);
  return lines;
}

function cmdSync(store: WorkspaceStore, adapters: DomainAdapter[] | undefined, actor: ActorId, args: string[], nowFn: () => number): CliResult {
  let rest = args;
  const dryFlag = extractBoolFlag(rest, "--dry-run");
  rest = dryFlag.rest;
  const policyFlag = extractValueFlag(rest, "--policy");
  rest = policyFlag.rest;
  if (rest.length > 0) return { code: 1, lines: [`Unexpected argument: ${rest[0]}`] };

  if (!adapters || adapters.length === 0) {
    return { code: 1, lines: ["No domain adapters are configured for this build (pass `adapters` or `deps`)."] };
  }

  let policy: ConflictPolicy = "last-writer-wins";
  if (policyFlag.present) {
    if (!policyFlag.value || !CONFLICT_POLICIES.includes(policyFlag.value as ConflictPolicy)) {
      return { code: 1, lines: [`Invalid --policy value: ${policyFlag.value}`, `Expected one of: ${CONFLICT_POLICIES.join(", ")}`] };
    }
    policy = policyFlag.value as ConflictPolicy;
  }

  let mirror: InMemoryMirror;
  try {
    mirror = buildEngineMirror(store, adapters);
  } catch (err) {
    return { code: 1, lines: [errMessage(err)] };
  }

  const domains = [...new Set(adapters.map((a) => a.domain))];
  const engine = new SyncEngine({ store, mirror, actor, policy, now: nowFn, domains });

  if (dryFlag.present) {
    let plan: SyncReport;
    try {
      plan = engine.plan();
    } catch (err) {
      return { code: 1, lines: [errMessage(err)] };
    }
    return { code: 0, lines: formatSyncReport("Dry run (plan only) — no writes performed.", plan) };
  }

  let report: SyncReport;
  try {
    report = engine.reconcile();
  } catch (err) {
    return { code: 1, lines: [errMessage(err)] };
  }

  // Write whatever the store pulled ahead of the engine back into the REAL
  // engine, grouped by domain, via each adapter's own importRecords.
  const pulledByDomain = new Map<WorkspaceDomain, WorkspaceRecord[]>();
  for (const r of report.pulled) {
    const arr = pulledByDomain.get(r.domain) ?? [];
    arr.push(r);
    pulledByDomain.set(r.domain, arr);
  }
  const applyErrorLines: string[] = [];
  for (const adapter of adapters) {
    const recs = pulledByDomain.get(adapter.domain);
    if (!recs || recs.length === 0) continue;
    const applyReport = adapter.importRecords(recs);
    for (const e of applyReport.errors) applyErrorLines.push(`  ${adapter.domain} apply error: ${e.key}: ${e.reason}`);
  }

  const lines = formatSyncReport("Synced.", report);
  lines.push(...applyErrorLines);
  return { code: applyErrorLines.length > 0 ? 1 : 0, lines };
}

// ---------------------------------------------------------------------------
// watch
// ---------------------------------------------------------------------------

async function cmdWatch(store: WorkspaceStore, root: string, actor: ActorId, args: string[], nowFn: () => number): Promise<CliResult> {
  let rest = args;
  const jsonFlag = extractBoolFlag(rest, "--json");
  rest = jsonFlag.rest;
  const onceFlag = extractBoolFlag(rest, "--once");
  rest = onceFlag.rest;
  const forFlag = extractValueFlag(rest, "--for");
  rest = forFlag.rest;
  if (rest.length > 0) return { code: 1, lines: [`Unexpected argument: ${rest[0]}`] };

  let forMs = 2000;
  if (forFlag.present) {
    if (forFlag.value === undefined) return { code: 1, lines: ["--for requires a value"] };
    const n = Number(forFlag.value);
    if (!Number.isFinite(n) || n < 0) return { code: 1, lines: [`Invalid --for value: ${forFlag.value}`] };
    forMs = n;
  }

  // `watch: false` (never opens fs.watch) and this command drives poll()
  // itself on an explicit sleep/now() loop — never `feed.start()` — so
  // there is never a real setInterval/fs.watch handle left behind: every
  // setTimeout used below auto-clears the instant it fires.
  // Hyphen-joined: the consumer name becomes a real filename under
  // `<root>/cursors/`, and a colon is not a legal path character on Windows.
  const consumer = `cli-watch-${actor.kind}-${actor.id}`;
  let feed: WorkspaceFeed;
  try {
    feed = new WorkspaceFeed({ store, root, consumer, now: nowFn, watch: false });
  } catch (err) {
    return { code: 1, lines: [errMessage(err)] };
  }

  const changes: WorkspaceChange[] = [];
  const pollOnce = (): void => {
    changes.push(...feed.poll());
  };

  pollOnce();
  if (!onceFlag.present) {
    const startedAt = nowFn();
    const stepMs = Math.max(1, Math.min(25, forMs || 1));
    while (nowFn() - startedAt < forMs) {
      await sleep(stepMs);
      pollOnce();
    }
  }

  const recordCount = changes.reduce((n, c) => n + c.records.length, 0);
  if (jsonFlag.present) {
    return {
      code: 0,
      lines: [
        JSON.stringify(
          {
            batches: changes.length,
            records: recordCount,
            changes: changes.map((c) => ({ seq: c.seq, at: c.at, actor: c.actor, recordCount: c.records.length })),
          },
          null,
          2,
        ),
      ],
    };
  }
  if (changes.length === 0) return { code: 0, lines: ["No changes observed."] };
  const lines = [`Observed ${changes.length} batch(es), ${recordCount} record(s):`];
  for (const c of changes) lines.push(`  seq=${c.seq} actor=${c.actor} records=${c.records.length}`);
  return { code: 0, lines };
}

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

const STALE_LOCK_THRESHOLD_MS = 30_000;

interface CursorHealth {
  consumer: string;
  seq: number;
  head: string;
  healthy: boolean;
}

function cmdDoctor(store: WorkspaceStore, root: string, args: string[]): CliResult {
  const jsonFlag = extractBoolFlag(args, "--json");
  if (jsonFlag.rest.length > 0) return { code: 1, lines: [`Unexpected argument: ${jsonFlag.rest[0]}`] };

  // Snapshot lock + quarantine state FIRST, before any store operation
  // below (verifyChain, journalSince) gets a chance to acquire the lock
  // itself and — as an honest side effect of that acquisition — reclaim a
  // stale lock out from under this diagnostic read. Reporting what was
  // observed at the moment `doctor` started is the useful, non-racy
  // contract for a health check.
  const quarantineDir = join(root, "quarantine");
  let quarantined: string[] = [];
  try {
    quarantined = existsSync(quarantineDir) ? readdirSync(quarantineDir) : [];
  } catch {
    quarantined = [];
  }

  const lockDir = join(root, ".lock");
  let lockHeld = false;
  let lockAgeMs: number | undefined;
  try {
    if (existsSync(lockDir)) {
      lockHeld = true;
      lockAgeMs = Date.now() - statSync(lockDir).mtimeMs;
    }
  } catch {
    /* lock vanished mid-check (released by its holder) — treat as free */
    lockHeld = false;
  }
  const lockStale = lockHeld && (lockAgeMs ?? 0) > STALE_LOCK_THRESHOLD_MS;

  const chain = store.verifyChain();

  const cursorsDir = join(root, "cursors");
  const cursors: CursorHealth[] = [];
  try {
    if (existsSync(cursorsDir)) {
      const files = readdirSync(cursorsDir).filter((f) => f.endsWith(".json"));
      for (const f of files) {
        let consumer = f.replace(/\.json$/, "");
        let seq = -1;
        let head = "";
        let healthy = false;
        try {
          const raw = JSON.parse(readFileSync(join(cursorsDir, f), "utf8")) as Record<string, unknown>;
          if (typeof raw.consumer === "string") consumer = raw.consumer;
          if (typeof raw.seq === "number") seq = raw.seq;
          if (typeof raw.head === "string") head = raw.head;
          if (seq <= 0) {
            healthy = true;
          } else {
            try {
              const entries = store.journalSince(Math.max(0, seq - 1));
              const first = entries[0];
              healthy = !!first && first.seq === seq && first.hash === head;
            } catch {
              healthy = false;
            }
          }
        } catch {
          healthy = false;
        }
        cursors.push({ consumer, seq, head, healthy });
      }
    }
  } catch {
    /* cursors dir unreadable — report an empty list rather than crash */
  }

  const ok = chain.ok && quarantined.length === 0 && !lockStale && cursors.every((c) => c.healthy);

  if (jsonFlag.present) {
    return {
      code: ok ? 0 : 1,
      lines: [JSON.stringify({ ok, chain, quarantined, lock: { held: lockHeld, ageMs: lockAgeMs ?? null, stale: lockStale }, cursors }, null, 2)],
    };
  }

  const lines = [
    `journal chain: ${chain.ok ? "OK" : `BROKEN at seq ${chain.brokenAt} (${chain.reason})`}`,
    `quarantined files: ${quarantined.length === 0 ? "none" : quarantined.join(", ")}`,
    `lock: ${lockHeld ? `HELD${lockStale ? " (STALE)" : ""} (age ${lockAgeMs}ms)` : "free"}`,
    `cursors: ${cursors.length === 0 ? "none" : ""}`,
  ];
  for (const c of cursors) lines.push(`  ${c.consumer}: seq=${c.seq} ${c.healthy ? "OK" : "STALE/BROKEN"}`);
  return { code: ok ? 0 : 1, lines };
}

// ---------------------------------------------------------------------------
// dispatcher
// ---------------------------------------------------------------------------

export async function runStateCommand(argv: string[], deps: StateCommandDeps): Promise<CliResult> {
  const [sub, ...rest] = argv;

  if (sub === undefined || sub === "help" || sub === "--help" || sub === "-h") {
    return { code: 0, lines: STATE_USAGE };
  }

  const nowFn = deps.now ?? Date.now;

  let store: WorkspaceStore;
  try {
    store = deps.store ?? new WorkspaceStore({ root: deps.root, actor: deps.actor, now: nowFn });
  } catch (err) {
    return { code: 1, lines: [errMessage(err)] };
  }

  const adapters = deps.adapters ?? (deps.deps ? allAdapters(deps.deps) : undefined);

  switch (sub) {
    case "status":
      return cmdStatus(store, rest);
    case "list":
      return cmdList(store, rest);
    case "get":
      return cmdGet(store, rest);
    case "set":
      return cmdSet(store, rest);
    case "delete":
      return cmdDelete(store, rest);
    case "export":
      return cmdExport(store, adapters, rest);
    case "import":
      return cmdImport(store, adapters, rest);
    case "sync":
      return cmdSync(store, adapters, deps.actor, rest, nowFn);
    case "watch":
      return cmdWatch(store, deps.root, deps.actor, rest, nowFn);
    case "doctor":
      return cmdDoctor(store, deps.root, rest);
    default:
      return { code: 1, lines: [`Unknown state command: ${sub}`, ...STATE_USAGE] };
  }
}
