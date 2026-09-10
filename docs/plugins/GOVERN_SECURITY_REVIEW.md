# Govern OAuth independent security review

2026-09-10. Provider checkout: `/Users/preston/govern-remediation-integration`. Reviewer authored only `src/lib/hades-oauth-independent.review.mjs` and this report. Production implementation is authored by another worker. No listener, network, native UI or hosted database execution was attempted.

## Findings reproduced, then repaired

1. **Authorization-code replay does not revoke issued credentials.** Actual `hades_exchange` executes twice with correct client/redirect/PKCE; second call returns invalid_grant but the grant remains unrevoked and its access credential remains valid. The wrong-PKCE replay test confirms it must remain non-revoking. Correct-PKCE consumed-code replay should commit revocation then return an error value.
2. **Projection trigger breaks existing authenticated writes.** After migration, a role with SELECT/UPDATE permission on agents receives SQLSTATE 42501 permission denied for function hades_project on ordinary UPDATE. New trigger executes as invoker while projection helper and tables revoke authenticated access. Use narrow trigger definer authority with schema qualification and a trusted fixed search_path, preserving direct helper/table refusal. Do not grant general projection mutation access to clients.

Both failures are reproduced by executing the production migration/functions in PGlite, not SQL string assertions. Evidence: `/tmp/govern-independent-red.log`, `/tmp/govern-independent-current.log`. Initial checkpoint: seven tests, five pass, two fail. Both production defects were repaired by the author; final verification follows below.

## Method and boundaries

Existing local Hades dependency `@electric-sql/pglite` runs PostgreSQL/WASM entirely in process. Each test creates a fresh in-memory database with compatible minimal workspaces/profiles/workspace_members/agents/policies tables and anon/authenticated roles, then executes the full new `supabase/migrations/20260910_hades_oauth.sql` unchanged. The dedicated test contains an explicit existing dependency path; no install/download occurred. Fixtures close the engine after every test.

Actual SQL checks include current membership deletion, foreign tenant rename refusal, expected-revision CAS, exact repeat idempotency, different-input key refusal, transactional rollback of failed write receipts, refresh rotation/replay committed revocation and ordered deletion projection. The record/change test executes actual production TypeScript `readHadesAccount` and its SQL through a PGlite-backed query adapter, verifying exclusion of foreign data and a tombstone after a snapshot checkpoint. Concurrent Promise requests prove admission on one serialized PGlite engine, not hosted multi-connection contention.

Read-only authorization review: exact fixed native client and callback; nontrivial state; S256 PKCE; same-origin consent POST; one-use hashed CSRF state bound to current human/workspace; membership recheck inside SQL; fixed supported scopes; access credentials stored as hashes; bounded form and JSON bodies. Govern has no dynamic OAuth resource parameter in this implementation; the fixed client and dedicated bearer endpoints define its current scope. Safe projected fields exclude credentials. Typed mutation is agent rename only, requires owner/admin membership plus agents:write, and has no arbitrary record/query/authority mutation route.

## Remaining gates

All work is source-only and uncommitted. Full production schema migration compatibility, hosted role ownership/RLS behavior, independent PostgreSQL connections and lock contention, deployment, live sign-in/consent/refresh, native callback, and native account-data workflows remain unverified. Applying migration or issuing real credentials was not authorized/executed in this lane. The broader feature catalog is not implied by these bounded checks.

## Final repair verification

Govern: **2 files, 17/17 tests passed**, including **8 independent actual-SQL tests**, `/tmp/govern-independent-green.log`.

```sh
./node_modules/.bin/vitest run src/lib/hades-oauth-independent.review.mjs src/lib/hades-oauth.test.ts --maxWorkers=1
```

Correct-PKCE consumed-code replay now commits revocation; wrong PKCE and wrong-client spent-refresh presentations do not revoke. Trigger wrappers now execute with narrowly elevated authority and `search_path = pg_catalog, public, pg_temp`; helper calls are schema-qualified. Authorized authenticated-role UPDATE succeeds while direct hades_project invocation remains denied. Both original red findings are resolved within the isolated SQL boundary. No further concrete blocker reproduced.

## Cadre additional SQL review

Parent-authorized additional review of `/Users/preston/Documents/Codex/2026-09-05/cadre-revamp/rakazo`, with only new `packages/core/src/node/hades-oauth-independent.review.mjs` authored here. Existing AGENTS.md was read. No parent directory credential/configuration files were read.

