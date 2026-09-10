# Scalar OAuth CRM data v2

Source-only candidate in the existing Scalar repository. No deployment, schema application, provider request, native flow, listener, dependency installation or commit was performed. This is an additive data interface, not an MCP tool execution interface.

## Consent and authority

The existing issuer already discloses `crm:read` as "Read your contacts, companies, activities and pipelines" and `crm:write` as "Create and update records in your CRM" (`src/lib/oauth-server.ts`). These are broader than the earlier name/notes implementation. The new collection and descriptive-edit interface stays within that actual consent; it does not repurpose rename-only permission or silently request MCP authority.

Every new read and write runs inside a Serializable Prisma transaction. Before returning data or replaying a write receipt it rechecks the current access-token kind/expiry/revocation, grant revocation and actor/account binding, client identity/disabled state, and current token/grant/client scope ceilings. Workspace access requires the existing local TeamMember row; personal access requires the subject to own the account. Existing CRM routes allow current workspace members to edit CRM rows without an admin-only rule, and this interface preserves that policy. The check follows the product's local membership mirror, not a fresh external Clerk request.

All primary queries scope `userId` to the approved account. Contacts additionally require a same-account company parent when present; activities require owned linked targets; pipeline entries require an owned pipeline and contact, including the contact's company boundary. Write replay checks the current target and relationships before returning the retained payload, without repeating the effect. Receipts bind account, subject, client, grant and idempotency key. Current read and write scopes remain required even on replay.

The existing protected-resource metadata describes MCP at `/api/mcp/mcp`, not CRM. This new module explicitly defines `SCALAR_CRM_RESOURCE = https://tryscalar.xyz/api/oauth/records`. Legacy absent-resource CRM grants remain accepted. If a resource is supplied, the current token, grant and request context must match that exact CRM resource. MCP or other audiences are refused. The legacy `/api/oauth/contacts` endpoint now refuses explicit audiences because it has no defined legacy resource URI. This is a new source contract, not a claim that production already publishes new metadata.

## Read contract

`GET /api/oauth/records?collection=COLLECTION` returns `{records,nextPage?}`. `nextPage` is the last delivered record UUID and is sent back as `page`. `GET /api/oauth/records?collection=COLLECTION&id=UUID` returns `{record}`. Detail and page cannot be combined. Unknown collections or malformed IDs fail explicitly.

Each record is `{id,collection,title,revision,updatedAt,data}`. `revision` is SHA-256 of the collection, identity, update time and fixed-field projection, for optimistic compare-and-set. It is not proof of authenticity. `updatedAt` is epoch milliseconds; date fields within data are ISO strings or null.

| Collection | Actual Prisma model | Projected data fields |
|---|---|---|
| contacts | Contact | name, email, phone, company, title, website, linkedin, facebook, instagram, twitter, location, status, tags, notes, entityId, lastContactedAt |
| companies | Entity | name, domain, website, phone, industry, location, description, size, status, tags, notes |
| activities | Activity | contactId, entityId, kind, body, channel, actorLabel |
| pipelines | Pipeline | name, goal |
| pipelineEntries | PipelineEntry | pipelineId, contactId, stage, dealScore, conversationStatus, lastActivityAt |

There is no guessed enrichment or identity matching. Raw provider enrichment JSON, API credentials, billing/settings fields, private storage handles and unrelated account configuration are not selected. User-entered notes and activity bodies are returned as authorized content; this is not a promise that arbitrary user text contains no sensitive material.

Pages contain at most 100 rows and approximately 2 MiB of serialized record bodies, plus envelope overhead. Each full record must be at most 128 KiB or the request fails with 413. Text is never silently truncated. Pages are ordinary current reads, not a frozen multi-page snapshot. No change cursor or realtime feed is invented: full refresh reconciliation is still required.

## Write contract

`POST /api/oauth/records`, JSON:

```json
{"key":"UUID","collection":"companies","id":"UUID","operation":"update","expectedRevision":"64 lowercase hex characters","data":{"description":"Approved company description"}}
```

Allowed collections and fields:

- contacts: name, company, title, location, notes, tags.
- companies: name, industry, location, description, size, notes, tags.
- pipelineEntries: stage, dealScore, conversationStatus. This also stamps lastActivityAt, matching the existing product PATCH route.

At least one recognized field is required. Unknown fields are rejected. Contact/company string lengths, nullable clearing, tag bounds and pipeline enums match the existing product PATCH contracts. Pipeline stages: NEW, ENRICHED, PROSPECTING, ENGAGING, REPLYING, WON, LOST. Conversation states: OPEN, AWAITING_REPLY, STALLED, CLOSED. Deal score is an integer from 0 through 100, or null. Requests are at most 64 KiB of actual streamed bytes.

