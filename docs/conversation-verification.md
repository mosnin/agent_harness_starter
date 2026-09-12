# Conversation integration verification — 2026-09-12

## Implemented source
Hades: command discovery, profile skill selection, persistent conversation goals, owned team inbox/resume, post-action computer observation, bundled Ponytail/ECC/HumanLayer material, optional context-mode/computer-use adapters, and a narrow persistent local delegation API/plugin.
Browser: Conversation default, persistent composer across supporting views, return to transcript on send, agent-owned tab suspension protection, and the local browser-delegation plugin.

## Evidence
- Hades desktop suite: 2,748 passed, 6 failed, 1 skipped (2,755 total). All six failures reproduced in an isolated archive of the unchanged baseline `43fdf5cd1a1c51e3baea3f85e1232102f249fefa`. They concern four maintenance backup-schema tests, the shutdown interruption-history test, and the clean-but-unpinned Helm release test. This is not a green full suite.
- Updated tests cover durable retry receipts including capacity, partial cancellation/status failures, conversation ownership, scoped skill-reference reads, worker inbox identity, parent-only resume, skill command preservation and fresh computer observations.
- Hades TypeScript, desktop UI bundle and sidecar bundle pass.
- Browser conversation/workspace component tests: 30 pass. Tab lifecycle tests: 8 pass. Browser typecheck and production build pass.
- Both local plugin manifests pass the plugin validator. Stdio smoke verifies initialize, four tools, and recovery after a non-object JSON-RPC message. Live host installation and provider execution are not covered.
- Rendered desktop fixture at 1280x720: slash suggestions appear above the existing composer; arrow/Enter inserts `/skill ` without sending. This uses mocked desktop RPC, not an installed native app. Narrow layouts and real account flows remain unverified.
- Independent read-only source review checked ownership, retry/cancellation, skill-reference bounds, resume scope and browser composer continuity. Its capacity-retry finding was fixed with a regression test. It is not independent visual acceptance.

## Remaining release gates
The installed applications were not replaced. Validate the packaged native app with a real provider, two collaborating agents, an actual authorized browser task, code review/commit, computer permissions and interruption/restart. Existing full-suite failures remain explicit release debt. The plugins require a local compatible host; they do not replace the host's built-in browser or connect cloud-only ChatGPT to localhost.

context-mode and open-computer-use manifests require separately installed runtimes. Parent chat can retrieve context for Helm; scoped Helm children do not launch arbitrary MCP services. Fortress, QM and BrowserSkill are evaluated architectural options rather than embedded runtimes. No Helium GPL patch was copied. See the pinned upstream research report for decisions and source evidence.

## Continuation: reliability and native browser inspection
The six baseline failures are now fixed. Full desktop suite: **2,755 passed, 0 failed, 1 skipped** (2,756 tests). The additional regression verifies that staging an audited Work goal appends an import transition with the new snapshot hash, and rejects an altered trigger even when its name matches a canonical trigger. Legacy backup tables acquire the revision column in the isolated staging directory. Cancelled turns now persist interruption state through shutdown. The Helm release guard rejects unpinned source before invoking Bun. TypeScript and desktop/sidecar builds pass. Independent read-only source review found no blocker in these changes.

A production-built Electron browser candidate ran with an isolated user-data directory. Direct inspection found duplicate setup panels in Tasks. The revised embedded view shows one setup panel, collapses the manual form under “Advanced task setup”, and retains the chat draft and composer. Native screenshot/AX inspection confirmed the corrected view; component tests verify the disclosure and single setup panel. The full AgentPanel/AgentWorkspace checks remain 30 passing; browser build and typecheck pass. This was a disconnected browser profile, with no provider task or new page-access grants.

Native Hades packaging remains blocked: `dist/helm-orca` is absent; the pinned local Orca source exists but lacks locked build/native dependencies; the existing Helm assets contain old, incomplete provenance; Bun is not on PATH. Approximately 1.4 GiB disk space was available at preflight. No installed bundle was replaced and no packaging gate was bypassed. Resolving the runtime build prerequisites and exercising the packaged multi-agent/browser/provider path remain release gates.
