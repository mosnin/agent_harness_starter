# Company OS provider OAuth security review

2026-09-10. Independent source and deterministic fixture review by integration, who did not author this provider OAuth implementation. This concerns `/Users/preston/company-os-web`, not the separately bundled local Company OS framework. The reviewed provider additions are uncommitted source; this is not deployed or native OAuth acceptance.

## Disposition

One concrete consent defect found and repaired: `app/oauth/authorize/consent.tsx` originally described `companyos:data:read` as browsing the document index, although the full-record endpoint exposes current revision contents and branch documents. The author now discloses reading document contents, including branch documents. This repair was source-inspected; browser rendering and consent interaction were not exercised.

No additional blocking defect reproduced in this bounded review. Acceptance applies to the tested boundaries below, not every provider feature or enterprise identity control.

## Behavioral evidence

Command from provider checkout:

```sh
./node_modules/.bin/vitest run convex/oauth-independent.test.ts convex/oauth.test.ts lib/oauth-events.test.ts lib/oauth-body.test.ts --maxWorkers=2
```

Result: **4 files, 31 tests passed**, including **6 newly authored independent challenges**. Raw log: `/tmp/companyos-independent-tests.log`. Convex-test provides isolated transactional fixtures and in-process HTTP routing; no TCP listener, real Convex deployment, native app, account credentials, or provider request was used. An initial test used an invalid fixture event enum and failed schema validation; replacing it with the real `document_archived` enum corrected the fixture, not production behavior.

New tests verify concurrent distinct write intents admit exactly one expected revision, rejected input creates no write receipt/revision/event, expired notification tickets and deleted human identity refuse authority, another company's events/full records remain excluded, synchronous revocation tears down subscription once, and pre-cancelled streams never subscribe.

Existing tests additionally cover exact client/redirect/resource/S256; outsider refusal; wrong verifier without consumption; committed code and refresh replay revocation; token expiry; scope and foreign cursor refusal; idempotency collision and replay; cross-company write refusal; atomic revision/event paths; later cursor edits and archive tombstones; ticket capacity; real current head contents; response/body bounds; SSE consumer cancellation, late updates and idle expiry.

## Reviewed runtime boundaries

- Human consent calls public `oauth:approve`, whose internal `issue` mutation obtains current authenticated membership and company identity. Renderer-supplied identity is not trusted. Write authority also rechecks current member capability at mutation time.
- Exact issuer `https://www.companyos.sh`, client `hades-desktop-companyos-v1`, private redirect `ai.hades.desktop:/oauth/company-os`, resource `https://www.companyos.sh/api/plugins/v1`. No discovery-based authority expansion or arbitrary redirect is accepted.
- Convex HTTP `/oauth/token` performs code/refresh exchange. Replay returns an error value after grant revocation so the mutation commits revocation, rather than throwing and rolling it back.
- Fixed Next route proxies forward to configured HTTPS Convex site without redirects. `/api/plugins/v1/account`, `snapshot`, `changes`, `write`, and `records/[id]` expose scoped account/document data. Full records validate the revision's company and document identity and bound output to 1 MiB.
- Expected revision, write fingerprint and idempotency receipt share a Convex mutation with `appendRevision`. Receipt replay is scoped to grant; altered input conflicts. This relies on Convex's real transactional execution, exercised here through convex-test, not a deployed contention test.
- Event cursors are grant-bound and tenant-filtered, publish current document projections, and explicitly refuse excessive same-timestamp cursor state rather than silently skipping. Notifications are a bounded wake-up stream, not a durable replacement for explicit changes polling.
- `/api/plugins/v1/events` obtains a separate notification-only ticket and uses the public `oauth:watch` subscription. Tickets recheck token, grant, human, company and membership; stream lifetime is bounded to 45 seconds. Cancellation unsubscribes and closes the Convex client; token/ticket values are not intentionally logged.

## Remaining acceptance and limits

Real deployed schema/functions, exact issuer hosting, registered native callback, user consent, account projection, refresh/revocation, remote contention, SSE proxy hosting/reconnect behavior and native cancellation remain unverified. Source fixtures do not establish Keychain storage or Hades receiver correctness. Subscription expiry is enforced by stream timeout because wall-clock passage alone does not trigger a Convex subscription update. Data reads include branch/current-head contents but do not implement a full revision-history browsing API. Data indexing is metadata; full content is fetched explicitly. This is scoped document integration, not a complete enterprise IAM system.

## Exact reviewed source hashes

| Path relative to provider checkout | SHA-256 |
|---|---|
| `convex/oauth.ts` | `44151edb1b4b63ed166e7af50f9cccc448eee2554729b29c8419cb18fb3ad3aa` |
| `convex/oauthPolicy.ts` | `4d486efbae3b586e54140da773e89692af4edf4fa32d92d23ec8f905a306c7d4` |
| `convex/oauthHttp.ts` | `0ed0a9c8d5f263375e3707a64888e54d4b5cbdef7ab163ea3e650aa017790da9` |
| `convex/schema.ts` | `63b46e3ba8e06072fb7f9e1760ed6b917925699932b84ed090121e8b4dd10cf1` |
| `convex/http.ts` | `f28c14bfa313ad460a5c898bdbcd51ff568afd602232af44412a1ff42b1a8c55` |
| `lib/oauth-events.ts` | `1c249146faef94028e85421db7a38f6bd2ec3f61f4c3009a3097751d0573e523` |
| `lib/oauth-proxy.ts` | `7703eb464c73ac0939b05a42b822364c535aa9ad3e488f90b0289cb0e0a4388e` |
| `lib/oauth-body.ts` | `b4cb03feaa7286cf29b3030773d9a1b22d031944357065a98642609869cd7c6e` |
| `app/oauth/authorize/consent.tsx` | `f5e69e2a95383647d1af052ee297261662a89c3b2b92d86b2cce94ce9723e0a7` |
| `app/oauth/authorize/page.tsx` | `43b4d2b55710905a1e8f847e13dba0325f9806d73cf04f6182aac9edde3f4b4a` |
| `app/api/plugins/v1/events/route.ts` | `6da94de9eaf8cffde8fcd9c0be0af5b14d2d0bb5df1391578d419437a28a0bdd` |
| `app/api/plugins/v1/records/[id]/route.ts` | `78dc0d926c750f94bd57e52f1cf35e9d32ae92186cad36441c98817d89580d3e` |
| `convex/oauth-independent.test.ts` | `60e14a6ef352e09000c15a1057b236f5ff61e528df7ff0964b5b95d302fa10c7` |
