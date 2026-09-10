# Explicit worker replacement and bounded host observation

This local source checkpoint starts from Hades `23490e4c1a2a45fb35522b19dde5269337be7a6d`, branch `claude/hermes-swarm-framework-vbhrot`, repository `mosnin/agent_harness_starter`. The enterprise goal remains active. Actual Orca, provider, native and matched-comparison acceptance remain open.

## Behavior

Previously, Resume could only reconcile the same Orca request. A stopped failed worker could never be deliberately replaced. Work now exposes **Prepare replacement**, a fresh eligibility check, explicit confirmation, and **Replacement ready**. Preparing does not dispatch a worker or apply source changes. Resume uses the ordinary task admission path and requires remaining host allocation, time and attempts.

The host checks the exact goal, manager profile, assigned worker profile, task, attempt and predecessor request. The Orca service requires either an exact exited worker with matching runtime/dispatch/base or a pre-dispatch intent that can be permanently retired by a cancellation flag and revision compare-and-swap. Missing records and uncertain dispatches refuse replacement. A service-owned seal chooses one successor UUID permanently. Two processes cannot choose different successors for one predecessor, and a late predecessor owner cannot advance to workerStart after sealing.

Work saves the successor and original seal in replacement history. It preserves all old attempts, imports, rounds and unknown usage allocations. Neither worker exit nor replacement settles provider usage. Normal admission reserves the next attempt separately; limits are not automatically enlarged. Historical snapshots and already prepared reviews remain readable, but preparing a new predecessor review, applying its patch or accepting it for the successor is refused.

Replacement claims reserve the project against cooperating Work/source operations. Only the exact replacement metadata claim can be recovered after a crash: the previous claim identity is fenced, and the same permanent predecessor seal is adopted. An apply/check/import claim is never retired through this path. Stop cancels the claim and fences a late Work checkpoint. If Stop arrives after sealing, the seal remains retained and a later explicit replacement retry adopts it. A crash after the Work checkpoint is reconciled from the exact saved history/seal without another dispatch.

An independent host lifetime now bounds startup, recovery, status and wait calls. A held callback cannot prevent the caller from observing its deadline or cancellation, and a late callback cannot resume execution. Revoked Work authority triggers Stop for the exact retained owned intent. Stop itself may remain unconfirmed; its result is not fabricated. Signal-less runtime reads can remain pending inside the service after the caller settles, so they remain visible to maintenance until their actual settlement.

## Pinned upstream contract

Source review of actual Orca `bf4e2705046cf9ef9c915929a9646da85717af07` found:

- `workerStart.timeoutMs` controls boot readiness, not provider execution duration.
- The worker contract has no normalized token, spend or internal-turn cap, and no normalized usage receipt in workerRead/workerShow.
- Claude structured result accounting is suppressed from its transcript; Codex token-usage frames are status chrome and not journaled. Parsing terminal prose would not provide reliable accounting.
- OpenCode lacks an agent model-option catalog, so a requested model override is rejected upstream. New Work now refuses this unsupported choice before allocating an attempt, held usage or dispatch intent; the Orca service independently refuses before its admission. Historical acknowledged requests retain their idempotent read behavior.

The UI distinguishes reported tokens, unknown held allocation, historical original allocation, host time and Work attempts. These are host admission/observation policies. Provider token/spend limits, normalized usage telemetry and enforcement across a host crash still require an actual negotiated upstream implementation and real provider trials. No provider-enforced cap is claimed here.

## Verification and review

The [source receipt](orca-replacement-v1-receipt.json) binds the final commands, source and artifact hashes, and logs.

| Final command | Result | Scope |
| --- | --- | --- |
| `node scripts/check-work-offline.mjs` | 391 passed, 37 files | Serialized test files; internal task/process concurrency remains exercised |
| `node scripts/check-plugins.mjs` | 303 passed, 21 files | Plugin/framework and shared desktop source fixtures |
| `node node_modules/typescript/bin/tsc --noEmit --incremental false` | Exit 0 | Fresh full source typecheck |
| `npm run desktop:build` | Exit 0 | Sidecar and frontend source bundles |

The runners share 11 routing cases in one file, giving 683 distinct cases across 57 files. Focused author and independent reruns are contained by the broader regression; their counts are not added again.

The initial two-file-worker run had 9 five-second timeouts in existing Git fixtures and one teardown rejection after timeout removed a still-used temporary directory. Those same 37 cases passed unchanged in isolation. The runner now serializes test files, without increasing deadlines or removing concurrency assertions. The final full run passed 391/391 with no unhandled errors. This establishes the recorded serialized gate; it does not retroactively pass the initial parallel run or identify the Mac's overall load as a proven cause.

The first fresh typecheck also caught Stop-state narrowing errors missed by DOM execution. Explicit state typing and a current-selection guard repaired these; fresh full types and the UI suites passed afterward. Pre-repair logs remain retained.

The tests use injected Orca/provider transports, real disposable SQLite/Git/worktrees/files, a bounded Node file-content check, and DOM/RPC fixtures. They test concurrent confirmations, shared-store claim recovery, cancellation around sealing, saved-seal recovery, zero implicit budget refunds, additional-attempt admission, old-output fences, changed profiles/projects and queued Stop. Nine additional trials actually SIGKILL an owned child host process: three repetitions immediately after the claim, after the seal, and after the Work checkpoint. The parent recovers the retained SQLite state, preserves exactly one successor and prior unknown allocation, and dispatches exactly one modeled successor only after an explicit allocation extension and Resume. This is actual host-process crash evidence with a modeled worker transport. No listener, installed app, real provider or native worker is used.

Independent review found and repaired stale eligibility after a new overlapping claim, an unsupported model consuming host admission, authority revocation leaving an owned worker unstopped, detached service calls becoming invisible to maintenance, and contradictory worker identity releasing capacity. A historical-review challenge added the current Work binding guard to new review preparation. See [the backend review](orca-replacement-independent-review.md) for red evidence and exact reviewed source hashes. UI review additionally verifies no implicit Resume limit increases, reachable Stop during preparation, late-result fences and exact saved-metadata recovery. A completed objective can still have a new review operation; Stop now cancels that review while preserving its prior acceptance. The final frozen gate is included in the receipt.

## Remaining gates

The actual Helm fork remains `mosnin/opencode@89bac15fcea8f7fb90d50c6d4cf457b25673a7b5`. The pinned Orca runtime has not been rebuilt, packaged, booted or exercised with actual provider credentials. No native Hades interaction, real 60-minute team run, seven-platform live OAuth acceptance or matched harness comparison is claimed. Existing permission and disk constraints remain; they have not been bypassed. This checkpoint advances G05/G09/G10/G16/G18/G20 source evidence and does not close the enterprise goal.
