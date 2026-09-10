# Independent Helm Orca adapter review

**Revise before runtime acceptance.** Five focused regression tests fail against the reviewed source; the existing service/runtime/transport suites remain **23/23 passing**. This is a local source and fixture review. It does not establish that two real Orca daemons run successfully, that a real provider survives Stop, or that the pinned runtime can be built or launched.

The review contract is the caller's bounded lifecycle requirement: preserve request idempotency and project/profile/runtime authority, admit capacity only for active or genuinely uncertain effects, carry one authorized Stop through local startup when its exact dispatch becomes known, and preserve the durable result of operations already in flight during close. The runtime also claims one private runtime per canonical project/profile. The root owns repairs and acceptance. This reviewer changed only this report and `src/desktop/__tests__/helm-orca-review.test.ts`.

**Observed evidence and source identity.** The checkout HEAD is `81cd435977ee5f8b6e7e78f0595aa3da1777af78`; the reviewed adapter files are uncommitted additions, so HEAD alone does not identify them. Source hashes captured immediately after the failing test run:

| File | SHA-256 |
|---|---|
| `src/desktop/core/helm-orca-service.ts` | `a8783fa9492e913ba38add871f9e6833c4bbc8c247cda10e67d426fca454b743` |
| `src/desktop/core/helm-orca-runtime.ts` | `cc9ea508faad6e286ef7e24409395e3eab290c76abea628f43e786adf42855b0` |
| `src/desktop/core/helm-orca-transport.ts` | `fbaeafaafc9e502d4fad3c31809ba0dc1ae0f04c6edc9e9b856a2896dbbc56f9` |
| `src/desktop/core/workbench-service.ts` | `7be571728507fcbf0a340ae099661c97c298b1b50451c48e234131cc5d849fac` |
| `src/desktop/__tests__/helm-orca-review.test.ts` | `4b2d6ff57b80b3f3e9a5781c22e8275aba44ecf686c85fadd6b57b93e47cff60` |
| `docs/HELM-ORCA.md` | `3413276c4cc2584a979c07c38307890a9a904d6c8502251e666be5a340800df0` |

The test command was:

```text
node node_modules/vitest/vitest.mjs run src/desktop/__tests__/helm-orca-service.test.ts src/desktop/__tests__/helm-orca-runtime.test.ts src/desktop/__tests__/helm-orca-transport.test.ts src/desktop/__tests__/helm-orca-review.test.ts --maxWorkers=1 --no-file-parallelism
```

Observed September 10, 2026 at 02:27:29 local time, Node `v22.22.2`, Vitest `4.1.5`: **1 failed test file, 3 passed; 5 failed tests, 23 passed**. All RPC calls were injected fixtures; transport sockets were synthetic EventEmitters. Runtime `spawn` was mocked in the new tests, with inert artifact bodies. No provider, native app, listening endpoint or real Orca process was launched. The focused test run took 489 ms. No broad build or provider test was attempted.

**F01 — P2, actionable defect: pre-cancelled work consumes durable capacity despite zero external effects.**

At [service line 45](/Users/preston/Documents/Codex/2026-09-06/hades-repair/src/desktop/core/helm-orca-service.ts:45), `start` creates an active intent and commits it before checking the incoming abort signal at line 55. The connection helper rejects before calling `connect`, but the catch at line 64 turns this known pre-dispatch outcome into active `unknown`. The new test at [line 59](/Users/preston/Documents/Codex/2026-09-06/hades-repair/src/desktop/__tests__/helm-orca-review.test.ts:59) proves `connect` and RPC call counts are both zero while `hasActiveWork()` remains true. Four distinct such requests can occupy the global four-slot admission limit and block maintenance. No dispatch identity exists for normal Stop to clear.

Check the initial abort before durable active admission, or persist an explicit inactive terminal outcome. Keep genuine post-effect uncertainty active. The existing test named `cancel before dispatch launches nothing` checks only the absent RPC and currently endorses the unknown result; it does not test capacity recovery.

**F02 — P2, actionable defect: deterministic artifact rejection also leaves an active phantom worker.**

[Workbench lines 1034-1045](/Users/preston/Documents/Codex/2026-09-06/hades-repair/src/desktop/core/workbench-service.ts:1034) check only whether `helm-orca-build.json` exists before `start` admits an intent. [Runtime lines 16-18](/Users/preston/Documents/Codex/2026-09-06/hades-repair/src/desktop/core/helm-orca-runtime.ts:16) then reject invalid revision/file/hash data before `spawn`. The real runtime preflight, supplied a correct-pin empty manifest, is exercised by the new test at [line 69](/Users/preston/Documents/Codex/2026-09-06/hades-repair/src/desktop/__tests__/helm-orca-review.test.ts:69). It makes zero mocked spawn calls, yet the service retains active capacity. The artifact's existence is correctly distinct from provider readiness in the UI, but it is insufficient start admission.

Use a shared, side-effect-free artifact validator before active admission and make `info` distinguish invalid from merely present artifacts. Alternatively propagate a typed, proven pre-effect rejection from `connect`; do not classify all connection failures as harmless, because bootstrap can already have effects after launch.

**F03 — P1, actionable defect: a single Stop is not carried through a late acknowledged local startup.**

