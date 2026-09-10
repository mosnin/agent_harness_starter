# Work audit adversarial review — 2026-09-10

Disposition: two reproduced blockers; no implementation edits by reviewer.

## Findings

1. **Current state is not bound to the displayed audit head.** Altering work_goals.payload outside the journal leaves auditHead and export available. The retained chain can be internally valid while its final afterHash no longer represents the current goal. Compare the current canonical snapshot (and an appropriate revision invariant) against the latest journal event in one read snapshot. Legacy goals must remain explicitly unanchored rather than invent history. Frozen historical export may remain valid as history, but must not imply current-state verification.
2. **Denied read-only audit access mutates another profile.** auditHead calls get(), which globally reconciles expired leases before checking profile. A foreign-profile request clears an expired goal owner, increments revision, and changes status to needs_review before throwing. Audit access should directly load and authorize the row without reconciliation; journal reads should be side-effect free.

## Deterministic evidence

New work-audit-review.test.ts: 5 cases, 2 red and 3 green before repairs. Red log: /tmp/work-audit-review-red.log. Green assertions cover initial run rollback/no execution when audit append fails; actual claimReady attempts and token reservations rolling back atomically on failed audit append, then successful claim with no-op polling adding no event; separate SQLite owners producing sequential revisions and refusing foreign frozen-head scope.

Existing source boundaries reviewed: append uses savepoints, canonical snapshots and event hashes; authoritative create/edit/run/reconcile/claim paths wrap payload and journal in the same transaction. Workbench routes resolve the selected profile and pass goal ID; expected-head scope is validated by journal. Claims are cooperative write reservations, not OS permissions. SQLite lease-only changes are distinct from canonical goal payload history. Actor labels presently identify the system service, not a verified human identity.

This is in-process storage/source evidence. No services, listeners, providers, native UI, or real worker execution were launched. Hash chains are tamper-evident relative to a retained independent anchor; a database owner can replace the database and its history. This is not enterprise or runtime acceptance.

## Reviewed file hashes (SHA-256)

- `src/desktop/core/work-audit.ts`: `225468016e3868b44256589802ced8cd27b9e040b38981339e39f414b1cb3e14`
- `src/desktop/core/durable-work.ts`: `bbfb941dfde57ea8b12625ac6144367da6ff6633a00f2c6d4413c819ae035688`
- `src/desktop/core/workbench-service.ts`: `b7db80b9f7ddd4a187ad4574f4d746a0fe8d85fc9a802155d650234d29e81b0d`
- `src/desktop/__tests__/work-audit-review.test.ts`: `d1eecf54119a051fd794cd4b0d7173f6dec3a53d6e864746d4efebc1bd7aa20b`
- `/tmp/work-audit-review-red.log`: `6e1e64473891b5abba86a397bb468eb584073359f1b32841bc04990c1126e74b`

## Repair verification

Both blockers repaired by root and independently rechecked. Final scoped disposition: accepted for these deterministic audit boundaries, with runtime and external-anchor limitations above unchanged. `auditSnapshot` directly reads the scoped row without scheduler reconciliation and checks canonical payload against latest afterHash inside the read savepoint. Lease-only revision advancement remains allowed; payload drift and revision rollback below the latest event are refused. Legacy sequence-zero history is unanchored.

Final independent run: 3 files, 27/27 tests passed (work-audit-review 6, integration 5, journal 16). New final case verifies head/page/export reads leave the row and journal unchanged; an authorized edit by a separate SQLite owner between frozen-head acquisition and page loading persists, while the export ends at its original head. This tests two connections with deterministic interleaving, not stress testing simultaneous OS processes. No additional concrete blocker found in this bounded source and storage review.

Repaired-source and evidence SHA-256:

- `src/desktop/core/work-audit.ts`: `225468016e3868b44256589802ced8cd27b9e040b38981339e39f414b1cb3e14`
- `src/desktop/core/durable-work.ts`: `9c6d352371e30b7cbad3dd4f5fcf3bd766c75b570dcb1eaacaa6b62a704d3007`
- `src/desktop/core/workbench-service.ts`: `b7db80b9f7ddd4a187ad4574f4d746a0fe8d85fc9a802155d650234d29e81b0d`
- `src/desktop/__tests__/work-audit-review.test.ts`: `333a324128572065fa8a2142dd67c22463e889d3d96bf0c50be7e5219e425218`
- `/tmp/work-audit-review-green.log`: `7442185cddada712b7157622121bf4ece91fc875d78904d4a82d51a57f90d068`
