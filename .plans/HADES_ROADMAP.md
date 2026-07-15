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
- [x] 7. User modeling (Honcho-style dialectic): build a durable model of the user across sessions.
- [x] 8. Memory-augmented executor: inject relevant memories + user model + skills into worker prompts.

## Phase B — Real Platform Connectors (lives-where-you-do)
- [x] 9. `PlatformConnector` interface + registry + delivery/mirroring + rate limiting.
- [x] 10. Telegram connector (send/receive via injectable transport).
- [x] 11. Slack connector (Events API + Web API via injectable transport).
- [x] 12. Discord connector.
- [x] 13. WhatsApp Cloud connector.
- [x] 14. Signal connector (signal-cli shape).
- [x] 15. Voice: injectable STT (transcribe inbound audio) + TTS reply hook.
- [x] 16. Cross-platform conversation continuity (one session across channels).

## Phase C — Execution Backends
- [x] 17. `RemoteBackend` abstraction (beyond worker providers) + registry.
- [x] 18. SSH backend (run worker over ssh, injectable exec).
- [x] 19. Modal backend (serverless, injectable client).
- [x] 20. Daytona backend (serverless persistence, injectable client).
- [x] 21. Singularity/Apptainer backend.
- [x] 22. Serverless hibernate/wake + scale-to-zero lifecycle.

## Phase D — Protocols, Models, Plugins
- [x] 23. ACP adapter: server + session model (injectable transport).
- [x] 24. ACP: edit-approval + permissions + provenance events.
- [x] 25. Model-switching UX: `hades model` + model registry + persisted selection.
- [x] 26. Plugin system: `HadesPlugin` interface + loader + lifecycle hooks.
- [x] 27. Example plugins (browser, kanban, achievements) + a local plugin registry.
- [x] 28. Skill packs: domain bundles (devops, research, finance…) + pack loader.

## Phase E — Research/Training + Interactive REPL
- [x] 29. Trajectory recording: capture goal→task→tool→result trajectories.
- [x] 30. Batch trajectory generation runner (drive N goals → dataset).
- [x] 31. Trajectory compression for training data.
- [x] 32. Interactive terminal REPL: multiline input, history, streaming.
- [x] 33. REPL: slash-command registry + autocomplete + interrupt-and-redirect.
- [x] 34. REPL wired to memory + swarm (a real conversational agent loop).

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
- **Iter 7 — user modeling (dialectic).** `learning/UserModel` (+ `FileUserModel`): durable traits (attribute→value, confidence, evidence) updated dialectically via pure `reconcile` — create / reinforce (asymptotic confidence) / revise-on-stronger-evidence / ignore-weaker. `ingest(memories)` builds it (offline `deriveTraitsFromMemories`), `describe()` renders prose. Durable across sessions. 7 tests. Full suite green.
- **Iter 8 — memory-augmented executor (Phase A complete).** `MemoryAugmentedExecutor` wraps any swarm `TaskExecutor`, retrieves memories relevant to the task + the user model, and injects them into `task.input._memoryContext` so prompt-building executors surface learned context automatically — closing the loop into execution. Passes through when nothing's learned; verified inside a real swarm. 3 tests. **Phase A done.** Full suite green.