[Service lines 82-87](/Users/preston/Documents/Codex/2026-09-06/hades-repair/src/desktop/core/helm-orca-service.ts:82) record cancellation and await the local startup settlement, then return unconditionally. When the already in-flight startup returns a matching dispatch ID, the saved record retains it but Stop never reaches the dispatch-scoped RPC at line 92. The test at [line 86](/Users/preston/Documents/Codex/2026-09-06/hades-repair/src/desktop/__tests__/helm-orca-review.test.ts:86) returns `dispatch-owned` after Stop is requested and observes **zero `workerStop` calls**. The user must invoke Stop again, despite already authorizing termination of this same attempt.

After the local wait, reload the durable attempt and continue that Stop if an active exact dispatch has now been acknowledged and runtime authority still matches. Preserve `unknown` if dispatch/authority remains unknown. Do not replay `workerStart`. The existing late-ready test explicitly requires a second Stop; that expectation must change if the requested one-stop lifecycle contract is implemented.

**F04 — P1, actionable defect: close loses a received in-flight Stop result by closing SQLite too early.**

[Service line 95](/Users/preston/Documents/Codex/2026-09-06/hades-repair/src/desktop/core/helm-orca-service.ts:95) waits only for promises inserted by `start` at line 54. `stop`, `status` and `recover` can await RPC and later write, but none joins that settlement set. The new test at [line 105](/Users/preston/Documents/Codex/2026-09-06/hades-repair/src/desktop/__tests__/helm-orca-review.test.ts:105) starts a worker, enters a scoped Stop, closes the service, then supplies the exact acknowledged stopped receipt. The operation rejects with **`ERR_INVALID_STATE: database is not open`** instead of persisting it. Workbench calls this close path at line 2789.

Track all admitted database-using asynchronous operations through their final settlement, reject new operations after closing begins, and close SQLite only after those operations can no longer write. Preserve uncertain outcomes when the RPC truly cannot be settled. This failure specifically concerns the durable receipt; it does not prove a provider remains running after process shutdown.

**F05 — P2, actionable defect at the adapter boundary: two runtime managers can both launch before publication.**

[Runtime lines 14-21](/Users/preston/Documents/Codex/2026-09-06/hades-repair/src/desktop/core/helm-orca-runtime.ts:14) use a per-manager map and a filesystem publication-exists check, then spawn before any shared startup reservation exists. Two managers sharing the same private directory and canonical scope both pass the check while metadata is absent. The test at [line 126](/Users/preston/Documents/Codex/2026-09-06/hades-repair/src/desktop/__tests__/helm-orca-review.test.ts:126) observes **two mocked spawn calls**, contrary to the one-runtime contract. SQLite intent admission does not serialize these different intent/runtime bootstrap attempts. The later exclusive bootstrap write at line 32 happens after the launches.

Add an atomic scope-bound runtime startup ownership record before spawn, including recovery for a crashed or uncertain owner. A stale record or absence of metadata must not automatically authorize takeover. The fixture proves duplicate launch attempts at this adapter boundary; whether upstream refuses the second real daemon or leaves competing resources remains untested and must not be stated as an observed live defect.

**Conditionally supported boundaries and challenges not promoted to defects.**

- The existing fixture suite confirms repeated identical service requests do not repeat dispatch, altered requests and foreign profiles fail, and two service instances share the durable four-worker admission bound. SQL `BEGIN IMMEDIATE` and revision checks support the mechanism; no separate-process crash test was run.
- Workbench validates an enrolled canonical root and an existing profile before exposing scoped list/get/read/recover/stop operations. The connection helper refuses a changed recorded runtime ID. This establishes task metadata scope in the inspected path, not provider-account isolation: the runtime intentionally inherits the normal local HOME and docs explicitly defer an account selector.
- Lost acknowledgments remain active and read-reconcile through the retained request UUID. A still-live or unverifiable worker does not release capacity; exact exited observation yields `needs_review`, not accepted output. These conservative cases remain appropriate.
- The transport fixture tests pass request/runtime identity matching, fragmented JSON-lines, size bounds, cancellation without retry, and a total deadline that keepalives do not extend. No live socket/API compatibility claim follows.
- Refusing prior runtime publication and uncertain bootstrap rather than automatically creating replacements is an explicitly documented recovery limitation. This review does not treat that refusal as proof of a bug. F05 concerns the earlier interval where no shared startup reservation exists.

**Assumptions and unknowns.** The service `connect` callback can perform resource-creating bootstrap; a generic connect exception is not proof of zero effects. Only initial abort and the exercised artifact validation failure are demonstrated pre-effect cases. The runtime artifact is still unbuilt because exact dependencies are missing. Node ABI/architecture, native PTY/watcher behavior, auth, real readiness/stop semantics, process takeover, integration/apply and real shutdown resource settlement remain unverified. Hades computer control was not used. The original source pin is `bf4e2705046cf9ef9c915929a9646da85717af07`, distinct from the newer reference-research development pin.

**Recommendation.** Root should repair the five bounded failures, rerun these tests and reconcile the two existing tests that encode the old startup behavior. Then review the changed source hashes and residual lifecycle gaps before attempting any separately authorized real runtime acceptance. This report is evidence for repair, not product acceptance.
