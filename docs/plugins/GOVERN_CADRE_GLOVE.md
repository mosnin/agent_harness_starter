# Govern, Cadre and Glove native plugin providers

> This document preserves the original v1 inventory. Expanded contracts and repaired receipt authority are recorded in ACCEPTANCE_V2.md, GLOVE_PROVIDER_V2.md, GOVERN_SECURITY_REVIEW.md and CADRE_REPLAY_ACCEPTANCE.md; v1 hashes/counts below are historical.

Authorized source lane, 2026-09-10. This document preserves the full program scope; a narrow metadata adapter is a candidate, not completion of all account read/write functionality. Independent acceptance is limited to the stated source and fixture boundaries; no candidate is a deployed provider or authenticated native journey.

## Source inventory

| Product | Owning source | Branch and baseline | Existing authority |
| --- | --- | --- | --- |
| Govern | mosnin/agentid; govern-remediation-integration checkout | remediation/integration; 0a64d0e87b357630cf956a1af6cebf857ae04d9e | Signed human cookie, Neon profiles and current workspace_members role |
| Cadre | rakazo in cadre-revamp | fix/computer-startup-recovery; b3cdf808e8c975f2b81627eb78a1866e8198bf58 | Hono, Better Auth, Prisma space membership plus per-user record scope |
| Glove | glove-audit/source | codex/persistent-demo-computers; 89e49e4fb4e13ec77699ac043e50087ad567df05 | Clerk human/org identity, Convex org and role permissions |

Govern and Cadre started clean. Glove already contains extensive uncommitted lifecycle/knowledge/recording changes; those are retained. Parent directories and secret fixture files are outside this lane. No new packages, product service listeners, native UI, product database migrations, deployments or authenticated provider calls are executed. SQL migrations are executed only inside explicitly provisioned in-memory PGlite fixtures. One initial Glove test invocation attempted a tsx CLI IPC pipe and failed before tests; the corrected Node loader invocation avoids that IPC path (see verification limits below).

## Common candidate transport

Product-mounted endpoints: `/api/hades/authorize`, `/api/hades/token`, `/api/hades/userinfo`, `/api/hades/revoke`, `/api/hades/records` and `/api/hades/changes`. Authorization requires the product's existing signed-in human and explicit consent. Client IDs are product-specific, PKCE is S256, and callbacks are exact `ai.hades.desktop:/oauth/{govern|cadre|glove}` values. Tokens are opaque; only hashes enter product persistence.

- Snapshot: `GET records?page=<opaque nextPage>` returns `{records, nextPage?, cursor}`.
- Common record: `{id, collection, title, updatedAt?, revision, data}` with explicit allowlisted data fields.
- Changes: `GET changes?cursor=<durable cursor>` returns `{changes:[{record}|{deleted:{collection,id}}],cursor,hasMore}`.
- Candidate write: `POST records` accepts `{key,collection,id,operation:'rename',expectedRevision,data:{name}}`; result is `{key,status:'applied',record}`. This is an initial concrete mutation; broader product write coverage remains required.
- Userinfo: `{sub,name,account:{id,tenantId,name},iss}`.
- OAuth grant response: `{access_token,refresh_token,token_type:'Bearer',expires_in,scope}`; refresh rotates and revoke invalidates the family.

A durable changes feed is a recovery primitive. Polling it is not live streaming. No live subscription is claimed by this lane.

## Govern candidate

Canonical issuer defaults to `https://govern.sh` through the existing `NEXT_PUBLIC_SITE_URL` setting. Public client `hades-desktop-govern`; exact callback `ai.hades.desktop:/oauth/govern`; scopes `agents:read policies:read workspaces:read agents:write`.

The migration `20260910_hades_oauth.sql` adds server-owned grants, spent refresh hashes, a serialized per-workspace clock, safe record projections, tombstones and idempotency receipts. Current membership is checked from the database; writes require admin/owner. The code uses a single locked database operation for code/refresh consumption and a single transaction for rename + revision check + receipt + change publication. Safe reads cover agent identity/status, policy metadata and workspace metadata. Credentials, registry bearer material, policy condition payloads and execution authority are excluded.

