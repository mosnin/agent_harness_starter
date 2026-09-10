# Glove provider v2: bounded business content

2026-09-10. This source candidate expands the existing native OAuth provider with knowledge text, session transcripts, outcomes and meaningful product/knowledge edits. It preserves the product's actual schema and role rules. It is an offline source/fixture result; hosted authorization, native use and complete business coverage remain open. Exact source and evidence hashes are in `provider-source-glove-v2-receipt.json`. The v1 receipts and review remain intact.

Source checkout: `/Users/preston/Documents/Codex/2026-09-06/glove-audit/source`, branch `codex/persistent-demo-computers`, base HEAD `89e49e4fb4e13ec77699ac043e50087ad567df05`. This version changes only `convex/_lib/hadesOAuthContract.ts`, `convex/hadesOAuthStore.ts`, `convex/hadesOAuth.ts` and `lib/hades/transport.ts`, and adds author fixtures/runner. Existing business modules, unrelated dirty LiveKit work, Hades native client and provider schemas are outside this delta.

## Authorization and consent

The public client is `hades-desktop-glove`; the fixed callback is `ai.hades.desktop:/oauth/glove`. Issuer is `HADES_OAUTH_ISSUER`, default `https://glove.so`, and must match in Next and Convex. The existing human Clerk session, consent form, S256 PKCE, opaque token exchange/rotation and revocation are retained. No token or Clerk secret belongs in the renderer.

| Scope | Granted capability |
| --- | --- |
| `products:read` | Explicit product description/features/metadata projection |
| `sessions:read` | Session metadata and processing status |
| `recordings:read` | Recording metadata; no media URL or storage authority |
| `workspaces:read` | Workspace name and slug |
| `knowledge:read` | Knowledge item title and full stored content |
| `transcripts:read` | Conversational transcript messages; system diagnostics excluded |
| `outcomes:read` | Stored demo summary/outcome fields |
| `products:write` | Existing rename-only operation |
| `products:update` | Newly consented descriptive product edits |
| `knowledge:write` | Knowledge text, category and publication-status edits |

Existing grants and refreshes retain exactly their granted scopes. Adding a collection or broader edit requires a new human consent. In particular, the original rename consent is not silently interpreted as permission for product description edits.

The store uses the existing `normalizeRole`/`roleHasPermission` model. Product writes require `manage_products`; knowledge writes require `manage_knowledge`; recording/transcript/outcome access requires `view_replays`. The current Clerk user and organization membership are rechecked by the action, including banned/locked user state, with fixed-origin requests, redirect refusal, 5-second timeout and 256 KiB response limits. An internally supplied proof must match actor and organization and be no older than 15 seconds. Clerk revocation and the later Convex mutation are separate systems; their cross-system race is an open hosted gate.

## Read contract

The common record is `{id, collection, title, updatedAt, revision, data}`. Fields below are an explicit allowlist; absent optional values remain absent.

| Collection / actual table | `data` fields |
| --- | --- |
| `products` / `products` | `name`, `productUrl`, `audience`, `valueProposition`, `forbiddenClaims`, `painPoints`, `topFeatures`, `competitors`, `pricingSummary`, `status`, `slug` |
| `sessions` / `demoSessions` | `title`, `productId`, `flowId`, `status`, `scheduledAt`, `startedAt`, `endedAt`, `runtimeProvider`, `runtimeWorkerStatus`, `recordingStatus`, `summaryStatus`, `followUpStatus`, `completedSummaryId`, `scheduledTimezone`, `scheduledEndAt`, `durationMinutes` |
| `recordings` / `recordings` | `sessionId`, `provider`, `status`, `recordingType`, `durationSeconds`, `startedAt`, `stoppedAt`, `processedAt`, `publicReplayEnabled` |
| `workspaces` / `organizations` | `name`, `slug` |
| `knowledge` / `knowledgeItems` | `productId`, `title`, `content`, `category`, `sourceType`, `status` |
| `transcripts` / `transcriptMessages` | `sessionId`, `speakerRole`, `speakerName`, `content`, `timestampMs`, `source` |
| `outcomes` / `demoSummaries` | `sessionId`, `recordingId`, `summaryStatus`, `executiveSummary`, `buyerCompany`, `buyerParticipants`, `buyerIntent`, `painPoints`, `featuresDiscussed`, `objections`, `answersGiven`, `unresolvedQuestions`, `competitorMentions`, `pricingSensitivity`, `integrationNeeds`, `securityConcerns`, `nextBestAction`, `recommendedFollowUpTiming`, `ctaShown`, `ctaClicked`, `conversionLikelihood`, `humanHandoffRecommended`, `confidence`, `riskFlags`, `generatedBy`, `generatedAt` |

Product descriptive fields come from the real product model; it has no `description` field. Knowledge returns the complete stored item text within the bounded snapshot size. Transcript records retain actual conversational and simulation speaker roles; they exclude system-role messages and `audioUrl`. Summary provider failure messages are omitted. Recording records have no standalone transcription field in this schema: recording detail references the related session's transcript and outcomes.

`GET /api/hades/records?collection=...` returns `{records, cursor, nextPage?}` with up to 100 records. `GET /api/hades/records?collection=...&id=...` dispatches the new `record` action and returns `{record, related, cursor}`. A product's related knowledge, and a session/recording's related transcripts/outcomes, are included only if separately scoped. Each related group is `{collection, filter, records, total, nextPage?}` with a 20-record preview. Its continuation reads the ordinary collection with the same filter and page token. Product filters apply to `knowledge`/`sessions`; session filters apply to `recordings`/`transcripts`/`outcomes`. Page tokens bind the collection and parent filter. The native client may browse these collections independently without rendering the related previews.

