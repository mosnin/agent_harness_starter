# Hades Mac desktop — implementation and acceptance

Research date: 2026-09-06. Primary reference: [Hermes Desktop documentation](https://hermes-agent.nousresearch.com/docs/user-guide/desktop/) and [official desktop product page](https://hermes-agent.nousresearch.com/desktop). Hermes is an actively changing product; this is a dated capability comparison, not a claim of complete parity.

The reference groups desktop work into conversations, projects, files and artifacts, terminals, Git and worktrees, profiles, memory, skills, routines, voice, floating windows, provider settings, extensions, messaging and remote connections. It also describes browser annotations, model downloads, OAuth accounts, theme imports, application updates and cloud services.

## Built in this branch

| Hades capability | Implementation | Acceptance boundary |
| --- | --- | --- |
| Native Mac application | Tauri/WKWebView with a bundled Node backend and PTY helper | Native build, light/dark screenshots and live local-model controls inspected on this Mac |
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
| Local model management | Ollama inventory, streamed downloads, cancellation, removal and profile selection | Existing runtime required; real Qwen inference verified on this Mac; download lifecycle tested against an HTTP fixture |
| Team rooms | Two to eight profiles, ordered rounds, shared context, independent sessions and inline approvals | HTTP integration verified; cancellation stops before the next member; no remote bot federation |
| Checkpoints | Before/after review and conflict-checked restore for approved file edits and editor saves | Per-file records, at most 2 MB; newer changes, symlinks and incomplete edits block restore; excludes shell/MCP changes |
| Extensions | Review/install/enable/disable/remove local Hades skill + MCP manifests; removed manifests retained | Disabled on install, commands visible before enabling; real MCP subprocess and approval tested; no arbitrary code plugin runtime or marketplace |
| Themes and shortcuts | VS Code JSON/JSONC UI colors; configurable in-app bindings with collision checks | UI colors only; no syntax themes or marketplace; global Quick Entry remains fixed |
| Existing harness | Fleet/gateway/learning/scheduler inspection in Command Center | Original service modules remain; advanced command-line surfaces still exist |

## Remaining Hermes differences

This build does **not** claim complete Hermes equivalence. Remaining features include remote multi-host desktop connections, messaging setup panels, provider OAuth, automatic local-runtime installation, remote bot federation, live browser DOM annotations/screenshots, whole-turn or shell checkpoint rollback, marketplace/theme syntax integration, global hotkey rebinding, localization, signed automatic updates, and vendor-operated cloud services. These require additional integrations and acceptance work; there are no simulated success controls for them.

## Running and packaging

`./script/build_and_run.sh` builds the UI and backend, compiles the Mac shell, creates `dist-mac/Hades.app`, ad-hoc signs it and opens it through Launch Services. `--build-only` omits launch; `--verify` checks the launched process; `--logs` streams native logs. The Codex Run action calls the same script.

Desktop state defaults to `~/.hades`; use `HADES_DATA_DIR` to choose another directory. The default profile uses the CLI's session and memory file formats. To use the same records from a project terminal, set `HADES_DATA_DIR="$HOME/.hades"`. Additional profiles use `~/.hades/profiles/<id>`.

Ad-hoc signing is for local use. Developer ID signing, notarization, public distribution and automatic updates are not established by a successful local build.

## Follow-up verification

The packaged backend completed a real `qwen3.5:latest` request against the already-installed Ollama runtime on this Mac, streamed the reply, and saved the two-message conversation. `node scripts/smoke-macos.mjs --local` reproduces this in an isolated temporary directory. It does not download a model or change the user's profiles.

Slow provider reads and queued Git work no longer hold approval replies, cancellation or terminal input behind them in the sidecar input loop. Native light/dark conversation screens, the installed Ollama inventory and the Team rooms empty state were captured after the Mac became accessible. Local model selection was exercised in the app. Full native interaction acceptance for every new feature remains separate from backend tests.

API references: [Ollama model API](https://github.com/ollama/ollama/blob/main/docs/api.md), [VS Code color theme format](https://code.visualstudio.com/api/extension-guides/color-theme).
