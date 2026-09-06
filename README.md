# Hades

Hades is an agent harness for the CLI, terminal UI and native desktop. The main
working path is a model-backed conversation with workspace file tools and
persistent sessions. Swarm workers share that agent loop. This repository also
contains experimental verification, federation, migration and learning modules.

## Run the agent

Requires Node.js 22 and npm. From a checkout:

```sh
npm ci --ignore-scripts
npm run build:hades
export HADES_PROVIDER=openai
# Set OPENAI_API_KEY in your environment or secret manager.
node dist-hades/hades.js chat --root /path/to/your/project
```

OpenAI defaults to `gpt-4o-mini`; use `--model` or `HADES_MODEL` to choose a model
available to your account. For Anthropic, set `HADES_PROVIDER=anthropic`,
`ANTHROPIC_API_KEY` and an explicit `HADES_MODEL`. For an OpenAI-compatible local
server, set `HADES_PROVIDER=local`, `HADES_BASE_URL` (including its `/v1` prefix)
and `HADES_MODEL`. A local server uses only the optional `HADES_API_KEY`; it does
not receive credentials from your cloud provider environment.

```sh
# A single task with a bounded model/tool loop
node dist-hades/hades.js chat --once "Read package.json and explain the test commands"

# The session ID is printed at startup. Resume it in a later process:
node dist-hades/hades.js chat --session SESSION_ID
```

`/remember`, `/recall`, `/history` and `/help` are available in a conversation.
`/exit` ends it. Ctrl-C cancels the current model turn. The default limit is 20
model steps; override with `--max-steps`. Sessions and memory live in `.hades/`
under the launching directory, or `HADES_DATA_DIR` when set. Keep this directory
private: it contains conversation content.

File operations enforce workspace path checks. Shell execution is disabled by
default. `--allow-shell git,rg` opts into selected host commands; this is **not an
OS sandbox**. Allowed programs run with your user permissions. Cancellation
cannot roll back an edit, and an active shell command may run until its timeout.

## Run a swarm

```sh
npm run build:swarm
# Uses the same provider configuration and actual tools as chat:
npm run swarm -- run "Read package.json and summarize the dependencies"

# Explicit fixture mode, no credentials required:
npm run swarm -- run "Demonstrate orchestration" --demo

# Run workers as child processes:
npm run swarm -- run "Read README.md and summarize it" --mode process
```

Real runs default to one task to avoid parallel edits racing in a shared
workspace. Programmatic callers can supply a planner and isolated workspaces.
State is persisted in `HADES_DATA_DIR/swarm-state.json` (default `.hades/`) and
restored for inspection on restart. Interrupted tasks are not automatically
replayed. Process workers share host permissions; Docker requires a configured
image, reachable control-plane address and network. Container workspaces are
inside the container, not automatically mounted from your project.

The desktop sidecar uses the same real executor. Build its JavaScript halves
with `npm run desktop:build`; native installers use the separate Desktop Build
workflow. Messaging uses an explicit `HADES_GATEWAY_ENGINE=swarm` opt-in and
provider credentials. Its fallback labels itself as a mock.

## What verification means

The swarm gate checks that evidence quotes occur in successful tool outputs and
that the delivered output is represented by a claim. Missing evidence, unrelated
output and an available judge's failure or outage reject admission. This checks
provenance and coverage; it does **not** establish that every claim follows from
its evidence or that the user's whole task is correct.

Normal chat does not claim correctness certification. Gateway certification
requires an independent final-outcome checker and caller-supplied calibration;
production defaults provide neither, so they abstain from certification. STYX
also requires explicit calibration. Synthetic calibration is a test fixture.
Its legacy `ConformalGate` implements an empirical threshold heuristic, not an
established guarantee on conditional deployment error. Signed MCP and cluster
receipts attest integrity, not correctness. A signature binds bytes to an issuer;
it does not make an answer true or establish that the issuer is trusted.

## Validation and competitive status

```sh
npm run type-check
npm test -- --maxWorkers=4
npm run build:hades
npm run build:swarm
npm run desktop:build
npm run test:smoke
```

Browser tests need a local browser installation:
`node node_modules/playwright-core/cli.js install --with-deps chromium`.
The packaged CLI smoke uses real HTTP, files and separate processes with scripted
model replies. It does not exercise a paid provider or measure model quality.
Cost estimates use available token usage and pricing; unknown or zero spend does
not produce a meaningful per-dollar throughput score.

Showdown's local single-agent surrogate is not the Hermes implementation.
Modeled results are labeled demos. No matched real harness evaluation currently
establishes superiority over Hermes, Codex, Claude Code or other agents.

See [the remediation record](docs/AUDIT_REMEDIATION.md) for the exact validation
boundary, [architecture](ARCHITECTURE.md), and [desktop setup](docs/DESKTOP_APP.md).
`src/app/` and the Next.js scripts are legacy starter scaffolding, not the Hades
product surface. Historical architecture and roadmap documents describe both
implemented components and unproven aspirations; use exercised runtime evidence
when assessing readiness.