Knowledge must still belong to the grant organization and have a current product in that organization. Transcript/outcome records require a current session in the same organization. An inaccessible or system-only row is withdrawn from snapshots. Historical change payloads are filtered against the current authorized snapshot before delivery, including after parent moves; safe tombstones and scanned cursor progress remain available.

## Write contract

`POST /api/hades/records` accepts `{key, collection, operation, id, expectedRevision, data}`. `key` is 8–160 characters from `[A-Za-z0-9._:-]`; `id` is 1–200 characters; `expectedRevision` is a canonical nonnegative decimal safe integer. Unknown top-level or data fields are rejected. Success is `{key, status: "applied", record}`.

| Collection / operation | Scope | Allowed partial `data` |
| --- | --- | --- |
| `products` / `rename` | `products:write` | Exactly `{name}` |
| `products` / `update` | `products:update` | `name`, `audience`, `valueProposition`, `pricingSummary`, `forbiddenClaims`, `painPoints`, `topFeatures`, `competitors` |
| `knowledge` / `update` | `knowledge:write` | `title`, `content`, `category`, `status` |

At least one field is required. Product name is nonblank and at most 160 characters/640 UTF-8 bytes. Product descriptive strings allow at most 12,000 bytes each; arrays allow up to 100 nonblank strings of at most 1,000 bytes each. Knowledge title/content are trimmed and nonblank, with maxima of 1,000/48,000 bytes. Categories are `faq`, `feature`, `pricing`, `objection`, `competitor`, `custom`; status is `active`, `draft`, `archived`. Data JSON is at most 58,000 UTF-8 bytes; the mounted update request body is at most 65,536 bytes. OAuth and legacy non-update bodies retain the smaller 8 KiB limit.

The mutation checks fresh grant authority and scope, current target organization and knowledge parent, and the observed revision. It applies the edit, reconciles the result and writes the durable idempotency receipt in the same Convex mutation. A repeated canonical request returns its receipt without repeating the effect, while rechecking current target/parent authority. Same key with different content returns `idempotency_conflict`; a new key with stale revision returns `revision_conflict`.

Knowledge edits preserve the existing `updateKnowledgeItem` rule: edited or withdrawn claims archive prior matching knowledge chunks. A restore never revives those chunks. More than 1,000 indexed chunks fails before effects with `knowledge_index_capacity_exceeded`; no regeneration/embedding job is started by this provider. Product URL, browser credentials/session vaults, computer settings, execution state, knowledge parent/source type and storage authority are not writable.

## Evidence and remaining coverage

The author runner uses only installed fixture dependencies: Vitest 4.1.5, convex-test 0.0.56 and a single Convex 1.45.0 resolution tree. The project declares `convex: ^1.41.0`; its installed package is also 1.45.0. Earlier wording that treated the declared minimum as the installed version was inaccurate. The receipt binds both installed package manifests and license files. Vitest/tsx declare MIT; Convex/convex-test declare Apache-2.0. The private Glove package has no declared license or root license file in this inventory; no redistribution right is inferred. Run from the Glove checkout:

```sh
HADES_REVIEW_NODE_MODULES='/Users/preston/Documents/Codex/2026-09-06/hades-repair/node_modules' HADES_REVIEW_CONVEX_NODE_MODULES='/Users/preston/company-os-web/node_modules' node scripts/run-hades-v2-tests.mjs
node --import tsx --test scripts/tests/hades-oauth.test.ts
```

The final author run passes all 12 new cases and the unchanged seven prior independent cases (19 total); the original Node suite passes all 11 cases. The new author suite tests actual schema projections, real stored content, old-consent boundaries, canonical idempotency/CAS, credential/runtime-field refusal, chunk archival and overflow rollback, role checks, parent transfer withdrawal, bound continuation pages, public action/transport delivery and competing updates. Clerk responses are explicit fixtures; unplanned fetches throw. Independent review reproduced receipt replay after ownership/parent transfer and historical-change replay after withdrawal; the current store repairs both, preserving idempotent effects and tombstone/cursor delivery. The receipt binds final results and the separate review records the independent regressions. No dependency installation, product listener, provider request, migration, deployment or native action is part of this v2 lane.

Delivery remains periodic snapshot reconciliation. It does not publish backend notifications or promise a complete event audit between polls. Bounds remain 1,000 rows per collection, 2,000 total rows, 64,000 serialized characters per projected record, 100 records per page and 200 scanned changes per page. Over-capacity snapshots fail without advancing a committed cursor. Large or active accounts and long transcript histories can exceed this limit and need a different backend pagination design.

Complete business read/write acceptance remains open. This version does not export uploaded knowledge-file binaries, embedding chunks, media playback/downloads, system transcripts, credentials, public session handles, browser state or storage references. It does not add knowledge creation, product creation/deletion, session execution/scheduling writes, transcript/outcome edits, recording control, demo flows/steps, follow-up drafts, lead/billing/security administration or every other business entity. The current 32 unrelated LiveKit generated-API diagnostics also block a full project type pass. Hosted multi-connection contention, production function generation/deployment, human consent, native callback/Keychain recovery and the complete seven-provider workflow still need their own evidence.