The same actual migration/function tests run against compatible minimal spaces/user/member/space_members/bots/tasks tables, preserving quoted Prisma column names. Actual production `createHadesOAuth().readHadesAccount()` SQL was exercised. **2 files, 16/16 tests passed**, including **9 new actual-SQL tests** plus seven existing mounted Hono request fixture tests, `/tmp/cadre-independent-green.log`.

```sh
./node_modules/.bin/vitest run packages/core/src/node/hades-oauth-independent.review.mjs apps/api/src/hades-oauth.test.ts --maxWorkers=1
```

Covers correct-PKCE consumed-code revocation, wrong-PKCE and wrong-client non-revocation, refresh replay, CAS/idempotency receipt rollback, competing edits on one in-process engine, current membership, foreign tenant write refusal, snapshot/changes SQL, restricted business-writer role update with direct projection call denied, and owner-transfer tombstone without leaking the new owner's data. Cadre's author applied the parallel replay and trigger corrections before this SQL run; this review did not reproduce a Cadre red before the fixes.

Read-only mounted-path inspection confirms `apps/api/src/app.ts` mounts existing Hono routes through `mountHadesOAuth`, supplies Prisma query execution and resolves a current browser-cookie session plus space membership for consent. Actor-owned bots/tasks are filtered in projection, and rename SQL requires both matching space and owner. This is scoped metadata/task prompt reading and bot rename, not credentials or computer control. Full real Prisma migrations, production session transport, hosted contention, OAuth login and provider/native account integration remain unverified.

## Exact reviewed source hashes

### Govern

Base HEAD `0a64d0e87b357630cf956a1af6cebf857ae04d9e`; reviewed OAuth changes are uncommitted.

| Source-relative path | SHA-256 |
|---|---|
| `src/lib/hades-oauth.ts` | `ee809072c8b1d028b9e009d2f72b1ee052862b6185b91b9c1dfbc6bf53ed5351` |
| `supabase/migrations/20260910_hades_oauth.sql` | `97bbc968c0c761ce441d9e4920c9816d6895bcba3b85717070290130d9553acc` |
| `src/app/hades/authorize/page.tsx` | `5d05aacafd0e3a984ce2809476783ba3283eb9fbcdc0c78afd7a7635b7002261` |
| `src/lib/hades-oauth-independent.review.mjs` | `73aa0118baf54a8e1af129b1954efbd2d9855a1db0087241859c439053e2e091` |

### Cadre

Base HEAD `b3cdf808e8c975f2b81627eb78a1866e8198bf58`; reviewed OAuth changes are uncommitted.

| Source-relative path | SHA-256 |
|---|---|
| `packages/core/src/node/hades-oauth.ts` | `3ac0e752e9e024cf888670638aeba956cdadbe331f7a3f9d5fc514e2b9753601` |
| `packages/db/prisma/migrations/20260910000000_hades_oauth/migration.sql` | `48950c00efcb7aadfff57a135ba2cc0996f2a227d83956ead657bbec636d93e9` |
| `apps/api/src/hades-oauth.ts` | `683eebfe20d1a034b3e6d33c7e9f67605619577583b3ca74cdad9c1e5ff91cf6` |
| `apps/api/src/app.ts` | `d7579a340728675edfea1a117ba202ca48232e8b056a5a0ca2bc14429db1c2b4` |
| `packages/core/src/node/hades-oauth-independent.review.mjs` | `0c97a3f8950cd68c486ab7a84e984ffbf06764f027004f31655eec351e34efb0` |


## Govern portable review rerun

The independent suite is now `src/lib/hades-oauth-independent.review.mjs`, using normal package imports and an explicit `scripts/run-hades-review.mjs` resolver. No machine-specific source import remains. Run via:

```sh
HADES_REVIEW_NODE_MODULES=/path/to/review/node_modules node scripts/run-hades-review.mjs
```

See provider `scripts/HADES_REVIEW.md` for exact dependency provenance and separation from default CI/typechecking. Final portable rerun: **17/17 passed**, `/tmp/govern-portable-review.log`. The runner pins Vitest 4.1.5 and @electric-sql/pglite 0.4.1 in the review dependency tree. No installations, lockfile changes, listeners or provider calls. Earlier direct commands above are historical evidence and superseded by this runner. Glove's explicit single Convex resolution tree and JavaScript review artifact remove the production TypeScript package-identity error without unsafe production casts.

