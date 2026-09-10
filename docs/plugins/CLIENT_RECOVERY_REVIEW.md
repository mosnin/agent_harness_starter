# Client recovery independent review

2026-09-10. Reviewer owns only new `src/desktop/__tests__/ecosystem-recovery.test.ts` and this receipt. Root authored all production repairs. Uncommitted source and isolated fixtures only; no sockets, native applications, live accounts or provider calls.

**Final result: 7/7 tests pass**, `/tmp/ecosystem-recovery-green.log`.

```sh
./node_modules/.bin/vitest run src/desktop/__tests__/ecosystem-recovery.test.ts --maxWorkers=1
```

A concrete initial red was reproduced: `boundedPluginJson` accepted an already-aborted request, invoked a resolving fixture transport and returned success for HTTP204. Root added abort checks before fetch, after headers and before final parsing, and cancellation of pending body readers. The regression now passes; `/tmp/ecosystem-recovery-red.log` retains initial evidence.

The seven tests establish:

- A feed reset discards revoked cached rows and resumes from the replacement snapshot checkpoint, skipping old feed pages; a subsequent concurrent update at the new cursor is retained.
- Inconsistent checkpoint values across snapshot pages reject the whole replacement and preserve saved records/cursor.
- An already-aborted JSON request makes no transport call, including the HTTP204 case.
- An active SSE reader is cancelled and drained by pause; paused tick does not reconnect; explicit resume reconnects; close clears reconnect timers and later resume/tick performs no work.
- HTTP401 on an active stream removes agent read/write grants and marks authorization failure.
- Cancellation aborts a pending JSON body reader rather than waiting for more bytes.
- A delayed HTTP401 acknowledgement after pause cannot revoke the still-valid saved grants or schedule a reconnect.

Tests use private temporary SQLite, injected fetch and ReadableStream fixtures. The concurrent-write scenario is a deterministic provider-feed response after the replacement snapshot, not a real remote writer. Timer assertions inspect the service-owned reconnect map and observed fetch counts; no native event-loop or long-running hosted reconnection claim is made.

Root's Workbench maintenance pause/drain/resume wiring was source-inspected, but this suite directly exercises the service and HTTP boundary rather than a full maintenance RPC or backup. Existing shared sync-job cancellation semantics, real transport implementations, live provider checkpoint correctness, packaged application behavior and actual maintenance workflow remain separate acceptance gates. No additional concrete blocker reproduced in this bounded recovery review.

## Candidate hashes

| File | SHA-256 |
|---|---|
| `src/desktop/core/ecosystem-service.ts` | `ba281ee38874e8f4e227a654d6e7396dd090606605370cf9c0f1fe48e342dff5` |
| `src/desktop/core/ecosystem-http.ts` | `e61d04f672899a9da5a1b4c9ea633d8092bea9caa5ba695c6f16ca89d1098c82` |
| `src/desktop/core/ecosystem-events.ts` | `656b2403b43c867181a3aec2c501d666e710f08a4a077481145fb36c338b266b` |
| `src/desktop/core/workbench-service.ts` | `329836c4599686807959c2a4dbd7577f7668adb087d7b0e822db145c62750d85` |
| `src/desktop/__tests__/ecosystem-recovery.test.ts` | `3175bae407f62fb0b542671eb717843353f11efc4348d9f3aee3247f0326891e` |
