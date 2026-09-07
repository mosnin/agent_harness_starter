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
  The desktop exposes Stop run and the run's conversation. History is available
  over `job.runs`; a full history/recovery interface remains outstanding.
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
guessed token savings. Targeted archive/loop regressions pass; comprehensive
real-model acceptance after that correction remains outstanding.

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
last live attempt predates the final budget correction; its failure remains
recorded. Codex and OpenRouter live task completion remain separate gates.
