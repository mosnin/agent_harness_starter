# Deterministic regression v2 — 2026-09-10

**29 files, 253/253 tests passed, 0 failures, 0 skipped; exit 0.** Two Vitest workers. No tracked candidate source/test hash changed during the run.

This supersedes the **socket-free characterization**, not the historical test counts, in the original receipt. See [the preserved erratum](inprocess-regression-errata.md). In v1, NODE_ENV=test did not prevent WebhookService from attempting a listener. In v2, every selected Workbench fixture explicitly substitutes `OfflineWebhookFixture` through vi.mock. That fixture opens no socket and does not verify webhooks. BrowserRuntime remains disabled by the test environment. No listener readiness claim is made.

Selected Orca process fixtures mock spawn; transport uses EventEmitter sockets; readiness probes inject runners; Helm preview injects Browser callbacks; packaging injects build functions. Workbench shutdown source-check/Helm cases inject live promise/controller records, not processes. UI cases use happy-dom RPC fixtures, not native apps. No actual provider, runtime, native-app or listener workflow was selected. This is reviewed fixture evidence, not a host-wide syscall trace.

New coverage includes reserved control lanes, queued-start cancellation, real Workbench routing with offline dependencies, shutdown barriers and failed checkpoint handling, plus stable WorkGoals/WorkAudit/HelmOrca DOM flows. Existing durable/audit/admission/delegation/maintenance/provenance-adjacent packaging coverage remains. No new regression was found.

The exact command, candidate HEAD, per-file counts, all selected test hashes and core/UI candidate hashes are in `inprocess-regression-v2.json`. Raw evidence: `/tmp/helm-inprocess-v2-results.json`, `/tmp/helm-inprocess-v2-run.log`. Current changes remain source candidates; passing this slice does not establish rebuilt OpenCode/Orca, native or provider acceptance.

## Exact selected files

- `src/desktop/__tests__/durable-work.test.ts`
- `src/desktop/__tests__/durable-work-review.test.ts`
- `src/desktop/__tests__/work-scheduling.test.ts`
- `src/desktop/__tests__/work-audit.test.ts`
- `src/desktop/__tests__/work-audit-integration.test.ts`
- `src/desktop/__tests__/work-audit-review.test.ts`
- `src/desktop/__tests__/delegation-tools.test.ts`
- `src/desktop/__tests__/helm-orca-service.test.ts`
- `src/desktop/__tests__/helm-orca-ownership.test.ts`
- `src/desktop/__tests__/helm-orca-runtime.test.ts`
- `src/desktop/__tests__/helm-orca-review.test.ts`
- `src/desktop/__tests__/helm-orca-tools.test.ts`
- `src/desktop/__tests__/helm-orca-transport.test.ts`
- `src/desktop/__tests__/helm-orca-workbench-tools.test.ts`
- `src/desktop/__tests__/helm-orca-readiness.test.ts`
- `src/desktop/__tests__/helm-context-tools.test.ts`
- `src/desktop/__tests__/helm-code-storage.test.ts`
- `src/desktop/__tests__/helm-provider-readiness.test.ts`
- `src/desktop/__tests__/helm-handoff.test.ts`
- `src/desktop/__tests__/helm-preview.test.ts`
- `src/desktop/__tests__/maintenance-service.test.ts`
- `src/desktop/__tests__/package-desktop.test.ts`
- `src/desktop/__tests__/workbench-enterprise.test.ts`
- `src/desktop/__tests__/desktop-request-queue.test.ts`
- `src/desktop/__tests__/desktop-request-routing.test.ts`
- `src/desktop/__tests__/workbench-shutdown.test.ts`
- `src/desktop/__tests__/work-goals.test.ts`
- `src/desktop/__tests__/work-audit-ui.test.ts`
- `src/desktop/__tests__/helm-orca-ui.test.ts`

## Exclusions

- workbench-maintenance/hooks/delegation/durable-work/helm/service/webhook/browser: Actual HTTP listeners in these suites; not run
- helm-code-service/helm-service/helm-integration/helm-source-checks/build-helm/spatial-*: Real subprocess or native-helper workflows; outside this in-process lane
- helm-ui/maintenance-ui: Not included in this bounded lifecycle recheck; three specified stable Work/Orca DOM suites included.
- Current independent-review test file: excluded while its review was active.