### Phase B
- **Iter 9 — connector abstraction (Phase B start).** `gateway/`: `PlatformConnector` interface (normalize inbound → handler → deliver reply), `ConnectorHub` (register many connectors; per-message rate-limit → mirror → route to one handler; proactive `deliver`), token-bucket `RateLimiter` (injectable clock), and `InMemoryConnector` test double / in-process channel. One handler, many channels. 5 tests. Full suite green.
- **Iter 10 — Telegram connector.** `TelegramConnector` long-polls `getUpdates` over an injectable `TelegramTransport`, normalizes via `parseTelegram`, routes through the handler, replies via `sendMessage`, and advances the update offset. Real `createTelegramHttpTransport(token)` for production. Tested with a fake transport (no token). 3 tests. Full suite green.
- **Iter 11 — Slack connector.** `SlackConnector` exposes `ingest(payload)` for the Events-API webhook: answers the url_verification challenge, dedupes retried `event_id`s, ignores bot/edited messages, normalizes via `parseSlack`, and replies through an injectable `chat.postMessage` transport (`createSlackHttpTransport`). 4 tests. Full suite green.
- **Iter 12 — Discord connector.** `DiscordConnector.ingest(payload)` normalizes MESSAGE_CREATE events (skipping bot authors + empty content) via `parseDiscord`, routes them, and replies through an injectable `createMessage` transport (`createDiscordHttpTransport`). 3 tests. Full suite green.
- **Iter 13 — WhatsApp Cloud connector.** `WhatsAppConnector.verify()` answers the GET webhook handshake; `ingest()` walks the entry→changes→messages envelope, handles text messages only (ignores status/media), routes them, replies via an injectable send transport (`createWhatsAppHttpTransport`). 3 tests. Full suite green.
- **Iter 14 — Signal connector.** Poll-based `SignalConnector` over an injectable `SignalTransport` (signal-cli receive/send shape): drains data messages, skips receipts/empties, routes, replies to source. `createSignalJsonRpcTransport` for a signal-cli daemon. Added `signal` to `GatewayPlatform`. 2 tests. Full suite green.
- **Iter 15 — voice.** `gateway/VoicePipeline` wraps a text handler into a voice-aware one via injectable `SpeechToText` + optional `TextToSpeech`: inbound audio is transcribed before routing (prefers provided text when both present), and the reply is spoken back only when the turn was voice. `AudioRef`/`VoiceInbound`/`VoiceReply` carry audio alongside the platform-agnostic message; no audio backend needed to test. 4 tests. Full suite green (763).
- **Iter 16 — cross-platform continuity (Phase B complete).** `gateway/continuity`: an `Identity` unifies a user's per-platform handles into one canonical record carrying a single `sessionId` and `lastSeen` channel. `InMemoryIdentityStore`/`FileIdentityStore` resolve handle→identity, `link` (merging two identities, preserving the target's session), and persist. `IdentityLinker` runs the "prove it's you" flow — a one-time, TTL-bound, single-use code issued from a known channel and redeemed from a new one. `ContinuityRouter` wraps a handler so one identity keeps one conversation across channels, flags a `switchedChannel`, records `lastSeen`, and exposes `deliveryTargetFor` for proactive replies — drops straight into `ConnectorHub`. Injectable clock + code/session generators. 8 tests. **Phase B done.** Full suite green (771).

