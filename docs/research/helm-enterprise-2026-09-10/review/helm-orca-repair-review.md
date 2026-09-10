# Independent Orca repair review

The five original reproductions are repaired in the inspected candidate, and **36 of 36 focused fixture tests passed**. The repair claim is conditionally supported at this local fixture/source boundary. Two additional source-level cases remain actionable; they were not exercised by new tests in this review. Real Orca/PTY/provider operation and product acceptance remain unestablished. Root owns the implementation and acceptance decision.

This review is independent of the repairs. It preserves [the original five-finding report](helm-orca-review.md) and the frozen `helm-orca-review.test.ts`. I changed no implementation or test. The allowed oracle was the existing focused fixture suites; no provider, listening endpoint, native app, real Orca child or upstream downloaded source was executed. Workbench/UI/audit-journal files are concurrently owned elsewhere and are not covered by these frozen core hashes.

The challenged contract is: an already-withdrawn request or deterministic preflight failure consumes no worker capacity; a Stop issued during local startup applies to its late acknowledged dispatch; admitted asynchronous DB work settles before close; runtime startup has one durable owner across managers; one waiting caller withdrawing does not cancel another caller's shared startup; coordinator launch serialization survives queue cancellation. Unknown mutation effects stay uncertain and are not automatically replayed.

| Artifact | SHA256 |
|---|---|
| `src/desktop/core/helm-orca-service.ts` | `572b1b44dba39872ef577da3e482faabd37e6eb45a1b999369116167064a9530` |
| `src/desktop/core/helm-orca-runtime.ts` | `60d949c9bdcd26d9b32e4d9e35ba44c8d9394bb1423624b44a9a0403bf34f967` |
| `src/desktop/core/helm-orca-transport.ts` | `fbaeafaafc9e502d4fad3c31809ba0dc1ae0f04c6edc9e9b856a2896dbbc56f9` |
| `src/desktop/core/helm-orca-errors.ts` | `49863ced7aaff946b73dd3d607a40bb00591da3a5bdae12f859670838bdee811` |
| `src/desktop/__tests__/helm-orca-service.test.ts` | `cf05cc33cde28c31991b8a94ed6f9ac84113875212e6f14304e218de3f569345` |
| `src/desktop/__tests__/helm-orca-runtime.test.ts` | `2a59e866532dfd2cb65965fdd524726f7899c975a9152520a3977ede376c86e7` |
| `src/desktop/__tests__/helm-orca-transport.test.ts` | `7a0e20b39c07f6c1341b00f7e10e819a3c8584aae4ae64759b9d5f11fa5318d4` |
| `src/desktop/__tests__/helm-orca-review.test.ts` | `4b2d6ff57b80b3f3e9a5781c22e8275aba44ecf686c85fadd6b57b93e47cff60` |
| `src/desktop/__tests__/helm-orca-ownership.test.ts` | `e8a62cbf711d07f28016c097d81dd323e762ed7fc88ad030bcb59f49ba9998a1` |
| `docs/HELM-ORCA.md` | `b1ee2fdc049ab6a78cec8150d6d6991247037eb93d30e06ee1ff71d9b2d4c595` |
| `third_party/helm-orca.json` | `2241ee126943d01a90be3783991295b1e3f1efc038de7da312ccd1c112da7eec` |

Observed test command:

```sh
node node_modules/vitest/vitest.mjs run src/desktop/__tests__/helm-orca-service.test.ts src/desktop/__tests__/helm-orca-runtime.test.ts src/desktop/__tests__/helm-orca-transport.test.ts src/desktop/__tests__/helm-orca-review.test.ts src/desktop/__tests__/helm-orca-ownership.test.ts --maxWorkers=1 --no-file-parallelism
```

Vitest 4.1.5 completed five files with 36 passing tests, exit 0, at local 02:47:38 on 2026-09-10, duration 1.14 seconds. The transport uses synthetic EventEmitter sockets, service tests inject RPC, and runtime tests use mocked spawn/request plus inert artifact bytes. The frozen five-test file remains SHA256 `4b2d6ff57b80b3f3e9a5781c22e8275aba44ecf686c85fadd6b57b93e47cff60`.

