# Cadre receipt replay: independent repair acceptance

Reviewed 2026-09-10 against the uncommitted source candidate in `cadre-revamp/rakazo`. This reviewer authored the earlier v2 feature implementation but did **not** author the subsequent receipt repair or its nine regression tests. Independence here applies to acceptance of that repair, not to the entire Cadre implementation.

## Disposition

The repaired `hades_rename` and `hades_update_bot` satisfy the bounded replay checks. Both first resolve the current unrevoked, unexpired grant and current membership, then enforce the operation scope. After receipt identity checking, both lock the actual bot matching the current tenant and actor with `archivedAt IS NULL`, before any retained result is returned. Thus an old receipt cannot bypass a current ownership transfer or archive restriction.

The retained-result branch removes `record.data.instructions` when the current grant lacks `bots:instructions:read`. It returns before the business UPDATE and before receipt/projection writes. The regression tests verify an applied response with instructions omitted and an unchanged projection clock for both operations. This establishes no repeated effect in these fixtures. Receipt storage remains historical; the repair does not erase previously delivered copies or claim retroactive removal from external clients.

Read-only inspection also confirms new rename effects reject archived bots, matching the update path. The added content-write scope remains separate from the legacy rename scope. No new instruction-write or execution permission is granted.

## Executed evidence

From the Cadre repository:

```sh
HADES_REVIEW_NODE_MODULES=/path/to/retained/node_modules node scripts/run-hades-review.mjs
```

Independent rerun: **3 files, 29/29 tests passed**, 10.64 seconds, `/tmp/cadre-replay-independent-acceptance.log`. The runner verifies Vitest 4.1.5 and PGlite 0.4.1. It executed the unchanged production migration functions in an in-process database, plus existing Hono/parser fixtures. No install, listener, remote operation, native UI, or implementation edit was performed in this acceptance pass.

The nine repair regressions cover instruction removal, ownership transfer, archived bots and removed organization membership for both write operations, plus current-scope filtering of production snapshot/history queries. Existing twenty tests retain CAS, input collision, OAuth replay, scope, routing and projection checks. Tests use minimal compatible business tables and a single PGlite engine, not the complete hosted Prisma schema or multi-connection production contention.

## Exact accepted candidate

| Source-relative file | SHA-256 |
|---|---|
| `packages/db/prisma/migrations/20260910000000_hades_oauth/migration.sql` | `148f07dbb2bd776fbb46b110d47e429fa10e58801614f44fe9689cb1c3d4e587` |
| `packages/core/src/node/hades-oauth.ts` | `cf110b145478280bce8128f930bb2bac3783317e0f0a040f1b5425c336ee54df` |
| `apps/api/src/hades-oauth.ts` | `428d9fecdd1fc649cd1f3dee2052514eeb4d37114ec6fbf2079ab703acb7a4fd` |
| `packages/core/src/node/hades-oauth-v2-independent.review.mjs` | `9c79e9daaa9f56ccff2749742fa504b7d140d357a573c51110fe98b75734dc58` |
| `scripts/run-hades-review.mjs` | `42839731b33664609520a7310f7f919e9be3cd318497c1ec46d9b7065411556f` |

These match the repair author's `scripts/HADES_REVIEW_V2_REPLAY.md`. No additional concrete replay defect was reproduced. Hosted migration/deployment, live consent and native Hades account workflows remain unverified and are not accepted by this receipt.
