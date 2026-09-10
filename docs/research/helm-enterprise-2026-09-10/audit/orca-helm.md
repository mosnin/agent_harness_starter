# Orca → Helm integration audit

Date: 2026-09-10. Evidence level: pinned local source inspection, not a runtime, provider, packaging or UI acceptance test. No builds, installations, credentials, network calls or application mutations were performed. Source-byte hashes are retained in `orca-helm-source-manifest.json`. Concurrent Hades UI edits were excluded from this audit.

## Answer: where is Orca?

Orca is a separate, clean reference checkout at `/Users/preston/Documents/Codex/2026-09-06/orca-reference`, origin `https://github.com/stablyai/orca.git`, revision **bf4e2705046cf9ef9c915929a9646da85717af07**, package version **1.4.197**. Hades revision **81cd435977ee5f8b6e7e78f0595aa3da1777af78** does not execute Orca through its Helm adapters. `docs/HELM.md:146` accurately calls Orca inspiration and says its source/assets were not copied. `src/desktop/core/helm-adapters.ts:5` enumerates Hades, Codex, Claude, Gemini, OpenCode and Grok, with direct CLI arguments at line22. No Orca runtime client appears in that implementation. A historical statement about a mosnin/orca fork is not current remote verification; this audit pins the actual available stablyai checkout instead.

OpenCode is materially different: Hades has an actual fork integration. `helm-code-service.ts:104` launches its executable with `serve --hostname 127.0.0.1 --port 0`; the same module owns a profile/project-scoped authenticated gateway and directory validation. `docs/HELM.md` records the v1.18.21 upstream baseline `826d9ad46a22bef0294998e08daa3c4904fea28f` and fork build manifests. That baseline is documentation provenance here, not a fresh verification of the separately built OpenCode artifact.

## What is reusable in the actual Orca source?

License: repository `LICENSE` is MIT, copyright 2026 Lovecast Inc.; retain its copyright/permission notice with substantial copied source. Native binaries, dependencies and bundled providers require their own inventory; this is not a blanket conclusion about every dependency.

| Actual surface | Source evidence in Orca | Integration implication |
|---|---|---|
| Node runtime, separate from Electron | `config/scripts/build-orcad.mjs:1`, `src/main/orcad/main.ts:1`, `orcad-entry.ts:140` | Prefer this engine boundary over transplanting desktop UI. Build excludes browser-pane/speech clusters. External node-pty and parcel watcher native artifacts remain packaging work. |
| Persistent PTY daemon | `build-orcad.mjs:42` explicitly bundles daemon entry alongside runtime | Supports a process/session lifecycle richer than a one-shot CLI child. Whether recovery works in Hades must be exercised; deliberate daemon survival changes Hades shutdown semantics. |
| Typed worktree API | `src/main/runtime/rpc/methods/worktree.ts:30–249` | Real `worktree.create/show/sleep/activate/rm`, lineage and creation argument validation. Avoid two engines creating/removing the same checkout. |
| Runs, task graph, dispatch | `src/cli/specs/orchestration.ts:7–200`; RPC aggregation `src/main/runtime/rpc/methods/orchestration.ts` | Run is a namespace/mailbox, explicitly **not a scheduler**. Task dependencies and supervised dispatch exist, but Hades must still own policy and placement choices. |
| Worker lifecycle | `src/cli/specs/orchestration-worker-specs.ts:5–100` | `worker-start/show/read/stop/abandon`; ready vs failed vs outcome_unknown, residual resources and recovery commands. Stop and abandon have distinct meanings. |
| Durable messages/reconciliation | orchestration CLI `check`, `request-show`, `--retry-request`; `rpc/methods/orchestration/runs/mutation-request-show.ts:13` | FIFO delivery replay until acknowledgement; mutation identity supports reconciliation. An absent receipt explicitly does not prove no action happened. Never translate timeout to a fresh dispatch. |
| Structured sessions | `rpc/methods/structured-agent-session.ts:1,62,86`; `structured-agent-session-gate.ts:17–65` | `agentSession.*` requires negotiated `agent-session.structured.v1`; attach path currently casts providers to Claude/Codex. Do not claim every CLI gains a structured resumable session. |
| Transport and startup authority | `src/cli/runtime/transport.ts:1`; `orcad-entry.ts:190–216` | Local Unix/named-pipe and runtime RPC exist. Node startup reconciles restored orchestration authority before binding. Account preparation hooks for Codex/Claude desktop flows are deliberately unset in headless startup. |

The older `orca serve` documentation describes an Electron-backed headless path (including Linux display dependencies). It does **not** invalidate the separate Node `orcad` build present in this pinned source. Conversely the Node build script is not proof that a relocatable signed macOS artifact has been packaged or launched here.

## Hades already has meaningful machinery, but not one unified engine

