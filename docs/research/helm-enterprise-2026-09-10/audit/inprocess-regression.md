# In-process regression receipt — 2026-09-10

**23 files; 196/196 tests passed; 0 failed; 0 skipped.** Exit 0. Selected source/test files changed during run: [].

This is a broader deterministic regression slice, not the full desktop suite, native acceptance, provider readiness, or an actual Orca/OpenCode build. Two Vitest workers were used. Fixtures were inspected before selection: Orca transport uses an EventEmitter socket, runtime ownership mocks spawn, provider probes inject runners, Workbench tests use NODE_ENV=test and in-process ModelClients, and packaging injects build functions. Maintenance uses disposable local SQLite/filesystem state. No actual listeners, app control or provider calls were selected.

Coverage includes durable scheduling and edit admission; audit atomicity, corruption and scope checks; conversation allocation and approval refusal; Orca dispatch/recovery/ownership/cancellation using fake public contracts; Helm source context/handoff/preview receipts and private UI storage; provider-readiness parsing; maintenance backups and restore staging; and packaging orchestration.

Exact command, file-level counts, candidate HEAD and SHA-256 hashes of selected tests and relevant source are retained in `inprocess-regression.json`. Vitest raw JSON: `/tmp/helm-inprocess-results.json`; process log: `/tmp/helm-inprocess-run.log`. No source or existing tests were changed by this lane.

## Selected files

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

## Exclusions

- workbench-maintenance/hooks/delegation/durable-work/helm/service/webhook/browser: Actual HTTP listeners in these suites; not run
- helm-code-service/helm-service/helm-integration/helm-source-checks/build-helm/spatial-*: Real subprocess or native-helper workflows; outside this in-process lane
- work-goals/work-audit-ui/helm-orca-ui/helm-ui/maintenance-ui: UI source currently in another lane; parent runs after freeze

No new failure was found in this bounded slice. Independent native, real-provider, listener-based integration, rebuilt fork assets and final UI gates remain separate.