### Phase C
- **Iter 17 — RemoteBackend abstraction (Phase C start).** `backends/`: `RemoteBackend` seam for running a worker on *remote* compute (SSH/Modal/Daytona/Singularity) beyond the swarm core's local `ContainerProvider` — provision/terminate/status/logs plus a `RemoteState` lifecycle and optional `hibernate`/`wake` for serverless scale-to-zero. `RemoteBackendRegistry` registers backends, provisions on a named or first-available backend, tracks handles, and drives hibernate/wake/terminate; `RemoteHandle` carries endpoint + backend-private `meta`. `FakeBackend` (in-process, injectable clock, optional hibernate) tests it all without remote credentials. 6 tests. Full suite green (777).
- **Iter 18 — SSH backend.** `SshBackend` runs each worker as a `nohup` background process on a remote host over an injectable `SshTransport`: `provision` launches with the worker env, captures the PID as the native id, and tees to a per-worker log; `status` probes with `kill -0`; `terminate` kills the PID; `logs` tails the file. No hibernate/wake (a plain host isn't serverless). `createSshCliTransport` builds a real `ssh` invocation (port/identity/BatchMode) with an injectable local spawner. Tested against a fake host simulating a process table. 7 tests. Full suite green (784).
- **Iter 19 — Modal backend.** `ModalBackend` (serverless) spawns a Modal function call hosting the worker and returns its web endpoint, over an injectable `ModalClient`. True scale-to-zero: `hibernate` cancels the live call (cost → 0) while preserving app + env in `meta`; `wake` re-spawns an identical call from that saved spec; `status`/`logs` short-circuit while hibernated so no poll bills a stopped call. Poll status maps to `RemoteState`. Verified standalone and through the registry's hibernate/wake tracking. 6 tests. Full suite green (790).
- **Iter 20 — Daytona backend.** `DaytonaBackend` (serverless with **persistent volumes**) over an injectable `DaytonaClient`. Unlike Modal's fresh-call-per-wake, `hibernate` *stops* the workspace (compute → 0, disk kept) and `wake` *resumes the same workspace id*, so the worker returns to its files and installed deps; `terminate` destroys the volume for good. Workspace state maps to `RemoteState` (stopped → hibernated). Verified standalone and via the registry. 5 tests. Full suite green (795).
- **Iter 21 — Singularity/Apptainer backend.** `SingularityBackend` runs each worker as a named container **instance** from a `.sif` image over an injectable `CommandRunner`: `provision` → `instance start` with `--env`/`--memory`, `status` parses `instance list`, `terminate` → `instance stop`, `logs` tails the instance's stdout log. Requires a `.sif` (spec or default); binary configurable (`apptainer`/`singularity`). Persistent HPC node, so no hibernate/wake. Tested against a fake CLI simulating the instance table. 7 tests. Full suite green (802).
- **Iter 22 — scale-to-zero lifecycle (Phase C complete).** `ScaleToZeroManager` wraps the `RemoteBackendRegistry` and drives idle workers to zero cost and back: `markActive` stamps last-use, `sweep` auto-hibernates every running worker idle past `idleMs` (skipping backends without hibernate — SSH/Singularity — never erroring on a mixed fleet), `ensureAwake`/`acquire` wake a hibernated worker on demand and reset its idle timer. Injectable clock makes the idle reaper deterministic; lifecycle events (`active`/`hibernated`/`woken`/`skipped`) feed observability. 5 tests. **Phase C done.** Full suite green (807).

### Phase D
- **Iter 23 — ACP adapter (Phase D start).** `acp/`: the agent side of the Agent Client Protocol so an editor can drive a coding session against the swarm. `AcpServer` answers JSON-RPC over an injectable `AcpTransport` — `initialize` handshake, `session/new`, `session/prompt` (delegating to an injectable handler that streams `session/update` notifications: message/thought chunks, tool calls, plans), and the `session/cancel` notification — with a session model, ordering/guard checks (init before session, unknown-session/method errors), and handler errors surfaced as JSON-RPC internal errors. `InMemoryAcpTransport.pair()` wires a client and agent in-process for testing (no stdio). 7 tests. Full suite green (814).
- **Iter 24 — ACP edit-approval + permissions + provenance.** Extended `AcpServer` with outbound requests (`sendRequest`, exposed on the prompt context) so the agent can call client-side methods mid-turn, correlating responses back to pending promises. `EditApprovalManager` drives the `session/request_permission` flow: a `PermissionPolicy` remembers allow-always/reject-always per (session, path) so repeated edits don't re-prompt, and a `ProvenanceLog` records every attempted/approved/denied/cancelled/auto-*/applied edit — extending the swarm's provenance guarantees to the ACP surface. Verified in isolation and end-to-end over the paired transport (agent requests permission during a prompt, client grants, edit applied, trail logged). 6 tests. Full suite green (820).
- **Iter 25 — model-switching UX.** `models/`: `ModelRegistry` (register/resolve by id or case-insensitive alias, group by provider, mark a default), `InMemoryModelSelection`/`FileModelSelection` (durable, atomic-write current-model choice kept separate from the config-rebuilt catalog), and `ModelCommand` — the terminal-free `hades model` logic the CLI + REPL share: `list` (active marked with `*`), `current`, `use <id|alias>` (validated), plus bare-id shorthand via `run()`. Gracefully falls back to the default when a persisted model is no longer registered. 7 tests. Full suite green (827).
- **Iter 26 — plugin system.** `plugins/`: the `HadesPlugin` interface (`register(ctx)` + optional `onEnable`/`onDisable` lifecycle, declared `dependencies`) and `PluginManager`. Registration runs `register(ctx)` once, wiring runtime hooks (`goal:start/complete`, `message:inbound/outbound`, `tool:before/after`) and letting a plugin extend host services (`addSkill`/`addModel`/`addConnector`, no-op-false when a service isn't wired). `emit` fans a hook to every enabled plugin and isolates a throwing listener (caught + logged) so one bad plugin can't break a goal; `disable`/`enable` toggle dispatch without re-registering; duplicate names and missing dependencies are rejected. Observe-and-react hooks keep core control flow (and the swarm's guarantees) untouched. 7 tests. Full suite green (834).
- **Iter 27 — example plugins + local registry.** Three worked examples: `BrowserPlugin` (registers a `browse` skill + prompt fragment via `addSkill`, counts successful browse tool calls), `KanbanPlugin` (mirrors goals onto a todo/in_progress/done board — start → in-progress, complete → done, abort → todo), `AchievementsPlugin` (gamification — counts completed goals, unlocks milestone badges, ignores aborted goals). `LocalPluginRegistry` is the offline plugin-marketplace analogue: catalog entries with factories, `available()` metadata listing (no factories leaked), fresh instance per `create`, and `load(name, manager)` to install into a live manager; `defaultPluginRegistry()` seeds the three built-ins. 7 tests. Full suite green (841).
- **Iter 28 — skill packs (Phase D complete).** `skill-packs/`: a `SkillPack` is a curated bundle of `SwarmSkill`s for a domain. `SkillPackLoader` installs a pack into a live `SkillRegistry`, tracks loaded packs, and won't clobber an existing same-named skill (reports `skipped`) unless `overwrite` is set. `SkillPackCatalog` is the browse-packs surface (`list` skill names, `install(name, loader)`). Three built-ins — **devops** (deploy/ci-pipeline/observability), **research** (literature-search/synthesis/citation), **finance** (financial-analysis/forecasting/risk) — each skill carrying capabilities + a behavioral prompt fragment; installed packs resolve their merged capabilities through the registry. 7 tests. **Phase D done.** Full suite green (848).

### Phase E
- **Iter 29 — trajectory recording (Phase E start).** `research/`: `TrajectoryRecorder` captures goal→task→tool→result trajectories as the swarm runs, built incrementally (`beginGoal`→`beginTask`→`recordTool`→`endTask`→`endGoal`) with an injectable clock for deterministic recordings; ignores events for unknown goals/tasks. `GoalTrajectory`/`TaskTrajectory`/`ToolEvent` are the training-data unit; `toSkillTrajectory` distills a recording down to the lighter `Trajectory` `SkillForge` learns from (verified end-to-end: record → distill → forge a skill). `InMemoryTrajectoryStore`/`FileTrajectoryStore` accumulate datasets with atomic-write persistence. 4 tests. Full suite green (852).
- **Iter 30 — batch trajectory generation.** `BatchTrajectoryRunner` drives a list of objectives through an injectable `GoalRunner` (wired to the swarm + recorder) to build a training dataset: bounded concurrency (worker-pool, never exceeds the limit), per-goal failure isolation (recorded in `failures`, never aborting the batch), progress callbacks, and results returned in input order regardless of completion order — optionally appended to a `TrajectoryStore`. 4 tests. Full suite green (856).
- **Iter 31 — trajectory compression.** `compressTrajectory` shrinks a verbose recording into a compact training example: flattens tasks→tools, optionally drops failed steps, collapses runs of the identical tool+ok into one repeat-counted step, and caps length (head+tail, marking `truncated`) — keeping objective, outcome, tool sequence, and per-tool counts. `toTrainingExample` renders a prompt/completion pair (numbered plan with `(xN)`/`[failed]` annotations); `toJsonl` serializes a dataset. Pure and deterministic. 5 tests. Full suite green (861).
- **Iter 32 — interactive REPL core.** `repl/`: `MultilineBuffer` assembles a turn across lines — continues on a trailing backslash or an open construct (unbalanced brackets, an open ``` fence, quote-aware), force-submits on a blank line. `CommandHistory`/`FileCommandHistory` give up/down navigation back to a live draft, coalesce consecutive duplicates, cap size, and persist. `Repl` ties input → multiline → a streaming handler → an injectable `ReplIO`, recording history and showing a continuation prompt while a turn is incomplete. Driven line-by-line rather than owning stdin, so the whole loop is unit-testable and can back any front-end. 10 tests. Full suite green (871).
- **Iter 33 — REPL slash commands + autocomplete + interrupt.** `SlashCommandRegistry` resolves commands by name or alias, parses `/name args`, offers prefix autocomplete (`/mo` → `/model`), and reports unknown `/`-commands rather than sending a typo to the agent; `helpCommand` self-lists the registry. Wired into `Repl`: a `/`-line short-circuits the handler to the registry; `interrupt()` aborts the in-flight turn via an `AbortSignal` passed to the handler (Ctrl-C → `^C`); `complete()` autocompletes slash commands or, for plain input, matching history entries. Existing 3-arg handler stays backward-compatible with 2-arg handlers. 8 tests. Full suite green (879).
- **Iter 34 — conversational agent loop (Phase E complete).** `ConversationalAgent` closes the loop: each turn retrieves memories relevant to the input (ranked, best-first) plus the user model, hands the augmented context to an injectable `ConversationBrain` (the LLM/swarm seam), streams the reply, and persists both sides to a `SessionStore` so the next turn carries history. Built-in slash commands — `/remember` (persist a fact), `/recall` (search memory), `/history`, `/model` (delegates to `ModelCommand`), `/help` — let the user drive memory and model inline. `agent.repl(io)` returns a fully wired REPL; the whole loop runs in tests with a fake brain, no LLM/swarm/disk. 6 tests. **Phase E done.** Full suite green (885).
