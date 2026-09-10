# Orca replacement independent review

Disposition: bounded source and offline fixture acceptance of replacement identity, recovery, inspector freshness and predecessor-output fences. This is not actual Orca/provider/native acceptance or provider budget enforcement.

Independent tests: `src/desktop/__tests__/workbench-orca-replacement-review.test.ts` (four cases). The offline/real-Git fixture was adapted from the author's route suite; only artifact validation is modeled, not admission preflight. No service listener or provider was started.

Two concrete defects were reproduced and repaired by root:

- A source claim appearing during awaited worker inspection still returned eligible. Current inspector captures Work revision and rechecks overlapping claims across profiles/goals and editing tasks after the await. Independent same-goal and foreign-profile cases pass.
- Unsupported OpenCode model failed only after allocation, leaving one attempt, 10,000 unknown reserved tokens and a dispatch intent without any service row. Engine-aware admission preflight now refuses with zero rounds, zero reservation and no dispatch intent. Task status is `failed`, goal `needs_review`; the initial reviewer assertion incorrectly used the goal status for the task and was corrected without weakening allocation assertions.

Historical prepared output was separately challenged by the author route test during independent rerun. Before repair, a predecessor snapshot could prepare a new review after replacement. Current Work-bound prepare enters the source-operation guard and validates current workOrigin. The strengthened test first verifies actual immutable imported file contents and prepares a review, then rotates the predecessor. Historical get remains available; new prepare and old apply refuse. After successor dispatch, old apply and acceptance still refuse and original source bytes remain unchanged. This evidence uses modeled Orca transport with real local Git/filesystem and a synthetic Node verification command, not a native worker.

Final command:

```sh
./node_modules/.bin/vitest run src/desktop/__tests__/workbench-orca-replacement-review.test.ts src/desktop/__tests__/workbench-orca-replacement.test.ts --maxWorkers=1
```

Result: 17/17 across two files, of which four are independent and thirteen author cases. Log: `/tmp/orca-replacement-final-boundary-review.log`. Earlier red evidence: `/tmp/orca-replacement-independent-red-v3.log`. Do not add these counts to a containing broader gate.

Source review confirmed stable successor sealing and revision-fenced metadata claim recovery; cross-instance recovery fences prior callbacks, unrelated source claims remain held, and replacement retains predecessor attempts/import history/unknown allocation. No additional concrete blocker reproduced within this scope. Race checks remain cooperative host guards, not OS isolation or proof of provider termination.

SHA-256 at final read:

| File | SHA-256 |
|---|---|
| src/desktop/core/durable-work.ts | 0ffefef89ad49d1fb35137521816bae92edf1a859178c1ae443269529ab5588f |
| src/desktop/core/workbench-service.ts | 4e1db0fe74ad91ab7aa760e60b27251b7c31756572dff9a250d6b987ba342983 |
| src/desktop/core/helm-orca-service.ts | 09b2e5f1b85aa559e50a14a30652c239d8732815ffc8b5700e121dba3bc56f4f |
| src/desktop/core/work-orca.ts | e2771f8dfda96faad03ac613e03d2d2965750adb8f5a6244919e03e8003c4409 |
| src/desktop/__tests__/workbench-orca-replacement.test.ts | 8ea0f109f4986001353ffd143cdc1e530d224bc46b0f40370f53e58f6159c5d9 |
| src/desktop/__tests__/workbench-orca-replacement-review.test.ts | 783792d3e100126634adacb8c7d518a59c5b874e334eeca9a025add56a3f406c |

The reviewer authored work-orca deadline code, so this report does not independently accept that implementation. Its guard-revocation and detached-operation maintenance checks were reviewed separately by provider_readiness. Runtime calls without cancellation support can remain tracked after caller timeout; no measured token usage or confirmed process termination is inferred.

## Final backend follow-up

The preceding 17-case run and source hashes remain historical. A further independent authority suite reproduced four capacity-release defects: workerShow with a missing worker or contradictory dispatch/runtime/base still released the retained active reservation. The service now requires matching worker dispatch, runtime epoch and retained base before accepting the observation. All five independent cases (four contradictions plus valid control) passed in `/tmp/orca-status-authority-independent-final.log`. Test file: `src/desktop/__tests__/helm-orca-status-authority-review.test.ts`. Contradictions retain active capacity and report unknown; the valid exited observation remains unchecked output, not acceptance.

