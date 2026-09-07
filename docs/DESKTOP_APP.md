# Hades for Mac

Hades now builds as a native Tauri application with its own Node runtime. It opens directly through Launch Services and runs without a development server or a separate Node installation.

## Build and run

Requirements for building: macOS, Xcode command-line tools, Node 22 or newer, and stable Rust.

```sh
npm ci --ignore-scripts
./script/build_and_run.sh
```

The app is written to `dist-mac/Hades.app`. The Codex Run action uses this same script. `--build-only` builds without launching; `--verify` also checks the launched process; `--logs` opens native log streaming. Rebuilding stops the previously built Hades app before replacing its executable.

```sh
./script/package_mac.sh
```

This produces a ZIP and DMG for the build machine's architecture in `dist-mac/`. They use ad-hoc signing for local use. Developer ID signing, notarization, and automatic updates remain distribution work; these artifacts are not a public signed release.

## First conversation

1. Open **Settings**, choose OpenAI, Anthropic, or a compatible local endpoint, and enter an available model ID. Provider keys are stored in macOS Keychain.
2. Open a project folder. The selected folder is the workspace for file tools and terminals.
3. Send a message. Text streams into the conversation; file writes, shell commands and MCP calls ask for approval. Stop cancels the active turn, including a pending approval.

Use the titlebar to open files, Git review, a real interactive terminal, a second session window or floating chat. The sidebar provides artifacts, memory, skills, routines and agent profiles. Quick Entry is opt-in in Settings and runs while Hades is open. Voice transcription needs microphone permission and a compatible speech provider; the transcript stays in the composer until sent.

## Data and architecture

The default data directory is `~/.hades`. Set `HADES_DATA_DIR` before launch to choose another directory. The default profile reads and writes the CLI's session and memory formats; additional profiles use `profiles/<id>`. Restart a surface after another process changes its store: simultaneous CLI/desktop file-store writers are not coordinated by a database lock.

- `src-tauri/src/gui.rs` owns the native windows, Keychain access, shortcuts and bundled child process.
- `src/desktop/ui/workbench.ts` is the chat-first WKWebView interface. It has no Node imports or remote script dependencies.
- `src/desktop/core/workbench-service.ts` connects desktop workflows to the existing agent loop, providers, workspace tools and stores.
- `src/desktop/sidecar-entry.ts` serves desktop requests and preserves the existing harness IPC services. The Command Center currently exposes service inspection; the original advanced command-line interfaces remain available.
- `scripts/macos-pty.c` provides the shell PTY; xterm.js renders it.
- The bundle includes `Resources/package.json` so Node does not search protected parent directories for package metadata on cold start.

Backend startup errors are written to `<data directory>/desktop-backend.log`. No API key is included in snapshots or profile exports. Shell and MCP processes run with the user's account permissions; workspace path checks are not an OS sandbox.

See [the Hermes capability comparison](HERMES_DESKTOP_PARITY.md), [design and logo provenance](HADES_DESIGN.md), and [local acceptance evidence](MAC_DESKTOP_ACCEPTANCE.md) for the exact implemented and verified scope.
