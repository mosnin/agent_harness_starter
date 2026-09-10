# Actual Orca backend lane

This lane uses the pinned upstream **Orca bf4e2705046cf9ef9c915929a9646da85717af07** Node `orcad` engine and its existing public local RPC. It does not reimplement its worker/worktree engine. Source/license provenance is in `third_party/helm-orca.json` and `third_party/helm-orca-LICENSE`.

## Host integration

```ts
const runtime = new HelmOrcaRuntime(privateRuntimeDirectory, pinnedArtifactDirectory);
const orca = new HelmOrcaService(privateIntentDirectory, {
  connect: (scope, signal) => runtime.connect(scope, signal),
});
const record = await orca.start(
  { root: authorizedCanonicalProject, profile: authorizedProfile },
  { requestId: persistedUUID, prompt, agent: 'codex' },
  parentSignal,
);
```

Root/profile and artifact paths are host-owned, never model-selected. `start` returns after bounded worker startup; `list/get/read/recover/stop` require the same scope. `read` returns Orca's labeled output, not an inferred coding result. `ready` means worker startup readiness, **not completed coding work**. Hades must apply its independent verification/review/apply gate. `close()` cancels active adapter work; runtime `close()` separately terminates its owned runtime process. Orca's daemon deliberately survives runtime exit; this is not a claim that every provider process stopped.

Orca private runtime startup negotiates runtime protocol3 and `orchestration.contract.v1`, registers the authorized Git repository, creates a coordinator workspace with `runHooks:false`, and obtains a real background coordinator terminal. Actual `runCreate` requires that stable terminal identity. Run creation and worker startup are serialized per real coordinator to avoid rebinding its current Run during another launch. Each attempt creates a Run and starts a worker with `worktree:'new-top-level', setup:'skip'`. No pairing or discovery of an unrelated user Orca instance occurs. CLI provider authentication availability is not inferred from installed binaries; no account files are copied. Provider programs may use their normal local authentication through HOME; this lane does not yet present a provider account selector.

## Durable semantics

A new private SQLite intent database provides atomic admission across service instances/processes. At most four active or uncertain workers can be admitted; ready workers continue holding capacity. Existing JSON intent files are refused with an explicit migration message, never silently migrated. Repeated identical requests return the saved record; changed payload or scope is rejected. Every mutating RPC carries its retained Orca mutation request UUID and contractversion1. On timeout, cancellation or malformed acknowledgement, the record stays `unknown`; another host viewing an in-flight record reports ownership uncertainty; no automatic mutation replay occurs. `recover` calls only `orchestration.requestShow`. A completed workerStart receipt can recover the dispatch; absent/pending remains unknown. Read, status and stop are dispatch-scoped. Status uses actual `orchestration.workerShow` with matching dispatch identity and `observation.exactWorker`. Only exact exited observation releases capacity, yielding `needs_review`, never completed/verified. A completed dispatch report with a live or unverifiable process remains active. Startup stop records cancellation, awaits a locally owned request settling and returns unknown when termination is unconfirmed. Cross-process cancellation is retained for the owning host. Stop only reports stopped for the matching explicit Orca stopped verdict. Setup, coordinator and worker resources are never automatically deleted.

Current conservative limitations: recovery only uses the original live runtime identity. Runtime restart, prior metadata, or uncertain coordinator bootstrap requires operator reconciliation and refuses automatic re-creation. `recover` of an unknown runCreate does not automatically proceed to workerStart. These are intentional safe gaps, not unattended restart parity. Hades Workbench wiring and aggregate objectives/budgets remain the host integration responsibility. Public structured sessions and permission response UI are not exposed by this first lane.

## Build and packaging

Set `HELM_ORCA_SOURCE` to the clean pinned local checkout; run `node scripts/build-helm-orca.mjs --check`. It does not install or download dependencies. Explicit `--build` runs upstream `config/scripts/build-orcad.mjs`, stages the output plus installed native runtime dependency closure, and emits a hash-bound `helm-orca-build.json` only after complete staging. Use a fresh `HELM_ORCA_OUTPUT` directory; existing outputs are never overwritten. Build generation changes upstream ignored `out/orcad`, not its source. The native runtime includes node-pty, parcel watcher and platform-specific optional packages. Correct Node ABI, architecture, relocatability and macOS signing require separate acceptance. Do not ship a partial output without a completed manifest.

Observed 2026-09-10 preflight: reference checkout lacks `node_modules/esbuild/package.json`; build refused. No large install/build attempted. Runtime artifact and real provider acceptance are therefore outstanding.

## Evidence and remaining gates

Focused service, transport and runtime preflight suites: **23/23 passed** (injected Orca RPC and synthetic EventEmitter socket; no listening endpoints or providers). They cover duplicate ID, altered identity, profile scope, lost acknowledgement/recovery, restart unknown, cancellation, stale runtime, stop verdict, response framing/size/deadline, durable four-worker admission across instances, live/completed distinction and late startup acknowledgement. This does not prove upstream runtime launch, PTY creation, provider authentication or native UI.

Required next: build pinned artifact with native dependencies; run private real runtime through status→coordinator→worker→read→stop; prove terminal shell initialization/setup side effects are acceptable; independently challenge authority/receipt mapping; complete restart attach with actual Orca takeover proof; implement human permission wait/response; wire objective budgets and review/apply. Never label a ready worker as verified work.

Pinned listener limitation: `src/main/orcad/orcad-entry.ts:203` hard-codes `enableWebSocket:true`; its public CLI exposes no disable-WebSocket flag. `--no-pairing` disables pairing offers, not the listener. The internal RPC server supports `enableWebSocket:false`, but changing that requires an explicit maintained upstream patch/new supported entry. This lane keeps loopback-only binding and does not bypass listener denials. Native runtime execution remains gated.

Offline dependency audit: `docs/research/helm-enterprise-2026-09-10/audit/orca-offline-dependencies.json` records candidate package manifests/hashes. Missing pinned headless xterm, patched serialize addon, Claude SDK and agent-browser prevent an offline build. Installed Orca node-pty1.1.0 fails a read-only reverse check against the pinned patch; it is not an accepted substitute. Available esbuild versions also differ from locked0.25.12. No packages were staged, installed or extracted.

## Conversation tools

The registered Hades conversation tools are helm_orca_readiness/start/status/read/reconcile/stop. Start and stop use the existing approval boundary. Restricted, built-in Helm child and delegated Work child sessions receive none of these tools. Project/profile/executable/transport cannot be selected by model arguments.

A stable caller key maps to a host-generated UUID and exact input fingerprint in SessionMeta before invocation; at most four allocations per conversation, with unknown outcomes never refunded. Readiness includes only this conversation's retained IDs/keys so a lost return can be inspected. Start validates artifacts before reserving; runtime/provider authentication remains unverified. Effect guards are checked before and after awaited boundaries. Provider token/time caps and spend measurement are explicitly not supplied by this adapter.

Focused evidence: 7 tool-boundary tests plus 3 actual Workbench in-process tests pass (10 total); Workbench tests prove UUID persistence across restart, withheld tools for restricted/child sessions and approval refusal before allocation. Provider/service effects use stubs; no actual Orca runtime, listeners, providers or native UI launched. Full TypeScript check passed at this source snapshot.
