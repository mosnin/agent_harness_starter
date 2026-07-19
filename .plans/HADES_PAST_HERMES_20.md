# Hades > Hermes — a 20-phase plan to a verifiable, superhuman agent harness

The goal is not to clone Hermes. It is to reach **full parity** on everything Hermes
does, then pull **decisively past it** on the one thing Hermes cannot answer:
*can you prove the work was actually correct?* That is the STYX moat
(`docs/STYX_ARCHITECTURE.md`) and the North Star metric is **V-TPH$**
(Verified Tasks Per Hour per Dollar), which is un-gameable: lying "verified" scores 0.

## Ground rules (every phase, no exceptions)
- **No fabricated numbers.** Every benchmark runs real code or is labelled a model.
- **Adversarial verification stays.** Each phase ships builder teams on distinct new
  files plus independent verifiers that try to break them; only green + audited lands.
- **Never regress a green phase.** Full `vitest` + `tsc -p tsconfig.lib.json` +
  `cargo test` stay green; the eval suite never goes backwards.
- **The product is the CLI, the TUI, and the native desktop app.** Never a web SPA.
- Develop on `claude/hermes-swarm-framework-vbhrot`.

## Where we already are (do not rebuild)
STYX verification swarm (gate, certificates, conformal abstention, tiers, market),
swarm hierarchy (manager/workers), multi-provider client, MCP client+server,
SKILL.md skills + library + packs, plugins, memory store, teams/roles, A2A,
hierarchy benchmarks, V-TPH$, ReAct loop, `hades` CLI, live TUI (`hades tui`),
Tauri desktop app (command palette, Compare/head-to-head, Metrics/V-TPH$, cert
verify), packaging scaffolding. Suite: 2341 tests green.

---

# ARC I — Parity on the agent core (the loop, tools, memory)

## Phase 1 — Programmatic Tool Calling (`execute_code`) — DONE (cycle 1)
Shipped: `src/hades/exec/` (tool-rpc bridge, worker_threads JS sandbox, real
`python3 -I` subprocess sandbox, hash-chained provenance ledger, `execute_code`
tool, pipeline-bench checkpoint), wired into the product via `hades exec
run|bench`, `execEnabledRegistry()`, and the `hades/exec` barrel. Checkpoint
measured for real: 8 ReAct model turns -> 1 `execute_code` call (87.5% step
reduction), identical tool work, agreeing answers, programmatic trace
hash-chain verified (ReAct transcript has nothing to verify — the moat).
Next up: **Phase 2 — Tool suite expansion + toolset manager.**
Hermes parity: collapse multi-step tool pipelines into a single inference by letting
the model write code that calls tools over an RPC bridge.
- `src/hades/exec/tool-rpc.ts` — typed RPC bridge exposing every registered tool to a
  sandboxed runtime; `src/hades/exec/code-tool.ts` — the `execute_code` tool.
- Sandboxed JS/Python execution behind the existing execution backends (no `eval`;
  worker isolate / subprocess with a capability allowlist).
- **Beyond Hermes:** every RPC tool call inside the sandbox emits a STYX
  provenance record, so a "single inference pipeline" is still fully auditable.
- Checkpoint: real pipeline (search -> extract -> summarize) runs in one turn; measured
  tool-call count drops vs. the ReAct baseline on the eval suite.

## Phase 2 — Tool suite expansion + toolset manager
Hermes parity: 40-60+ tools, enable/disable via `hermes tools`.
- `src/hades/tools/` new tools: web-search, fetch/extract, file ops, shell (gated),
  http, image-gen, tts, vision-describe. `src/hades/cli/tools-command.ts` (`hades tools`).
- Provider-agnostic: real when keys present, honest deterministic mock otherwise
  (never a fabricated result presented as real).
- **Beyond Hermes:** each tool ships a calibrated verifier stub so its output can be
  scored by the STYX ensemble, not just returned.
- Checkpoint: `hades tools` lists/toggles; each tool has a real + mock path under test.

## Phase 3 — Browser automation backend
Hermes parity: cloud browser (search, extract, browse, vision, act).
- `src/hades/browser/driver.ts` on the pre-installed Playwright Chromium
  (`/opt/pw-browsers`); navigate/act/screenshot/extract/vision.
- Headless-first; honest about what needs a display.
- **Beyond Hermes:** DOM-action traces are hashed into the certificate trace, so a
  browsing task can be replayed and verified, not just trusted.
