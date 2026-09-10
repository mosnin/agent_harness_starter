# Hades delivery and acceptance status

Updated 2026-09-07. Repository: `mosnin/agent_harness_starter`; branch:
`claude/hermes-swarm-framework-vbhrot`. This document tracks the continuing
desktop/harness request. A component being present or a unit test passing is not
full product, provider or competitor-parity acceptance.

## Runtime foundations in this change

- Federation signing, verification and admission preserve wire order while
  nested application requests remain asynchronous. Regression tests cover
  delayed signing/verification and nested calls; the previous implementation
  fails the ordering regressions.
- Native routines enter a SQLite WAL inbox before schedule advancement. Claims
  have an owner, fence and expiring lease; competing workers cannot claim the
  same routine/profile concurrently. Cancellation defeats stale completion.
  A crashed/closed worker leaves an interrupted run for inspection, not an
  automatic replay of potentially completed effects.
- Routine status reflects actual agent completion/failure and approval waits.
  The desktop exposes Stop run and the run's conversation. The native run-history panel shows the latest 100 runs and links to their
  conversations. Routine editing and removal are available; interrupted-run
  reconciliation and resumable recovery remain outstanding.
- Empty model replies, provider truncation, step exhaustion and context overflow
  surface as incomplete runs. Invalid file arguments are rejected before
  approval; missing write content cannot silently truncate a file.
- Known Ollama serving windows come from the loaded instance, not advertised
  model capacity. Request budgeting reserves output and anchors estimates to
  measured provider usage. It is conservative estimation, not exact tokenization.
- Older large settled tool exchanges can be archived to private, content-addressed
  files before removal from the working prompt. `context_read` recalls exact
  paginated evidence without replay. User/system messages, failed tools and the
  latest three exchanges remain exact. Archive corruption/failure stops recall
  or compaction. The original turn is retained separately on completion/error.
  This is not semantic summarization, a resumable tool journal, or proof of net
  token-cost savings. History can still exceed the remaining budget.

## Desktop findings

Actual native inspection found stale file state after switching projects and a
synchronous folder read that could stall the sidecar. Project switching now
clears scoped state and ignores stale list/Git/terminal results. Directory
enumeration is asynchronous with a bounded failure message. Other filesystem
operations and macOS protected-folder access still require broader verification.

The native app opened a disposable project and its CodeMirror editor. Markdown
and plain text now wrap. Screenshots were emitted from the actual Hades window.
Terminal commands execute. During automated inspection WebKit reported the page
as hidden and its animation-frame renderer did not repaint until a view change.
Temporary diagnostics and an unproven repaint workaround were removed. Foreground
terminal visual acceptance remains separate from the verified PTY command path.

## Comprehensive agent acceptance

`scripts/verify-agent-tasks.mjs` runs the packaged sidecar with an actual local
model in an isolated workspace. It asks for a multi-file expense-ledger repair,
independent hidden checks, a sidecar restart, a dependent CSV enhancement and a
denied write. Hidden failures may prompt two bounded repair turns; every attempt
is retained. These are real tests, not fixture-model responses.

The installed Qwen model initially served a 4,096-token context despite a much
larger advertised maximum. That caused truncation. A task-owned Ollama process
with a verified 32,768-token serving window removed that configuration issue.
The twenty-step run then exhausted its step limit. An eighty-step run stopped
after 26 tool calls at the conservative context budget. Neither passed task
acceptance. The first archive-backed run stopped after 21 tool calls and 696,790 ms. It
exposed a false overflow: after archival, the guard reset measured provider
usage to a whole-prompt byte estimate. The corrected guard retains measured
usage and conservatively charges replacement/new messages without subtracting
guessed token savings. Targeted archive/loop regressions pass. The real local-model run at
`e5638e7f967461d5562e4b91a8d2d27f36339f8d` then exceeded its twenty-minute
limit. It eventually passed the project-visible ledger tests, but did not
complete the task or reach independent hidden checks, restart, CSV enhancement
or denied-write acceptance. That is a failed comprehensive run.

All failed evidence is retained under `/tmp/hades-agent-acceptance-*`. This path
is local temporary evidence, not a durable release asset. The native app build
and source tests do not prove Codex/OpenRouter provider acceptance. Official
Codex reports an existing ChatGPT login, but Hades uses a separate scoped
authentication home; that integration still needs its own live sign-in/test.

## Remaining integrated outcomes

| Workstream | Required next acceptance |
| --- | --- |
| Long work | Durable run/tool-effect journal, persistent approvals and steering, crash reconciliation, resumable continuation, bounded spend/time, real forced-crash acceptance. |
| Mastra | Pin/test stable optional adapter; configure real recovery leases and storage; test repeated tool effects and cancellation. Python workers remain optional. |
| Team agents | Agent membership, peer-message lineage, durable wake triggers, dedupe/conflict rules, hop/concurrency limits, dependent two-agent work with checked artifacts. Existing human Team chat/rooms are not full Rakazo parity. |
| Schedules/hooks | Unify routine/CLI/Slack/peer/webhook admission with authenticated triggers and acknowledgement after durable storage; test downtime/catch-up and duplicate deliveries. |
| Provider tools | Native structured function-call transport, large argument repair, Codex subscription and OpenRouter live acceptance, provider-switch/context fidelity. |
| Context | Exact/provider token counting where available, validated rolling summaries, memory retrieval, cache-cost accounting and quality measurements. LLMLingua remains an optional experiment. |
| Browser/computer use | Stagehand adapter with explicit owned/borrowed browser lifecycle; separate native OS computer-use permissions and end-to-end tests. A browser adapter does not establish OS automation. |
| Harness in desktop | One effective-capability registry and exercised native access to CLI/swarm features. IDE/editor presence does not establish full Orca parity. |
| Product quality | Verify foreground terminal repaint; inspect all native surfaces in light/dark, compact/large text, keyboard/VoiceOver, reconnect and protected-folder workflows. |
| Release | Exact commit build, current signature/archive/CI receipts and provider/runtime acceptance. Earlier ZIPs are historical artifacts. |

