# Independent Glove v2 authority review

Scope: actual provider Convex mutation implementation, explicit OAuth consent scopes, current business-row authority, retained receipts, history, related detail isolation and bounded full content. Reviewer authored only `convex/hadesOAuthV2Independent.review.mjs`, this receipt and standard runner inclusion; implementation repairs were performed by a different worker. The actual schema seed is adapted from the author fixture; challenge assertions are independent. No unrelated LiveKit source was modified.

## Findings and resolution

1. Frozen store `04512a9293d9158f54481250aa6467681100c30eb46a576d050df4a2b58a4885` returned retained write receipts before checking current target organization or knowledge parent visibility. Actual fixtures reproduced **three failures** for product transfer, knowledge transfer and knowledge-parent transfer. Implementation now checks current target visibility before returning an exact retained result; it does not repeat the write.
2. The first repair retained historical change payloads for knowledge whose parent became foreign. An independent cursor-zero challenge reproduced the disclosure even while direct detail correctly refused it. Final implementation filters nondeleted historical payloads against currently scoped and visible reconciled records. Tombstones and the scanned cursor remain intact. Further challenges pass for foreign-session transcripts/outcomes and newly system-role transcript messages.

## Acceptance evidence

**Standard portable gate: 19/19 passed** (seven prior independent cases plus twelve new cases), 396 ms. Command:

```sh
HADES_REVIEW_NODE_MODULES=/path/to/retained/node_modules HADES_REVIEW_CONVEX_NODE_MODULES=/path/to/convex/node_modules node scripts/run-hades-review.mjs
```

Runner pins Vitest 4.1.5, convex-test 0.0.56 and Convex 1.45.0; no downloads, installs, listeners or real provider requests. Actual `handleHadesStore` runs in isolated Convex test transactions using the source schema.

New cases cover both receipt target transfers, knowledge parent transfer, old rename-only grant refusing broader update, current knowledge role and scope recheck, transcript/outcome scope removal across retained history and detail, same-organization related-session isolation, oversized full content refusing without truncation or projection advancement, current-parent history withdrawal, system-role withdrawal, and pagination across 205 filtered historic transcript rows with every tombstone delivered. Original independent cases continue CAS/idempotency/foreign-org/refresh and authority checks. No implementation changes were made by this reviewer.

Initial logs remain local: `/tmp/glove-v2-independent-red.log` (3 failed / 24 passed combined author + independent); `/tmp/glove-v2-independent-history.log` (1 failed / 27 passed); final `/tmp/glove-v2-independent-final.log` (19 passed standard independent gate). These counts refer to different suite inventories as the independent challenges were added, not a regression in prior cases.

No material blocker remains reproduced within this review scope. Author tests and typechecking are reported separately by the implementation worker. This acceptance does not establish hosted Convex conflict handling, full production migration/generated API compatibility, live Clerk revocation timing, browser/native consent behavior, deployment, provider delivery, or real-time notifications. Glove reconciliation remains explicitly bounded polling. Responses already delivered before an authority change cannot be recalled by this server repair.

## Frozen hashes

| File | SHA-256 |
|---|---|
| `convex/_lib/hadesOAuthContract.ts` | `79904c39521a2f6f9ccd8d3bda5cc7154ae3df68199fb516531b4419ad0e68cd` |
| `convex/hadesOAuthStore.ts` | `a91861893f4ae27c28e5608d48ed70c9b6cfa84b949cfdadc3fd1f8c0044a7df` |
| `convex/hadesOAuth.ts` | `6a0a10b651d0815ba5ea6da90aa95950d7b0dacdbcc6400dc96b7d551b7059d8` |
| `lib/hades/transport.ts` | `cf9d68c5a63a62878c12208f23ca8ee6d20a269316d0009d18d1f6952ef5e6e1` |
| `convex/hadesOAuthV2Independent.review.mjs` | `35b235e4f2e964b5da3c7b1c4394a7e909e1e10c4d07dc4a56faf995a7964ff8` |
| `scripts/run-hades-review.mjs` | `41cddd1b4079169553e6c0bdc09a335f2379133f5c3b35c6f9b2f2063c882393` |

Local evidence hashes:

- `/tmp/glove-v2-independent-red.log`: `46aa70b89c18cccda1739a131d97dc4d343c701aa896e1edf2ec394148e4e46d`
- `/tmp/glove-v2-independent-history.log`: `893dfeec7bba7674111272df89e097a5174a96a8f22fa22a600e4fcfadd020f8`
- `/tmp/glove-v2-independent-final.log`: `7421a91afc0742ccbd786ad0309af3aa56c3107dac81aec65aa3fa6e5bdef082`
