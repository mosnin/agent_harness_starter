# Independent desktop lifecycle repair review

Disposition: **supported at the bounded source and isolated fixture level**. The final candidate passes **35 JavaScript tests in six files** and **11 standard-library-only Rust tests** (nine production helper tests plus two independent wire-correlation tests). No actionable defect remains within the final requested negative oracles. GUI-feature compilation, actual sidecar/native shutdown and runtime/provider operation remain unverified.

The reviewer did not implement the production changes. I added `desktop-lifecycle-review.test.ts` and `request_capacity_review.rs` only, and preserved the previous [pre-review](desktop-lifecycle-pre-review.md). Root and integration repaired the production findings. No listener, native GUI, provider, network request or real Orca runtime was executed in this independent review.

## Finding closure

| Challenged behavior | Final source and observed oracle |
| --- | --- |
| Stop blocked behind startup or inspection | Separate serial, inspection and control capacities preserve mutation ordering while admitting the 18 exact control methods. Spatial workflow stop/cancel receives control capacity by exact string operation; start/replay stays serial. The independent speech/workflow controls and root queue saturation cases pass. |
| Queued Start can execute after Stop | Trusted routing cancels only matching unstarted serial requests. Root fixtures prove a scoped queued Orca Start never creates an intent and queued Work Resume cannot restart its stopped plan. Queued Code open, capture, speech and workflow start/replay have explicit predicates in the inspected code. Raw scope aliases are not guessed. |
| Removing a duplicate incorrectly certifies worker stop | Workbench's out-of-band scheduling context triggers a scoped retained-record lookup. A retained worker still receives its actual scoped Stop; an absent record receives `cancelledBeforeAdmission` with `workerState:not_found_at_inspection`. The UI clears that pending request without inventing a stopped worker. Both paths pass. |
| Client forges queued-cancellation authority | RPC argument fields do not supply the second handle parameter. Only trusted queue matching sets the context. Root fixtures reject wrong-profile cancellation and a forged RPC cancellation hint. The matching function and host subsequently validate distinct concerns. |
| Malformed workflow operation withdraws queued work | The reviewed intermediate JS converted operation with `String`, unlike the native/string validator. Root repaired both routing and queued-cancellation predicates to exact string comparisons. Array/null/object classification assertions now pass; malformed operations do not receive this cancellation route. This was a source finding, not a separately executed red test. |
| Handler/output failure poisons the queue | Queue completion releases lane capacity after resolved, thrown or rejected handlers. The independent test throws from both the handler and rejection sink, and the following request still runs. |
| EOF skips queued callers or ends before admitted handlers | Queue close rejects unstarted entries, aborts active signals and drains every lane. The independent EOF test passes. Sidecar source begins queue close and Workbench revocation before awaiting both, then disposes independent schedule/sidecar resources. Actual stdio/native EOF was not executed. |
| Cleanup failure skips later cancellation | Workbench revokes active conversation/room/capture/approval producers first, isolates synchronous and asynchronous closers, waits for admitted calls/turns/file writes and then closes history. Root tests prove later cleanup occurs after an injected checkpoint failure and that one close promise is shared. Awaited callers receive the failure. |
| Snapshot shutdown returns early or deadlocks | `maintenanceIdle` remains pending until snapshot finally settles. Close blocks new admission immediately and waits before cleanup; snapshot completion does not await its own close promise. The barrier fixture passes. |
| Reentrant admission closes history early | The independent red test found that operation invocation preceded registration in `admissionTasks`: history closed while that callback remained held. Root now registers a deferred promise before synchronous invocation. The unchanged independent test passes, preserving immediate admission while keeping shutdown pending until callback settlement. |
| Final interrupted-turn receipt is omitted | `historyClosed` is distinct from admission closure. Root's fixture emits late interruption/done events while a turn is held, then opens the saved journal and verifies the interruption. Emission after drain no longer reads closed history. This is injected event/storage evidence, not a live provider receipt. |
| Native saturation consumes cancellation capacity | The production std-only helper retains 256 regular and 16 control slots; regular/inspection saturation cannot consume the control reservation. Capacity remains bounded, and control saturation itself returns a refusal. JS/native method lists agree and the Rust conditional workflow cases pass. |
| Duplicate caller ID or stale cleanup removes the wrong waiter | Concurrent duplicates are rejected. Each admission has a monotonic ticket; cleanup removes only matching ticket/ID. Counters survive clear and fail closed at exhaustion. Production helper tests pass. |
| Delayed reply fulfills a reused caller ID | The intermediate native source still delivered by caller ID. The final source sends a unique native wire ID per admission, looks up that exact ID and restores the caller ID only for the matched waiter. Unknown/late wire replies are discarded. Both independent tests pass for timeout/readmission and clear/readmission, including caller-ID spoof and duplicate reply refusal. This wire defect was identified statically; the independent executable assertions were adapted to the corrected API. |

The first independent JavaScript run at local **03:24:12** on 2026-09-10 ran the new review file plus the pure queue file: **nine passed, one failed**, exit 1. The failed assertion observed `journal.close` before release of the reentrant admission callback. The independent TypeScript file was not changed after this red result.

## Final observed execution

```sh
node node_modules/vitest/vitest.mjs run src/desktop/__tests__/desktop-lifecycle-review.test.ts src/desktop/__tests__/desktop-request-queue.test.ts src/desktop/__tests__/desktop-request-routing.test.ts src/desktop/__tests__/workbench-shutdown.test.ts src/desktop/__tests__/helm-orca-ui.test.ts src/desktop/__tests__/helm-orca-readiness.test.ts --maxWorkers=1 --no-file-parallelism
```

