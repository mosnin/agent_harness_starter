# Hades desktop integration program

Current scope: simplify the native Tauri UI; ChatGPT/Codex subscription and OpenRouter; an integrated IDE informed by Orca; Rakazo's persistent teammate/computer/integration workflows; human and agent team chat; Centaur-informed Slack agents; access to the complete Hades harness.

## Source identity and license

- Hades: mosnin/agent_harness_starter, branch claude/hermes-swarm-framework-vbhrot. Starting revision d578e99da6c1779508ed4dde2c171f2a580a2f63.
- Orca: stablyai/orca at bf4e2705046cf9ef9c915929a9646da85717af07, MIT, copyright Lovecast Inc. Fork created at https://github.com/mosnin/orca. Electron application with an embedded editor/worktree architecture; do not transplant its Electron process assumptions into Tauri.
- Rakazo: elie222/rakazo at 86ac54d1a12be427801c38705dcea010d55c5068, Apache-2.0. Persistent teammate platform using a shared authenticated service, worker queue and computer-provider adapters. External integrations still need their own credentials and applicable provider terms.
- Centaur: paradigmxyz/centaur at d3143c354ea4df79f40961d8b0fe1b910caee286, Apache-2.0 OR MIT. Independently implemented threaded Slack bridge; Kubernetes, iron-proxy and durable workflow services are not embedded. See [Slack integration](centaur-and-slack.md).
- Design OS: https://github.com/buildermethods/design-os. Not installed as a Codex plugin. Use explicit product sections and design tokens; preserve the existing native application.
- Codex: official @openai/codex runtime pinned to 0.145.0. App-server stdio API, managed ChatGPT authentication; protocol is version-specific and experimental. Hades owns its tool/approval loop.

## Acceptance gates

No capability is accepted based on a page, button, mock provider, build, or test count alone. Record implemented, contract-tested, native-exercised, and external-provider-verified separately.

1. Provider and UI foundation: consistent controls/spacing/type, no ornamental ASCII or marketing headings; API-key isolation; Codex login/status/cancel/logout/model list/stream/interrupt; OpenRouter catalog/auth/stream/cost/error behavior.
2. IDE: project-owned file tabs, syntax-aware editing, find/replace, selection-to-agent, save/checkpoint/restore, conflict protection, dirty-draft recovery, Git review/worktrees and PTY in the same application. No cross-project save after navigation.
3. Harness coverage: enumerate the actual CLI and service features, map dedicated desktop controls versus an integrated terminal command surface, and retain explicit mock/provider-gated behavior.
4. Teams: people and agents, persistent channels/history, membership/roles, invitations, authenticated cross-client delivery, reconnect, duplicate-send prevention, access revocation and explicit agent invocation. Local agent rooms alone do not meet human team-chat acceptance.
5. Persistent teammate/computer workflows: map every Rakazo README feature to Hades implementation or a stated remaining integration. Never equate opening the upstream app or a provider settings form with native integration.
6. Native QA and packaging: light/dark, keyboard, narrow/wide windows, real provider turn, file save/restore, terminal, restart, signed local bundle. Public release signing/notarization remains separate.

## Current environmental gates

The Mac is locked and the user is away from the desk. Continue code and automated tests; native visual QA must be performed after unlock. ChatGPT account sign-in and externally billed provider/computer/connector verification require a configured account. Do not substitute a fake success state.


## Feature map at this implementation checkpoint

This is a scope ledger, not a claim of full upstream parity.

| Source capability | Hades implementation / access | Remaining acceptance or implementation |
| --- | --- | --- |
| Subscription inference | Official Codex 0.145.0 app-server, managed login, status, catalog, text protocol, cancellation | Real runtime handshake observed; interactive ChatGPT sign-in and paid turn still require account verification |
| OpenRouter | Exact provider credential routing, model catalog and streaming cost | Local protocol tests; live account turn pending |
| Orca editor | CodeMirror tabs, syntax, undo, find/replace, save, SHA revision checks, draft recovery, selection to chat | Native visual/keyboard QA pending unlock |
| Orca Git/worktrees | Existing native Git review, worktree actions and integrated PTY; command catalog | Remote SSH worktrees, richer annotated diffs, multi-pane terminal layouts remain |
| Orca browser/design workflows | Existing preview/browser tools | Element annotation editing, Linear workflow and mobile continuation not ported |
| Rakazo persistent bots | Agent profiles with separate conversations, memory, routines, skills and history | Hosted multi-user bot execution not yet attached to the shared team server |
| Rakazo voice | Existing local speech and OpenAI-compatible dictation | Live voice calls, ElevenLabs and Cartesia adapters are not integrated into desktop |
| Rakazo team/private computers | Existing harness backend commands are reachable from Harness | Dedicated computer ownership UI, provisioned desktop streams and shared/private ACLs remain |
| Rakazo browser/terminal/files | Native editor, PTY, Git and preview plus harness browser command | Remote graphical desktop session management remains |
| Rakazo delegation | Existing local agent rooms and hierarchy/team commands | Durable cross-host peer delegation and hosted agent lifecycle remain |
| Rakazo BYO model credentials | Native Keychain profiles, Codex, OpenRouter, OpenAI, Anthropic and local | Pi runtime itself not embedded; live provider verification remains |
| Rakazo integrations | Existing desktop plugins/skills and stdio MCP with per-call approval | Remote MCP, Composio/Pipedream account linking, Treg and OpenAPI installation flows remain |
| Rakazo computer providers | Existing Hades backend commands include optional providers | Live Docker/E2B/Daytona/Box desktop provisioning parity not established; Docker unavailable here |
| Human and agent team chat | SQLite team service, authenticated members, invitations, channels, thread replies, read cursors, explicit agent turns, durable reply receipts | Two clients tested locally; cross-Mac HTTPS deployment, private channels and recovery UI remain |
| Centaur Slack conversations | Socket Mode, allowlists, per-thread history, progress/final replies, reconnect and durable inbox | Live Slack workspace installation and message verification pending |
| Centaur runtime | Existing Hades tools, profiles, approvals and harness commands | Kubernetes control plane, credential-injection proxy, API adapter and workflow engine not ported |
| Complete Hades command access | 34 canonical CLI families enumerated and checked against dispatcher; profile-aware terminal launch | A command launcher is not a dedicated UI for every subcommand or a configured external service |

The app is a native Tauri application. No Next.js dashboard was added. The Orca fork remains a reference fork; changes in this program are in the Hades repository.
