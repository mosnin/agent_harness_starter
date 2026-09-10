# Independent Scalar v2 Hades client review

This review exercises the actual EcosystemService and local SQLite store with the root-authored Scalar catalog definition and modeled provider fetch responses. The reviewer authored the Scalar provider interface earlier, but did not implement the Hades client adapter under review. There is no real HTTP listener, native app, network call, provider credential or dependency installation.

## Exact-contract checks

The adapter matches the source provider's five collections and new `/api/oauth/records` GET/POST path, existing crm:read/crm:write consent, optional absent-resource compatibility, UUID IDs/keys, SHA-256 revisions and three writable field sets. Company records are actual Entity rows, not invented Company rows. Activities and pipeline definitions remain read-only. The iterator is client-local pagination state, not a fabricated provider checkpoint.

Four initial integration cases passed: actual sync walks contacts across two pages, then empty companies and three remaining collections; repeated refresh starts again with contacts and stores no checkpoint; a later pipelines failure leaves the previous complete cache intact; detail validates exact record identity and account; exact write DTO reaches the source endpoint while a read-only grant cannot mutate. The read-only case now retains an enabled local write toggle to ensure the provider scopes, not merely the toggle, enforce refusal.

## Reproduced finding

A fifth challenge returned a successful HTTP response with `{status:"applied",record:{id:OTHER}}` after the requested write was dispatched. The Scalar adapter did not validate the acknowledgement identity, so EcosystemService reported the unrelated response as an applied mutation. Initial result: one failed, four passed; `/tmp/ecosystem-scalar-independent-red.log`.

Expected repair: validate source acknowledgement status and record identity/shape at the adapter boundary. An uncertain response after dispatch must remain unknown, and repeating the same local idempotency key must not send another POST. A sixth fixture additionally checks a negative provider acknowledgement.

## Status

Root repaired Scalar and the analogous all-seven write adapters. The independent suite now passes **37/37**: six Scalar iterator/cache/detail/write cases and 31 all-seven acknowledgement cases. Final log `/tmp/ecosystem-write-ack-independent-final.log`, Vitest 4.1.5, `--maxWorkers=1`, 367 ms. No client implementation was edited by the reviewer.

The all-seven matrix uses each catalog definition with the real EcosystemService and local SQLite store: valid source-shaped acknowledgements; empty successful bodies; wrong record/identity; rejected statuses; and changed echoed keys for Govern/Cadre/Glove. Empty/wrong/rejected cases remain unknown after reopening the service against the same SQLite state, and do not dispatch a second POST. Native changed-key cases also retain unknown without a second POST in the current service.

This follow-up found two additional acknowledgement defects: Operate and Company OS accepted an explicit `status:"rejected"` alongside otherwise valid projection fields. Their actual source DTOs have no status member. Root now refuses any explicit status on those projection acknowledgements. An initial positive Stored fixture used a numeric revision instead of its actual SHA-256 revision; that was corrected from the provider route source and is not counted as a production finding.

No remaining material client defect was reproduced in this bounded matrix. Actual Scalar Prisma/database compatibility, provider deployment, OAuth consent and native workflows remain separate from this modeled client acceptance. The reviewer authored only the new review files and this report. The standard plugin gate includes these reviewer filenames through root-owned runner changes.

## Final source and review hashes

| File | SHA-256 |
|---|---|
| `src/desktop/core/ecosystem-catalog.ts` | `6bb6b1daa4f56ea725496073c68583c688d1abc0e43ea978b3828c61e7d7b4fa` |
| `src/desktop/core/ecosystem-service.ts` | `3c2dbba28f781566096b9818d68de5d6e209126437ee35e09bc23dbb22566a91` |
| `src/desktop/__tests__/ecosystem-scalar-review.test.ts` | `c0c59d7748234192f9512b41478cf22dcdd0c43fc377b34dd1e8f6be99404fa6` |
| `src/desktop/__tests__/ecosystem-write-ack-review.test.ts` | `a38ed7cd736776687859a3217f94f47a9a0d86293720efbbae3ce16b7f765894` |

Evidence logs:

- `/tmp/ecosystem-scalar-independent-red.log`: `7a6b36183c5ac02d1b0b8faabec72a572aaaa5c74ad3098fef549714ce571c7e`
- `/tmp/ecosystem-write-ack-independent.log`: `09af6c4bbfab83ead2a21c13a0f0f98d6678b91858f3cb63a813711769df2119`
- `/tmp/ecosystem-write-ack-independent-final.log`: `240c81dd3bdb5730d3e7d86204f6ec01234ad4957d35d7ac50e9e1a6521fe371`

## Final fixture correction and type gate

Root review identified fixture-only contract inaccuracies: the type alias is EcosystemId, Company OS templateVersion is number 1, Operate task IDs include the operate:task: prefix and the acknowledgement must echo it, and native revisions are numeric strings. These were corrected without client production edits. Prior logs remain retained rather than overwritten. The corrected final rerun passes **37/37**, 357 ms, and full root TypeScript passes with no output. Final logs: `/tmp/ecosystem-write-ack-independent-final-v2.log` and `/tmp/ecosystem-ack-review-types-final.log`. The current test hashes below supersede the preceding test inventory.

- `src/desktop/core/ecosystem-catalog.ts`: `6bb6b1daa4f56ea725496073c68583c688d1abc0e43ea978b3828c61e7d7b4fa`
- `src/desktop/__tests__/ecosystem-scalar-review.test.ts`: `c0c59d7748234192f9512b41478cf22dcdd0c43fc377b34dd1e8f6be99404fa6`
- `src/desktop/__tests__/ecosystem-write-ack-review.test.ts`: `af484a1a6dc4889ab19db3b73594c454561bbfa75e91a7f566f1ff973e09ebdb`
- `/tmp/ecosystem-write-ack-independent-final-v2.log`: `9c0c0497eb1b5b3cc8b6a260ad5b6fd2707be0f6befd75c6b1b1ba0a88700438`
- `/tmp/ecosystem-ack-review-types-final.log`: `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`

## Native revision contract follow-up

Root tightened native acknowledgement revisions to positive decimal sequence strings, matching Cadre/Govern SQL and Glove projection sequences. Scalar/Stored still require their source SHA-256 revisions. Independent actual-service cases now reject a leading-zero revision for each native provider, retain unknown across SQLite/service reopen, and send only one POST. No client source was edited by the reviewer.

The independent combined gate now passes **40/40** (34 acknowledgement cases plus six Scalar cases), Vitest 4.1.5, `--maxWorkers=1`, 363 ms. Log `/tmp/ecosystem-write-ack-native-revision-final.log`. Prior receipt sections and hashes remain intact; current hashes follow. This remains modeled-fetch and actual local service acceptance, not provider deployment or live interoperability.

- `src/desktop/core/ecosystem-catalog.ts`: `b58da8942877c716a46dd4836820a72b6a7740388524e1b00d81ff3adbd29755`
- `src/desktop/__tests__/ecosystem-write-ack-review.test.ts`: `976e54d510e4530b5a2f9e93c98811c58dbde7ae4fe55d4f67c3f4d1d6003323`
- `/tmp/ecosystem-write-ack-native-revision-final.log`: `46297df8ac39c743736bd3f572765a567f584618af8c2c830d89dc56a0e43342`
