# Default Hades Work engine offline regression

The new `workbench-durable-work-offline.test.ts` preserves the two valuable source scenarios from the existing server-backed test without starting that server or modifying it. It mocks only WebhookService using the explicit offline-webhooks fixture and injects the private Workbench model-client factory with `vi.spyOn`. Model replies are selected by the actual requested profile/model and report explicit usage: 10 input tokens plus 5 output tokens per call.

**2/2 scenarios pass** using Vitest 4.1.5 and `--maxWorkers=1`, 896 ms. Four actual model-fixture calls across the dependent two-profile scenario account for exactly 60 tokens. No production regression was reproduced.

- Default Hades engine selection flows through actual Workbench dispatch, DurableWork, conversation runtime, approval store, file_ops effects and local SQLite. The first task cannot write before approval. The second profile starts only after the first task's checked artifact is complete, and receives dependency reports with checked artifact receipts. Each task retains its own output evidence; final goal checks retain both SHA-256 output receipts. Reopening Workbench preserves completed Work state and the saved conversation's successful file tool receipt. A foreign profile cannot retrieve the owning Work goal.
- Stopping a live Work approval cancels the default-engine task. Replying allow to the old approval afterward cannot create the file; the conversation finishes and the Work goal remains cancelled.

The initial fixture incorrectly used structuredClone on the entire ChatRequest, which includes a callback. This caused both initial failures before approval. Capturing message objects and request fields without cloning callback values repaired the fixture; no production edits were required. Original fixture-failure log is retained separately and is not a production defect claim.

No real provider, socket, listener, native app or dependency installation was used. This accepts the source default-engine path and real local effects only. Provider HTTP streaming, remote execution, live native permissions and Orca runtime behavior are not tested here. The existing listener-based test was neither run nor changed.

## Commands and evidence

```sh
./node_modules/.bin/vitest run src/desktop/__tests__/workbench-durable-work-offline.test.ts --maxWorkers=1
./node_modules/.bin/tsc --noEmit --incremental false
```

The final full TypeScript check passes with no output. Whitespace checks pass. Retained logs: `/tmp/work-default-engine-offline.log` (fixture-only failure), `/tmp/work-default-engine-offline-final.log` (2/2 pass), `/tmp/work-default-engine-offline-types-final.log` (typecheck).

## Frozen hashes

| File | SHA-256 |
|---|---|
| `src/desktop/__tests__/workbench-durable-work-offline.test.ts` | `bd4061ed975feb0258be49876b0fb19ed56a6577b1c6d4e3566f2a6ed4740870` |
| `src/desktop/core/workbench-service.ts` | `e505712167c4b2f562580e6465a58c3faa46c051ba7d8b5da7bf62c7c48cc5fe` |
| `src/desktop/core/durable-work.ts` | `9f9411cde4bb2d7fc2a196c5689da3010cec64d4ff4427e031ef26d976fd58ac` |
| `src/desktop/__tests__/fixtures/offline-webhooks.ts` | `2f3647e9820e7b276b31acd06002f5532bb1dc37ae9da78051702cb19174615c` |