Mounted human consent page: `/hades/authorize`. GET creates only a short-lived consent request. Same-origin POST must supply its one-use nonce, the same signed-in actor/workspace, and an explicit allow/deny decision. Failed or expired requests do not redirect to unvalidated callback URLs.

Govern passes 9 author-produced HTTP/unit fixtures and 8 independently authored PGlite SQL fixtures (17 total). Independent SQL challenges found and reproduced two defects: consumed-code replay did not revoke the issued family, and revoked helper privileges broke existing authenticated-role agent writes. The repair validates client/redirect/PKCE before code-replay revocation; only the narrow trigger wrappers use SECURITY DEFINER with a fixed search path and schema-qualified helper. Direct helper/table privileges remain revoked. The repaired tests pass; these are in-memory SQL semantics, not a deployed Neon/RLS/connection-pool acceptance. Full Govern TypeScript checking passed.

Safe data fields:

| Collection | `data` fields |
| --- | --- |
| agents | name, description, provider, model, status, risk |
| policies | name, description, category, effect, status, enabled, severity, approvalRequired |
| workspaces | name, slug, plan |

These are complete DTO projections for this candidate, not full business-object exports. `account.id` and `tenantId` are the workspace ID. No separate record-detail endpoint is implemented.

## Cadre candidate

Canonical issuer is the API's existing `env.webOrigin`, targeting `https://cadre.to`. Public client `hades-desktop-cadre`; exact callback `ai.hades.desktop:/oauth/cadre`; scopes `bots:read tasks:read spaces:read bots:write`.

Shared behavior is in `packages/core/src/node/hades-oauth.ts`; `apps/api/src/hades-oauth.ts` mounts the Hono endpoints from the existing application. The human consent route accepts the product cookie session and deliberately bypasses the legacy bearer-to-cookie compatibility conversion. Product `requireMembership` derives the active space. SQL rechecks space membership, organization membership and user suspension. Bot/task rows remain scoped to both space and actor; a same-space member cannot rename another member's bot. `account.id` is `spaceId:userId`; `tenantId` is the space ID.

The Prisma migration adds the same atomic grant, spent-token, receipt and commit-ordered projection design as Govern, adapted to the actual quoted Prisma tables. Ordinary bot/task/space changes feed the projection through fixed-privilege triggers. Actor reassignment emits an old-actor tombstone before the new-actor record. Rename requires the current projection revision, mutates only `name` plus the normal update timestamp, and commits one receipt with the change.

| Collection | `data` fields |
| --- | --- |
| bots | name, title, description, modelProvider, modelId, archivedAt |
| tasks | prompt, status, botId, threadId |
| spaces | name, organizationId |

These are safe DTO projections; bot instructions, secret references and runtime controls are excluded. No detail endpoint is implemented. Existing sign-in remains unchanged; the consent screen offers sign-in in another tab and a return-to-consent action. Native callback scheme is included in the consent form CSP so its redirect can hand off to Hades.

Seven offline Hono fixtures and API TypeScript checking pass. The independent reviewer also ran nine actual-SQL cases with the mounted suite (16 total), including production snapshot/change SQL and actor-transfer filtering; see `GOVERN_SECURITY_REVIEW.md`. Five additional author-produced PGlite fixtures execute the real migration and SQL functions for PKCE-bound replay revocation, per-owner CAS/idempotency, existing business-role trigger compatibility, reassignment/deletion tombstones, refresh replay and suspension. This is SQL execution inside a fixture schema, not a production Prisma migration or multi-connection isolation acceptance.

## Glove candidate

Canonical issuer defaults to `https://glove.so`. `HADES_OAUTH_ISSUER`, if set, must match in Next and Convex. Public client `hades-desktop-glove`; exact callback `ai.hades.desktop:/oauth/glove`; scopes `products:read sessions:read recordings:read workspaces:read products:write`.

Next endpoints call a product-owned Convex action. Consent requires the real Clerk cookie session and a Convex human JWT, active organization, a five-minute one-use nonce, explicit allow/deny and a matching Origin on POST. Bearer credentials cannot substitute for the consent cookie session. The Convex action checks current Clerk organization membership and user suspension/lock state on grant use, using fixed-origin HTTPS calls with redirects forbidden, a five-second signal and 256 KiB response bounds. Internal mutations recheck the grant and the fresh actor/org/role attestation. Products write requires the existing `manage_products` permission; recording metadata read requires `view_replays`.

