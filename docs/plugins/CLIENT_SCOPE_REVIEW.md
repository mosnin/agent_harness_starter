# Independent client scope review — 2026-09-10

Scope: current uncommitted Hades capability, catalog, service and SQLite store changes. Reviewer authored only `src/desktop/__tests__/ecosystem-scopes-review.test.ts` and this receipt. Production changes were made by the parent. All tests use injected in-process fetch responses, actual service/capability code and disposable SQLite storage. No listeners, native UI, credentials, provider calls or remote mutation.

## Finding and repair

The independent test reproduced a write-ledger classification defect: after successful identity preflight, the agent-write toggle could be removed before the adapter called POST. The request fence prevented all effectful fetches, but `dispatched = true` had already been set when entering the adapter, producing an `unknown` receipt. The same condition applied to scope narrowing before POST.

The parent moved the marker to the actual fetch boundary, after origin and pre-abort validation, for non-GET/HEAD write requests. Both no-effect cases now return `rejected`. A separate lost-acknowledgement test confirms an attempted POST still produces retained `unknown` and is not replayed. This repair does not make uncertain remote effects safe to retry.

## Independent acceptance evidence

```sh
./node_modules/.bin/vitest run src/desktop/__tests__/ecosystem-scopes-review.test.ts --maxWorkers=1
```

Final: **1 file, 9/9 tests passed**, `/tmp/ecosystem-scopes-independent-final.log`, 168 ms reported duration.

- Agent-write toggle removal after identity preflight prevents POST and retains a rejected receipt.
- Token refresh narrowing after identity preflight prevents POST and retains a rejected receipt.
- A pre-aborted write performs no fetch and is rejected.
- A dispatched POST with lost acknowledgement stays unknown; the same key does not dispatch again.
- Snapshot pages spanning a scope-narrowing refresh cannot publish a mixed projection; prior fields and cursor are cleared, with recoverable `stale` state.
- An initial refresh that clears the old cursor uses a fresh snapshot rather than the old change feed.
- A full-record response cannot cross a scope-narrowing refresh.
- A retained successful write keeps its status and suppresses its old result payload without repeating the effect.
- Actual Govern catalog permits legacy rename, requires metadata scope for agent updates and extra configuration scope for provider fields. A separately declared optional collection-read scope is filtered from capability disclosure when absent.

Source inspection confirms the reduced token, empty projection and cleared cursor are committed in one store transaction. Every effect request rechecks current generation and agent permissions after token acquisition. Record and sync completion compare scope fingerprints before returning or committing old-scope data. These statements describe this candidate, not a hosted grant-revocation guarantee; remote permission changes become locally visible only through the service's responses/refresh contract.

## Reviewed candidate hashes

| File | SHA-256 |
|---|---|
| `src/desktop/core/ecosystem-capabilities.ts` | `1aa0b9e1405633c316559593905ebcf3099e58e453795102a847e631d416decb` |
| `src/desktop/core/ecosystem-service.ts` | `43dc24f83e140836bd3950221911e5b696932c2c15d212ae9c30c0794355c1ea` |
| `src/desktop/core/ecosystem-store.ts` | `12e1bd552af976744c0377a5a1b58c00e1c7ca88de3cfacd8ed9f85fccdd61c7` |
| `src/desktop/core/ecosystem-catalog.ts` | `6cec2cae986565905a30ba28647ea0504227010b5c32c4070178e462ed353aeb` |
| `src/desktop/__tests__/ecosystem-scopes-review.test.ts` | `ba461721f64613920d432f44559c4f5fa261ebead693649d002828fdb8c6e2c4` |

No further concrete blocker reproduced in this bounded review. Full application regression, visual permission disclosure, deployed provider scopes, and native OAuth remain separate gates. These tests do not simulate multi-process store writers or prove every provider's field projection.

## Follow-up: explicit connection access

The later connection-access candidate was reviewed separately; earlier hashes remain historical. Three new independent cases verify that an invalid access value preserves the existing connection and credentials without fetch; omitted OAuth token scope inherits the actual read-only request rather than the full catalog; and an explicitly overgranted token is refused before userinfo lookup or account attachment. The expanded suite passed **12/12**, `/tmp/ecosystem-access-independent.log` (180 ms).

Source trace confirms UI `connectionAccess` defaults to `read`, selector changes update it, Connect sends it as `access`, and Workbench forwards it as the service's third argument. Service validation precedes disconnect. Requested scopes are filtered from the source allowlist, retained on the pending state, and passed explicitly into callback token validation. Old programmatic callers that omit access still default to `write` for compatibility: the read-only default applies to the new UI path, not every API caller. Source inspection is not native or rendered UI acceptance. No additional defect reproduced.

| Follow-up source | SHA-256 |
|---|---|
| `src/desktop/core/ecosystem-service.ts` | `01037f70ac51e9ad97f3323c808fd427ff93aab30b191753ab39747f5bd603c2` |
| `src/desktop/core/workbench-service.ts` | `891ac44d4cb72e897a99b5ffd52eca8357b002a8d8f727fa4171a5ce9ca56f88` |
| `src/desktop/ui/ecosystem-plugins.ts` | `e3e8e885ec773322affca3fccf81cc265191f5c93fd228af9f39f7fad3bdd19f` |
| `src/desktop/__tests__/ecosystem-scopes-review.test.ts` | `e665d66b1ba3e19eaf0a49ceb6f60fbc6467166c353f7baafe758a7e75923590` |
