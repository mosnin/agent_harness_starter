# Hades architecture

Hades is a set of layers on top of the Hermes-Swarm core. The swarm owns
execution + verification (grounding gate, consensus, contradiction detection,
provenance, anti-rogue guardrail). Hades never bypasses that — it wraps it.

```
┌─────────────────────────────────────────────────────────────┐
│  Surfaces:   hades CLI   ·   REPL   ·   ACP server   ·        │
│              ConnectorHub (Slack/Telegram/Discord/WhatsApp/   │
│              Signal/voice)                                    │
├─────────────────────────────────────────────────────────────┤
│  Hades brain:  ConversationalAgent (memory-augmented turns)  │
│                PluginManager · ModelCommand · SkillPacks     │
├─────────────────────────────────────────────────────────────┤
│  Learning:   MemoryStore · SessionStore · UserModel          │
│              MemoryCurator · SkillForge · SkillTuner         │
│              TrajectoryRecorder · Batch/Compression          │
├─────────────────────────────────────────────────────────────┤
│  Execution:  RemoteBackendRegistry (SSH/Modal/Daytona/       │
│              Singularity) · ScaleToZeroManager               │
├─────────────────────────────────────────────────────────────┤
│  Swarm core (src/swarm-runtime): manager · verification gate │
│              · isolation providers · skills · gateway        │
└─────────────────────────────────────────────────────────────┘
```

## Module map (`src/hades/`)

| Module         | Responsibility                                                            |
|----------------|---------------------------------------------------------------------------|
| `memory/`      | Durable cross-session memory + session store (ranked retrieval, FTS-ish). |
| `learning/`    | Curator, nudges, skill forge/tuner, user model, memory-augmented executor.|
| `gateway/`     | `ConnectorHub`, rate limiter, platform connectors, voice, continuity.     |
| `backends/`    | `RemoteBackend` registry + SSH/Modal/Daytona/Singularity + scale-to-zero. |
| `acp/`         | ACP server, transport, edit-approval + permissions + provenance.          |
| `models/`      | Model registry, persisted selection, `hades model` command, defaults.     |
| `plugins/`     | `HadesPlugin` + `PluginManager` + example plugins + local registry.       |
| `skill-packs/` | Domain skill bundles + loader + catalog.                                   |
| `research/`    | Trajectory recorder/store, batch runner, compression → training data.     |
| `repl/`        | Multiline buffer, history, slash commands, `Repl`, `ConversationalAgent`. |
| `cli/`         | `HadesCli` router + `buildHadesCli` wiring.                                |
| `config/`      | Layered config + env mapping + i18n.                                       |
| `bin/`         | `hades` process entrypoint.                                                |
| `examples/`    | Runnable, dependency-free demos.                                          |

## Design invariants

- **Injectable everything.** Transports, clients, exec, clocks, STT/TTS, brains,
  and summarizers are all injected, so the whole tree tests without credentials,
  a network, an LLM, or a real clock (deterministic time).
- **Atomic persistence.** File-backed stores write to a temp file + rename;
  in-memory base classes override a single `persist()` seam.
- **Observe-don't-mutate plugins.** Plugin hooks react to events; they can extend
  services (skills/models/connectors) but never rewrite core control flow, so the
  swarm's verification guarantees hold no matter what's installed.
- **The verification gate is never bypassed.** Every channel reply, ACP result,
  and REPL answer is still the product of the swarm's grounded, anti-hallucination
  pipeline.
