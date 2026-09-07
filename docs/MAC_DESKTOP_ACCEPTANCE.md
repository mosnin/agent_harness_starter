# Mac desktop acceptance receipt

Date: 2026-09-06 (America/New_York). Repository: `mosnin/agent_harness_starter`. Branch: `claude/hermes-swarm-framework-vbhrot`. Starting revision: `5eb3692104067924688dc2e2f4196d5e0564943f`.

## Delivered locally

- `dist-mac/Hades.app`: native arm64 application, bundled Node backend, PTY helper and original icon.
- `dist-mac/Hades-mac-arm64.zip` and `dist-mac/Hades-mac-arm64.dmg`: local-use packages. The DMG was mounted read-only and contains `Hades.app`; the ZIP preserves the application bundle.
- `src/desktop/assets/hades-icon.png`: original logo artwork. Design choices and generation provenance are in `HADES_DESIGN.md`.

The app was built on Apple Silicon with macOS 26.5.2. It is ad-hoc signed with identifier `ai.hades.desktop`, not Developer ID signed or notarized. Other macOS versions and Intel hardware have not been exercised locally.

## Automated checks

| Check | Observed result |
| --- | --- |
| `npm run type-check` | Passed |
| Full Vitest suite | 510 files passed; 11,879 tests passed, one skipped |
| Default native Rust tests | 9 passed |
| Native GUI build | `cargo build --features gui` passed through the Mac build script |
| Packaged CLI and swarm smoke | Real localhost HTTP fixture; actual file edit, new-process session resume, missing-key failure, inline/process swarm and restored goals passed |
| Desktop workflow tests | Real Git initialization/staging/commit/deletion, file editing, memory/skill profile round trip, scheduled model run, path boundaries and tool approval/cancellation passed |
| Model streaming tests | Byte-split UTF-8/SSE, Anthropic usage/image format, truncated stream rejection, mid-stream errors and cancellation passed |
| Packaged Mac backend smoke | Bundled Node and PTY executed a real shell command, resized, and cleaned up descendants on both stdin EOF and SIGTERM |
| `codesign --verify --deep --strict` | Passed for the application and bundled executables |
| Sidecar/build follow-up checks | 8 tests passed after shutdown handling changes |

The packaged Mac smoke command is `node scripts/smoke-macos.mjs`; add `--signal` to check signal shutdown. It creates a temporary project, uses no provider credentials and does not change user data. Desktop Build CI runs both modes.

## Native UI evidence and limits

The actual application was opened through macOS Launch Services and inspected through accessibility and native window screenshots. Observed workflows included selecting a temporary project, configuring an explicitly labeled local test provider, streaming a file-assisted reply, displaying tool activity, previewing a file, and reopening the saved conversation after a cold launch. The native terminal executed `echo h` and displayed its result. Light and dark interface layouts and the original app mark were inspected.

Testing found and repaired three concrete native issues: Node package lookup escaping the app bundle on cold start, treating a WebKit resize notification as a fatal startup failure, and terminal initialization before its host was attached. A package metadata boundary now stays inside the bundle; the terminal uses a bundled PTY with explicit resize and shutdown handling.

The Mac locked during the final visual pass. Final visual acceptance after the last layout and native folder-dialog changes is **pending unlock**. Those final sources compile, and the packaged backend/PTY checks pass; that is not a substitute for checking the remaining native screens. Global Quick Entry, microphone permission/live transcription, paid-provider credentials, and all secondary panels have not received complete native end-to-end acceptance.

The HTTP fixtures prove transport, streaming, file execution and persistence. They do not prove a paid model's quality, an authenticated provider account, or superiority to Hermes. There is no claim of complete Hermes feature parity: see `HERMES_DESKTOP_PARITY.md` for the implemented surface and remaining integrations.

## Distribution boundary

No public release, notarization, auto-update service or production deployment is established here. GitHub CI status must be checked against the pushed revision separately from these local results. No pull request was opened.

## CI follow-up

The first pushed revision passed the native Mac application build, its packaged smoke checks, and the full Linux job. The full Mac job reported a five-second timeout in the real Git workflow and a throughput timing assertion while other tests competed for CPU. CI now runs the same soak and desktop workflow assertions in a separate serial step, after the remaining suite. The Git subprocess test has a bounded 20-second cold-start budget; the throughput threshold is unchanged. Five consecutive isolated local runs passed (19 tests each). No test is omitted by this split.

## Desktop continuation — 2026-09-06

Added local Ollama management, ordered team rooms, persistent file checkpoints, declarative skill/MCP extensions, VS Code UI color imports and configurable in-app shortcuts. Local correctness checks passed: 511 files, 11,889 passing tests and one skip (509-file parallel suite plus 23 isolated desktop/soak tests). The new plugin test starts a real MCP subprocess only after enable, then requires an approval before invoking it.

The bundled backend passed `node scripts/smoke-macos.mjs --local`: real installed `qwen3.5:latest`, streamed reply, persisted two-message conversation, real PTY input/resize and EOF cleanup. The SIGTERM mode also passed. This used a temporary data directory and did not change user profiles or download models.

The Mac later became accessible. Native screenshots now cover the light/dark conversation workspace, local model inventory and Team rooms empty state. The Local models → Use model action created a functioning Qwen profile, preserving the existing Hades profile. These observations do not establish every new native workflow, provider OAuth, remote hosts, messaging integrations, browser annotations, localization or signed updates.

Native provider follow-through: selecting `qwen3.5:latest` in Local models created a new local profile. Sending a short greeting in Hades produced a streamed “Hello! 👋” reply, persisted the conversation and returned the composer to its ready state. A native screenshot captured that completed reply. The existing OpenAI profile was preserved.

Native checkpoint follow-through: opened an isolated `/private/tmp/hades-native-gap-qa.*` project through the app, edited README.md in the file inspector, reviewed before/after contents, restored through the confirmation dialog, and verified the original bytes on disk. The pass exposed stale token counts on new chats and success messages using error styling; both were repaired. Dialog focus now starts in the first editable field, and projects have a Hide control.
