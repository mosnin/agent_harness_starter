# Hades — the learning agent on top of the swarm

Hades is the fuller agent that wraps the **Hermes-Swarm** core
(`src/swarm-runtime/`) and closes the gaps against Hermes. Where the swarm
*executes and verifies* (and structurally can't hallucinate its way past its
verification gate), Hades **remembers, learns, and lives where you do** — without
giving up any of those guarantees.

Everything ships as `src/hades/` and is built so it tests **without real
credentials**: every connector, backend, model, LLM, clock, and transport is
injectable.

## Install

```bash
./scripts/install-hades.sh      # verifies Node 18+, installs, type-checks, drops `hades` on PATH
hades help
```

Or run the gateway in Docker:

```bash
docker build -f Dockerfile.hades -t hades-gateway .
docker run --rm -e HADES_MODEL=claude-opus-4-1 -v hades-data:/data hades-gateway hades help
```

## The `hades` CLI

```
hades chat                 Start the interactive REPL (memory + swarm)
hades gateway              Start the messaging gateway (Slack/Telegram/…)
hades model [use <id>]     Show or switch the active model
hades skills [packs]       List skills / available skill packs
hades plugins              List available plugins
hades memory <search|add>  Search or add long-term memories
hades learn stats          Recorded-trajectory dataset size
hades version | help
```

Every subcommand reuses the same building blocks the REPL uses, so behavior is
identical across surfaces.

## The closed learning loop

Each conversational turn (`ConversationalAgent`):

1. **Retrieve** memories relevant to the input (ranked by lexical overlap ·
   salience · recency) plus the durable **user model**.
2. **Augment** the brain's context with them and stream the reply.
3. **Persist** both sides to the session store, so the next turn has continuity.
4. **Learn** offline: the `MemoryCurator` extracts salient facts, the
   `SkillForge` distills reusable skills from successful trajectories, and the
   `SkillTuner` refines them from usage.

Drive it directly with slash commands: `/remember`, `/recall`, `/history`,
`/model`, `/help`.

See `src/hades/examples/learning-loop.ts` for a runnable, dependency-free demo.

## Lives where you do — connectors

`ConnectorHub` runs one handler across many channels with per-user rate limiting
and mirroring. Built-in connectors (all over injectable transports): **Telegram,
Slack, Discord, WhatsApp Cloud, Signal**, plus a **voice** pipeline (injectable
STT/TTS) and **cross-platform continuity** (one identity + one conversation
across channels, with a prove-it's-you link code).

## Execution backends

Beyond the swarm's local isolation (docker/process/inline), `RemoteBackend`
adds remote compute: **SSH**, **Modal** (serverless), **Daytona** (persistent
serverless), **Singularity/Apptainer** (HPC). `ScaleToZeroManager` auto-hibernates
idle workers and wakes them on demand.

## Editors — ACP

`AcpServer` speaks the Agent Client Protocol so an editor can drive a coding
session against the swarm, with streamed updates, **edit-approval** (remembered
allow/deny), and a **provenance log** of every edit decision.

## Models, plugins, skill packs

- **Models**: `hades model` over a registry with aliases + persisted selection.
- **Plugins**: the `HadesPlugin` interface + `PluginManager` (lifecycle, hooks,
  service extension). Examples: browser, kanban, achievements.
- **Skill packs**: domain bundles (devops / research / finance) installed into a
  live `SkillRegistry`.

## Configuration

Config layers **defaults < file < `HADES_*` env < overrides** (`loadConfig`).
Key env vars: `HADES_MODEL`, `HADES_LOCALE`, `HADES_DATA_DIR`,
`HADES_MEMORY_PATH`, `HADES_GATEWAY_TRIGGER`, `HADES_GATEWAY_ALLOWED_USERS`,
`HADES_PLUGINS`. UI strings are localized via `I18n` (en/es starter catalogs).

## Research / training

`TrajectoryRecorder` captures goal→task→tool→result trajectories;
`BatchTrajectoryRunner` drives N goals into a dataset; `compressTrajectory` +
`toTrainingExample`/`toJsonl` render compact training data.

See [HADES_ARCHITECTURE.md](./HADES_ARCHITECTURE.md) for the module map.