| Original finding / additional repair | Observed repair and inference |
|---|---|
| F01 already-aborted start consumed an active slot | Service lines 64-66 check the caller signal before scope/intent admission. The unchanged reproduction now passes with no intent, connection or call. |
| F02 invalid artifacts consumed an uncertain worker slot | Runtime lines 15-30 perform typed deterministic validation; service lines 91-96 distinguish HelmOrcaPreflightError and release the active allocation. Missing/empty/wrong/changed/duplicate/path-escape/platform fixtures refuse before spawn. |
| F03 Stop lost its authorization after a late startup receipt | Service lines 125-142 await local startup settlement, reload the record and continue into the scoped Stop once a dispatch ID exists. The frozen late-receipt test passes with exactly one workerStart and one workerStop. |
| F04 close shut SQLite before an in-flight Stop receipt | Service lines 55-61 and 102-105 track asynchronous entry points; lines 145-150 reject new operations and await all admitted operations before closing DB. The frozen pending-Stop/close test passes. This set now includes recovery/status/read as well as start/stop. |
| F05 two runtime managers launched before publication | Runtime lines 38-42 add an exclusive create-only owner claim before spawn. The frozen two-manager test now observes at most one mocked spawn. A retained claim is not stolen through PID/clock guesses. |
| Concurrent Stop coalescing | Service lines 116-123 verify scope before joining one pending Stop. Focused tests preserve one mutation, reject another profile and refuse replay of an uncertain Stop from another service instance. |
| Cancelled coordinator queue waiter | Service lines 17-30 release a cancelled waiter's gate without bypassing the predecessor. A focused three-request test proves its successor does not overtake the current owner. This is local process queue evidence, not a distributed coordinator lock. |
| Shared runtime startup cancellation | Runtime lines 68-76 count waiting callers and abort startup only when none remains before readiness. The new ownership fixture proves that cancelling the first waiter does not kill the process while the second completes the mocked bootstrap. |

Two residual findings follow directly from the frozen call graph:

1. **R01 — deterministic prior-publication refusal still consumes active capacity (P2, source-level actionable defect).** `HelmOrcaRuntime.connect` line 38 refuses when `orca-runtime.json` already exists, before owner-claim creation, spawn or RPC. It throws a generic Error. A new `HelmOrcaService.start` has already inserted its active intent at lines 72-79; the catch at lines 91-97 classifies this generic refusal as unknown and leaves active=true. By contrast, the equally local owner-claim refusal at runtime line 42 is typed and releases capacity. Four new request IDs against retained publication can therefore fill four new active slots even though none of those requests submitted workerStart. Existing prior work may still be uncertain, but that is distinct from these new requests. The fix should preserve the prior runtime/owner evidence while classifying this attempt's proven pre-dispatch refusal consistently. No new executable reproduction was run here.

2. **R02 — reconciliation can bootstrap a runtime for an intent that never dispatched (P2, source-level actionable defect).** `recoverOwned` at service line 103 calls `connection` unconditionally after get/live checks, even for failed, inactive, stage-connect records with no runtime identity. Consider a deterministic artifact failure, then artifacts becoming available before the same intent is reconciled. The supplied runtime connector can claim/spawn and perform repo.add, worktree.create and terminal.create (runtime lines 36-62) before requestShow asks about a UUID that was never dispatched. This exceeds the advertised receipt-reading behavior and creates resources on a failed preflight's reconciliation path. Refuse/return such terminal pre-dispatch records without connection; reconnecting known uncertain work needs an explicit recovery/ownership path. No new executable reproduction was run here.

These cases do not contradict the observed 36 passing tests: the suites cover invalid manifests and duplicate owner claims, but not a new intent refused by pre-existing runtime publication or a later reconciliation of a preflight-failed intent. They also do not prove that a real process was launched during this review.

The remaining operational blockers are concrete. The exact pinned artifact still lacks its required dependency closure, including the reported headless xterm/serialize, Claude SDK and agent-browser constraints; a package manifest and hashes are not PTY readiness. Startup ownership is a retained fail-closed claim, not implemented restart attachment: prior publication or claim blocks automatic takeover, and close sends termination without proving daemon/provider exit. The actual status→coordinator→worker→read→stop path, lost-acknowledgement recovery and authority mapping need an authorized real run. Provider token/time caps, spend accounting, account selection, human permission wait/response and a complete review/apply gate remain separately documented gaps. `ready` and exact process exit still do not certify a coding deliverable.

Source assumptions are restricted to the injected connection contract and host-owned scope/artifact paths. Runtime responses are identity-checked by the transport and bound to a retained runtime ID, but this fixture review does not prove the authenticity or completeness of upstream capability/receipt semantics. The coordinator queue is module-local; successful per-process ordering must not be described as arbitrary distributed serialization. Retained owner claims and unknown worker intents must remain available for reconciliation, rather than being deleted to make a test or status green.

Recommended handoff: close the five original code findings at the bounded fixture level, address R01/R02 with focused regression evidence, and retain the named real-runtime/dependency/authority gates. This report makes no overall backend or product acceptance decision.

## Final repair receipt — 2026-09-10

