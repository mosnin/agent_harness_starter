# Native repair acceptance — September 7, 2026

Work remains on `claude/hermes-swarm-framework-vbhrot`. The native Tauri application and agent runtime are the product surfaces under test.

## Changes under acceptance

The repair adds durable execution journals, work objectives and delegation controls; native schedules and authenticated webhook handling; channel access and shell-hook controls; credential pool and maintenance operations; tool activity and terminal rendering fixes; and an explicit native connection to Hades Browser. Provider transport, typed tool input, approval parsing and bounded agent execution were repaired alongside those surfaces.

The Browser connection is explicit, loopback-only and bound to the selected agent profile and project. Its token is held by the native Keychain/RAM path, not persisted in ordinary connection settings or returned in status. Browser conversations create durable agent sessions. Mutations use normal approvals plus browser consent; disconnect, pause and cancellation do not replay uncertain effects. Exact approval IDs bind answers from the Browser to the pending Agent action. Model context receives compact workspace/tab metadata instead of theme and favicon payloads.

## Verified evidence

- Integrated current-source suite: 282 files, 3,767 tests passed. TypeScript check passed.
- Real Codex Sol multifile acceptance passed after a storage-related retry, including independent hidden checks. Mini completed a separately documented recovery run; it is not counted as a fresh first-pass success.
- Real webhook-to-Codex execution produced its checked file and retained its deduplication state across restart.
- Native parallel work produced two verified reports. Journal/artifact restoration and embedded terminal rendering were exercised.
- Native backup creation and checksum/schema verification passed for 11 files. Native staged restore remains a separate unexercised gate.
- Native Browser pairing, opening an isolated tab, page reading and a denied personal-space read were observed. Earlier failed form runs exposed scroll validation, approval placement and token-budget issues. Fresh real Codex Sol runs subsequently completed read/snapshot/type/click/read/answer with independent final page checks. One used scoped test-runner approvals and another used both approval buttons in the native Browser UI.

Receipts, original failures, recovery records and native screenshots are retained in the sibling `2026-09-07/hades-fix-verification` directory. Large model task tests use explicitly scoped local fixtures; passing them is evidence for those paths, not universal harness capability.

## Remaining gates

Hades Accessibility and Screen Recording permissions were not granted during this acceptance. No real native computer input is claimed. External Slack delivery, all provider combinations, complete competitor parity and unattended long-duration reliability are not established by the local suite. The app is ad-hoc signed for development, not Developer ID signed/notarized. No pull request or remote release is implied by this local acceptance record.

## September 8 scope and subscription acceptance

Codex inference no longer repeats tool descriptions already present in the base instructions; JSON argument schemas and action restrictions remain. Persistent-thread cumulative usage fallback now reports per-turn deltas, rejecting invalid backwards totals. Trusted `chat.send.toolAllowlist` filters the actual tool registry and model schema; scope persists across continuation and restart, cannot silently widen, and scoped tasks do not start unrelated MCP processes. The initial scoped execution interface deliberately rejects delegation/MCP scope until child propagation and MCP discovery contracts exist. Default unrestricted task behavior is unchanged.

Receipts retain per-inference usage, request byte counts, effective tools and budget reservations. The acceptance runner checks the live subscription model catalog, stores receipts outside temporary directories when configured, and records interrupted outcomes before bounded process cleanup. It confines every browser call to one local fixture tab and never permits shell/files or personal-page actions.

The earlier 60,000-token run completed six browser actions but stopped before verification; it remains failed. Under the explicit 100,000-token test cap, the scoped Sol run passed in approximately 48 seconds with 65,196 input tokens (39,296 cached) and 526 output tokens. A second run with native Browser approvals passed with 65,292 input (39,424 cached) and 542 output tokens. Monetary cost is unmeasured. This proves the bounded browser workflow, not economical completion of arbitrary long-running tasks. Full raw receipts: `live-browser-runs/hades-real-browser-EWJooP/receipt.json` and `hades-real-browser-Ls2w7Z/receipt.json` in the verification directory.

## Native filesystem permission recovery

A fresh native GUI read exposed a real macOS boundary: the ad-hoc rebuild no longer matched its existing Documents-folder TCC grant. The native Node open remained blocked and the old tool ignored Stop while awaiting it. TCC logs and a process sample confirm this original failure; it is not counted as successful file access.

Read/list/stat now have one 10-second deadline spanning jail resolution and filesystem stages, and the desktop Stop signal reaches the operation. Late results never advance to further reads; late handles are closed. A process-wide guard refuses additional reads while any abandoned syscall or cleanup remains pending, preventing repeated attempts from consuming more filesystem workers. The kernel syscall itself cannot be cancelled. Mutations retain their existing semantics; no timeout-induced write retry was introduced.

Independent review corrected concurrent cleanup tracking and a queued-close cancellation race. All 96 focused checks and TypeScript passed; the final integrated suite passed 3,767 tests. The rebuilt native app returned an actionable permission error after a 10,008ms read and became idle. The final bundle repeated the timeout path and passed native Stop during a blocked read. After restarting to release the old native syscall, the same public fixture in `/Users/preston/hades-native-qa` was read successfully through Codex Sol: one real file operation, correct reference/button labels, unchanged file and completed native conversation. Protected Documents access itself remains ungranted; stable signing and permission acceptance remain release requirements.

Persistent evidence: `native-agent-file-read-acceptance.json`, `native-file-timeout-journal.json`, `native-file-normal-journal.json`, `native-file-read-diagnosis.md`, and screenshots 09/10 in the sibling verification directory.