| Capability | Current Hades default path | Precise remaining gap |
|---|---|---|
| Isolated coding run | `helm-service.ts:98–178`: persist run before dispatch, create Git worktree, execute adapter; max4 live jobs | One-shot runs. Restart marks active runs interrupted (`:33`), rather than attaching to a durable provider/terminal execution identity. No Orca dispatch mapping. |
| Agent delegation | `workbench-service.ts:375–417`, `helm-tools.ts:28–75` | Host binds root/profile/conversation; four delegated tasks/60 reserved minutes; children cannot recursively delegate. This is bounded one-level delegation, not a hierarchical autonomous worker organization. |
| General durable task graph | `durable-work.ts:45–82,128–140,182–240`, Workbench constructor `:341` | SQLite owner lease/revision, dependencies, two ready tasks per batch, continuation sessions, token reservations, explicit resume. It executes Hades conversations through executeWorkRequest, not Orca dispatches or a unified OpenCode team. Acceptance is bounded path/contains checks (`:172`), not a full engineering review gate. |
| Persistent coding conversation | `helm-code-service.ts`, `helm-code-storage.ts` | Actual embedded OpenCode engine/UI; separate storage/execution identity from Helm runs and Work goals. Session existence does not map to a verified change or a task graph receipt. |
| Scheduling | Workbench timer `:357`, `runJob :2645`, persisted wakes `:2650` | Default desktop uses routines/wake queue. `schedule-service.ts` is an adapter requiring an attached runner and honestly refuses without one (`:249`); do not count every scheduler module as default functionality. No single durable owner tying a scheduled objective to an Orca run and review/apply outcome. |
| Teams | Workbench `:1422–1459`, TeamClient/TeamDeliveries | Human/team communication and reply delivery. Distinct from supervised agent dispatch/worker mailboxes; neither should be relabeled as the other. |
| Verification/apply | `helm-service.ts:210–238`, `helm-integration.ts:97,146–148`, source-check and preview modules | Valuable source/diff verification and durable uncertain apply states already exist. Preserve them; a worker_done or CLI exit must never bypass review or authorize merge. |
| Permissions/budgets | `helm-tools.ts`, Workbench host closures; adapter arguments `helm-adapters.ts:22` | Keep local agent permission modes and conversation authority. Git worktree is not an OS sandbox. Aggregate child cost/account identity and Orca permission response mapping are not unified today. |

## Recommended implementation boundary

**Integrate actual pinned Orca as an owned runtime; keep the actual OpenCode fork.** Do not rename existing HelmService “Orca” or copy isolated algorithms and claim full Orca functionality. Do not add a second independent top-level scheduler.

1. Add an explicit Helm execution backend interface whose durable record holds Hades objective/task/attempt IDs, Orca runtime identity/Run/Task/Dispatch IDs, canonical repository/worktree identity, provider session identity where supported, and request fingerprint. Keep legacy adapters available during migration; one attempt has exactly one backend owner.
2. Start a private, pinned `orcad` artifact under Hades lifecycle management with explicit data-root and transport identity. Validate native dependencies and supported capabilities before offering it. Never discover and adopt arbitrary user Orca runtime authority implicitly. Keep setup hooks off unless explicitly authorized; Orca new-worktree setup defaults differ from current Hades Git safety choices.
3. Initially integrate one vertical lane: create Run/task → supervised worker on owned isolated worktree → bounded transcript/status → explicit permission response → stop/recover → existing Hades verification/review/apply. Expose actual missing capability/authentication instead of substituting another provider silently.
4. Choose Orca as the worktree and worker lifecycle owner for that lane; Hades records and reviews its outputs. Legacy HelmService can own legacy runs, but must not recreate, delete or independently restart Orca-owned resources. Wire OpenCode sessions to these task/worktree records without assuming Orca structured Claude/Codex APIs support OpenCode. Verify actual Orca OpenCode worker capability or retain the OpenCode server adapter for that provider.
5. Hades Work remains the objective/dependency/budget/acceptance authority. It asks Orca to execute ready tasks; Orca is the worker authority. Persist transition/dispatch intent before calling it, reconcile uncertain outcomes, and expose human-required decisions in one inbox. Child permissions can narrow inherited authority; they cannot broaden it. Stage federation/remote hosts after local ownership is proven.

## Acceptance cases (must measure, not infer)

- **Actual runtime packaging:** offline clean-user launch of pinned orcad, native PTY/watcher checks and RPC version/capability receipt. No dependency on developer checkout, Electron window, or globally installed Orca. Capture binary/source hashes and retained license inventory.
- **One dispatch despite lost acknowledgement:** interrupt after worker creation before Hades receives reply; restart Hades and reconcile same request/dispatch. Assert exactly one worker/worktree, no fresh task dispatch, and unknown remains visible when proof is absent.
- **Ownership and shutdown:** competing Hades owners cannot claim one attempt; terminate runtime, Hades and worker independently. Assert documented daemon survival/termination and reattachment behavior, no killing unrelated terminals, no automatic provider prompt resend.
- **Permissions:** two profiles/projects, malicious child asking for another root/account, expired decision, deny/cancel then late response. Assert no cross-profile access or late action. Exercise native permission wait via real supported provider separately from fixture tests.
- **Graph/budget:** three dependent tasks plus an independent failure, concurrent worker cap, child spawning denied or explicitly budgeted. Assert dependency gates, reserved unknown usage, bounded attempts/time and no scheduler duplicate after restart.
- **Worktree fidelity:** dirty source, same repository reached by symlink, concurrent creation, untracked conflict, binary/deleted files, source drift after review. Assert canonical ownership, no source mutation before explicit apply and no stale verification accepted.
- **Provider sessions:** real Claude/Codex structured create/attach/send/respond/cancel where installed and authorized; OpenCode separately via its actual server. Assert unsupported capability is visible and provider authentication is not inferred from executable version.
- **Terminal/output:** reconnect with transcript cursor, source_changed, backpressure, very large output, waiting human prompt and worker stop. Assert bounded retained output and waiting/failed/unknown are distinct.
- **End-to-end engineering outcome:** user objective → parallel bounded workers → independent checks/review → explicit integration → source checks → local preview. Require actual changed artifacts/test receipts, not worker success text. Native UI, real provider and browser permission gates are separate evidence classes.

No runtime or broad-suite readiness conclusion follows from this audit. Immediate next implementation is the single owned Orca vertical lane above, with the acceptance cases used as its contract; remote federation and automatic multi-repository merging remain later gates.