The source comparison and licensing constraints are in
[the research report](harness-research-20260907.md). Full Hermes superiority,
Grok/ChatGPT/Cowork parity and all requested integrations are not established.

## Verification receipts for this change

The final full suite passed **523 test files / 11,954 tests**, with one
pre-existing skip, and TypeScript type checking passed. Earlier ENOSPC failures
and their successful isolated retries remain retained. The final run includes
context-budget calibration, archive recall, routine ownership/cancellation,
federation ordering and project-state regressions. Native build/ad-hoc signature
checks passed during this change; a separate verified bundle is built with
`HADES_APP_OUTPUT` to avoid stopping the user's current application.

Live comprehensive local-model acceptance still has no successful receipt. The
last live attempt includes the final budget correction and failed its twenty-minute
limit; its evidence remains recorded. Codex and OpenRouter live task completion remain separate gates.

## Native redesign and management continuation

The next source checkpoint follows the user's dark Codex workspace reference:
compact navigation, a quiet system-font hierarchy, one stroke-icon family,
restrained composer and a toggleable task-details card. Hades remains a native
Tauri application. Tools & connections groups the existing skills, memory,
local models, extensions, Slack, rooms, artifacts and command library with the
new Computer control, MCP and Activity pages. Sidebar projects and form drafts
survive background updates. Toolbar icons match their destination. A custom
routine schedule reveals cron/time-zone fields only when selected.

The new dedicated Conversations page searches full saved message text with
source/status filters, pagination, rename, export and archive/restore. Search
currently scans stored messages, so scale acceptance remains open. System reads
actual macOS/CPU/memory/disk/app-uptime values. Activity persists allowlisted run
metadata and reported token counts; it is not a raw log viewer, exact spend
accounting or historical backfill. Structured MCP forms preserve arguments and
explicitly inspect a configured server's real tool declarations. These tools
start only on inspection or enabled agent turns.

Computer control has a bundled macOS 14+ accessibility/screen-capture bridge,
foreground observations, image transport, AX actions, typing, keys, coordinate
click/scroll and observed-app focus. Access starts off. Every input action uses
the desktop approval path and a one-use, turn-owned observation; stale app,
window, focused-field and AX element references fail closed. Actions invalidate
other turns' observations, overlapping bridge operations are refused, and Stop
aborts pending requests. Unknown action outcomes are never replayed. Coordinate
input still cannot prove that every same-window pixel/control is unchanged.
Drag, clipboard, multiple mouse buttons and full browser lifecycle are separate
gaps. Only the latest screenshot enters model context, even with archival; the
local conversation receipt retains originals. Image budgeting is a conservative
planning allowance rather than exact provider tokenization.

Native dark screenshots and accessibility inspection covered chat, Tools &
connections, Conversations, System, Computer control and the routine editor.
The enable/Stop controls changed visible native state correctly. Accessibility
and Screen Recording permissions remain **not granted**; no live capture/input
acceptance is claimed. The helper builds for macOS 14.0 and was bundled with
successful deep/strict ad-hoc signature verification. The earlier foreground
terminal and comprehensive model acceptance gaps still apply.

The broader source suite passed 526 files / 11,966 tests, with one existing skip.
Subsequent focused computer-control and workbench checks cover the final small
UI/concurrency edits; exact final packaging receipts are recorded separately.

### Reference extraction and remaining parity

[The durable capability inventory](reference-capabilities-20260907.json) retains
33 Hermes dashboard families and 94 Chat On Steroids families with pinned source
references, limitations and portability decisions. The latter covers all 140
production text modules (79 full static reads, 61 partial), not exhaustive branch
semantics or upstream execution. It is an inventory, not 127 integrated features.

Still missing from native Hermes management are generic channels/pairing,
signed webhook subscriptions, consented shell hooks, credential rotation pools,
full log/analytics controls, gateway lifecycle and maintenance/backup interfaces.
The screenshot reference governs presentation; placeholder buttons do not count
as these integrations. Existing Slack/team paths are distinct from a generic
messaging gateway.

For goal/plan/loop/child orchestration, retain the actual native authorized
`WorkbenchService.turn -> ConversationalAgent -> AgentLoop` path. Extract its
runner for real children before exposing orchestration UI. The default inline
swarm can use a demo executor, goal cancellation does not currently propagate
into in-flight worker execution, and state hydration is not active resumption.
Durable child inboxes, wake admission, effect receipts, bounded budgets and crash
reconciliation therefore remain required before long-work parity can be claimed.
