# Independent durable Work to Orca review

Scope: source and in-process SQLite admission/recovery behavior. No packaged Orca runtime, provider call, native app, listener, network or dependency install. The reviewer owns only a new regression test and this report. Production repair is assigned to a different worker.

## Reproduced blocker

The frozen `claimReady` calls Orca preflight inside the shared admission transaction without a task-local failure boundary. An unavailable Orca sibling throws, rolls back the entire ready batch and terminates the plan loop. A ready independent Hades task is never dispatched. Initial reproduction: one failed, three passed in `work-orca-review.test.ts`; retained log `/tmp/work-orca-independent-red.log`.

Required fairness: record the unavailable task's actionable error without creating an attempt or reserving tokens; continue inspecting and admitting independent ready tasks. This must hold with Orca first at maxConcurrent 1 or 2, and with Hades first at maxConcurrent 2. Unavailable-task dependents must remain blocked; there is no provider fallback.

## Passing initial challenges

- Abort immediately after durable intent prevents service start. No fabricated stop receipt is allocated. A later resume with no service receipt refuses redispatch.
- Restored request identity belonging only to another profile cannot be recovered or stopped in the current scope.
- Restart retains the original unknown 1000-token reservation. A consumed round prevents reconciliation until maxRounds is explicitly increased. Authorized reconciliation reserves zero new tokens, recovers once, does not call start again and cannot complete the task.

The source uses real Work SQLite persistence. Engine service results are injected fixtures; they do not prove subprocess, provider, packaged runtime or native cancellation behavior. Existing Work UI source routes explicit engine selection into task creation, defaults to Hades, and discloses unknown usage and unchecked output. This is not visual or keyboard acceptance.

## Status

The implementation worker repaired the task-local preflight boundary. Independent rerun: **6/6 passed**, Vitest 4.1.5, `--maxWorkers=1`, 169 ms. The unavailable Orca task retains its actionable error, failed status, zero rounds, zero attempts and zero reservation; independent Hades work completes in all three order/capacity cases. Dependency/evidence/storage errors still propagate outside this narrow catch.

No further material defect was reproduced within this bounded review. This accepts source behavior only, not actual Orca/provider/runtime delivery, live stopping, worker ownership across an actual process kill, native UI or verified source integration. Broader author suites and full-project typechecking are reported by the implementation worker, separately from this six-case independent gate.

Final log: `/tmp/work-orca-independent-green.log`. Original red log is preserved. Reviewer changed only the new test and this report.

## Frozen hashes

| File | SHA-256 |
|---|---|
| `src/desktop/core/durable-work.ts` | `9f9411cde4bb2d7fc2a196c5689da3010cec64d4ff4427e031ef26d976fd58ac` |
| `src/desktop/core/work-orca.ts` | `587343d34a1c24ed5027de49d72d1d1b8e72be78f1625e4c659ed5d94fcdeb3c` |
| `src/desktop/core/workbench-service.ts` | `e505712167c4b2f562580e6465a58c3faa46c051ba7d8b5da7bf62c7c48cc5fe` |
| `src/desktop/ui/work-goals.ts` | `57fd0fce980528762ba99909eb44ff135979f9c867a06d62b207869b6e282ae4` |
| `src/desktop/__tests__/work-orca-review.test.ts` | `da6ef98d6555d5bff49c23d900042366e694b1fa348e39c8eb190e073e863394` |

Local evidence hashes:

- `/tmp/work-orca-independent-red.log`: `402e4c7c5c21d912f0a936ce211e7ac6986dd7efc59121dd028039ac398eace1`
- `/tmp/work-orca-independent-green.log`: `12cbf031ccef3c3216c82fcd0059431bbb33c2b1d107b429c33809aaf2a3c237`