Reviewed author evidence `/tmp/hades-replacement-crash-boundaries.log`: 22/22, including nine actual owned-child SIGKILL cases (claim/seal/Work-checkpoint, three repetitions each). Source inspection confirms child self-SIGKILL and durable reopening; these are real process-crash fixtures with modeled Orca transport, not actual daemon/provider crashes. The reviewer did not rerun this Git-heavy suite during the final concurrent gate.

Reviewed `/tmp/hades-work-completed-stop.log`: one selected case passed, five skipped. DurableWork.stop now validates the goal owner, cancels exact goal source claims and local controllers before returning an already-completed goal. The author fixture starts a bounded Node verification command on an accepted objective, then checks Stop ends new review work while preserving completed status and the acceptance receipt. This is source review plus retained author execution evidence, not an independently rerun native workflow.

The root's initial two-worker broad run had fixture timeouts and a teardown rejection; isolated unchanged Git cases subsequently passed according to root. This review does not infer an environment cause or call that initial run green. Final serial broad-gate evidence was pending at that follow-up; it is resolved by the completed-log inspection below. No additional heavy test suite was scheduled by this reviewer.

Final backend hashes at this follow-up:

| File | SHA-256 |
|---|---|
| src/desktop/core/durable-work.ts | 378b19fe5ce47336bd43c7f111bc3cd2ac96e4ec7141e2f24060b96a1ea3d6f9 |
| src/desktop/core/workbench-service.ts | 4e1db0fe74ad91ab7aa760e60b27251b7c31756572dff9a250d6b987ba342983 |
| src/desktop/core/helm-orca-service.ts | 5f1677801a3aa72a474a2e1166ed28422f0af17dbb21b63e31ea938b7c79a75f |
| src/desktop/core/work-orca.ts | e2771f8dfda96faad03ac613e03d2d2965750adb8f5a6244919e03e8003c4409 |
| src/desktop/__tests__/workbench-orca-replacement.test.ts | 274f01af6bea85a137d342096a876a80901dd09322ed35fc2f7a7a6051d28477 |
| src/desktop/__tests__/workbench-orca-replacement-review.test.ts | 783792d3e100126634adacb8c7d518a59c5b874e334eeca9a025add56a3f406c |
| src/desktop/__tests__/helm-orca-status-authority-review.test.ts | d3dbd2caf48435c4ec448a933f8e1b6ca5a4de41232734f6c4b67d8cb3e4d820 |
| src/desktop/__tests__/workbench-orca-acceptance.test.ts | a77f800492774300418ec1312b7ac7438255b93eb8aed2f2135bfea7525efd4c |

All counts above overlap containing gates and earlier versions; they must not be summed as independent coverage. Scope remains source/fixture backend acceptance with actual packaged runtime, native UI, provider termination and usage enforcement gates open.


## Completed final gate inspection

Inspected retained logs under `audit/evidence/orca-replacement-v1/`:

- `hades-replacement-final-work.log`: 391/391 tests, 37/37 files; final serial run completed in 163.83 seconds.
- `hades-replacement-final-plugins.log`: 303/303 tests, 21/21 files.
- `hades-replacement-final-types.log`: zero bytes, consistent with the root-reported successful full TypeScript exit. An empty log alone cannot independently establish an exit code; root supplies that execution result.
- `hades-replacement-final-build.log`: successful sidecar and desktop UI source-bundle completion markers.

The shared routing file contributes eleven cases to both suites: 391 + 303 - 11 = **683 distinct cases across 57 files**. Earlier focused suites, UI subsets, and repetitions contained in these suites are not additional distinct coverage. All eight final backend/test SHA-256 values in the preceding table were rehashed and matched without discrepancy. No tests or builds were rerun for this final log-and-hash inspection.

Disposition: completed source/fixture gate verified within the stated evidence scope. Historical two-worker failures remain recorded above; the final serial success does not retroactively make them green or establish a specific cause. Source bundling is not native packaging or deployed/runtime acceptance. Actual Orca/provider operation, provider-enforced limits and reliable usage telemetry remain open gates.