- Checkpoint: a real headless browse+extract task returns cited content under test.

## Phase 4 — Deep memory: session search + summarization
Hermes parity: FTS5 full-text search across sessions + LLM summarization, MEMORY.md /
USER.md, context files that shape every conversation.
- `src/hades/memory/session-store.ts` (SQLite FTS5 or a portable index),
  `src/hades/memory/summarizer.ts`, `MEMORY.md`/`USER.md` loaders into the prompt.
- `hades memory search|timeline` over real recorded sessions.
- **Beyond Hermes:** memory writes pass the verification gate; a contradiction against
  an existing high-salience fact is flagged, not silently overwritten.
- Checkpoint: search recall measured on a seeded corpus; contradiction test passes.

## Phase 5 — Dialectic user modeling
Hermes parity: Honcho-style evolving model of the user across sessions.
- `src/hades/memory/user-model.ts` — a structured, evolving user profile derived from
  verified interactions; salience decay; explicit provenance per belief.
- **Beyond Hermes:** every belief carries a calibrated confidence + the certificate of
  the interaction it came from; low-confidence beliefs abstain rather than assert.
- Checkpoint: profile converges on a scripted multi-session fixture; no unsupported
  belief exceeds its evidence.

---

# ARC II — Parity on reach (backends, messaging, scheduling, skills)

## Phase 6 — Execution backends to full parity
Hermes parity: local, Docker, SSH, Singularity, Modal, Daytona + serverless hibernation.
- Add `src/hades/backends/modal.ts`, `daytona.ts`; a unified `BackendManager` with
  idle-hibernate/resume; capability + cost metadata per backend.
- **Beyond Hermes:** the bandit router (Phase 16) picks a backend by measured
  V-TPH$, not a static default.
- Checkpoint: each backend has a real adapter test (mocked transport) + a `backends`
  listing command; hibernate/resume state machine unit-tested.

## Phase 7 — Messaging gateway (six platforms)
Hermes parity: Telegram, Discord, Slack, WhatsApp, Signal, Email through one gateway,
DM pairing, cross-platform conversation continuity.
- `src/hades/gateway/` per-platform adapters + a single gateway process; pairing +
  identity; a shared conversation store keyed by user across platforms.
- **Beyond Hermes:** every outbound agent message can attach a verification badge
  (verified / abstained), so recipients see trust state, not just text.
- Checkpoint: adapter contract tests per platform (fake transports); continuity test
  across two platforms for one user.

## Phase 8 — Voice
Hermes parity: TTS out, voice-memo transcription in.
- `src/hades/voice/tts.ts`, `stt.ts` (provider-backed real, mock otherwise); wired into
  the gateway (voice memo -> transcript -> agent -> optional TTS reply).
- Checkpoint: round-trip test on a fixture audio path (mock STT/TTS deterministic).

## Phase 9 — Scheduler + scheduled delivery
Hermes parity: built-in cron; scheduled task delivery to any platform (daily reports,
nightly jobs), wake/hibernate.
- `src/hades/schedule/cron.ts` + `delivery.ts` -> gateway surfaces; durable job store.
- **Beyond Hermes:** a scheduled job's output is gate-verified before delivery; a job
  that would deliver an unverifiable result abstains and says so.
- Checkpoint: cron parse + fire + deliver tested deterministically (injected clock).

## Phase 10 — Self-improving skills + Skills Hub interop
Hermes parity: auto-create skills from successful trajectories, refine in use, share via
agentskills.io.
- `src/hades/skills/synthesize.ts` (verified-trajectory -> SKILL.md), refine-on-use
  loop, an agentskills.io-compatible import/export.
- **Beyond Hermes:** only trajectories that passed the verification gate become skills;
  each skill carries a Brier-scored track record and can lose trust if it regresses.
- Checkpoint: a seeded verified trajectory yields a valid SKILL.md that re-runs green;
  a skill whose success rate drops is demoted.

---

# ARC III — Surfaces to flagship quality

## Phase 11 — TUI to flagship
Hermes parity: multiline editing, slash-command autocomplete, history,
interrupt-and-redirect, streaming tool output.
- Wire the already-built `tui/panes.ts` (split-pane logs + worker drill-in) and
  `tui/history.ts` (goal-run replay) into `tui/app.ts`; add multiline compose, slash
  autocomplete, interrupt-and-redirect, live streaming.
