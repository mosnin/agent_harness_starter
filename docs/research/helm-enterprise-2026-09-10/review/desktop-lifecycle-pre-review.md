# Desktop request and shutdown pre-review

This is an independent read-only source challenge before the proposed dispatcher/shutdown repair. No test, listener, native process or provider operation was executed. The findings identify repair or regression targets; they are not a review of the later candidate. Root owns sidecar/Workbench wiring; integration owns the dispatcher module/tests. No implementation or test was edited here.

Inspected source snapshots:

| File | SHA-256 |
| --- | --- |
| `src/desktop/sidecar-entry.ts` | `958b0de784408db6522c84793cd479861b03c36f3cc5a04861931cccc2d83f0f` |
| `src/desktop/core/workbench-service.ts` | `b7db80b9f7ddd4a187ad4574f4d746a0fe8d85fc9a802155d650234d29e81b0d` |
| `src/desktop/ui/helm-orca.ts` | `47ec82fd5b6c83e4e08aa5dc6f5f8df5b134e3de6b9e26e130996d3c5b3f2d45` |
| `src-tauri/src/gui.rs` | `16ba9f0d6542ceb8e471acee85ea72dff15323d4e6700b80c8558106c3f76b48` |
| `src/desktop/core/native-lifetime.ts` | `3c74144d4d51f64685cd803f4ccbac2d78ef5bea345c84fe123d6d45d2708b64` |

## Concrete concerns

**Q01 — Control sits behind the work it must interrupt.** Sidecar lines 723–765 bypass a fixed method list but omit `helm.orca.stop/recover/read/refresh`, `work.stop`, `helm.cancel` and `helm.source.cancel`. A queued Orca Start awaits service startup/dispatch; a Stop behind it cannot reach the service's existing cancellation machinery until Start finishes. Other omitted revocation methods include `spatial.cancel`, `helm.code.close`, `browser.disconnect`, `team.disconnect`, `voice.stop` and `terminal.close`; review each actual contract rather than treating every read-looking method as harmless. `spatial.workflow` mixes start/replay with stop/cancel in its arguments, so blanket method classification needs care.

**Q02 — Bypassing does not cancel a Start that has not been admitted.** Hold unrelated request A, enqueue Start B, then submit Stop B. The UI allocates B's task UUID before its Start RPC (helm-orca UI lines 135–151), so this is reachable. The service creates B's durable intent only when the queued request executes. A bypass Stop before then cannot find its record; after A settles, B can still start. The dispatcher needs a scoped queued-admission cancellation mechanism or an equally explicit pending-stop result/continuation. Merely showing an error does not stop B. Matching must include task identity, project and profile; a wrong-scope Stop must not withdraw B.

**Q03 — EOF drops responses and leaves handlers outside caller lifetime.** Sidecar lines 758–766 skip queued work after `acceptingDesktopRequests=false` without a reply. Its finally block at 793–803 does not await desktopQueue or the `void workbench.handle` bypass requests. Main can release the data lock and invoke `process.exit` after `runSidecar` returns (lines 860 onward) while an admitted desktop handler/cleanup remains pending. Queued work should receive explicit closing cancellation without executing, and admitted handlers need tracked settlement. Do not wait for an uninterruptible handler before beginning revocation.

**Q04 — Unexpected handler failure poisons the queue.** The mutation chain has `.then(...).finally(...)` but no recovery catch. Normal dispatch errors are caught by Workbench.handle; however, a rejected handler (for example, its output callback throws while emitting the error response) leaves the tail rejected, causing later queued handlers to skip. The detached control call has no rejection observer. The repair should isolate handler and response-callback failures, preserve subsequent queue progress and avoid duplicate replies.

**S01 — Shutdown ignores asynchronous completion.** Workbench lines 2825–2827/2841 ignore promises from Code, Orca service and team close. The Orca service now intentionally awaits admitted DB work; Workbench's synchronous return discards that lifecycle guarantee. Setting `closed=true` and starting cleanup is not completion. Close should return one shared completion promise and sidecar must await it before releasing ownership or exiting.

**S02 — One synchronous cleanup failure skips later revocation.** Workbench sets closed at line 2819, then invokes closers sequentially without failure isolation. A failure in browser disconnect, work checkpoint, wake interruption or journal checkpoint can skip later controller aborts/process stops and make a repeated close return immediately. Invoke all revocations/closers even when one throws; observe both synchronous failures and rejected promises, and report incomplete cleanup rather than manufacturing success.

**S03 — Maintenance postponement currently returns early.** While the backup barrier is active, close only sets `closeAfterMaintenance=true` and returns. The snapshot later calls close from its finally block. A caller awaiting the current void return cannot know when the snapshot and subsequent cleanup finish. Keep new admission denied immediately; completion must remain pending through barrier release and cleanup. Avoid a dependency cycle where the snapshot finally awaits the same close promise that waits on the snapshot.

## Required negative cases for the repair

| Case | Meaningful oracle |
| --- | --- |
| Running deferred Start, then Stop/approval | Control handler starts before deferred mutation completes; ordinary mutations remain ordered. |
| Unrelated A running, Start B queued, scoped Stop B | B never reaches execution after A settles; B and Stop receive explicit truthful replies; another scope cannot cancel B. |
| Normal queue at its bound | Overflow gets one explicit response; the reserved control path remains usable and is itself bounded. |
| Held reads/control calls plus Stop | Capacity policy cannot let status/read traffic consume every reserved cancellation slot if responsiveness is claimed. |
| Handler throws/rejects, response sink throws | Later requests still run; no unhandled rejection and no duplicate success/error reply for one request. |
| EOF with one admitted mutation/control and queued work | Revocation begins promptly; queued work never executes; admitted callbacks settle before lifetime completion; closing responses are truthful. |
| Child close A throws, B rejects, C is held | Every independent closer/abort is invoked once; repeated close shares completion; failure is surfaced; completion waits for C. |
| Close during backup | Admission closes immediately, state stays available until backup settlement, then all cleanup finishes; no promise cycle. |
| Late turn/Orca receipt during shutdown | The owning service's persistence settles or retains uncertainty before its storage/lifetime ends; process termination is not reported from sending a signal alone. |

## Caller limits and counterevidence

The native bridge in `gui.rs:119–154` caps **all** pending response waiters at 256, then waits 65 seconds. That cap also rejects Stop/approval before they reach any sidecar bypass. Timeout removes the waiter without cancelling a queued/admitted operation; a later result may be discarded. A sidecar-only fixture cannot establish native control admission under saturation. The stdout reader does clear pending waiters on disconnect, so dropped replies are not necessarily permanent hangs.

`native-lifetime.ts:8–15` starts a two-second process-group termination deadline after EOF/parent loss. Main only clears it when runSidecar completes. An awaited JavaScript shutdown is still bounded by that native lifetime; this review does not execute or accept its real process behavior.

Workbench's emit wrapper at lines 243–268 records normal journal/activity events only while `!closed`. Therefore closing the journal before ordinary late emissions does not itself prove a post-close SQLite write failure. It does mean the current shutdown skips persisting those late terminal events, and active turns/MCP cleanup are not joined. The exact new shutdown contract must distinguish intentionally interrupted/unknown work from fully settled work. The retained source also shows some child services manage their own deferred DB close; do not replace those guarantees with an outer `void` or claim all children synchronously terminate.

Existing sidecar tests mainly cover legacy command framing/order. The schedule responsiveness test exercises a real local HTTP fixture and was not run in this restricted review. Use injected/deferred handlers and resource stubs for the new bounded dispatcher/shutdown regressions; real listeners/native/provider testing remains a separate authorized gate.