The transaction checks current revision and conditionally updates the timestamp and all projected fields to avoid same-timestamp lost updates. It stores the result receipt with the business mutation. Exact replay returns the retained result after current authority checks; changed input with the same key is a conflict. Serialization failures are surfaced without automatic retry. Response: `{status:"applied",record}`. There is no outbound contact, enrichment lookup, field provenance fabrication, parent reassignment, deletion, task execution or history rewriting.

Legacy `/api/oauth/contacts` remains compatible for absent-resource grants and name/notes updates. Its retained receipt now also requires a currently owned target before return.

## Evidence and limitations

- **26/26 focused fixtures passed**: new data module 15, production route 3, legacy contacts 6, native client 2. Retained runner Vitest 2.1.9. Final log `/tmp/scalar-v2-tests-final.log`.
- Strict focused TypeScript checking passes for new/legacy data modules and new data fixtures: `/tmp/scalar-v2-scoped-types-final.log`.
- `git diff --check` passes. Formatting used retained Prettier without source dependency changes.
- Tests use an explicit deterministic Prisma-port fixture with query predicates and rollback, plus production HTTP route code with injected authentication/data dependencies. They do not run a generated Prisma client or actual PostgreSQL transactions. Hosted CAS/serialization and actual ORM query compatibility remain acceptance gates.
- Whole-project typechecking could not pass with the retained dependency tree: Prisma client and AI packages are missing, along with downstream baseline diagnostics. The new module's initial narrowing errors were repaired and its scoped check passes. No full type-pass claim is made.
- Repository ESLint cannot load because retained ESLint 8.57.1 lacks the `eslint/config` export required by this repository configuration. No lint pass is claimed. A build was not attempted because the required generated dependencies are absent; the package build also contains a database preflight and was not run.

Remaining all-data coverage includes contact email/call/social histories, segments, additional provenance and enriched fields, workflow/run results, creation/deletion and pipeline-definition edits. Those require their actual visibility/effect contracts before expansion. Source deployment, generated Prisma verification, migration readiness of the existing OauthDataWrite table, live OAuth consent and native Hades interoperability remain unverified.

## Source references

- `prisma/schema.prisma`: Entity, Contact, Activity, Pipeline, PipelineEntry, TeamMember and OAuth models.
- `src/app/api/contacts/[id]/route.ts`: descriptive-field validation and account ownership.
- `src/app/api/entities/[id]/route.ts`: company metadata validation and account ownership.
- `src/app/api/pipelines/[id]/entries/route.ts`: stage/score/conversation validation and lastActivityAt behavior.
- `src/lib/oauth-server.ts`: existing scope descriptions and OAuth account resolution.

## Frozen hashes

| File | SHA-256 |
|---|---|
| `src/lib/oauth-crm-data.ts` | `b762c6d1ce0e9d479b6b1b4dae007c029779e214efe3dc24ad5abd1ea8c1279d` |
| `src/app/api/oauth/records/route.ts` | `46a638df6c71d459411eb56bd81e12f60fc18033580ac5f4e122a0ff8e3bf06f` |
| `src/lib/oauth-contact-data.ts` | `daa837ed071af30399ab62187f43b8fd938ec5a2db4c283da64b930f0da64c06` |
| `tests/oauth-crm-data.test.ts` | `ce608c5415aaea49df7265b8f652e249593f11163fd670f372f2332622ef7fd9` |
| `tests/oauth-crm-route.test.ts` | `65a9c194773edc7d8e4e75134e04acc2229ea183d349d47d47434a7d162da7ef` |
| `tests/oauth-contact-data.test.ts` | `7efd6ec8ec3579cb2fce55a7db6a89301002208fd531438c71c0c4048fe5f5c1` |

## Independent empty-selector correction

Independent review reproduced explicit `id=` broadening a detail request into collection enumeration. The provider now validates presence with `!== undefined` for both id and page, rejects empty values, and rejects combining either selector even when empty. Review fixtures remain owned by the independent reviewer. Author rerun: 26/26 passed; scoped strict typechecking passed. Logs `/tmp/scalar-v2-empty-fix.log` and `/tmp/scalar-v2-empty-types.log`. No other source behavior changed. The earlier hash table remains the original reviewed candidate; current corrected module hash follows.

`src/lib/oauth-crm-data.ts`: `3e9cfb6c727d2afbd3fc3a89add13b0567ce6b3be576d18f5da6c23f3c9d9ea1`
