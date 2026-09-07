# Hades Mac desktop — implementation and acceptance

Research date: 2026-09-06. Primary reference: [Hermes Desktop documentation](https://hermes-agent.nousresearch.com/docs/user-guide/desktop/) and [official desktop product page](https://hermes-agent.nousresearch.com/desktop). Hermes is an actively changing product; this is a dated capability comparison, not a claim of complete parity.

The reference groups desktop work into conversations, projects, files and artifacts, terminals, Git and worktrees, profiles, memory, skills, routines, voice, floating windows, provider settings, extensions, messaging and remote connections. It also describes browser annotations, model downloads, OAuth accounts, theme imports, application updates and cloud services.

## Built in this branch

| Hades capability | Implementation | Acceptance boundary |
| --- | --- | --- |
| Native Mac application | Tauri/WKWebView with a bundled Node backend and PTY helper | Build and initial native GUI checks on this Mac; final visual pass pending unlock |
| Identity and appearance | Original red H/bracket logo, native app icon, system typography, light/dark/system, reduced motion, zoom | Reference inspired original mark, not a copied logo |
| Chat | Real HTTP streaming, tool activity, cancellation, write/shell/MCP approvals, history, queued prompts, transcript search, tabs | Scripted localhost provider exercises the real wire and file tool; paid providers need credentials |
| Models | OpenAI, Anthropic and compatible local/custom endpoints; provider catalog, profile default and conversation model override | Exact model ID must exist at the endpoint; catalog is fetched from the configured provider |
| Credentials | macOS Keychain; private supervisor pipe into backend memory | Keys are excluded from settings, snapshots and profile exports |
| Projects and files | Explicit folder selection, file tree, text editing, image previews, Finder/editor opening, text/image attachments | No automatic broad home-directory scan; PDF extraction is not implemented |
| Artifacts | Workspace writes and assistant links indexed with conversation references | Existing files can also be browsed directly |
| Terminal | Bundled forkpty host with xterm.js, tabs, input, resizing and scrollback | Shell runs as the signed-in user; no OS sandbox claim |
| Git | Status, diff, stage/unstage, commit, push confirmation, new branches and worktrees | No automatic push; no destructive revert button |
| Profiles | Independent stores and personas; export/import | Import disables process-launching MCP/shell settings until deliberately configured |
| Memory and skills | Durable memory CRUD, constellation/list view, local SKILL.md editing and attaching | The constellation is a navigation view, not evidence of semantic learning quality |
| Routines | Interval or five-field cron, timezone, pause, manual run, saved result sessions | App must stay open; closed-app scheduling and delivery integrations are separate |
| MCP | Explicit local stdio servers, real initialize/list/call, per-call approval, cancellation cleanup | Remote HTTP/SSE server transport and OAuth are not connected here |
| Voice | Record a clip, transcribe through a compatible speech endpoint, system read-aloud, stop | Microphone permission and live transcription require user/provider verification |
| Windows | Session windows, floating chat and opt-in global Quick Entry | Same local backend; Quick Entry preference persists; no automatic foreground-app/screen capture |
| Existing harness | Fleet/gateway/learning/scheduler inspection in Command Center | Original service modules remain; advanced command-line surfaces still exist |

## Remaining Hermes differences

This build does **not** claim complete Hermes equivalence. Remaining features include remote multi-host desktop connections, messaging setup panels, provider OAuth, managed local model downloads, multi-bot group rooms and handoffs, live browser DOM annotations/screenshots, checkpoint rollback, VS Code theme imports, plugin installation UI, rebindable shortcuts, localization, signed automatic updates, and vendor-operated cloud services. These require additional integrations and acceptance work; there are no simulated success controls for them.

## Running and packaging

`./script/build_and_run.sh` builds the UI and backend, compiles the Mac shell, creates `dist-mac/Hades.app`, ad-hoc signs it and opens it through Launch Services. `--build-only` omits launch; `--verify` checks the launched process; `--logs` streams native logs. The Codex Run action calls the same script.

Desktop state defaults to `~/.hades`; use `HADES_DATA_DIR` to choose another directory. The default profile uses the CLI's session and memory file formats. To use the same records from a project terminal, set `HADES_DATA_DIR="$HOME/.hades"`. Additional profiles use `~/.hades/profiles/<id>`.

Ad-hoc signing is for local use. Developer ID signing, notarization, public distribution and automatic updates are not established by a successful local build.