- **Beyond Hermes:** a live verification lane in the TUI (accept/abstain/reject per
  task) and an inline V-TPH$ readout.
- Checkpoint: keymap + render state-machine tests; `hades tui` drives a real run.

## Phase 12 — Desktop app to shipping quality
Hermes parity: native app that shares core/config/keys/sessions/skills/memory with the
CLI; anything built in the terminal carries over and vice-versa.
- Real `--features gui` Tauri build validated on a display machine; shared-state sync
  layer so CLI and desktop read/write the same store; live sidecar streaming for every
  view; keyboard-first everywhere.
- **Beyond Hermes:** the desktop app is the only agent GUI with a drop-a-certificate
  verify flow and a live V-TPH$ / Compare panel wired to real runs.
- Checkpoint: end-to-end desktop run against the real sidecar; state round-trips CLI<->app.

## Phase 13 — Install, portability, migration
Hermes parity: single-command installer, portable runtime, OpenClaw migration.
- `install.sh` / `install.ps1`, a portable bundle (node runtime + sidecar + assets),
  and `hades migrate` importing Hermes/OpenClaw settings, memories, skills, keys.
- Checkpoint: installer dry-run + migration importer tested on fixtures; real installer
  documented honestly (built on real runners, not faked here).

---

# ARC IV — Beyond Hermes (the moat Hermes cannot cross)

## Phase 14 — STYX everywhere (verify the whole surface)
Every tool call, skill execution, memory write, and outbound message flows through the
conformal-abstention gate and emits an ed25519 certificate. The agent has a **provable
silent-wrong bound (<= epsilon)** end to end, not just on final answers.
- Unify the per-subsystem verifiers (Phases 2-10) under one gate; a global "trust
  budget" the agent spends and reports.
- Checkpoint: measured silent-wrong rate on the eval suite stays under the configured
  epsilon; every accepted output has a verifiable certificate.

## Phase 15 — Verified-work market maturity
Turn `styx/market.ts` into a real internal economy: agents/skills earn Brier-scored
reputation, exchange verified tasks, and gate trust on certificates. A skill or provider
that lies loses reputation automatically.
- Checkpoint: reputation converges correctly on a seeded honest/dishonest mix; a
  fabricated "verified" claim scores 0 and is demoted.

## Phase 16 — Budget-optimal multi-provider routing
A bandit routes each task across providers/models/backends to maximize measured
V-TPH$, with per-verifier calibration and conformal risk control. Fan-out for hard
tasks, cheapest-that-verifies for easy ones.
- Checkpoint: on a mixed eval batch, the router beats any single fixed provider on
  measured V-TPH$ (real numbers, recorded).

## Phase 17 — Distributed swarm + federation
Multi-node manager, A2A federation across machines, worker autoscale across the Phase 6
backends, chaos-tested (kill workers/nodes mid-run and still finish verified).
- Checkpoint: a multi-node run completes under injected failures; makespan + verified
  throughput measured vs. single-node.

## Phase 18 — Continuous self-evaluation + never-regress gate
A live eval harness runs the suite on every change, tracks V-TPH$ over time, auto-bisects
regressions, and blocks a merge that lowers verified throughput or raises silent-wrong.
- Checkpoint: an injected regression is caught and localized automatically.

## Phase 19 — Verified-trajectory data flywheel
Export the gate-verified trajectory dataset (cert-labelled, compressed) for optional
local fine-tuning; the agent gets better from its own *verified* experience, not raw
logs. Every datum is labelled real/verified, never fabricated.
- Checkpoint: dataset export is reproducible and cert-consistent; an optional local
  fine-tune loop is wired behind a flag and documented (not run unless a model is present).

## Phase 20 — Trust, governance, and the positioning
ed25519 agent identity, capability tokens, tamper-evident audit log, a policy engine,
and a fully offline / air-gapped mode. Ship the story Hermes structurally cannot tell:
**the agent whose every action is independently verifiable.**
- Checkpoint: air-gapped run with no network completes verified; audit log is
  tamper-evident; capability tokens enforce least privilege under test.

---

## Sequencing and cadence
- Arcs run in order; within an arc, phases can overlap where files are disjoint.
- Each phase: locked-contract builder teams on new files + independent adversarial
  verifiers, central integration, real benchmark checkpoint, then the next phase.
- Parity (Arcs I-III) makes Hades a genuine Hermes alternative. The moat (Arc IV) makes
  it something Hermes is not: an agent you can **prove**. That is how we get past it.
