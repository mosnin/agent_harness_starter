# Ecosystem security review — 2026-09-10

Independent bounded source and deterministic fixture review of root implementation. **Four reproduced defects remain open at this snapshot; 12 tests, 4 red / 8 green.** No services, sockets, real credentials, providers or native apps were used. Fixtures use HTTPS-shaped URLs intercepted by an in-process fetch function.

## Required repairs

1. **Refresh singleflight order:** `token()` reads persisted `refreshUncertain` before checking the live refresh promise. A second consumer during a healthy pending refresh is rejected as a lost rotation. Check the current generation's in-flight promise first; preserve durable uncertainty refusal when no live owner exists.
2. **Ordered feed semantics:** `sync()` collects every upsert before every delete. Delete then recreate the same ID in a batch incorrectly produces no record. Apply operations in exact feed order to an isolated map, then commit data/cursor atomically.
3. **Empty query:** `data({query:""})` rejects a cleared search field. Accept bounded empty/whitespace search as no filter while retaining type/size checks.
4. **Scope attenuation:** a refresh can reduce OAuth scopes to read-only, but `request(...,agentWrite=true)` checks only the local agentWrite toggle. It sends the write even though refreshed scopes lack required write grants. Check current agentRead/agentWrite and current provider write scopes after refresh, immediately before transport.

## Passing boundary evidence

- PKCE SHA256 challenge matches exchanged verifier; state unpredictable; wrong callback plugin/issuer rejected; accepted state is single-use; expiration refused.
- Credentials stored as authenticated ciphertext; copying ciphertext to another profile fails associated-data authentication. No native Keychain claim is made.
- Lost refresh acknowledgement remains uncertain and is not retried automatically.
- Tenant drift and incomplete change batches preserve old data/cursor; duplicate snapshot IDs refuse replacement.
- Disconnect fences late snapshot publication and deletes local data.
- Stable write keys retain unknown receipts; altered-input reuse refused; agent grant revocation before/during token refresh blocks writes.
- Exact allowed-origin checks prevent credential forwarding to lookalike domains; redirects/credentials/cache policies set; oversized declared JSON refused.

`src/desktop/__tests__/ecosystem-service.test.ts` retains all12 cases. Red evidence: `/tmp/ecosystem-review-red.log`, `/tmp/ecosystem-review-red-2.log`; current expanded run `/tmp/ecosystem-review-current.log`.

## Further limits

No seven-product authenticated journey, native credential store, OAuth browser callback, actual refresh rotation, write/idempotency provider contract or live change feed was tested. `hasMore` is currently rejected conservatively; complete paginated change consumption remains a capability gap rather than permission to advance the cursor. Multi-process write receipt admission is not proven by same-process fixtures. Account/provider adapters must independently enforce tenant scope and optimistic revision; generic core cannot establish correctness of an unreviewed endpoint. Hashes bind this source snapshot, not an enterprise-wide acceptance.

## Snapshot SHA-256

- `src/desktop/core/ecosystem-types.ts`: `965406b83851ea100ff4393a4e10f111213c50ce7b5d4643e0e5e9bf5c8bc0a7`
- `src/desktop/core/ecosystem-http.ts`: `b9dd2c999afcd40aab44b8295d9357e04e373f7059cfeaaba00929fba315ce73`
- `src/desktop/core/ecosystem-tools.ts`: `78b867ce1b4f952a3f32263e3978cdabfaf43e680547f59b100b3d4cf5c5ca6a`
- `src/desktop/core/ecosystem-service.ts`: `d3510ff0accc4ef2cc7b6ee3dbce7fd268cc15065f92a10e210cae3113c2ad1c`
- `src/desktop/core/ecosystem-store.ts`: `57b10fe92be30570ba4bcde3fe3d705e99c66d082df187ead2d93c4346baef19`
- `src/desktop/core/ecosystem-catalog.ts`: `e3d5a49b93d0f8f11d4f33a50460603eb0c574a5a6eb73e3fd5daa3b9d53ede6`
- `src/desktop/__tests__/ecosystem-service.test.ts`: `967999d91e77489234e5685ece71b2f733879b43c5af82704f737fb5059ef49c`
- `/tmp/ecosystem-review-current.log`: `1ebf1c1782cc68af8cb1c856fde3ae8ace1833f1e212f64cc4e37fa7f004c2b0`

## Repair verification

Root repaired all four reproduced defects. Independent rerun: **12/12 tests passed**, `/tmp/ecosystem-review-green.log`. Live refresh promise now precedes durable uncertainty check; changes apply sequentially to a merged map before atomic replacement/cursor commit; empty UI query is accepted; write transport rechecks refreshed token scopes and current read/write toggles. These exact fixture boundaries are accepted. Other limitations above remain, particularly live provider contracts, native vault/callbacks and paginated change feeds. No further broad security claim.

- `src/desktop/core/ecosystem-types.ts`: `965406b83851ea100ff4393a4e10f111213c50ce7b5d4643e0e5e9bf5c8bc0a7`
- `src/desktop/core/ecosystem-http.ts`: `b9dd2c999afcd40aab44b8295d9357e04e373f7059cfeaaba00929fba315ce73`
- `src/desktop/core/ecosystem-tools.ts`: `78b867ce1b4f952a3f32263e3978cdabfaf43e680547f59b100b3d4cf5c5ca6a`
- `src/desktop/core/ecosystem-service.ts`: `010e9a181ac85848c06cc10cd60133c747a6dcadc8b1e03b25f6d4ebe97dfc6d`
- `src/desktop/core/ecosystem-store.ts`: `57b10fe92be30570ba4bcde3fe3d705e99c66d082df187ead2d93c4346baef19`
- `src/desktop/core/ecosystem-catalog.ts`: `e3d5a49b93d0f8f11d4f33a50460603eb0c574a5a6eb73e3fd5daa3b9d53ede6`
- `src/desktop/__tests__/ecosystem-service.test.ts`: `967999d91e77489234e5685ece71b2f733879b43c5af82704f737fb5059ef49c`
- `/tmp/ecosystem-review-green.log`: `bb6d1fc4022a3331436bbbd57eaed48f2e9b8bbe782d8055ebcabff487810503`
