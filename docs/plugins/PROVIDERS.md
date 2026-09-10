# Provider source contracts

Observed 2026-09-10. Source evidence only: no authenticated live journey or deployment revision is accepted. A SaaS sign-in session, API key, and an OAuth delegated grant are distinct authorities. Missing endpoints below must not be guessed or marked connected.

| Product/domain | Source revision | Delegated OAuth | Data boundary |
| --- | --- | --- | --- |
| Stored / stored.to | mosnin/agentwiki `37ef3dfb155e7169b866fced81675dc886676b24` (GitHub main) | S256 public code + refresh; static client registration | OAuth userinfo exists; memory gateway currently API-key-only |
| Operate / www.operate.to | mosnin/Clickup `849ddaa28b68adcd3b80c4b6b6a9aa23e0d8f4bd` (local) | S256 public code + refresh + device; dynamic registration | Dedicated read-only Company OS account + paginated snapshot |
| Scalar / tryscalar.xyz | mosnin/Sicarii `7922be8b22e6f7cd3e6041ddecfeceac8f0a4414` (GitHub main) | S256 public code + refresh; dynamic registration | OAuth userinfo exists; contacts REST uses Clerk sessions; MCP path requires separate scope review |
| Company OS / companyos.sh | mosnin/company-os-web `dfb526de427f9f7f8123a4fabcb92811c46f85f0` (local, unrelated edits preserved) | New local issuer candidate (below); not deployed | Existing agent keys remain separate from new human-delegated projection |
| Cadre / cadre.to | mosnin/cadre `b3cdf808e8c975f2b81627eb78a1866e8198bf58` (local candidate) | Company OS OAuth client, not evidence of Cadre issuer | Better Auth sessions; actual domain deployment binding remains unresolved against older mosnin/hermes-front-end candidate |
| Glove / glove.so | mosnin/aidemo `89e49e4fb4e13ec77699ac043e50087ad567df05` (local) | No authorization server found; documentation calls OAuth future work | Clerk identity + connection-scoped MCP bearer tokens |
| Govern / govern.sh | mosnin/agentid `0a64d0e87b357630cf956a1af6cebf857ae04d9e` (local) | No authorization server found in inspected routes/auth | Workspace-scoped hashed API keys; registry and v1 APIs |

## Operate: usable read projection contract

`src/lib/oauth-server.ts:112` defines discovery. Canonical issuer `https://www.operate.to`, authorization `/oauth/authorize`, token `/oauth/token`, registration `/oauth/register`, revocation `/oauth/revoke`, identity `/oauth/userinfo`. S256 and token auth `none`. The native callback is `ai.hades.desktop:/oauth/operate`; a narrow source change adds this exact URI to registration validation, pending deployment.

For the data browser request `companyos:account:read companyos:data:read`; the new task-write lane adds `companyos:data:write` and resource `https://www.operate.to/api/companyos`. `src/lib/oauth-resource.ts` and `convex/oauth.ts` enforce separation from MCP resource `/api/mcp` and `operate:read/write` scopes. Do not mix those scopes to obtain a write grant.

- GET `/api/companyos/v1/account`: `{subject:{id}, tenant:{id,label}, roles:[role]}`. Tenant is the granted workspace external identity.
- GET `/api/companyos/v1/snapshot?limit=100&cursor=...`: `{objects:[{type,id,version,updatedAt,sourceUrl?,data}],nextCursor:string|null,checkpoint:string}`. Maximum page200; internal traversal read budget50. Types include workspace, space, project, list, task, agent, run. Cursor binds to access token; token rotation may require restarting snapshot. The revised source checkpoint is an actual change cursor captured before the first projection read and retained across pages; it is not a frozen snapshot.
- PUT `/api/companyos/v1/installation` with `{externalInstallationId}` registers the human/client/grant installation. GET reads it; DELETE with the same exact ID disconnects. It is not a generic data-write API.
- Initial audit had no changefeed or projection write route. The local source now adds task updates, durable changes and subscription notifications described below; deployment remains unverified.

Evidence: `src/app/api/companyos/v1/{account,snapshot,installation}/route.ts`, `src/lib/companyos-snapshot-cursor.ts`, the route modules are the authoritative public wire contract.

## Stored: OAuth identity works in source, data adapter gap

Pinned source `web/src/lib/oauth/metadata.ts` advertises `/.well-known/oauth-authorization-server`, `/oauth/authorize`, `/oauth/token`, `/oauth/revoke`, `/oauth/userinfo`; issuer is configured `NEXT_PUBLIC_APP_URL`, resource `{issuer}/api`. No advertised registration endpoint. `web/src/lib/oauth/clients.ts` resolves enabled pre-registered clients and exact redirect membership. Do not invent a client ID. `web/scripts/oauth-register-client.ts` is the operator provisioning surface, not an HTTP API.

