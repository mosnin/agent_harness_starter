# Durable Work → Orca engine boundary

2026-09-10, source candidate based on `b6ec8b860252b34eefc80e0914bc1d1393eefb6a`. This is implementation verification, not independent or native acceptance.

## Product contract

Work tasks retain the Hades conversation engine by default. An explicit engine object `{kind:"orca",agent:"codex"|"claude"|"opencode",model?:string}` selects the actual existing Orca service. Caller-supplied request IDs and dispatch markers are rejected. Work creates an immutable request identity, persists the dispatch intent and binds it to the dispatching WorkAttempt before invoking the service. Source/runtime authority stays with the selected task profile and canonical project; no fallback provider is chosen.

The new `work-orca.ts` uses the existing `HelmOrcaService` public methods. It does not create a scheduler, worker or worktree implementation. Work child sessions still cannot invoke conversation Orca delegation tools. New task form selection reaches `work.create`; saving a draft does not start a provider.

Orca owns an isolated worktree. The engine observes acknowledged workers within the host time allocation. Worker readiness or exit never verifies source output. Unknown/exited/failed outcomes retain a review error and unknown token reservation; they cannot complete the task or release dependents. Hades measured usage is unchanged. This is **not** provider token/time/spend enforcement.

Resume reconciles the saved Orca intent instead of allocating another worker, including after service-journal reopen. A saved intent with no service record fails closed without replay. Reconciliation uses zero additional token reservation and preserves the original unknown reservation; its control calls remain bounded by Work rounds/time. There is currently no new-engine retry or completion shortcut: a distinct provider attempt requires a future explicit reviewed retry flow. Exact Orca worktree integration/acceptance remains an open gate.

Stop first cancels Work admission, then targets only engine IDs retained on that scoped goal. Active observation cancellation also requests the owned service stop. Service stop receipts retain uncertain termination rather than treating Work cancellation as proof that a remote provider exited. Missing package artifacts are checked before Work admission allocates an attempt or tokens, and again before dispatch.

## Verification

```sh
./node_modules/.bin/vitest run src/desktop/__tests__/workbench-work-orca.test.ts src/desktop/__tests__/work-orca.test.ts src/desktop/__tests__/durable-work.test.ts src/desktop/__tests__/durable-work-review.test.ts src/desktop/__tests__/work-goals.test.ts --maxWorkers=1
./node_modules/.bin/tsc --noEmit --incremental false
git diff --check
```

**57/57 tests across five files passed**, `/tmp/work-orca-final-tests.log` (1.52 seconds). Full root TypeScript passed with no output, `/tmp/work-orca-types-final.log`. Diff whitespace check passed. No installation, provider call, network/listener, native process or app control was performed.

New engine tests cover three repeated fault trials for each of: retained unknown acknowledgement with no repeat start; crash after persisted intent but before service allocation; actual `HelmOrcaService` SQLite reopen after a lost worker acknowledgement using injected in-process RPC. These are synthetic crash-boundary tests, not process-kill/runtime trials. Additional cases cover artifact preflight, caller identity rejection, current-scope stop, exit without acceptance, unknown usage, persisted Work attempt identity, and restart reconciliation. Actual Workbench routing is tested with an explicit offline webhook replacement and absent runtime artifacts; it creates no provider attempt. DOM tests verify explicit selection/default Hades and disclosure, not native visual quality.

## Candidate file hashes

| File | SHA-256 |
|---|---|
| `src/desktop/core/durable-work.ts` | `076e7b560562c4bdc4a27fb6695d33b189b718783a8cf97eb72892b2ac2683ab` |
| `src/desktop/core/work-orca.ts` | `587343d34a1c24ed5027de49d72d1d1b8e72be78f1625e4c659ed5d94fcdeb3c` |
| `src/desktop/core/workbench-service.ts` | `e505712167c4b2f562580e6465a58c3faa46c051ba7d8b5da7bf62c7c48cc5fe` |
| `src/desktop/ui/work-goals.ts` | `57fd0fce980528762ba99909eb44ff135979f9c867a06d62b207869b6e282ae4` |
| `src/desktop/__tests__/work-orca.test.ts` | `43fcedf9e04dcc281f9ec8c0a366e9def028bd92144fe518f021761ecfc971ef` |
| `src/desktop/__tests__/workbench-work-orca.test.ts` | `23dc91cdbea0dd1b9c81426a478a324db766857882cfdfe6f74f5daf603be60f` |
| `src/desktop/__tests__/work-goals.test.ts` | `4567a148c032aeadd82a2d4a1511a6b95e32c5dc12d11f11fb7f9ffac8893d7c` |

Remaining: independently review this source boundary; package exact Orca dependencies; exercise real runtime/provider cancellation and restart; implement exact worktree artifact review/integration and explicit terminal retry; verify the native task selector and recovery journey. This does not close G03/G05/G09/G11/G12/G13/G16 or the broader active Helm goal.

## Independent finding and author repair: preflight isolation

The independent reviewer reproduced a defect in the candidate above: an unavailable Orca task threw from admission preflight and rolled back the entire ready batch, preventing an unrelated Hades task from executing. Earlier hashes and results remain historical and do not accept this behavior.

The author repaired only `durable-work.ts`. The catch now encloses only the selected Orca task's artifact preflight. That task receives a failed/reviewable status and actionable error without allocating an attempt, reservation or service record; admission continues for independent ready siblings. All changes still commit together in the existing admission transaction/audit transition. Dependency evidence, write-path validation and storage/transaction failures retain their existing propagation and rollback behavior. Goal review text includes the failed task's reason.

Rerun added `src/desktop/__tests__/work-orca-review.test.ts` to the five-file command above: **63/63 across six files passed**, `/tmp/work-orca-preflight-repair.log` (1.64 seconds). The six independent reviewer tests include unavailable-Orca-first with concurrency one/two and Hades-first ordering. Reviewer tests were not edited. Full TypeScript passed, `/tmp/work-orca-preflight-types.log`; scoped diff whitespace check passed.

Repaired `src/desktop/core/durable-work.ts` SHA-256: `9f9411cde4bb2d7fc2a196c5689da3010cec64d4ff4427e031ef26d976fd58ac`. This is author repair verification pending the reviewer's rerun, not self-issued independent acceptance. Runtime/native/provider gates above remain open.
