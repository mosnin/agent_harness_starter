# Orca budget and usage contract v1

Primary source: `/Users/preston/Documents/Codex/2026-09-06/orca-reference`, Git revision **bf4e2705046cf9ef9c915929a9646da85717af07**. All source paths below are relative to that repository. This is a source-contract inspection, not an executed provider capability test. No provider versions or supported flags beyond the inspected source are inferred.

| Boundary | Exact source and conclusion |
|---|---|
| Public dispatch | `src/main/runtime/rpc/methods/orchestration/worker/worker-start-schema.ts:11–35` has model, effort, timeoutMs and placement options. It has no maximum-token, spend or turn control. Adding guessed RPC properties cannot create enforcement. |
| Startup timeout | `src/main/runtime/rpc/methods/orchestration/worker/local-worker-start.ts:93–94,213–218` retains timeoutMs and uses it for terminal readiness. Structured sessions are ready upon attachment. This is not a task lifetime deadline. |
| Launch selection | `src/main/runtime/rpc/methods/orchestration/worker/worker-launch-preferences.ts:12–34,70–77` records requested/effective agent/model/effort; unsupported model selection is rejected. |
| Claude launch | `src/main/claude/claude-structured-launch-resolution.ts:29–59,80–122` builds SDK options and maps durable arguments to typed model/effort or extraArgs. No explicit per-dispatch budget translation is defined. User-configured CLI flags are not a verified budget contract. |
| Codex launch | `src/main/codex/codex-structured-launch-resolution.ts:59–67` launches configured arguments plus app-server. `src/main/codex/codex-structured-turn-start.ts:25–34` allowlists model/effort/approval/personality/service-tier overrides, with no token/spend/turn budget. |
| OpenCode | `src/shared/tui-agent-launch-command.ts:40–89` builds configured terminal arguments. OpenCode is absent from the catalog at `src/shared/agent-session-option-catalog.ts:31–41`; worker model overrides therefore fail the launch-preferences check. Omitting the model uses the configured default, not an asserted model choice. |
| Public observations | `src/main/runtime/rpc/methods/orchestration/worker/worker-control.ts:71–80` returns worker/terminal observations. `src/shared/orchestration-worker-output.ts:33–93` defines transcript/terminal pages without a normalized usage receipt. Terminal exit is neither usage settlement nor accepted output. |

Potential telemetry exists before translation, but is not currently a durable per-worker accounting contract. Claude successful result bookkeeping is suppressed at `src/main/claude/claude-structured-journal-translation.ts:276–292`. Codex tokenUsage notifications are classified as status chrome at `src/main/native-chat/agent-session-wire/provider-frame-disposition.ts:32`; the explicit test at `src/main/codex/codex-structured-journal-translation-streams.test.ts:302–325` expects these frames not to be journaled. Claude's status-line feed (`src/main/claude/statusline-script.ts:14–16`) concerns account rate limits; it is not a task token/spend receipt. No normalized OpenCode usage contract was found in the inspected worker/read path.

## Implemented host boundary versus remaining work

Hades host source now bounds observation waits with a deadline/cancellation lifetime, requests at most one Stop for an existing exact owned intent, and fences late replies. Offline injected held-call tests exercise start/recover/status, cancellation and late publication; they do not prove that an actual provider process terminates. Signal-less service operations may remain pending and are tracked for maintenance until settlement. Work reservations retain unknown usage, and replacement requires explicit new admission without refunding predecessor uncertainty. Unsupported OpenCode model selection is checked before Work admission. These are host policies and source-fixture results, not upstream provider enforcement.

The next additive fork boundary should:

1. Define a capability-negotiated structured usage receipt keyed to dispatch, runtime/process incarnation, provider session and turn. Record cumulative-versus-delta semantics, sequence, source, completeness and unknown fields; deduplicate across reconnects and reject stale identity. Extract structured accounting before translation suppression, not from terminal prose.
2. Define requested limits separately from supported/applied enforcement. Only advertise a provider-specific hard limit after checking its actual installed transport/version and proving rejection before launch when mandatory limits cannot be honored. No generic maxTokens field or prompt instruction should imply enforcement.
3. Keep host reserved, observed and settled usage separate. Missing terminal accounting, cancellation and lost acknowledgement retain uncertainty. A provider exit never accepts source output or refunds an unknown reservation.
4. Test duplicate/out-of-order telemetry, restart and incarnation changes, absent final usage, unsupported mandatory limits, and deadline/Stop uncertainty offline; subsequently validate the actual packaged daemon and installed provider transports through authorized runtime tests.

No upstream telemetry schema, provider hard-limit implementation or live enforcement acceptance was produced by this source slice. Existing Orca worker/worktree ownership remains the execution foundation; Hades supplies policy and review rather than a competing worker engine.

## Primary file hashes

| Source file | SHA-256 |
|---|---|
| worker-start-schema.ts (full path above) | 95a66fec8d1df1527c2ba1ff6d6f1a043141105c3e1d6b5d0f85fbdd91a05319 |
| local-worker-start.ts (full path above) | 13c9278ca7aec43960efef8b23f1849f8bb38a99f47c8de9b724fd9bbd992acc |
| src/shared/orchestration-worker-output.ts | 789903dea4b7ede492695d63964893c9a27ba12bb91b52e334e9f662863d780e |
| src/shared/agent-session-option-catalog.ts | 5f70bcd92353fbce4e742a19b35eab340ecfb5a4d9f73918431ea76ff4023956 |
| src/main/claude/claude-structured-journal-translation.ts | 1ae5b37bd12408f7573f3bf8c6316151f2052a02d6d9778efd7284e840f7cefe |
| src/main/codex/codex-structured-turn-start.ts | 13abfc899a736a268167027b3c2cee023d606916c8dd8df30b0aa107fdba5f52 |