Scopes: `openid profile email org:read memory:read memory:write` (`web/src/lib/oauth/scopes.ts`). Opaque access tokens; `openid` permits identity, no ID token/JWKS claim. GET `/oauth/userinfo` returns `sub`; profile/email claims only with corresponding scope; `org:read` adds `org_id,org_name,org_slug,org_role` after current active membership validation.

`web/src/app/api/v1/memories/route.ts` lists via page/pageSize/query (max100) and creates memory; `[id]/route.ts` gets/patches/deletes. **These are not OAuth routes:** `web/src/lib/api/gateway.ts` calls `authenticateApiKey`, and `api/authenticate.ts` only queries API keys. OAuth consent does not authorize a data read through this gateway. Existing fire-and-forget memory webhooks and dashboard signals are not durable ordered change delivery. Need explicit OAuth scope + current membership + org placement adapter, idempotent conditional writes, cursor/tombstone contract.

## Scalar: OAuth identity and API separation

Pinned `src/app/oauth/metadata/authorization-server/route.ts` serves metadata through the well-known rewrite; endpoints `/oauth/{authorize,token,register,revoke,userinfo}`. Scopes `openid profile email crm:read crm:write mcp`. Public S256, refresh rotation, exact redirect, no ID tokens. Registration currently permits HTTPS/HTTP loopback only, so Hades private callback needs explicit source allowance or verified registered client.

GET `/oauth/userinfo`: `{sub,name?,...,workspace:{id,name,type:'workspace'|'personal',role},scope,client_id}`. Subject is human; workspace.id is data account, possibly a separate synthetic workspace user row. `src/lib/oauth-server.ts` resolves token to both userId and accountId. The userinfo implementation defaults missing workspace membership role to member; do not treat that as current membership acceptance.

`src/app/api/contacts/route.ts` uses `getAuthenticatedUser()` -> Clerk `getAuthContext`, not OAuth; list truncates at500 without cursor. OAuth/MCP and contacts REST must not be conflated. Need scoped paginated projection and current membership revocation tests before claiming account data.

## Remaining issuer owners

Company OS: `convex/auth.ts` configures password identity; `convex/http.ts` mounts auth and POST `/mcp`. `convex/agentKeys.ts` proves human membership/role for key issuance; `convex/mcp.ts` enforces resolved capabilities. A new delegated grant must recheck the human membership/capability ceiling rather than borrow a pre-existing agent key.

Cadre: `apps/api/src/app.ts:425` GET `/api/v1/company-os` reports the logged-in user's external Company OS connection. It is not account export or an OAuth authorization server. `api/auth/*` is Better Auth. Source candidate/domain binding is an open gate.

Glove: `convex/_lib/mcpAuth.ts` hashes connection bearer tokens; `docs/mcp_server.md` describes `/api/mcp` and explicitly labels OAuth future work. Use owner and connection resource policy adapters, never Clerk session export or admin key borrowing.

Govern: `src/lib/api-auth.ts` hashes `ap_live_/ap_test_` keys, selects workspace, enforces deployment environment and revocation; API-key authority has no human OAuth session. New grants must bind authenticated human workspace membership, approved scopes, expiry and revocation independently of admin keys.

## Required source work and acceptance

1. Exact native callback compatibility; static client registration where needed, no wildcard scheme.
2. Shared public-client grant mechanics with product-owned durable transactions, consent CSRF protection, current membership/scopes and distinct account identity. Sharing crypto helpers alone is not a mounted issuer.
3. Real scoped account/data projections. Advertise only implemented routes and sync semantics.
4. Conditional/idempotent writes; unknown remote outcome is not retry permission. Durable changes require ordered cursors, tombstones, expiration/reset and atomic snapshot handoff.
5. Deploy owning product revisions and prove each of seven human-approved connect/read/write/change/revoke journeys. No such live acceptance yet.


## Company OS local candidate update

New source in the owning `mosnin/company-os-web` checkout, not deployed. Existing canonical metadata (`app/layout.tsx:25`, `app/sitemap.ts:4`) defaults to **https://www.companyos.sh**. No live redirect/issuer acceptance is claimed. New issuer matches this default.

