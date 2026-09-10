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

## Durable storage checkpoint

Commit ac0eec403184139707d0350df613e925e0c7f241 adds schema-v3 usage storage, serialized journal writes and deferred sink admission. Duplicate observations are idempotent; contradictory payloads are retained. Usage cannot create authority: a durable published journal fence is required, including for fence zero. Independent read-only review found and then verified the correction to the empty-journal edge. No new rendered item or wire opcode is introduced.

38 focused tests across six files pass, including real disposable SQLite migration/reopen and actual journal/sink integration. Targeted strict typechecking passes. Tests use Node 24 and existing Hades tooling with installed Zod 4.4.2; Orca's pinned Zod 4.5.4 and full dependency suite remain unavailable. This is source evidence, not native or provider acceptance. Test log and isolated configurations are retained under evidence/orca-usage-storage-v1.

Provider adapter capture, owning-host worker projection, original-attempt settlement and long-run performance remain pending. The Hades shipping pin remains unchanged.

## Capture and local projection checkpoint

Orca commit 7d9a98ec352cc464b9fb695cb69f508c1a260f9c includes actual Claude acquisition/dispatch/emit capture and the local workerShow usage field (projection commit 96a7cf3f). It registers correlation before send and accepts only explicitly matched result user_message_uuid. Up to 64 dispatch correlations are retained. Legacy/unmatched/evicted results are diagnosed unknown, never assigned to the currently active turn. First valid result freezes usage turn identity so later replay cannot change duplicate/conflict identity. Sink admission means queued, not persisted.

Independent review found a higher-fence retryUnknown publication defect. A real SQLite+performSend+event-sink regression reproduced it: the synchronous result failed the lifecycle barrier with unpublished journal authority. Retry now republishes the existing unknown dispatch state at the current fence before sending. Stale publication fails before any provider dispatch, and retry preserves one submission.

The optional local workerShow usage field is exact-worker/local/session gated. Its available state means the journal could be read; an empty page does not establish zero usage or capture completeness. Original native clientMessageId (observation.identity.dispatchId) stays separate from the outer orchestration dispatch ID. Observation runtimeId is the journal execution host ID, not the orchestration runtime restart epoch. Conflicts and truncation are retained; totals and settled spend are not derived. Remote/federated responses do not yet expose this field and must be treated as unsupported.

53 source tests across nine files pass, including seven capture tests with the actual adapter and an injected fake provider connection, SQLite persistence/reopen and the retry red/green regression. Process transport and probes are explicitly prohibited in capture fixtures. Targeted strict checking of parser, storage, sink, capture module and projection passes using installed Hades tooling/dependencies. Extending the typecheck to the turn dependency graph reports missing sparse observability/providers modules and node-pty. Full pinned fork typecheck/build, actual RPC host execution and live provider samples are not accepted. Independent read-only review found no remaining blocker in the reviewed capture, retry and projection corrections. Evidence and source hashes: evidence/orca-usage-capture-v1.

Remaining: owning-host remote projection; durable treatment of uncorrelated provider telemetry; validated provider scope/cost semantics; original Work attempt settlement without double charging; supported mandatory provider caps; full fork/native build and real-provider acceptance. The Hades shipped Orca pin remains bf4e270; this integration branch is not yet shipped.

## Hades receiving-side retention

Hades 7c9025408fc2ddebc7be5ddd4bec31d5688bb2f0 validates the optional usage projection before retaining observations. It recomputes Orca canonical hashes, bounds pages and identifiers, rejects private/unknown fields, and distinguishes unsupported, unavailable, malformed, mismatched and available journal evidence. Session ownership is derived from dispatch.processIncarnation, not the usage payload. Worker dispatch/runtime/base, run, exactness, local execution host, assignee handle, provider and previously pinned session must agree.

Validated rows and the intent revision update share one SQLite transaction. Identical rows are idempotent; contradictory reports are retained and flagged even when first seen in different polls. Later unavailable/malformed polls cannot erase retained evidence. Original raw usage is removed from generic worker receipts. The profile/project-scoped retained reader is exposed through helm.orca.usage and the conversation-owned helm_orca_usage tool, with bounded local pages and post-read cancellation guards. No totals, settled charges or released Work reservations are derived.

67 tests across six Hades files pass, including restart retention, invalid authority, cross-profile refusal, duplicate/conflict retention, stale concurrent poll rollback, bounded retained pagination and tool ownership. Full Hades tsc --noEmit passes; provider-bundled sidecar and team-server source builds pass. Two additional cross-repo tests use the actual Orca parser, SQLite storage and local worker projection at 7d9a98ec to create contradictory observation JSON that Hades decodes with matching hashes. These are in-process source tests with injected RPC transport, not native/live-provider acceptance. Independent source review found no blocker in the scoped changes. Evidence: evidence/hades-orca-usage-retention-v1.

Next gap: Orca workerShow exposes only the first 100 observations. Hades nextOffset pages retained local evidence only; it cannot fetch upstream observations beyond that first page yet. lastRead.truncated remains visible. Retained offsets are not frozen snapshots across concurrent inserts. Upstream stable pagination, remote owning-host projection, uncorrelated telemetry retention, verified accounting semantics and original-attempt settlement remain required. The actual shipped Orca pin is unchanged.
