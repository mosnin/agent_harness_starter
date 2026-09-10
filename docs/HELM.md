# Helm — coding inside Hades

Helm is Hades' native coding workspace, built around an actual
[OpenCode fork](https://github.com/mosnin/opencode/tree/helm-integration).
Open **Helm** in the desktop sidebar. **Code** opens the fork's full coding
interface and engine inside Hades. **Tasks & context** adds delegation to local
coding CLIs, isolated tasks, explicit checks and reusable project knowledge.
The existing Hades conversation, editor, terminal and work-plan tools remain.

## Code with the OpenCode fork

Choose a project, then **Open coding workspace**. This uses OpenCode's actual
sessions, model picker, plan/build agents, permissions, changes and terminal.
Code works directly in the chosen project; its file changes are visible there.
Use **Tasks & context** for separately allocated jobs in isolated worktrees.

Coding prompts preserve literal dashes and quotes; automatic native text
replacement is disabled within Hades without changing system preferences.

The runtime and UI are built from the pinned fork. Hades serves the local UI
and owns an authenticated loopback connection; it never substitutes the hosted
OpenCode app or a stock installed CLI for this Code workspace. The packaged
binary must match its provenance manifest. The frame has no general Tauri API;
external links use a narrow host relay validated against its source and origin.

Each project/profile has a private OpenCode store. Existing OpenCode account
credentials are imported once when that store is first created. Subsequent
login, refresh and disconnect changes remain authoritative in that private
store and do not rewrite the original CLI account file. The local address is
reused across restarts when available; a port collision chooses a new address
without attaching to the other listener. Drafts, attachment blobs, tabs and
preferences use OpenCode's storage adapters backed by the private project store,
so WebKit's temporary embedded browser storage cannot erase them on app quit.
Saved gateway credentials are omitted and fresh startup credentials take precedence.
The store has a 64 MB quota, 4,096 entries, and bounded individual writes. Startup
cleanup reclaims unreferenced draft blobs after validating all records; malformed
records suppress cleanup. Writes are serialized within the owning sidecar, with
private file permissions and atomic replacement. Concurrent app instances and
sudden power-loss durability are not guaranteed.
Authentication rotates on every launch. Saved project context
is copied into the runtime when it opens; close and reopen after editing notes
to capture a fresh snapshot. Reviewed outcomes are still saved explicitly.

Up to four coding runtimes can be open. **Close coding workspace** stops its
local server and owned process group; normal session Stop remains available inside
OpenCode. Close coding workspaces before running a Hades backup or restore.


## Run and review

In **Tasks & context**:

1. Choose a project with at least one commit. Helm starts a detached worktree at
   the current local HEAD. Uncommitted and untracked source changes are excluded
   and shown in the task's preparation notes.
2. Choose **Hades**, **Codex**, **Claude Code**, **Gemini CLI**, **OpenCode**, or
   **Grok Build**. Installed means the executable was found, not that its account
   or chosen model is ready. Setup links explain the provider's own login flow.
3. Set an optional model override, time allocation, checks and saved context.
   Checks are an executable plus a JSON argument array, for example `npm` and
   `["test"]`. Shell expansion is not applied. Commands run with the user's
   normal local process privileges in the task directory.
4. Watch output, Stop, or open the task's Hades conversation when a built-in
   action needs approval. Process errors, timeouts, cancellation and interrupted
   runs remain in task history.
5. Review **Changes** and **Checks**. Successful agent exit means **Needs review**.
   **Verified** means the explicit commands passed and the observed Git diff did
   not change during verification. It does not mean merged, deployed, or that
   every requirement is correct. A changed diff invalidates the recorded result.
6. Open the task files or terminal to continue reviewing. **Use task again**
   creates a draft for a new task; it does not replay an interrupted command.
   Helm does not automatically commit, merge, push or delete worktrees.

## Local agents and account configuration

Each external agent runs as an actual local CLI process. Its model may use its
configured cloud provider. There is no separate Helm subscription or hosted
execution service.

| Agent | Invocation | Account boundary |
| --- | --- | --- |
| Hades | Existing Hades agent loop with only project tools | Selected Hades profile and its normal approvals |
| Codex | `codex exec`, JSON events, workspace-write sandbox | Hades-managed Codex home uses the same ChatGPT/keyring settings as Hades; standalone configuration is preserved when no managed home is supplied |
| Claude Code | Print mode, structured result, edit permission mode | Existing Claude CLI login |
| Gemini CLI | Prompt mode, structured result, auto-edit mode | Existing Gemini CLI installation/login |
| OpenCode | Structured run with explicit `--dir` | Existing OpenCode provider; per-task model override supported |
| Grok Build | Single task, structured result, workspace sandbox | Existing Grok login or configured API key |

Helm never adds skip-permission or YOLO flags. These CLIs have different
permission models; a Git worktree alone is not an operating-system sandbox.
OpenCode's task invocation denies external-directory access and disables auto
updates, LSP downloads and auto sharing. All child processes receive an explicit
cwd, PWD and INIT_CWD. Provider errors remain failures even with exit code zero.
Windows does not have the Unix process-group watchdog guarantee described below.

Executable discovery checks PATH plus standard local CLI directories. Native
packaging supplies the signed Codex runtime. Host configuration can override
`HADES_HELM_<AGENT>_BIN`; agent tool arguments cannot choose executables or env.
Provider login and installation are explicit user setup actions, not automatic
background changes. Tokens and monetary costs are not uniformly measured by all
adapters; the enforced common allocation is elapsed time, not a dollar limit.

## Hades delegation and project context

Hades conversations receive `helm_agents`, `helm_context`, `helm_delegate`,
`helm_status`, `helm_wait`, `helm_changes`, and `helm_cancel`. Delegation goes
through the existing approval UI and binds the caller's project, profile and
session. Delegated tasks can also choose a supported model without changing
the CLI's global configuration. A conversation can reserve up to four tasks and 60 cumulative minutes.
Model arguments cannot change those identities. Browser-only tasks cannot gain
Helm access, and built-in Helm children cannot recursively delegate.

Project context is a local hierarchy of decisions, constraints, notes and
reviewed outcomes. A task copies selected notes and their ancestors into a
snapshot with a content hash. Later edits do not alter a running task. Context
is partitioned by canonical project path; edits carry revision checks. An
outcome enters context only after the user chooses **Save reviewed outcome**.

## Execution and evidence boundaries

- Run identity and allocation are stored before process dispatch. Restart marks
  unfinished runs interrupted; it never automatically resends their prompts.
- Up to four jobs run concurrently. Git worktree creation is serialized by
  canonical Git common directory, including different roots in one repository.
- The task's total deadline spans preparation, execution and automatic checks.
  Later explicit verification receives its own bounded allocation.
- Git hooks and fsmonitor commands are disabled for Helm-managed Git calls.
- Worktree directory identity and its `.git` metadata are checked before host
  file review/verification. Source checkout changes are not silently overwritten.
- On Unix, cancellation terminates the process group; a watchdog monitors its
  parent pipe and PID, including a dead parent retained as a zombie. Tests include
  a resistant descendant, server self-exit and actual host SIGKILL. This does not
  promise remote provider-side job cancellation or custody of commands that
  deliberately detach into another operating-system session.
- Verification hashes tracked diffs and bounded untracked files, and reports
  display truncation. Ignored build/dependency content is not a full machine
  snapshot. Tests may still be incomplete or weak; humans review the changes.
- Context is bounded to 256 nodes/project and 64 KB/task; retained runs are
  bounded to 500 with bounded output. Reaching a bound fails visibly.

## Source decisions

[Cradle](https://github.com/wibus-wee/cradle-app) informed the unified session and
review experience. [First Tree](https://github.com/first-tree-ai/first-tree)
informed explicit project context and the reviewed-outcome loop.
[Orca](https://github.com/stablyai/orca) informed isolated coding workspaces and
provider-capability distinctions. This implementation extends Hades directly;
none of those three reference projects' source or assets were copied. The
OpenCode interface and engine are built from the actual fork, with its MIT
license included in the native bundle.

The existing `mosnin/orca` GitHub fork was confirmed during implementation.
Pinned source review and real-provider/native acceptance receipts accompany the
local delivery report; a supported adapter is separate from a verified account.

## Build the fork and Hades

The fork integration starts from OpenCode `v1.18.21`, upstream commit
`826d9ad46a22bef0294998e08daa3c4904fea28f`. The build manifest records the exact
fork commit, whether it was dirty, and the packaged runtime hash. Keep the
fork's upstream remote and review later updates against that base.

Use Bun 1.3.14 and the fork lockfile. In the fork checkout, install the app and
runtime dependencies:

```sh
bun install --filter '@opencode-ai/app' --ignore-scripts --frozen-lockfile
bun install --filter './packages/opencode' --ignore-scripts --frozen-lockfile
```

From this Hades checkout:

```sh
HADES_BUN=/path/to/bun npm run helm:build -- --source /path/to/opencode-fork
npm run desktop:mac
```

The build compiles upstream `packages/app` and `packages/opencode`, retains the
MIT license, omits duplicate embedded UI/source maps, and packages local assets
in `Resources/helm-ui`. The native build signs the runtime and records its
resulting hash before signing Hades. These commands do not publish a release.

On macOS, Hades still needs OS access to protected project folders. A native
Git preparation timeout now points to folder access instead of reporting it as
an agent failure. A successful CLI test launched from another application does
not establish Hades' own OS permission state.

### Orca installed runtime packaging

Both native packaging paths now require a verified `dist/helm-orca` tree and place it at `Contents/Resources/helm-orca`, beside the bundled Node executable. This matches the default runtime resolver; no development checkout path or environment override is needed. Missing artifacts fail before native compilation instead of silently producing an Orca-less application.

Build prerequisites remain separate: `HELM_ORCA_SOURCE=/path/to/pinned/orca node scripts/build-helm-orca.mjs --check` currently refuses this checkout because its locked `node_modules/esbuild/package.json` is absent. That check does not install dependencies or establish runtime readiness. After provisioning the exact pinned build dependencies, explicitly build with `--build`, then run `node scripts/package-helm-orca.mjs --check`. The supported source revision remains `bf4e2705046cf9ef9c915929a9646da85717af07`.

`package-helm-orca.mjs` checks pin, platform/architecture, entrypoints, complete file inventory, SHA-256 and path/symlink confinement. Local app staging copies into a new sibling, revalidates source and staged tree, then replaces the prior tree; validation failures preserve the prior output and stale files are not merged. A process crash between directory renames may leave the `.helm-orca-prior-*` backup for manual inspection; this is not a crash-atomic app updater.

Do not re-sign native files after generating the trusted build manifest or silently regenerate hashes to bless changed bytes. Native dependencies for a signed release must have their final signatures before manifest creation. The local packager verifies the installed Orca tree again after signing the outer application. Tauri mapping supplies the same tree; signed Tauri distribution still requires final resource-integrity verification and actual native dependency loading acceptance. No native build, signing, provider, or daemon execution was performed for this packaging source change.