- Fixed public client `hades-desktop-companyos-v1`; exact callback `ai.hades.desktop:/oauth/company-os`. No DCR endpoint, wildcard scheme, client secret or borrowed agent key.
- Metadata `/.well-known/oauth-authorization-server`; human consent `/oauth/authorize`; `/oauth/token` and `/oauth/revoke` POST form-encoded. Authorization code S256, single-use 5-minute codes, 1-hour access and absolute 30-day grants with rotating refresh; replay commits grant-family revocation. Current user existence and company membership checked again on every token use.
- Resource `https://www.companyos.sh/api/plugins/v1`; scopes `companyos:account:read`, `companyos:data:read`, explicit `companyos:data:write`. Grant tables contain digests, not plaintext codes or credentials. Consent uses authenticated Convex action, company selector and explicit Allow/Cancel. Lost approval response does not automatically retry.
- GET `/api/plugins/v1/account` => `{subject:{id},tenant:{id,label},roles:[role]}`.
- GET `/api/plugins/v1/snapshot?limit=100&cursor=...` => `{objects:[{type:'document',id,version,updatedAt,data:{title,kind,view,slug,status}}],nextCursor,freshness:'periodic'}`. This is a paginated document **index**, not full document content. Cursor is grant-bound. It is not an atomic frozen snapshot.
- POST `/api/plugins/v1/write` JSON `{operation:'document.update',id,expectedVersion,idempotencyKey,title,content,message,templateVersion}` updates an existing active main document only. Current membership and context:write role checked, explicit write scope required. Existing `appendRevision` core updates revision/history/search; event and idempotency receipt commit atomically. Success `{id,version,contentHash,replayed}`; conflict409 for expected version or changed payload under same key. No create/merge/archive authority is implied.
- GET `/api/plugins/v1/changes?limit=100&cursor=...` => `{changes:[{eventId,at,type:'document',objectId,deleted,version,object?}],nextCursor,hasMore,freshness:'periodic'}`. Ordered retained company events, current object projection, archive/missing-document tombstone. Initial cursor omitted starts at origin; replay events after snapshot and deduplicate event IDs. A tombstone can share the existing content revision, so consumers must not drop it just because its revision equals cached content.
- The first attempted exhausted Convex pagination cursor failed to observe later events in a regression. The corrected change checkpoint retains creation time plus same-time seen IDs and re-queries inclusively. It refuses beyond200 same-time IDs rather than silently dropping events. Empty/exhausted poll, later write and archive are tested. Historical ledger pruning is not supported by this source and must be treated as a future reset protocol requirement, not guaranteed forever.

Validation: 20 in-process tests across new OAuth, bounded stream and existing company suites passed; whole owning-project TypeScript check and focused lint passed. No listener, provider network, native app, production deployment or live consent was executed. Native/web consent rendering and keyboard acceptance require independent UI review. New-document creation, connector management UI, bounded expired-grant cleanup and all seven deployed acceptance journeys remain open.

Operate local callback repair: `convex/oauth.ts` permits exactly `ai.hades.desktop:/oauth/operate`; regression rejects other provider, double-slash, query, fragment, trailing slash and encoded variants. Existing OAuth suite10/10 passed. This source change is not deployed.


Company OS subsequent source validation: **26 tests** across OAuth/HTTP/write/cursor/watch authority, bounded stream reads, mocked SSE subscription lifecycle and existing company tests. Whole project typecheck passes. Full content is now exposed by GET `/api/plugins/v1/records/{id}` with the same token and live membership/scope gate. Response is `{type,id,version,updatedAt,data:{title,kind,view,slug,status,branchId,content,templateVersion}}`; latest stored revision is checked against both document and company. Oversized record returns413; no truncated successful body. Snapshot now supplies an opaque `checkpoint` captured from the ledger in the first page query and retained across subsequent page cursors. It is directly usable as `/changes` cursor; no historical-origin replay is required.

**Actual subscription source:** GET `/api/plugins/v1/events` uses server-side `ConvexClient.onUpdate` on public `oauth:watch`, with a separate notification-only ticket lasting at most45seconds. It never sends the OAuth bearer token to the public query, never uses admin auth, disables client logging, and exposes only an opaque watermark. The watch query rechecks token/grant/company membership and observes the latest company event. Grant/member changes therefore invalidate the subscription. Time alone does not re-run a Convex query, so the SSE bridge closes by45seconds and requires reauthorization on reconnect. Four concurrent tickets per grant; cleanup releases tickets and closes the client; expiry bounds crash residue.

Wire frames: `event: change` with `{watermark:string|null}` on first notification and changes; `event: revoked` with `{}` or `event: unavailable` with `{}`, then close. Notifications invalidate the cache, they do not themselves advance the data cursor. Drain `/changes` from the durable saved cursor on every connect/reconnect and notification, committing each batch+cursor atomically. Use the snapshot `checkpoint` for initial catch-up; omitted changes cursor is historical-origin recovery only. This is subscription-driven source, distinct from its durable polling recovery endpoint. Tests cover mocked subscription updates, duplicate suppression, cancellation, late callbacks, revocation and idle expiry. **No actual websocket/SSE provider connection was opened; source wiring is not live realtime acceptance.**


## Final Company OS / Operate source handoff (2026-09-10)

