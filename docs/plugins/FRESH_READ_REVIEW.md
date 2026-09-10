# Independent fresh-read and pagination review

2026-09-10; parent-authored uncommitted client changes relative to `b6ec8b860252b34eefc80e0914bc1d1393eefb6a`. Reviewer changed only the new `ecosystem-read-review.test.ts` and this document. No production changes were needed: no concrete defect reproduced in this bounded review.

The tests use actual EcosystemService, EcosystemStore and ecosystemTools with private disposable SQLite storage and modeled in-process fetch/adapter responses. They are neither deployed-provider nor native acceptance. No listeners, network, installs, credentials or app control were used.

## Evidence

```sh
./node_modules/.bin/vitest run src/desktop/__tests__/ecosystem-read-review.test.ts --maxWorkers=1
```

**6/6 passed**, `/tmp/ecosystem-fresh-read-independent.log`, 282 ms.

- Default fresh read refuses provider failure instead of returning saved data; explicit cached mode returns a snapshot without `checkedAt`.
- Identical refreshed contents retain the continuation identity, while changed contents, changed filters and a replacement connection generation refuse the old continuation.
- A cancelled reader promptly rejects while a separately owned background sync may finish; no late data is returned to that reader.
- A reader sharing a non-agent sync still refuses its result after agent-read access is removed.
- Actual `plugins_read` preserves all 75 large Unicode-record identities across bounded pages. Omitted payloads remain discoverable through IDs/content hints; continuation does not perform another provider refresh. Each result stays below 128 KiB.
- A narrowed grant invalidates continuation even when record bytes are identical.

Source inspection confirms content is canonicalized before hashing, with account/profile/generation and sorted scopes included; cursor and synchronization timestamps are excluded intentionally. The service additionally binds the page ID to normalized collection/query filters. The tool advances by the number of identities actually returned after payload omission, rather than skipping the remainder of a trimmed page.

An initial fixture attempted to replace a generation through `store.save`, which correctly refused it. The test was corrected to remove/recreate the fixture connection before checking old-page rejection; this was not a production defect.

## Exact candidate

| File | SHA-256 |
|---|---|
| `src/desktop/core/ecosystem-service.ts` | `3c2dbba28f781566096b9818d68de5d6e209126437ee35e09bc23dbb22566a91` |
| `src/desktop/core/ecosystem-store.ts` | `fba2c6a22b5323b5b737ce67a6617961467f59bacc0b591ad32a76521506807c` |
| `src/desktop/core/ecosystem-types.ts` | `33421faa856b1171c03c70a7fa60898325046ab683604bc750ca020876bb664d` |
| `src/desktop/core/ecosystem-tools.ts` | `d1a876ca6826c1e45a052d8c3799df788ae45931e66339232fe11dfcaa07275f` |
| `src/desktop/__tests__/ecosystem-read-review.test.ts` | `9097f3cb3294917d6cde014af1394d2c40394e5b8060cb8e8a9141e0ab0f3189` |

Remaining gates: hosted service pagination/change-feed fidelity, native agent usage, and independent review of provider implementations. A completed service sync is an observation through the configured provider contract, not proof that every remote product change is already reflected. No claim of full application regression or arbitrary schema-size coverage is made.
