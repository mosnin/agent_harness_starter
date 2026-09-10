# Native ecosystem client review v2

2026-09-10. Independent source and fixture review of root-authored client changes. Reviewer modified only the two test files listed below and this receipt. All reviewed changes are uncommitted source; no native runtime, provider, listener or deployment acceptance is implied.

## Findings and repairs

1. **Cancelled SSE initial catch-up:** a fetch fixture resolving despite an already-aborted signal caused `streamPluginEvents` to invoke its initial catch-up callback. Reproduced red. Root added abort checks before transport, after headers with body cancellation, and before catch-up. New regression passes.
2. **Full-record tenant identity:** unlike sync, record retrieval did not compare current provider userinfo with the saved account. A fixture returning a foreign tenant still produced a full record labelled with the old tenant. Reproduced red. Root added current human/account and tenant validation before record adapter access, preserving post-await generation and agent permission fences. Regression passes.
3. **Corresponding write boundary:** source review identified the same stale identity possibility for new writes. Root added current identity validation before adapter dispatch, retaining durable receipt lookup before new effects. Added no-adapter-dispatch regression passes. Pre-effect refusal is distinguished from uncertain dispatched results.

Initial evidence `/tmp/ecosystem-v2-red.log` contains two production reds plus one fixture setup error: attempting to replace a live connection generation through store.save. The fixture now performs a real disconnect before new-generation insertion. Existing lost-ack fixtures were narrowed to fail specifically `/write`, so they continue exercising effect uncertainty after the new `/me` preflight rather than failing identity lookup.

## Final deterministic evidence

```sh
./node_modules/.bin/vitest run src/desktop/__tests__/ecosystem-events.test.ts src/desktop/__tests__/ecosystem-service.test.ts --maxWorkers=2
```

**2 files, 25/25 tests passed**, zero skipped, `/tmp/ecosystem-v2-green.log`. Uses injected fetch, ReadableStream and temporary SQLite only. No listening sockets, native GUI, vault request, or external provider calls.

The six SSE cases cover coalesced invalidation without payload authority, revocation priority, unavailable/oversized frames, pre-cancel refusal, origin rejection and cancellation of an active reader. The nineteen service cases include the original twelve security tests plus durable uncertain writes across disconnect/reconnect and database reopen, ordered multipage cursor draining, current-tenant record/write refusal, profile-scoped public DCR reuse, and permission removal while a full-record response is pending.

## Source boundary review

- `ecosystem-store.ts` retains write receipts when deleting connection credentials and cached records. Lookup correlates profile, plugin, request key and recorded account/tenant across connection generations. Reopened SQLite test confirms an unknown effect is not sent again.
- Receipt replay precedes new identity preflight. This preserves uncertainty even if reconnection changes token details. Generic local ledger does not prove a remote provider implements its own idempotency or expected-revision semantics.
- Cursor pages are merged sequentially in memory and committed together after complete drain and scope fences; errors preserve the previous snapshot/checkpoint.
- SSE events carry invalidation/revocation only. They cannot choose URLs, credentials, records or authority. Public DCR registration IDs are cached per profile/plugin; current catalog origins remain host-defined.
- Read-only native source inspection: `src-tauri/src/gui.rs` rejects renderer requests whose method begins `native.` or ID begins `native-`, and rejects generic key.set. `hades_ecosystem_unlock` obtains/generates the 32-byte Keychain secret in Rust, passes it to the sidecar and returns only a boolean. Generic Keychain credential access rejects `ecosystem-master`. Callback URLs enter the dedicated native sidecar path; the client validates pending callback state and provider identity.

## Remaining limits

Native vault/unlock and callback behavior was read, not executed. No account login, real SSE connection/reconnect, remote revision conflict, deployment, packaging or native UI claim is established. Provider-issued identities must themselves be trustworthy; separate provider reviews cover that boundary. These fixtures do not constitute comprehensive process-level concurrency or account-compromise testing. Root was editing other client/UI/catalog paths concurrently; hashes below scope this receipt to the inspected candidate rather than a final repository commit.

## Candidate SHA-256 hashes

| File | SHA-256 |
|---|---|
| `src/desktop/core/ecosystem-service.ts` | `4d425b91d407a910f7adb45cfc3bc52e865f910323cae4faec5e6f8e4541c451` |
| `src/desktop/core/ecosystem-store.ts` | `6f82bc972e0d045501255c452104132360ab7af045d0294d3b4b2761c1864493` |
| `src/desktop/core/ecosystem-events.ts` | `656b2403b43c867181a3aec2c501d666e710f08a4a077481145fb36c338b266b` |
| `src/desktop/core/ecosystem-types.ts` | `52f2171ba5a88771139c45dbf3a8d4e0a1a46d796af8c9053eaf27cb8f294432` |
| `src/desktop/core/ecosystem-tools.ts` | `b7f4df485e3da4301ef702171f59663c5ffbfee7cc5d9eee0a2f87d685609716` |
| `src-tauri/src/gui.rs` | `09ad1e32fd1362c893d6b92bf48767646649fca064fc5721e300383f66ed81bd` |
| `src/desktop/__tests__/ecosystem-events.test.ts` | `90c3af5576cda4e1ffe60ef1d039b99373d17bda2e434b976b343030ae0422a3` |
| `src/desktop/__tests__/ecosystem-service.test.ts` | `fc1d0d33aff8b41d3100c9966af88aa2e2cbf9b1bce7d6866c8948e605cda07a` |
