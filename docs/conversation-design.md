# Hades conversation design

Revision 1, 2026-09-12. Product refinement; desktop and browser. Resolved for implementation by self-review; visual acceptance pending independent review.

## Evidence and authority
The user authorizes implementation and GitHub publication. Existing desktop already includes chat-scoped Helm and Work tools, inline coding reviews and managed workspaces. Browser opens Tasks on first use and replaces its composer when viewing supporting objects. No installed-app acceptance is claimed. Preserve providers, permissions, existing tasks, reviews, files, browser spaces, integrations and recovery.

## Critical journeys
1. Describe a goal in chat; inspect discovered capabilities; start appropriate work; see progress and results here.
2. Type slash to discover commands, select a skill, set a goal, request coding or parallel work without configuration pages.
3. Inspect browser tasks, saved research and memory while keeping the same draft and conversation.
4. Delegate from an external local client, obtain a durable identifier, read progress, continue or cancel without repeating work.
5. Observe computer state, act on fresh targets, inspect results and stop immediately.

## Visual plan
Hierarchy: conversation content first, its composer second, task progress and contextual actions third. Permission failures take precedence only when they block the requested action. Supporting navigation stays quiet.
Composition: preserve existing transcript width and system typography. Put slash suggestions immediately above the composer, with commands and descriptions sharing aligned edges. Keep browser conversation mounted; supporting task/library/memory sections expand above it, with a close control. Existing native inspectors remain secondary review surfaces.
Material: existing neutral surfaces and semantic tokens; no new blur, gradients or illustrations. Borders separate a command list from transcript content. Color communicates selected action or failure.
Details: inherit system sans and current body roles; 14px suggestions, 12px descriptions, 8px internal gaps and 12px padding. Commands are full-width rows with visible focus and at least 40px targets. Escape dismisses, arrows select, Tab/Enter inserts; selection never sends a message. Long names wrap. Keep raw user command text in history.
Responsive: list uses composer width and bounded height, wraps descriptions at narrow widths. No horizontal scroll. Browser's narrow side panel keeps composer last and available. At enlarged text the list scrolls independently. No added keyboard animation; immediate selected/pressed feedback. No additional motion dependency is needed.
Alternatives: a dashboard adds route decisions and loses draft continuity; a split IDE is useful for code review but too dense as the default. A conversation with progressive disclosure matches the explicit product direction. Cost: long tasks need compact, expandable progress.

## Stage decisions
0 pass: scope and authority explicit.
1 pass: user-reported friction and source evidence agree.
2 conditional: operator feedback available; broader usability study absent.
3 pass: launch/inspect/continue without page changes is testable.
4 pass: one conversation is the selected direction.
5 pass: preserve capabilities; implement bounded vertical journeys.
6 pass: existing durable tasks supply recovery and cancellation.
7 pass: tasks and skills become conversation-owned objects.
8 pass: commands accelerate optional actions; plain language remains primary.
9 pass: commands describe outcomes, not internal setup.
10 pass: no coercion or concealed execution.
11 conditional: five visual decisions resolved; rendering pending.
12 pass: reuse current tokens and components.
13 conditional: keyboard, focus and narrow-layout checks pending.
14 pass: no credential or permission bypass.
15 conditional: error, reconnect and interrupted execution checks pending.
16 conditional: candidate build and direct inspection pending.
17 conditional: no release/premium claim until real journeys pass.

## Baseline
No numerical score: current screenshots and representative task evidence are insufficient. Primary source defects are missing composer command discovery and browser first-use routing away from conversation. Changes are source candidates until validated.

## Candidate verification update
See `conversation-verification.md` for tested behavior, fixture inspection, independent source review and remaining native/visual release gates. Conditional stages above are not silently promoted to acceptance.
