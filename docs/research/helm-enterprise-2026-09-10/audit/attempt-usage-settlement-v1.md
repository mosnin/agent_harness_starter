# Attempt usage settlement

A reproduced defect allowed a worker reporting more tokens than its allocated attempt budget to be recorded as completed. The new regression failed with completed instead of failed. Settlement now records the reported consumption, releases that attempt's reservation, and fails the attempt with an allocation-overrun error. Exact-allocation results remain valid. An overrun cannot release dependent work even when another task leaves room in the overall goal budget. This detects overrun after reporting; it is not a provider hard cap.

Validation: 53 tests across durable-work, work-orca, work-orca-deadline and work-orca-review pass, including three new allocation boundary cases. These use real disposable SQLite/files and injected worker reports, not live provider execution.

## Remaining provider contract

Read-only inspection of pinned Orca bf4e2705046cf9ef9c915929a9646da85717af07 found no per-task token/cost/turn cap in worker-start-schema.ts; startup timeout applies to readiness. Its worker output is transcript/terminal data, not normalized accounting. Claude result frames contain usage/cost fields but successful result bookkeeping is suppressed by claude-structured-journal-translation.ts. Codex thread/tokenUsage/updated events are deliberately unjournaled and parameters remain unknown. No authoritative OpenCode accounting projection was found in that worker path.

The remaining implementation needs validated provider observations persisted through the fenced journal, bound to worker/session/turn identity, with cumulative deduplication and an optional negotiated workerShow usage projection. Reserved allocation, observed consumption and settled consumption must remain distinct. Unsupported mandatory provider caps must be refused before dispatch; host timeouts and prompts cannot be described as provider enforcement. Current Work Orca execution deliberately retains unknown usage and its reservation.

Independent read-only review found no current compatibility blocker: Orca's NaN reconciliation follows the existing unknown-usage branch before this comparison. Future accounting must settle the original dispatch attempt idempotently; returning cumulative spend as a zero-allocation reconciliation result would double charge and falsely signal overrun. No live provider cap is claimed.
