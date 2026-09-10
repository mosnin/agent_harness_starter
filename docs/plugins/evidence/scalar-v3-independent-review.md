# Scalar CRM v2 independent review

2026-09-10. Base source HEAD `7922be8b22e6f7cd3e6041ddecfeceac8f0a4414`; provider additions are uncommitted. The reviewer authored only `tests/oauth-crm-independent-review.test.ts` and this receipt. No production edits, dependency installation, network, listener, database preflight, build or native operation occurred.

## Source boundary

Inspected `oauth-crm-data.ts`, production `/api/oauth/records` route, the actual Prisma Contact/Entity/Activity/Pipeline/PipelineEntry and OAuth/member fields, and existing contact/entity/pipeline-entry mutation routes. Selected fields and relations match the schema. Activity uses createdAt rather than a nonexistent updatedAt. Allowed descriptive fields, enums and lastActivityAt stamping align with existing product edits. No enrichment or external identity matching is performed.

Current membership follows the local TeamMember mirror. Explicit resource values must match the CRM resource rather than MCP; absent-resource legacy grants remain supported. Read/write authority is rechecked transactionally before current-target queries or receipt replay. These checks do not prove that hosted membership mirrors are current or that the generated Prisma client accepts every query.

## Independent tests

```sh
./node_modules/.bin/vitest run tests/oauth-crm-independent-review.test.ts --maxWorkers=1 --minWorkers=1
```

Retained Vitest 2.1.9. The deterministic Prisma-port fixture is adapted from the author fixture, with recursive relationship matching replacing its simplified parent sentinel. Test cases are independently authored. The fixture is not an actual Prisma client or PostgreSQL transaction engine; rollback and same-timestamp races are modeled.

Six checks passed: nested pipeline/contact/company ownership on read and replay; current workspace membership and personal-account actor checks; audience/client-scope revocation before replay; same-timestamp changed-field CAS refusal with no receipt/effect; byte-limited pages delivering 31 full large records without loss; oversized full-record refusal without truncation.

The seventh check reproduced a contract defect: explicit `id: ""` bypasses truthy validation and returns the whole authorized collection. The production route passes an empty `?id=` through unchanged. This is unexpected request broadening, not cross-account access. The same presence-based validation is needed for empty page and detail-plus-page arguments. Reported to the author and root before any implementation change.

Initial independent result: **6 passed, 1 failed**, `/tmp/scalar-v2-independent-review.log`. Acceptance remains pending the author repair and independent rerun.

## Initially reviewed hashes

| File | SHA-256 |
|---|---|
| `src/lib/oauth-crm-data.ts` | `b762c6d1ce0e9d479b6b1b4dae007c029779e214efe3dc24ad5abd1ea8c1279d` |
| `src/app/api/oauth/records/route.ts` | `46a638df6c71d459411eb56bd81e12f60fc18033580ac5f4e122a0ff8e3bf06f` |
| `prisma/schema.prisma` | `f38e68ceb677e715eba357fedb35098ab6ab79e10172cdf03fe897b2e82418e3` |
| `tests/oauth-crm-independent-review.test.ts` | `f5f05b0acb28d4a6c7775d9cb30abe7efb6ba227b7f08da436479e0284e769f3` |

Ordinary collection pages are not a frozen multi-page provider snapshot. Hosted transaction contention, real generated ORM compatibility, deployment, live OAuth consent and native Hades delivery remain open gates. No provider or product-wide acceptance is implied.

## Repair verification

The author changed ID/page validation and detail branch selection to presence checks (`!== undefined`). Explicit empty identities now fail instead of changing the request into collection enumeration. Source inspection confirms the combined detail/page case and empty page are also rejected.

Independent rerun of the unchanged seven tests: **7/7 passed**, `/tmp/scalar-v2-independent-green.log`, 187 ms. Repaired `src/lib/oauth-crm-data.ts` SHA-256: `3e9cfb6c727d2afbd3fc3a89add13b0567ce6b3be576d18f5da6c23f3c9d9ea1`. No further concrete blocker reproduced within this source/fixture boundary. The deployment and actual ORM limits above remain unchanged.
