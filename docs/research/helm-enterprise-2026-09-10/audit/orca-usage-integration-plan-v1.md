# Actual Orca usage integration

Working branch: codex/helm-usage-receipts in /Users/preston/Documents/Codex/2026-09-06/orca-usage-integration, based on bf4e2705046cf9ef9c915929a9646da85717af07. Sparse checkout limits disk usage. The shipped Hades Orca pin remains unchanged until actual integration and build acceptance.

## Evidence and implementation sequence

1. Parse the pinned Claude result envelope into a strictly validated observation. The observed fixture in src/main/claude/claude-agent-sdk-contract-pins.test.ts contains result uuid, provider session_id, input/output usage and total_cost_usd. These fields do not prove whether the totals include previous turns, children, cache activity or all paid work. Preserve result scope and unknown aggregation; never declare provider enforcement from telemetry. The Codex thread/tokenUsage/updated method is present, but its transport data shape is not established by the retained typed source/fixtures. Historical scan estimates are not a substitute.
2. Capture observations at ClaudeStructuredSessionAdapter.emit only for the current acquisition, matching the active provider session. Host dispatch/turn identity must come from the adapter state rather than provider-controlled fields. A parser alone is not integrated runtime accounting.
3. Persist through the existing serialized, bounded event sink and journal ownership fence. AgentSessionJournal currently stores a versioned SQLite journal using synchronous FULL; openJournalDatabase refuses newer schema writes. Adding durable observation storage requires an explicit schema migration and the same read-only/fence checks. Do not put observations in the translator's temporary lifecycle status row: publishLifecycle removes that row on result. Do not add a visible status row or unknown render discriminant merely to store telemetry.
4. Bind observations to execution host, workspace, Orca session, acquisition fence, dispatch/turn and provider result UUID. A duplicate identical observation is idempotent; a conflicting report must retain a contradiction rather than overwrite or sum. Late acquisition observations must not debit a replacement. Provider aggregate scope stays unknown until proven.
5. Expose optional observations in workerShow using owning-host identity. Existing clients ignore optional JSON fields; new clients must handle absent support. No new stream opcode without capability negotiation. SSH loss remains unverifiable; never substitute client-side accounting for an unreachable execution host.
6. Hades must settle against the original Work dispatch attempt through a separate idempotent transition. Current zero-allocation reconciliation must not return cumulative usage as new attempt spend. Keep host reservations, observed totals and settled spend distinct. Unsupported mandatory provider caps must refuse before dispatch.

Required acceptance remains: parser negatives and scope evidence; duplicate/conflict/stale-fence persistence; crash/reopen; backpressure and failed persistence; matched owning-host projection; old/new-peer compatibility; Work original-attempt settlement; real provider samples; actual fork typecheck/build/runtime tests. Pure parser or injected journal tests cannot close provider or native gates.

## Parser checkpoint

Orca integration branch commit 32c15c732acd98d76a83511748f5227c7640a02a implements step 1 for Claude only. Eighteen isolated tests pass (13 author, 5 independently authored); strict standalone module typechecking passes. The tested files were byte-identical copies in a temporary test root using existing Hades test dependencies, with ORCA_BACKGROUND_LAUNCH=1. This is not a full Orca checkout typecheck/build or runtime test. The native build prerequisites remain missing. No provider caps or completed billing totals are claimed, and Hades still pins the previous accepted source foundation.

Verified SHA256 values:
- src/shared/provider-usage-observation.ts: 4e03f84a20cca0a0f3ea66c8c00c26f2d6a5817cc523b8516507a376a8c82afb
- src/shared/provider-usage-observation.test.ts: 3a42524bc9d266b955cf663c388beb9adb9a6810d225c1606f1c52851832b197
- src/shared/provider-usage-observation-review.test.ts: 553c7aaefe9ca2c7d33ef1ab31cdafb0a4f16a55834b3920911b799d29f3cb97

Retained test log: ../evidence/orca-usage-parser-v1/tests.rawlog. Next required implementation is fenced durable capture, then owning-host worker projection and idempotent settlement against the original Work attempt. The parser is currently not called by the runtime.
