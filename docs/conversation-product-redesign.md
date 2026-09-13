# Conversation product redesign

2026-09-12. User rejection reopens prior acceptance. Mode: product refinement, authorized implementation and installed-app update. Prior source improvements did not change the running bundle or eliminate the task-setup mental model.

## Product contract
The conversation owns the goal, context, team, coding runs, questions and results. Plain-language requests are sufficient. Hades plans tasks and chooses available execution tools. Coding engines are optional runtime adapters, never destinations the user must operate. A new conversation has one composer and no required project, task-ID, worker or plan form. Existing plans, checks, changes and recovery remain accessible as contextual activity. Model/provider sign-in and consequential action permissions stay explicit.

## Visual decision
Audience: the operator trying to get work done. First priority: “What would you like to get done?” and the composer. Second: outcome shortcuts (“Build or fix code”, “Research in the browser”, “Work with a team”) which insert instructions into that same composer. Third: conversation history, files and activity. Setup does not occupy the welcome state's primary actions. Use the existing Hades icon and neutral palette; upright system sans, 30px/500 heading, 15px body, 13px controls, 760px reading measure. Center the empty conversation vertically as one composition; place the composer immediately beneath the introduction. Active threads use the same composer anchored below transcript and task progress. Reduce sidebar competition and use 36px rows. Keep provider/model in the composer and Settings for configuration.

At narrow widths stack controls and retain the composer, readable text and bounded command list; support enlarged text without horizontal clipping. Use immediate focus/pressed feedback and native disclosure, no new animation. Preserve current theme and contrast tokens. All activity and inline review return focus to their triggering control; errors remain local and drafts survive navigation.

Compared directions: separate workspaces retain internal-engine complexity; a permanent IDE split overweights coding; conversation plus contextual results fits the user's explicit intent. Cost: detailed historical controls require opening activity, but starting work requires only a message. Resolved by self-review before implementation. Direct native inspection is required; no premium score claimed.

## Delivery and architecture
Core native packaging requires Hades, Node, Codex adapter, computer/terminal helpers and current UI. Bundled OpenCode/Orca engines are an explicit optional build feature with their existing provenance gates intact. Do not stage invalid optional engines. Keep installed-bundle rollback separate from user data. Preserve unrelated changes already present in the checkout.

## Gates and verification
Stages 0–10: pass for this explicit product contract, preserved authority, one conversation owner, legacy recovery and copy. 11–13: conditional until rendered hierarchy, keyboard and reflow inspection. 14: retain existing permissions. 15–17: conditional until current UI is built into the actual native candidate, launched, and exercised with real task execution. Baseline verdict: Needs work. Source tests alone do not close the task.

## Observed repair and acceptance (2026-09-12)

The actual running native app was replaced in place, preserving its original bundle at `dist-mac/rollback-20260912-conversation/Hades.app` and retaining user data. The new empty conversation, slash menu, restored completed thread, inline team plan and worker approvals were inspected in the native app. External Helm and Work destinations are removed from the primary workflow. Activity remains a contextual history inspector; New work inserts a team request in the composer. Browser/capture drafts remain consumable through the conversation and retain handoff provenance.

A configured Codex model, gpt-5.6-sol, performed the two-worker live test in conversation `f6f6c090-a401-480c-8f5a-69b9372d320d`, goal `acf8641f-8a65-47ce-bb5e-abf72cbff00f`. Both attempts started at 1789258440314 ms; each wrote its separate file after an inline approval. The parent used file reads to confirm ALPHA and BETA and reported completion in the original chat. Both stored file hashes matched independent reads. This proves this bounded native path, not unrestricted autonomy or all provider integrations.

The first live test exposed automatic budgets too small even for the first request (8530 estimated input plus 4096 output reserve). Delegation now defaults to 75000 tokens per task, capped at 300000 per plan; nonviable explicit budgets below 25000 per task fail before allocating workers. Existing plans are not silently expanded. Worker approvals are shown in the parent with validated session/root/goal lineage. Child sessions remain searchable but do not fill the recent-conversation list.

Validation: 2765 desktop tests passed in the full run, one was skipped, and two integration tests timed out under simultaneous native packaging. Both affected files passed on a bounded recheck (29 tests); no assertion failures remained. Final focused approval/UI checks: 10 passed. TypeScript and diff whitespace checks passed. Packaging flow checks: 19 passed. An independent source reviewer found three regressions (history scope, review without a selected session, and lost browser drafts); all were corrected and the follow-up review found no new blockers.

Design verdict: the rejected primary workflow is replaced and the bounded native journey is observed. Full accessibility/reflow testing and every upstream/optional-engine runtime are not certified. The candidate is a locally signed development build, not a notarized distribution release. Source includes pre-existing uncommitted Motion/external-conversation and work-state changes from another task; those changes were preserved and excluded from this repair commit.