Vitest 4.1.5: **six files, 35 passed**, exit 0; local start **03:27:18**, duration **1.29 seconds**, 2026-09-10. SQLite emitted its normal experimental-feature warning.

```sh
rustc --edition 2021 --test src-tauri/src/request_capacity_review.rs -o /tmp/hades-native-request-capacity-independent-tests
/tmp/hades-native-request-capacity-independent-tests
```

Compilation and execution each returned exit 0. **Eleven passed**: the wrapper imports the actual capacity module, so these comprise its nine tests and two independent tests. This does not compile the `gui` feature or execute Tauri's response-reader loop; that wiring was inspected as source. No GUI build is inferred from the standalone Rust result.

The original Workbench/routing/shutdown test constructors attempted webhook listening even with `HADES_WEBHOOK_PORT=0`; zero requests an ephemeral port. They were not rerun unmodified here. The final root Workbench suites explicitly mock `WebhookService` with `OfflineWebhookFixture`; the independent review test supplies its own minimal webhook mock. UI tests use injected RPC. These tests do not establish webhook behavior, listener availability or network policy. Prior receipts describing such unmocked constructors as listener-free require the separate errata already reported to root.

## Final frozen artifacts

All hashes were recorded before the final JavaScript run and verified unchanged afterward. Root's final native receipt hashes also match. The working tree is uncommitted; this table binds files directly and does not imply these changes are in the current HEAD.

| Artifact | SHA-256 |
| --- | --- |
| `src/desktop/core/desktop-request-queue.ts` | `3e2264fa5b1a0ae0fb65ddc595be1a88227c0618e77b2bbf9cf2be660a51a33d` |
| `src/desktop/core/desktop-request-routing.ts` | `5b43556faecdf6a4d96ec914131f536b79efb02df2c5ebe2cf133be9f5389273` |
| `src/desktop/sidecar-entry.ts` | `d85165019e99599beac2780eb4dfabe30824c76afbeaaa70c727505a8d58bd7b` |
| `src/desktop/core/workbench-service.ts` | `ca65ee4ac55142104a583027fc9f34aa98b5799fa22a8376a5d347ba8f682b60` |
| `src/desktop/core/helm-service.ts` | `6a9f7ce53b46b5c665d9c2a7603aaab86bb3899e94db13a75b897bdad0d8af7c` |
| `src/desktop/core/helm-source-checks.ts` | `e902ccc02cb053c18fec9e7ee108f5bf6c17034b3c50c2fe4cf28f8cff7df58a` |
| `src/desktop/ui/helm-orca.ts` | `c2033912db1943f0c66a40a43bb9b07fa8275127433b1569515876589fbfa2d4` |
| `src-tauri/src/gui.rs` | `a52f6997e917139eae87145f651d7ef8c3044750713935262a345201f37efea6` |
| `src-tauri/src/request_capacity.rs` | `39df4cfac52bc25d675827daea57dc72f84daf2d04cd9d2498a9f40064a2d2d6` |
| `src/desktop/__tests__/desktop-lifecycle-review.test.ts` | `0bd40414392cacf3beaf0572cf8f8fc7720144b3fff364de8b2a9b6fee62389e` |
| `src-tauri/src/request_capacity_review.rs` | `693696fe26f64ba0e3e5cb8f82fff9358b5770c385e2a4f0d1e5a377c07038b3` |
| `src/desktop/__tests__/desktop-request-queue.test.ts` | `a37049fc05791bf9ed72a29e0d52f7080d94079a23615cad3acd8784511681bb` |
| `src/desktop/__tests__/desktop-request-routing.test.ts` | `f07be67ff0676874d76e45c365ac9e5694542fa266b648cd9b0cb900a427c378` |
| `src/desktop/__tests__/workbench-shutdown.test.ts` | `59e8996b6e11c0d48b4c2f6ecf39767dbf6abe553df33acafa045b330b4bc2ae` |
| `src/desktop/__tests__/helm-orca-ui.test.ts` | `9941146c0c2ed8429caf3123d1638cf6f26813016f04f7e07439d90b4d3181ad` |
| `src/desktop/__tests__/helm-orca-readiness.test.ts` | `93e2038f6116484e60b02f904a0dff42da0788377af3f4ee7b53560f81bfcac6` |
| `src/desktop/__tests__/fixtures/offline-webhooks.ts` | `2f3647e9820e7b276b31acd06002f5532bb1dc37ae9da78051702cb19174615c` |

## Remaining acceptance gates

The native RPC wait is still **65 seconds** and only withdraws the waiter; it does not cancel unknown sidecar effects. The native process-group lifetime still has its **two-second** hard-stop deadline. Reserved slots and correlated replies do not turn timeout, SIGTERM or helper completion into proof of provider/process-tree termination. Actual shutdown/restart behavior, real lost-acknowledgement reconciliation, exact packaged runtime/dependency closure and provider identity/permissions remain separate gates.

The sidecar drain and GUI reply restoration are source-inspected integrations, not exercised native paths. Full GUI-feature compilation, project type/build checks and any user-authorized installed workflow are owned by root and are not asserted by this review. The mocks also leave webhook/network behavior untested. Independent deliverable verification remains necessary even when a worker exits or an intent settles. This report supplies no full backend, product, enterprise or superiority acceptance.
