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

## Local models, rooms and extensions

**Local models** connects to an existing loopback Ollama runtime. Refresh the inventory, download a model by its library name, cancel a pull, remove a model, or create a profile from an installed model. The app requires Ollama's success event before marking a download installed. `--local` on the packaged Mac smoke test exercises an installed Qwen model without changing your profiles.

**Team rooms** combine two to eight profiles in roster order. Each prompt starts one round; each agent reads bounded previous replies and uses its own model, memory, tools and approvals. Open a contribution's conversation for the full transcript. Stop cancels the current member and prevents the next from starting. Rooms and completed replies survive restart.

**Extensions** accepts a local JSON manifest with `format: "hades-plugin-v1"`, `name`, `version`, optional `description`, `skills: [{name, content}]`, and `mcp: [{name, command, args}]`. Download a working skill-only example from Extensions. Review instructions and commands, install disabled, then enable deliberately. Skills guide future turns; MCP servers start during those turns and every tool call needs approval. Removal retains a copy under the profile's `removed-plugins` directory. This format is separate from the harness code-based plugin API and does not claim marketplace compatibility.

**Checkpoints** is in the command palette and Git review. Approved regular-file writes/appends/deletes and editor saves receive persistent before/after records. Restore only succeeds when the current file still matches the recorded result. Files over 2 MB, shell/MCP changes and external-process mutations are outside this journal. Interrupted edits require manual review.

**Appearance and shortcuts** imports VS Code JSON/JSONC UI colors and edits in-app bindings. Values must be hex colors; no theme scripts execute. Global Quick Entry keeps its existing fixed shortcut.