Only internal Convex functions touch grant hashes, projection tables and receipts. Code consumption, refresh rotation/replay revocation, rename CAS and receipt insertion use Convex mutation transactions. The HTTP action returns raw opaque tokens only at issue/rotation. `account.id` is `organizationId:clerkUserId`; `tenantId` is the internal organization ID.

| Collection | `data` fields |
| --- | --- |
| products | name, productUrl, audience, valueProposition, forbiddenClaims, painPoints, topFeatures, competitors, pricingSummary, status |
| sessions | title, productId, flowId, status, scheduledAt, startedAt, endedAt, runtimeProvider, runtimeWorkerStatus |
| recordings | sessionId, provider, status, recordingType, durationSeconds, startedAt, stoppedAt, processedAt, publicReplayEnabled |
| workspaces | name, slug |

These are safe DTO projections, not full exports. Credentials/browser sessions, attendee join handles, signed recording/download URLs, replay IDs and provider error payloads are excluded. No detail endpoint or runtime operation is implemented.

Glove reconciles a bounded account snapshot atomically when Hades reads records or changes. It records observed updates and tombstones under a durable per-org cursor. It does not subscribe to backend events, and intermediate changes that occur and disappear between observations are not an event audit log. Limits are 1,000 rows per collection, 2,000 total snapshot rows, 64,000 characters per projected record, 100 records per page and 200 scanned change rows per page. Exceeding capacity fails without committing a new cursor. Product rename observes current product metadata before comparing the expected revision.

Eleven author-produced Node fixtures pass through contract helpers, mounted transport, mutation handlers and explicitly mocked Clerk fetches. The in-memory rollback/DB fixture models expected effects; it does not prove Convex transaction isolation, retry semantics, external Clerk revocation races or deployed function reachability. Seven independent convex-test cases also passed against the actual schema and mutation handler, including competing edits and foreign-org refusal; see `GLOVE_SECURITY_REVIEW.md`. Full TypeScript checking is currently blocked by 32 existing missing LiveKit generated-API references; no diagnostics target this lane's implementation. An independent review fixture subsequently added a cross-package schema type diagnostic of its own. Neither is silently treated as a full type pass.

## Verification limits and reproducibility

- Govern: author suite 9 passed; independent SQL plus author suite 17 passed. The reviewer retains ownership of the independent fixture and its portable runner (see `GOVERN_SECURITY_REVIEW.md`).
- Cadre: `vitest run apps/api/src/hades-oauth.test.ts`; 7 passed. API `tsc --noEmit -p apps/api/tsconfig.json` passed.
- Cadre SQL: `node --test docs/plugins/fixtures/cadre-provider-sql.mjs` with explicit `HADES_PGLITE_MODULE` and `HADES_CADRE_MIGRATION` local paths; 5 passed. The runner uses the already-installed Hades PGlite dependency and does not fetch/install packages.
- Glove: `node --import tsx --test scripts/tests/hades-oauth.test.ts`; 11 passed. Uses existing tsx 4.22.4 and Convex 1.41.0 with fetch rejected by default and explicit mock responses in the Clerk boundary test.
- Erratum: the earlier `tsx --test` CLI invocation attempted an IPC pipe listener and was denied with EPERM before tests. It is a failed invocation, not offline test evidence. The Node import form avoids the CLI IPC path; no escalation or service-listener workaround was used.
- Exact source hashes, runner receipts and the product/provider/native acceptance limits are recorded in `provider-source-v1-receipt.json`.

## Required remaining gates

- Independent review of the concrete source candidates and exact source/deployment revision binding.
- Authenticated read/write/change/revoke journeys for all seven program providers.
- Product database migrations; multi-connection code/refresh replay, revocation races, CAS/idempotency, interrupted snapshot recovery and tombstone verification on actual hosted backends. Glove also needs the current preexisting generated-API/type failures resolved by their owner.
- Full business collection and write inventory: conversations, tasks/work, sessions, recordings, policies/audit and workspace entities where the product's authority permits them; credentials and operational secrets remain excluded.
- Product-specific rate limits, retention/cleanup and operator-visible revocation management.
- Native install/callback, Keychain, visual/keyboard/zoom acceptance, source/deployment revision binding and independent security acceptance.
