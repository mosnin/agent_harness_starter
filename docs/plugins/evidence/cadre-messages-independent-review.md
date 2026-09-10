# Independent Hades message projection review

2026-09-10. This review covers the new Cadre message reader and separate follow-up migration, not the reviewer's earlier OAuth implementation. The reviewer changed only the independent review suite, its explicit runner and this receipt. No production code, author tests, dependencies or existing data were modified.

## Executed boundary

```sh
HADES_REVIEW_NODE_MODULES=/path/to/retained/node_modules node scripts/run-hades-messages-independent-review.mjs
```

Runner pins Vitest 4.1.5 and PGlite 0.4.1. The suite uses an adapted minimal author schema fixture but independently authored cases, executes both actual migrations and real `createHadesOAuth().readHadesAccount` SQL, and refuses network fetches. It does not run a generated Prisma client, a hosted database, native consent or HTTP listeners.

Seven checks passed: archive refusal and history tombstone; current thread-owner movement; internal peer output classification using an out-of-page source receipt and its current edits; grant/membership revocation; legitimate authenticated-role message update with direct projection invocation denied; filter/cursor identity refusal; and forty 60-KB messages delivered completely across bounded pages with detail-plus-page rejected.

Schema inspection confirms Message stores JSON blocks and optional runId, Run has an actual required taskId plus optional sourceMessageId, and Task/Thread/Run ownership columns used by the queries exist. Shared `message-visibility.ts` defines result/status callback visibility; message bodies are not exported from raw history. Current parents and current content are rehydrated before returning a record or deletion, so historical metadata does not bypass current parent authorization.

## Finding: unbounded source receipt classification

The eighth test failed against the initial candidate: a source message with one `bot_message_received` block containing a 300000-character intent made `hades_message_source` return 300434 serialized bytes. Own-message blocks have a 262144-byte boundary, but `sourceBlocks` aggregated raw receipt intents without a matching bound. Repeated receipt blocks can amplify this further across peer output rows. The HTTP page cap is later than this SQL response allocation.

This is a resource-bound defect, not a reproduced cross-owner text leak. Reported before production editing. The source policy needs only result/status callback classification, not raw arbitrary intent strings or unbounded receipt arrays. Initial evidence: **7 passed, 1 failed**, `/tmp/cadre-messages-independent.log`. Acceptance is pending author repair and rerun.

A ninth independent test also reproduced the parent's reported classification-order defect: 300-KB internal peer text throws `record_capacity_exceeded` before the reader can discard it, blocking an unrelated valid public answer. The test expects hidden content to remain hidden without denying public results. Expanded red run: **7 passed, 2 failed**, `/tmp/cadre-messages-independent-nine.log` (5.25 seconds). Both repairs remain with the author; reviewer source is unchanged apart from adding this case.

## Initial source hashes

| File | SHA-256 |
|---|---|
| `packages/core/src/node/hades-messages.ts` | `086fa9dccb5fe2579c18db2049884990a3b0028db511b12805c782f02cf1dd9c` |
| `packages/core/src/node/hades-oauth.ts` | `5b22d3137104189838c14477db33881cd9550c63a1c34eed52e1d83d1c0c7096` |
| `packages/db/prisma/migrations/20260910010000_hades_messages/migration.sql` | `5cb79cca606cb3bd91383487c0fe54a41f7f1b5928cbd36c2ec59452d407e91c` |
| `packages/core/src/message-visibility.ts` | `774d8ebcab5b39aeaa895fcb839ef4d640b7596c68fc53188aa42cd3bca67aa5` |
| `packages/db/prisma/schema.prisma` | `1c92b95a6ef9d66cf2cdf5ff65ea07a9dfc2479d1fcf01b2f8ba3926f82262ca` |

The SQL fixture preserves relevant parent relations and trigger behavior, but is not the entire production schema or proof of multi-connection contention. Live migration/application, native account access and provider delivery remain open. No build, deployment, network operation or package installation was attempted.

## Independent repair acceptance

The author repaired both findings. SQL now exports at most two distinct recognized source callback markers (result/status), and at most two bounded row receipt kinds. Unknown arbitrary intent content is excluded. The reader applies system/internal/receipt visibility before raising capacity errors, preserving the existing shared callback policy. Public oversized text still fails explicitly; hidden oversized peer text no longer blocks other results.

Independent rerun of the unchanged nine tests: **9/9 passed**, `/tmp/cadre-messages-independent-green.log`, 4.66 seconds. No further concrete blocker reproduced within this bounded source/SQL review. This is independent acceptance of those source repairs and scoped behaviors, not live/native or full-schema database acceptance.

| Repaired artifact | SHA-256 |
|---|---|
| `packages/core/src/node/hades-messages.ts` | `da91a1d32a255de9674eba3a446af96f5a8e709992cbd25ac3c7e1b59c213b74` |
| `packages/db/prisma/migrations/20260910010000_hades_messages/migration.sql` | `0a84aa0cec8343250dfbcbbb58874b3eda14ee706b27a6dd0528c5e2ad5dbcb7` |
| `packages/core/src/node/hades-messages-independent.review.mjs` | `ee83c8c631672ed2a5c81ebac0b985d6c5ed414b7608a1f66508b3aea737ea42` |
| `scripts/run-hades-messages-independent-review.mjs` | `4b12f890abe56c7c433a1da786081047ef6615f20e24ac97fd77698f0347ed0e` |
