# Orca output to accepted Work result

Local source checkpoint, 2026-09-10. Repository `mosnin/agent_harness_starter`, branch `claude/hermes-swarm-framework-vbhrot`, starting commit `c44644192872ff9e0887e38c9a68df1e910dc376`. The exact follow-up candidate is bound by [the receipt](orca-output-v1-receipt.json). The enterprise goal remains active; product acceptance is false.

## Delivered behavior

Orca dispatch now pins the actual source commit and repository identity before calling its existing `workerStart` contract with `baseBranch`. Import resolves the exact owned runtime, dispatch and managed worktree; it requires matching base and repeated exact exited-worker observations. Legacy records without this provenance cannot be imported by guessing a branch or merge base.

**Review changes** in Work or Orca copies a stopped worker's output into a separate Helm review worktree. The import preserves tracked, untracked, binary, deleted and executable-mode changes through a private index and full binary patch. It preserves source and worker file contents and their real indexes; Git worktree registration intentionally updates Git metadata. Descriptor, source, destination and workspace identities are checked around materialization. A durable import claim prevents replay after an uncertain copy. Imported output starts in **Needs review**.

The user follows Helm's existing checks, changes and source-check panels. No new substitute coding workspace is introduced. The displayed full patch must match the apply digest. Work reserves source operations against its task scheduler, and Stop fences the actual apply/check dispatch as well as queued Work-bound requests. Other editors and non-cooperating processes are not an OS sandboxed part of these reservations.

**Accept task result** is a separate action. The host revalidates the goal/task/profile/request/import/review/source-check relationship, checks the current source fingerprint and task output files, and refuses pending instructions or stale dependencies. Acceptance stores the exact receipt and checked file hashes. It retains unknown provider token reservations and original attempt history, and does not dispatch a dependent automatically. Resume can then run remaining tasks within the existing limits.

Durable apply claims serialize cooperating processes across Hades data directories using the canonical repository Git metadata. Unknown dispatched effects retain their claims. A confirmed applied receipt can release only its matching completed root claim without replay; a short SQLite transaction prevents a cleanup race from deleting a newer claimant. Work exposes this confirmed-application reconciliation in its recovery controls. A clean shutdown drains source operations and clears settled reservations.

## Verification

| Final command | Result | Scope |
| --- | --- | --- |
| `npm run test:work:offline` | 296 passed, 29 files | Injected runtime/model contracts, actual disposable Git/worktree/file/SQLite operations, bounded command processes and DOM fixtures |
| `npm run test:plugins` | 254 passed, 18 files | Plugin/framework and shared desktop regression fixtures |
| `node node_modules/typescript/bin/tsc --noEmit --incremental false` | Exit 0 | Full source typecheck |
| `npm run desktop:build` | Exit 0 | Sidecar and desktop frontend bundles |

The two test runners share **11 routing cases in one file**: 539 distinct test cases across 46 files. Independent reruns and author-focused passes are not added to that count. These are local control/data/UX tests, not a coding-intelligence score or native/provider acceptance.

The actual Workbench fixture repairs a small arithmetic module in a modeled Orca worker's real isolated Git tree, imports once, runs a meaningful `node --test` oracle in the snapshot and source, explicitly accepts, retains the 10,000-token unknown reservation, and runs one dependent only after an explicit budget extension and Resume. A separate assigned coding profile stays distinct from the goal owner's review authority. Real provider dispatch is replaced by an injected contract in this fixture.

An actual owned child-process SIGKILL fixture exercises apply-claim persistence and recovery after the applied receipt was saved. It is not the required 60-minute real agent-team run. UI verification uses DOM/RPC fixtures and a Workbench callback round trip; installed native pointer, keyboard and rendered appearance were not exercised.

## Findings repaired during review

- Import destinations could be inside source files or Git metadata; canonical descendant guards now refuse before materialization.
- A clean shutdown stranded a reservation after a source callback stopped without an effect; shutdown now waits for settlement before closing SQLite.
- Work's import/accept/run authority checks had transaction windows; the write transactions and conditional owner claim now repeat those checks.
- Stop during the initial source fingerprint could allow the first check command to start; the source-check service now receives cancellation and authority guards through every launch boundary.
- A saved applied receipt followed by a crash before cleanup could leave the source gate stuck; exact completed-claim reconciliation now releases that claim without replay.
- Queued Helm mutations bound to Work could outlive Stop before acquiring a reservation; exact Work scope hints let the queue revoke those requests, and the host validates the hints independently.

The broader regression also exposed an old non-Git transport fixture missing its explicit base resolver, and the new multi-profile fixture initially kept the newly created worker profile selected while invoking the manager's goal. Those fixture defects were corrected without weakening production authority checks. Their failing runs are retained.

Independent boundaries are documented in [the provenance review](helm-orca-import-independent-review.md), [the Work and apply review](work-orca-import-review.md), and [the UI receipt](orca-output-ui-receipt.json). Logs referenced there under `/tmp` have same-basename preserved copies in [the evidence directory](evidence/orca-output-v1/); the integrated receipt records their hashes. Historical inspection hashes in those reports describe their stated review pass; the integrated receipt binds the final candidate.

## Open acceptance gates

- Exact packaged Orca, PTY/watcher and authenticated provider execution have not run. Legacy records lacking creation provenance remain non-importable.
- Failed/uncertain import claims and genuinely unknown apply outcomes stay retained; arbitrary manual claim clearing is not offered as recovery. The required real restart/recovery program remains open.
- Provider token/time/spend enforcement, explicit replacement-worker retry semantics, and the real 60-minute team trial remain incomplete.
- Native visual/keyboard/pointer testing, the real capture-to-code workflow and the matched 24-case/three-trial product comparison remain open.
- The seven Plugins source adapters and bundled Company OS instructions are retained. **0/7 live OAuth account journeys** are accepted; provider migrations/deployments, framework publication/update distribution and full enterprise controls remain separate unfinished work.

No application was installed or operated, no provider account was used, and no repository was pushed or deployed in this checkpoint. The earlier denied actions were not retried through another route.
