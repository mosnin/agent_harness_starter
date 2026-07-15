# Hades Agent — 40-Iteration Build Roadmap

**What Hades is:** the fuller agent that wraps the Hermes-Swarm core
(`src/swarm-runtime/`) and closes the gaps against Hermes — a **closed learning
loop**, **real messaging-platform connectors**, **extra execution backends**,
the **ACP protocol**, **research/training tooling**, an **interactive terminal
REPL**, and a **plugin/skill ecosystem**. Hermes-Swarm executes and verifies;
Hades remembers, learns, and lives where you do. Built as `src/hades/`.

**North star:** everything the swarm can't hallucinate its way past, Hades makes
*durable and personal* — memory that persists across sessions, skills it creates
from experience, and channels it reaches you through — without losing the
verification guarantees underneath.

**Working agreement (every iteration):**
1. Read this file → pick the next `[ ]` iteration.
2. Write a 2–4 line plan for it (in the log at the bottom).
3. Implement in a focused chunk under `src/hades/`.
4. `tsc` clean + `vitest run` green (add tests; use **injectable transports /
   STT / exec / clock** so connectors & backends test without real credentials).
5. Commit to `claude/hermes-swarm-framework-vbhrot`. Update checkbox + log here.
6. Never break a previously-green iteration (swarm-runtime stays green too).

Baseline: swarm-runtime complete, 699 tests green.

---

## Phase A — The Closed Learning Loop (Hades's soul)
- [x] 1. Cross-session memory store: `MemoryStore` (memory + file backends) + `MemoryRecord` (fact, salience, tags, ts, embedding?).
- [x] 2. Session store + FTS-style search over past sessions (keyword rank + summarization hook).
- [x] 3. Agent-curated memory: extract & persist salient anchors from a finished session/goal.
- [x] 4. Memory nudges: periodic "persist this?" prompts + a nudge scheduler.
- [x] 5. Autonomous skill creation: synthesize a reusable `SwarmSkill` from a completed trajectory.
- [x] 6. Skill self-improvement: refine a skill from usage feedback (success/failure deltas).
- [ ] 7. User modeling (Honcho-style dialectic): build a durable model of the user across sessions.
- [ ] 8. Memory-augmented executor: inject relevant memories + user model + skills into worker prompts.

## Phase B — Real Platform Connectors (lives-where-you-do)
- [ ] 9. `PlatformConnector` interface + registry + delivery/mirroring + rate limiting.
- [ ] 10. Telegram connector (send/receive via injectable transport).
- [ ] 11. Slack connector (Events API + Web API via injectable transport).
- [ ] 12. Discord connector.
- [ ] 13. WhatsApp Cloud connector.
- [ ] 14. Signal connector (signal-cli shape).
- [ ] 15. Voice: injectable STT (transcribe inbound audio) + TTS reply hook.
- [ ] 16. Cross-platform conversation continuity (one session across channels).

## Phase C — Execution Backends
- [ ] 17. `RemoteBackend` abstraction (beyond worker providers) + registry.
- [ ] 18. SSH backend (run worker over ssh, injectable exec).
- [ ] 19. Modal backend (serverless, injectable client).
- [ ] 20. Daytona backend (serverless persistence, injectable client).
- [ ] 21. Singularity/Apptainer backend.
- [ ] 22. Serverless hibernate/wake + scale-to-zero lifecycle.

## Phase D — Protocols, Models, Plugins
- [ ] 23. ACP adapter: server + session model (injectable transport).
- [ ] 24. ACP: edit-approval + permissions + provenance events.
- [ ] 25. Model-switching UX: `hades model` + model registry + persisted selection.
- [ ] 26. Plugin system: `HadesPlugin` interface + loader + lifecycle hooks.
- [ ] 27. Example plugins (browser, kanban, achievements) + a local plugin registry.
- [ ] 28. Skill packs: domain bundles (devops, research, finance…) + pack loader.

## Phase E — Research/Training + Interactive REPL
- [ ] 29. Trajectory recording: capture goal→task→tool→result trajectories.
- [ ] 30. Batch trajectory generation runner (drive N goals → dataset).
- [ ] 31. Trajectory compression for training data.
- [ ] 32. Interactive terminal REPL: multiline input, history, streaming.
- [ ] 33. REPL: slash-command registry + autocomplete + interrupt-and-redirect.
- [ ] 34. REPL wired to memory + swarm (a real conversational agent loop).

## Phase F — Packaging / Polish / Release
- [ ] 35. `hades` unified CLI (chat, gateway, model, skills, plugins, memory, learn).
- [ ] 36. Config + env + i18n scaffolding (locales).
- [ ] 37. Installer script + packaging notes + Dockerfile for the Hades gateway.
- [ ] 38. Docs: Hades guide + architecture + runnable examples.
- [ ] 39. End-to-end suite across learning loop + gateway + backend + REPL.
- [ ] 40. Final review, README, CHANGELOG, build verification; STOP the loop.

---

## Iteration log
_(newest last; one entry per completed iteration)_

- **Iter 1 — cross-session memory store.** `src/hades/memory/`: `MemoryRecord` (fact, salience, tags, access stats) + `MemoryStore` with `InMemoryMemoryStore` and atomic-write `FileMemoryStore`. Pure `scoreMemory` ranks retrieval by lexical overlap · salience · recency decay (2-week half-life); retrieval records access. 6 tests. Full suite green.
- **Iter 2 — session store + FTS-style search.** `SessionStore` (memory + file) holding conversation sessions; pure `scoreSession` ranks by term-frequency over title/summary/messages and returns the best snippet. Injectable `Summarizer` hook generates a cheap, searchable summary for cross-session recall. 4 tests. Full suite green.
- **Iter 3 — agent-curated memory.** `learning/MemoryCurator`: reads a finished session and extracts salient facts (offline salient-statement pattern extractor normalizing 1st→3rd person, or an injectable LLM `FactExtractor`), persisting new ones to the MemoryStore and deduping (token-overlap) against existing memories. 3 tests. Full suite green.
- **Iter 4 — memory nudges.** Pure `evaluateNudges` (persist after N new turns since curation; summarize an idle, unsummarized session) + `NudgeEngine` that tracks per-session curation progress, emits nudges, and stops re-firing after `markCurated`. Injectable clock. 5 tests. Full suite green.
- **Iter 5 — autonomous skill creation.** `learning/SkillForge` distills a completed `Trajectory` into a reusable playbook `SwarmSkill`: capabilities = the tools that worked + a slugified name, plus a prompt fragment describing the known-good approach; `forgeAndRegister` drops it into a SkillRegistry. Skips failed/trivial trajectories; injectable LLM synthesizer optional. 6 tests. Full suite green.
- **Iter 6 — skill self-improvement.** `learning/SkillTuner` records per-skill success/failure and, once there's enough signal, refines: annotates high performers with their track record, flags chronic under-performers for retirement, or hands off to an injectable LLM refiner. `report()` ranks worst-first. 6 tests. Full suite green.