This appended receipt supersedes the actionable status of R01/R02 above and preserves the earlier snapshot verbatim. The repaired candidate passes **38 of 38 focused fixture tests in five files**, exit 0. The command is unchanged from the first receipt; Vitest 4.1.5 reported local start 03:04:41 and duration 1.14 seconds. The same SQLite experimental warning appeared. No new probe or test was authored by this reviewer.

**R01 is closed by source inspection plus the existing typed-preflight behavior coverage.** Runtime line 38 now throws `HelmOrcaPreflightError` for an existing publication before owner creation, spawn or RPC. Service lines 91–94 convert that type into `failed`, `active: false`. The retained publication remains untouched. There is no dedicated prior-publication service regression among these 38 tests; the exact branch and its catch are the evidence for this closure, supported by the passing artifact-preflight fixtures. This does not declare any older runtime or intent settled.

**R02 is closed with a dedicated passing fixture.** Service lines 104–107 return the scoped record for `stage === 'connect'` before calling `connection`. The new service test at lines 62–66 injects a preflight failure, then reconciles its record and proves the connector was called only once and no RPC was made. The failed record stays failed/inactive. A connect-stage record may still contain uncertain bootstrap effects from its original attempt; returning it does not certify bootstrap cleanup or authorize replay.

**Recovered runCreate receipts do not dispatch workers.** Service lines 108–115 query the retained request UUID. A completed matching `orchestration.runCreate` receipt at stage `run` stores the run identity and releases this attempt’s worker capacity without `workerStart`. The service test at lines 69–74 observes exactly `orchestration.runCreate`, then `orchestration.requestShow`. This is safe allocation reconciliation for a run with no submitted worker; the run itself remains retained for inspection.

The five original regression tests still pass and their file hash is unchanged. Shared-waiter cancellation, cross-manager ownership, coordinator queue serialization, Stop coalescing and asynchronous DB close remain covered by the same source/fixture boundary. No additional actionable defect was identified in this bounded repair delta. The final source hashes were checked again after the test run:

| Artifact | Final SHA256 |
| --- | --- |
| `src/desktop/core/helm-orca-service.ts` | `03bcdac33e7954854de3c636304d5b394e1ffef12d6941964c0172e1bd1e458c` |
| `src/desktop/core/helm-orca-runtime.ts` | `e3a57050aa39e8ce82893eb55bfa66a7db8bfa684b3f0b2b450e88cd2aee6812` |
| `src/desktop/core/helm-orca-transport.ts` | `fbaeafaafc9e502d4fad3c31809ba0dc1ae0f04c6edc9e9b856a2896dbbc56f9` |
| `src/desktop/core/helm-orca-errors.ts` | `49863ced7aaff946b73dd3d607a40bb00591da3a5bdae12f859670838bdee811` |
| `src/desktop/__tests__/helm-orca-service.test.ts` | `a32fea34f0f8f2c72da2a3bf48c82b0920782bffe14fcba3a35b453a0c44e486` |
| `src/desktop/__tests__/helm-orca-runtime.test.ts` | `2a59e866532dfd2cb65965fdd524726f7899c975a9152520a3977ede376c86e7` |
| `src/desktop/__tests__/helm-orca-transport.test.ts` | `7a0e20b39c07f6c1341b00f7e10e819a3c8584aae4ae64759b9d5f11fa5318d4` |
| `src/desktop/__tests__/helm-orca-review.test.ts` | `4b2d6ff57b80b3f3e9a5781c22e8275aba44ecf686c85fadd6b57b93e47cff60` |
| `src/desktop/__tests__/helm-orca-ownership.test.ts` | `e8a62cbf711d07f28016c097d81dd323e762ed7fc88ad030bcb59f49ba9998a1` |
| `docs/HELM-ORCA.md` | `b1ee2fdc049ab6a78cec8150d6d6991247037eb93d30e06ee1ff71d9b2d4c595` |
| `third_party/helm-orca.json` | `2241ee126943d01a90be3783991295b1e3f1efc038de7da312ccd1c112da7eec` |

Repository context is the local working tree at `/Users/preston/Documents/Codex/2026-09-06/hades-repair`, branch `claude/hermes-swarm-framework-vbhrot`, base HEAD `81cd435977ee5f8b6e7e78f0595aa3da1777af78`; these per-file digests bind the uncommitted candidate rather than implying the changes are contained in that commit. The prior report body SHA256 was `b7c10577d7801c8b6b14188cf6b659f4e821d6a61c31ac27ce8f503112c01bc4`.

The unresolved gates above remain: the exact real artifact/dependency closure, actual runtime and provider lifecycle, restart attachment and scoped lost-acknowledgement recovery, native launch/restart validation, and independent deliverable acceptance. Runtime close still sends termination without observing daemon/provider exit. No live runtime, provider, native, full backend or product acceptance is supplied by these 38 fixture passes.
