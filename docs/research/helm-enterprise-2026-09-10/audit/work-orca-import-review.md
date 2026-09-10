# Orca import and source acceptance review

2026-09-10. Bounded independent review of root HelmService import registration and DurableWork source reservation/acceptance, plus provider_readiness HelmIntegration durable apply changes. The reviewer authored the Orca descriptor/materializer helper; that helper is excluded from independent acceptance here and awaits another reviewer.

## Findings and repaired checks

- Reproduced clean cancellation before any source effect leaving a permanent source reservation after close/reopen. Original independent run: one failure and one pass, `/tmp/work-orca-import-independent.log`. Root now retains SQLite until all admitted source operations settle and release their claims.
- Flagged authority validation outside the write transaction. Root added guards and current task/request checks inside import-binding and acceptance edit callbacks. Independent guard-revocation tests demonstrate rollback without binding/completion and preservation of unknown usage/attempts.
- Cross-instance overlapping source reservation is denied; ordinary successful settlement releases it.

Final command: `./node_modules/.bin/vitest run src/desktop/__tests__/work-orca-import-independent.test.ts src/desktop/__tests__/helm-integration-claims.test.ts --maxWorkers=1`

Result: **11/11 passed in two files**, `/tmp/work-orca-import-apply-review.log`. Four tests are independently authored in this pass. Seven apply tests are author fixtures independently rerun; do not label them independently authored or add their earlier reruns to distinct totals. The apply suite exercises disposable real Git and an owned child-process crash, not an Orca/provider runtime or listener.

## Source review disposition

HelmService import uses a deterministic descriptor/owner/Work binding, durable exclusive claim, retained failure state and an initially unverified review run. Same identity cannot silently replay an uncertain import. Work acceptance retains measured-versus-unknown usage and original attempt outcomes. Current Workbench checks source-check/run/review ownership and current source fingerprint; this was source-inspected, not exercised as a native end-to-end journey here.

The apply helper rechecks full immutable review binding at final dispatch and stores exclusive source/review claims. Predispatch refusal releases owned claims; dispatched uncertainty retains them across restart; historical applied review returns its receipt without reapplying. No additional concrete blocker was found in the bounded source pass. These claims coordinate cooperating processes, not unrelated editors; external filesystem races remain a limitation. Crash-retained reservations need explicit recovery and are not evidence of completion.

Accepted only for these repaired source/fixture boundaries. Actual packaged Orca creation, stopped-worker snapshot import, provider checks, native review/apply UX and a full Work dependent-release journey remain open.

## Inspected candidate hashes

| File | SHA-256 |
|---|---|
| `src/desktop/core/helm-service.ts` | `4d82c6af19227501d8f9ff91a42a9dbf5075028f0ebbea0a980b39195a4b1eee` |
| `src/desktop/core/durable-work.ts` | `9cd952b1bb60495d75b795eb3ba4c0a5151a62eaa9e685a7865652059069cbdb` |
| `src/desktop/core/helm-integration.ts` | `f631098250607aa048d70b331fc1e4c8897849b45ec533c2769c3982b0476285` |
| `src/desktop/__tests__/work-orca-import-independent.test.ts` | `9412ed76b20a1addc65d32616b7c340979abd4ff105ce0eea4b6959dd8bfbe17` |
| `src/desktop/__tests__/helm-integration-claims.test.ts` | `80fcf60b7ceffb12eccae174484d5b3fddf2d3e9eacb36e81b66ab90b7ba40be` |

## Workbench source-check follow-up

Independently reproduced a late dispatch after Stop: Workbench awaited the source-check initial fingerprint without passing cancellation into the service; one first command was invoked after cancellation. Evidence `/tmp/workbench-orca-independent-red.log`: one failed, one passed. The affected command was spied to prevent the late real effect; the rest of the fixture uses actual Workbench routes, isolated Git, offline webhooks and modeled Orca receipts (adapted root fixture, independently authored negative cases).

Root and provider_readiness repaired the service/route fifth-argument signal and authority guard. It checks before admission, after fingerprint and immediately before each command spawn; ownership is registered before emitting persistence events. Terminal source-get/list routes wait for their matching Work reservation settlement.

Final scoped rerun: `./node_modules/.bin/vitest run src/desktop/__tests__/workbench-orca-independent.test.ts --maxWorkers=1`; **3/3 passed**, `/tmp/workbench-orca-independent-green.log`. The cases prove no late command after Stop during startup fingerprint; old acceptance refused after new instructions; close waits the pending source operation and prevents late command dispatch. No native/listener/provider execution was performed. Initial read-only Git fingerprint remains noncancellable; its return is fenced before effects. This is a source/fixture acceptance, not actual Orca/native acceptance.

| Final follow-up file | SHA-256 |
|---|---|
| `src/desktop/core/workbench-service.ts` | `17121757ee0bc76b31b4e91d943ad414b1bb302afa624eb2a8a2286568c049e8` |
| `src/desktop/core/helm-source-checks.ts` | `fd63af8195f332c927c36f129f7b9d3df635184330a49881ed00e84514f78112` |
| `src/desktop/core/durable-work.ts` | `9cd952b1bb60495d75b795eb3ba4c0a5151a62eaa9e685a7865652059069cbdb` |
| `src/desktop/__tests__/workbench-orca-independent.test.ts` | `74e1b2b81834c362e4090513d158534de97a10ed93498fe151b172891ef39bfb` |

## Completed-apply recovery and final admission delta

Reviewed the completed-apply-only recovery: immutable applied review/token/root/patch binding is required before releasing a matching claim. A short SQLite transaction serializes claim creation and compare/unlink cleanup, preventing one releaser from removing a new owner's claim. Missing claims are harmless; mismatched/uncertain claims remain. Workbench validates the exact profile/root/apply review and optional Work goal/task before releasing its reservation. This is recovery of a completed effect, not a retry or new acceptance.

Work cancellation hints are checked against the imported run and queue matching remains profile/goal specific. Flagged Work.run's reservation check outside the transaction; root added both an in-transaction draft/reservation recheck and a conditional SQL NOT EXISTS predicate when claiming ownership. No remaining concrete blocker found in this bounded delta review.

Five selected suites (Workbench independent, root Workbench acceptance, Work independent, desktop routing, integration claims) passed **37/37**, `/tmp/orca-final-recovery-review.log`. The final Work.run source repair arrived during that run; therefore the root Workbench acceptance plus Work independent suites were rerun after the repair: **8/8 passed**, `/tmp/orca-final-admission-review.log`. These are repetitions, not additive distinct counts. Desktop routing is also included in the broader Plugins runner; do not add that runner's routing cases again. No product/native/provider acceptance is inferred.

| Final delta file | SHA-256 |
|---|---|
| `src/desktop/core/durable-work.ts` | `e16f83de892eb8fe22810d0c18b6d3238813ed96d089cbf432acfc0b63c054aa` |
| `src/desktop/core/workbench-service.ts` | `d6327785dc2920914182b6853b7265c2c3b8717d1c62aa5b4ce92f5f6fad0ec8` |
| `src/desktop/core/helm-integration.ts` | `a79cf8f8adb7228e46afb19fa154e6eb98f3d3d2108bd4b68c24c77af4e8ed26` |
| `src/desktop/core/desktop-request-routing.ts` | `75df4320f28bf0b0f7ce7fbc125ef198672f239e488a6d07b59c2db3f32d2111` |
