# Native desktop integration verification — September 7, 2026

Repository: mosnin/agent_harness_starter. Branch: claude/hermes-swarm-framework-vbhrot. Baseline: d578e99da6c1779508ed4dde2c171f2a580a2f63. This receipt describes the implementation committed with this file.

## Locally verified

- TypeScript: `npm run type-check` passed.
- Full suite: 517 files passed; 11,912 tests passed; one existing test skipped. The Python sandbox process-count test now counts only its own worker's children, avoiding false failures from concurrent tests without weakening its no-spawn assertion.
- Native Rust: 10 tests passed, including renderer rejection of native credential methods and native response IDs.
- Native build: `script/build_and_run.sh --build-only` passed. App, bundled Node, PTY and Codex runtime passed ad-hoc signature verification.
- Packaged sidecar and PTY: EOF and SIGTERM shutdown, interactive terminal and resize passed in disposable workspaces.
- Real local provider: the packaged sidecar streamed and persisted a Qwen3.5 reply through Ollama. This is a backend execution receipt, not a native UI screenshot or ChatGPT/OpenRouter account test.
- Standalone team-server bundle: private owner credential file, two members, idempotent send, durable history after restart and SIGTERM shutdown passed.
- Slack: local Socket Mode fixtures exercise event acknowledgement after persistence, dedupe, allowlists, tenant boundaries, threading, restart, retryable message update, disconnect and reconnect. A real workbench/HTTP fixture test exercised a remotely requested file write, desktop approval, refusal and threaded reply.
- Codex: the official 0.145.0 executable's account/read and model/list handshake was exercised without logging in. Local protocol tests cover streamed notifications before turn/start returns, usage, concurrent threads, rejected native tools, auth destinations, failed turns, cancellation and close.
- OpenRouter: local transport tests cover exact credential selection, endpoint, streaming reported cost and missing pricing.
- Editor: actual CodeMirror with a DOM test environment verifies undo across tabs, project ownership, slow-read navigation races and stale recovery revision protection. Workbench disk tests verify save conflicts and binary rejection.
- Harness: the catalog is checked against all 34 canonical CLI command families. Real shell argv quoting is tested with command substitutions and metacharacters.

## Unverified or incomplete

The Mac remained locked during the current implementation. No new native screenshots, light/dark visual acceptance or keyboard walkthrough can be claimed for this revision. Previous screenshots are of an older revision.

ChatGPT sign-in, a live OpenRouter turn, Slack installation/message delivery and cross-Mac team HTTPS hosting remain unverified. No live Slack messages were sent. The app is ad-hoc signed and is not notarized.

The [feature map](desktop-program.md) records the remaining Orca, Rakazo and Centaur work. The native command catalog does not imply that every external provider is configured, that Centaur's infrastructure is included, or that Rakazo's computer/voice/integration features have all been ported.