Company OS now has **27 passing focused tests**, including a concurrent edit between snapshot pages: the checkpoint stays fixed and subsequent change catch-up observes the edit. First page and ledger watermark share a Convex query transaction; later pages are not frozen. Consent explicitly discloses reading document contents, including branch documents. Current company membership is checked by reads and watch; there is no separate private-document ACL in this source.

Operate has **54 passing focused tests across8 suites**, whole-project TypeScript and focused lint passing. It adds the following local implementation (not deployed):

- POST `/api/companyos/v1/write` accepts `{operation:'task.update',id:'operate:task:<id>',expectedVersion,idempotencyKey,title,description}`. Title1–200; description≤10000; key16–128 URL-safe characters; expectedVersion is the snapshot SHA256. Requires data:read + data:write, current owner/admin human authority, active installation, and readable task/list/space. Existing task core performs edits, automations, search and events; idempotency receipt commits in the same mutation. Reply `{id,version,replayed}`; conflict409 for changed-key payload or stale version. No task creation/deletion or non-task writes are implied.
- GET `/api/companyos/v1/changes` returns `{changes:[{eventId,deleted,type:'task',objectId,object?}],resetSnapshot,nextCursor,hasMore,freshness:'periodic'}`. Object is `{id,type,version,updatedAt:ISO,data}`. Task deletions have objectId without object. Other entity events, lost visibility, or visibility-policy changes require full snapshot replacement before committing the cursor. Inclusive event creation-time cursor resumes after empty/exhausted reads, scoped to grant/workspace. Same-time capacity is200, workspace visibility observation capacity1000 spaces; excess fails closed.
- Snapshot `checkpoint` is a change cursor captured before traversal, retained in signed traversal cursors. Changed objects during traversal are reconciled by catch-up. Hades must atomically replace the snapshot on `resetSnapshot:true` and commit that change cursor only after replacement, then resume deltas. No historical ledger deletion/reset protocol is claimed.
- GET `/api/companyos/v1/events` uses ordinary `ConvexClient.onUpdate` with separate random notification-only ticket, hashed at rest, bound to access grant/installation and at most45seconds. It observes event ledger **and** private-space visibility inputs. First/changed notifications emit `change`; revoked/unavailable ends stream. OAuth bearer is never an argument to the public query. Max4 active tickets/grant,256frames,8queuedframes; abort/close unsubscribes and releases ticket, expiry bounds crash residue. Durable `/changes` remains the catch-up authority. This is actual subscription source wiring, not a live websocket acceptance claim.
- Existing server-to-Convex transport now rejects redirects and enforces15second total body lifetime and4MiB response cap. Oversized/incomplete responses fail rather than produce truncated success.

Remaining gates: deploy each product's schema/functions/routes together; register the exact native callback/client; verify public canonical domain and discovery in production; real human consent, refresh/revoke, tenant-isolation and stream reconnect acceptance; hosted WebSocket support, ticket cleanup on worker termination; long-term ledger retention/reset policy; non-task write capabilities and source events for any mutation path that does not currently append events. No production/native/network acceptance was performed. Source inventories and exact hashes are in `evidence/companyos-operate-source-2026-09-10.json`.

Stored native client completion source: the versioned patch under
`/Users/preston/Documents/Codex/2026-09-10/stored-oauth-source-patch` now defines
`sto_client_hades_desktop_v1`, sole callback `ai.hades.desktop:/oauth/stored`,
and scopes `openid profile org:read memory:read memory:write`. This is a **new
source definition**, not a discovered deployed registration. Explicit operator
script `web/scripts/oauth-register-hades.ts` creates only if absent and refuses
disabled, broadened or conflicting rows; uniqueness races reread, uncertain
writes do not retry. It prints only public registration metadata. No dynamic
registration or automatic login-time provisioning was added.21 isolated tests
(14 registration,7 SQLite writes) and pure registration-module typecheck pass;
full Prisma/Next integration, deployment and the operator command remain
unexecuted. See `HADES-REGISTRATION-RECEIPT.json` and
`source/web/scripts/HADES-OAUTH.md` in that source-patch folder. The immutable20
original source hashes were rechecked. Patch SHA256:
`04b7940ccacca31d61380b0ab01d6a80cd47378c4cc11f251d67c616805dd673`.

Stored userinfo maps `sub` to human subject and `org_id` to tenant, with
`org_name` label and `org_role` from current active membership. OAuth memory
adapter GET `/api/v1/oauth/memories?page=1` returns `{records,nextPage?}`;
record `{id,collection:'memories',title,revision,updatedAt,data:{content,summary,source}}`.
POST same route accepts `{operation:'update',key,id,expectedRevision,data:{content}}`
and returns `{status:'applied',record}`. Native catalog must not claim an
installed client or a realtime changefeed: registration and live acceptance
remain pending, and this Stored slice has no durable changes/subscription.
