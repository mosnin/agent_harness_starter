# Glove OAuth independent review

2026-09-10. Independent review of another worker's candidate in the Glove source checkout, base HEAD `89e49e4fb4e13ec77699ac043e50087ad567df05`. OAuth additions are uncommitted source. Reviewer wrote only `convex/hadesOAuthIndependent.review.mjs` and this receipt.

**7/7 independent tests passed**, `/tmp/glove-independent-final.log`. No additional concrete authority bypass or transactional regression reproduced in this bounded review. Author independently hardened Clerk requests with redirect refusal and bounded JSON; final tests include the resulting helper source.

## Execution method

```sh
/Users/preston/Documents/Codex/2026-09-06/hades-repair/node_modules/.bin/vitest run convex/hadesOAuthIndependent.review.mjs --maxWorkers=1
```

Run from Glove checkout. Uses existing Hades Vitest and Company OS web convex-test dependencies by explicit absolute imports. No installation or dependency changes. Tests invoke the production `handleHadesStore` inside isolated convex-test transactions with the actual Glove schema; internal fresh-member assertions are explicit fixtures. Separate tests invoke actual `currentHadesMember` with injected Clerk fetch responses. No external Clerk call, account, native app, listening socket or deployed function was used. An initial fixture setup omitted the generated-module key; adding the existing `_generated/server.ts` module reference corrected the harness without production edits.

## Verified cases

- Correct-PKCE consumed-code replay commits revocation; wrong PKCE cannot revoke.
- Fresh member proof is bound to actor, Clerk organization, checked-at window and current role; foreign/stale/demoted proof is refused.
- Actual snapshot projection excludes a planted product credential ciphertext. Rename CAS and exact idempotent replay execute through the mutation; stale revision creates no additional receipt. Deleting the product produces a tombstone.
- Explicit recording DTO excludes planted storage/download/recording URLs, public replay token and provider token.
- Refresh rotates once; replay revokes its family; wrong client cannot revoke.
- Actual Clerk helper accepts the matching membership/user fixture, rejects missing membership and banned user, and requests only its fixed Clerk API origin.
- Competing rename intents admit one revision; another organization's product is excluded from reads and rejected for writes.

## Read-only boundary findings

Public action dispatch derives actor/organization from authenticated human context for consent, and from the stored grant for bearer use. Caller-supplied member/role values are not forwarded as authority. Every bearer exchange/read/write fetches current Clerk membership/user and passes a bounded-age server proof to the internal mutation. This is a remote check with a maximum fifteen-second proof age, not an atomic transaction with Clerk membership changes.

Consent uses a hashed one-use nonce tied to current human and organization, exact fixed client/redirect/S256 challenge and fixed scopes. Browser transport requires cookie-derived human auth and same-origin approval POST. Typed mutation is product rename only; current role must permit manage_products when the grant has products:write. Recording scope rechecks view_replays. Userinfo sub is the original grant actor; account identity combines organization and actor.

Reconciliation polls bounded ordinary product tables into a shared organization sequence and explicit safe DTOs. Snapshot baselines and change cursors are not claims of push/live events. Any source snapshot capacity failure rejects transactionally; the client must treat it as unavailable rather than complete. Credential vaults, signed-in browser state, recording access URLs and runtime-control fields are outside the explicit projection. Allowed descriptive content remains untrusted account data.

## Limits

Full deployed schema/function generation, Clerk API behavior, consent browser rendering, live native callback, remote concurrent requests, hosted transaction limits and end-to-end Hades integration remain unverified. The fixtures do not prove live membership freshness or production performance. Owner-provided transport tests exist separately; this receipt claims only the seven independently executed cases above. No production changes or remote writes by this reviewer.

## Exact candidate SHA-256

| Path | Hash |
|---|---|
| `convex/hadesOAuth.ts` | `d0dcc9d96be8da0a52de002b7fdaca0efd54d4b3f24c44a380e9d84dd4600adc` |
| `convex/hadesOAuthStore.ts` | `449b8bb3c07169b51f401ef2ebbf1b3d59738950b6d72cca5c2ac85c634a0d7c` |
| `convex/_lib/hadesOAuthContract.ts` | `0dd8c40dbdc0249418e164e89dce5f9a5047ac18d40cb5f7e16f25609806e50e` |
| `convex/_lib/hadesOAuthSchema.ts` | `274a310ac3c91f2e6e5ee8eafd36e9cc9dcfb6ffcb61d1e1ed947eddc68ad992` |
| `lib/hades/server.ts` | `dc6847dfaf6747339079e24e3270edde244fa2d45ef22da0497b270511999a6f` |
| `lib/hades/transport.ts` | `dcbf6d9ce618e3063b51022bec64253ba94c4dc4a8134e3d144823640596265d` |
| `convex/hadesOAuthIndependent.review.mjs` | `92854ad53eaaaa4e65fd39073f96c9876821b6816408555adff0e33c5edbb71f` |

## Glove portable review rerun

The independent suite is now `convex/hadesOAuthIndependent.review.mjs`, using normal package imports and an explicit `scripts/run-hades-review.mjs` resolver. No machine-specific source import remains. Run via:

```sh
HADES_REVIEW_NODE_MODULES=/path/to/review/node_modules HADES_REVIEW_CONVEX_NODE_MODULES=/path/to/convex/node_modules node scripts/run-hades-review.mjs
```

See provider `scripts/HADES_REVIEW.md` for exact dependency provenance and separation from default CI/typechecking. Final portable rerun: **7/7 passed**, `/tmp/glove-portable-review.log`. The runner pins Vitest 4.1.5 and convex-test 0.0.56 and Convex 1.45.0 in the second dependency tree. All Convex imports resolve through that same tree. No installations, lockfile changes, listeners or provider calls. Earlier direct commands above are historical evidence and superseded by this runner. Glove's explicit single Convex resolution tree and JavaScript review artifact remove the production TypeScript package-identity error without unsafe production casts.

Runner SHA-256: `2b0dce86720ad508d84470cc502d90f53f86d1ccfa51a5d2b5d8c5d5b58afcee`. Review source SHA-256: `92854ad53eaaaa4e65fd39073f96c9876821b6816408555adff0e33c5edbb71f`.
