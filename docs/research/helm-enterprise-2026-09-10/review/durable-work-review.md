# Independent durable work review

2026-09-10. Reviewer: integration agent; did not author this implementation. Read-only source review plus new deterministic SQLite/filesystem regression tests. No provider, socket, listener or native UI execution.

## Initial verdict at reviewed source

Changes required. Two concrete regressions reproduced (2/2 newly added tests fail); a third lease gap is supported by source inspection. This is not a blanket approval or live autonomous-work acceptance.

1. **Overlapping nested project roots admit the same file.** `claimReady` filters busy goals by exact root equality before comparing project-relative reservations. Outer project `root` with `sub/shared.ts` and inner project `root/sub` with `shared.ts` both execute. Red test expected1 execution, observed2. Compare canonical absolute paths across all active goals, with conservative case/Unicode normalization. The reservation is cooperative coordination, not an OS permission boundary.
2. **Shutdown persistence failure leaves other plans uncancelled.** `close` aborts one controller then writes its state before visiting the next. A deterministic SQLite trigger refusing the first update causes an exception and leaves the second live signal un-aborted. Abort all live controllers first, then best-effort persistence/cleanup in guaranteed paths. Do not allow failed receipt saving to prevent process cancellation.
3. **Post-tool hook lacks a fresh work effect guard.** Workbench `perform` guards before pre-hook and again before tool dispatch, but after the awaited tool result, the post-hook is guarded only by `!journalFailure`. A lease revoked during the tool can permit a subsequent post-hook until heartbeat cancellation. Recheck authority before post-hook, retain the already-returned tool result, and record/skips hook separately. Source finding; no network-based Workbench test attempted.

## Evidence examined

- DurableWork SQLite owner/lease/revision CAS, attempt identities and callback ownership checks; ready-pool scheduling, dependencies and reserved unknown tokens.
- work-evidence path normalization, symlink refusal, bounded regular-file checks and SHA256 freshness comparison. Task artifacts are immutable checkpoints until goal acceptance; this review does not demand dependent mutation of those artifacts.
- Workbench session root/profile/goal/task binding, effect guards after permission wait and file serialization, and delegation approval filtering.
- delegation-tools host-bound scope, depth cap, durable budget reserve callback and owned-goal callbacks. UI contract fields expose writes/checks/attempts and concurrency; this was data-contract inspection, not visual/native acceptance.

Preserved distinctions: completed task answer alone is not goal acceptance; configured task outputs are checked before dependent admission and effects; goal output checks are file/text evidence, not a complete software test suite. Token reservations are conservative accounting, not a guaranteed provider billing ceiling. Existing tests cover restart/no replay, stale callback rejection and unknown usage. No additional concrete defect found in those bounded paths beyond findings above.

## Retained reproducibility

New test: `src/desktop/__tests__/durable-work-review.test.ts`.
Red log: `/tmp/durable-work-independent-review.log`; SHA256 `3445be75d6005adc4591f9d7f30602e85a11a0a45fa6504d79a88cfe42a6b2ec`.
Existing deterministic suites log: `/tmp/durable-work-review-existing.log` (results retained separately from adversarial failures).

Reviewed source hashes (working-tree snapshot, not an accepted release commit):

```json
{
  "src/desktop/core/durable-work.ts": "151c128b309481dc08cf085027fcb32a5a299de05aeeb66f6bdea9f852641443",
  "src/desktop/core/work-evidence.ts": "1f4ea61cdebfef12c74f78b372886ba7e11e738fce2c613e24884e87ecfe991d",
  "src/desktop/core/workbench-service.ts": "68f6a5d2db7b331305e5998cd515d7266b2ad29efd4abdfdef8d7692ec65ce33",
  "src/desktop/core/delegation-tools.ts": "a5dd809afacf845040cc544c1fcc985e90b82c671b699b3aed9054b89ca4b07a",
  "src/desktop/ui/work-goals.ts": "7d922d83f92e9da4563b0afbc3ab388644e045b954700cc35ebef7d7c13d04ce",
  "src/desktop/__tests__/durable-work-review.test.ts": "d2cf202595b900228962e647031d8e6bb6e8d878f4ea3bd053f8f11a1a1a7f21"
}
```

Repair confirmation pending implementation owner; reviewer will append fresh test evidence after fixes.

## Repair re-review — scoped acceptance

The three reported defects are repaired in the source snapshot below. Independent rerun of `durable-work-review.test.ts`, `durable-work.test.ts`, `delegation-tools.test.ts`, and `workbench-enterprise.test.ts`: **4 files, 32 tests passed**. The two original red regressions are now green. No network listeners, provider calls or native UI were exercised; Workbench's provider interaction is an in-process fixture.

- Admission now compares canonical absolute reservations across all live plans. `workPlanWritesOverlap` delegates to NFC-normalized, case-folded prefix comparison; same-batch and already-running candidates use the same policy. The nested-project regression passes. Existing rolling-scheduling test proves a newly ready task can start while an unrelated slow task continues; conflict serialization still passes.
- `close` aborts every controller before any persistence operation, attempts remaining checkpoints even when an earlier one fails, closes the database and reports checkpoint failure through `deps.failed`. The SQLite-trigger failure regression proves both workers receive cancellation.
- Workbench rechecks the guard before post-tool hooks, emits a separate cancelled-hook receipt on refusal and preserves the successful tool result. The new in-process fixture writes the expected file once, revokes authority on checkpoint finish, observes no forbidden post-hook output, and retains `ok:true` for the completed file operation.
- Orca Workbench routing validates project/profile scope and missing artifact before creating an intent. The in-process absence test observes state missing, rejected start and an empty intent list; unauthorized project listing is refused. Maintenance includes durable Orca active-work state; shutdown closes service and owned runtime. This accepts the **missing-runtime gate**, not a real packaged Orca execution.

No additional concrete blocker found in this bounded repair review. Edit reservations remain cooperative coordination rather than an OS sandbox, checked task artifacts remain immutable until goal acceptance, and completion evidence remains scoped to configured checks. Real runtime/provider/permission/native UI acceptance remains outstanding and is not implied by these tests.

Recheck log: `/tmp/durable-work-independent-recheck.log`; SHA256 `d320ffbb84d349b5f2a487cb4d2d3c02b0445f2f88509bbec4f3b1e6cffd3e8c`.

Exact repaired source/test hashes:

```json
{
  "src/desktop/core/durable-work.ts": "cbb5d359a8e53c31d0784c758593653b2e0f4e8a8e60ddc7fb8accd9d433d8d6",
  "src/desktop/core/work-evidence.ts": "e01fc36e22ce7506f74779d8a711a808334106098c8c3e2b8822d206dc687252",
  "src/desktop/core/workbench-service.ts": "7be571728507fcbf0a340ae099661c97c298b1b50451c48e234131cc5d849fac",
  "src/desktop/core/delegation-tools.ts": "c6e70ecc9f4a08e09bcac24f1b56c0e837166719ae6cb4088f2b4066c2ab3295",
  "src/desktop/__tests__/durable-work-review.test.ts": "d2cf202595b900228962e647031d8e6bb6e8d878f4ea3bd053f8f11a1a1a7f21",
  "src/desktop/__tests__/workbench-enterprise.test.ts": "da57f4db83fefb3792139c35c3bd2a9d413b6d9d489466fa4c93128bc22ce5a2"
}
```