Runner SHA-256: `928f88d85ee54627102663871c82691c6ec763407391cae738fea0e7efd870a3`. Review source SHA-256: `73aa0118baf54a8e1af129b1954efbd2d9855a1db0087241859c439053e2e091`.

## Cadre portable review rerun

The independent suite is now `packages/core/src/node/hades-oauth-independent.review.mjs`, using normal package imports and an explicit `scripts/run-hades-review.mjs` resolver. No machine-specific source import remains. Run via:

```sh
HADES_REVIEW_NODE_MODULES=/path/to/review/node_modules node scripts/run-hades-review.mjs
```

See provider `scripts/HADES_REVIEW.md` for exact dependency provenance and separation from default CI/typechecking. Final portable rerun: **16/16 passed**, `/tmp/cadre-portable-review.log`. The runner pins Vitest 4.1.5 and @electric-sql/pglite 0.4.1 in the review dependency tree. No installations, lockfile changes, listeners or provider calls. Earlier direct commands above are historical evidence and superseded by this runner. Glove's explicit single Convex resolution tree and JavaScript review artifact remove the production TypeScript package-identity error without unsafe production casts.

Runner SHA-256: `af984f798d3529d5e455ee7d32e2ab6df7f28fd2d752561f9ca48373f6489734`. Review source SHA-256: `0c97a3f8950cd68c486ab7a84e984ffbf06764f027004f31655eec351e34efb0`.

## Govern v2 independent challenge — 2026-09-10

Scoped disposition: the reviewed v2 source passes the retained offline boundary checks. This is not hosted PostgreSQL, deployed OAuth, model availability, or native account acceptance. The preceding hashes and counts describe earlier candidates; this section identifies the v2 candidate.

The independent review found a consent escalation in the initial v2 candidate: `agents:write`, previously disclosed as “Rename agents”, also permitted description changes through `agent.update`. The author repaired the SQL boundary to require new `agents:metadata:write` for every `agent.update`; provider/model changes additionally require `agents:configuration:write`. Existing rename retains its original scope. The author's regression now covers refusal of a legacy rename grant. The author also repaired missing consent labels for all new scopes and expanded the read disclosure to configuration/access/spending metadata and policy target assignments. These labels were checked in source; their rendered presentation was not tested.

Three additive independent tests execute the actual production SQL in PGlite: missing configuration scope and malformed provider/model refusal with no failed receipts; policy metadata CAS/exact replay plus current-role demotion refusal and secret/condition exclusion; execution-field and foreign-tenant refusal. The provider enum and bounded nonempty model validation do not establish that a model exists or is compatible with a provider. Configuration writes grant no execution, credential, budget, permission, or enforcement authority.

Final command, from Govern:

```sh
HADES_REVIEW_NODE_MODULES=/path/to/review/node_modules node scripts/run-hades-review.mjs
```

Result: **3 files, 28/28 tests passed** in 9.30 seconds; log `/tmp/govern-v2-independent-final.log`. Breakdown: 11 independently authored SQL tests (8 retained + 3 new), 7 author v2 SQL tests, and 10 existing/author HTTP-contract tests. Vitest 4.1.5 and PGlite 0.4.1; no listeners, installations, network, provider, or native operations. PGlite uses one in-process engine and minimal compatible business tables, so this does not prove multi-connection production contention or full-schema migration compatibility. An intermediate combined run failed only because an author foreign-row fixture lacked the newly required metadata scope; the corrected fixture passed the final run.

| Reviewed v2 source | SHA-256 |
|---|---|
| `src/lib/hades-oauth.ts` | `672b47418c7e7a297be2314f405044b949715c33925dfa73b8a66c95f41c79e6` |
| `supabase/migrations/20260910_hades_oauth.sql` | `de66a867c6b4573f1ddddf58d05fbc500c377ee6b9a1c4aee4419bad1911b314` |
| `src/app/hades/authorize/page.tsx` | `16b5c78a7943b9df12d65868877634e0583bfac9f2f4d204d6d92c035f401b8e` |
| `src/lib/hades-oauth-independent.review.mjs` | `ab72eaed7d18a95705d8e39cdbf8b490f373fca3028fd94201040dbb6a56c952` |
| `scripts/run-hades-review.mjs` | `64dd0f0fffd6c3ad89330fdbf296faeac67e099e669290f0595e0483071cc8a7` |

No further concrete blocker was reproduced within this scoped independent review. Root remains the acceptance owner; all provider changes are source candidates, not a deployed release.
