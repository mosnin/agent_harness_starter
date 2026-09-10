# Reference harnesses for Helm — September 10, 2026

**Decision:** build Helm as a durable, evidence-producing coding product inside Hades, while reusing the actual requested foundations. Keep the coding engine, orchestration/ownership service, and user-facing work product separate. The inspected sources support these as distinct layers; they do not establish that any repository or a fleet of agents alone delivers an enterprise-ready product.

**Status:** bounded primary-source research, **needs independent review**. The kernel integrity check passed; the parent is responsible for constructing and reviewing the combined governed packet. No downloaded code was executed. No installation, model run, credential access, paid crawl or large clone was initiated. This memo does not audit the current Helm implementation; root’s local audit must reconcile every proposed requirement against it.

## Pinned source identities

These are default-branch **development snapshots**, not released-binary acceptance.

| Foundation | Default branch / immutable revision | What was inspected | License evidence |
|---|---|---|---|
| OpenAI Codex | `main` · `bf5ebd98c567931d82e873a4afdac7548bd85979` | Rust core, app-server entry, v2 agent spawn/resume/residency and tests | Apache-2.0 root license |
| OpenCode | `dev` · `859106eb17d5b840475f5e4b78e64c9622f8750e` | TypeScript/Effect task tool, prompt loop, server and background bridge | MIT root license |
| Orca | `main` · `34790ce0843affb73bb6340c9189b5b77e04a06b` | Orchestration guide, transactional worker admission and race tests | MIT root license |
| OpenWork | `dev` · `88b1eec4aa8bddd7a8abccbb39285c41bd1c7c36` | Overview and exact root/EE licenses only | Split license; not blanket MIT |

[API identity receipts and commit timestamps](reference-sources/pins.json), [repository metadata](reference-sources/repository-identities.json), and [all 35 body hashes](reference-sources/source-index.json) preserve what was observed. Root licenses do not erase third-party component obligations.

## What the executable architecture actually supplies

| Layer | Source-grounded finding | Implication for Helm |
|---|---|---|
| Codex execution core | `codex-core` owns business logic. Its platform notes describe enforcement differences across Seatbelt, Linux backends and Windows, including fail-closed unsupported policy shapes. [C01](https://github.com/openai/codex/blob/bf5ebd98c567931d82e873a4afdac7548bd85979/codex-rs/core/README.md#L3) | Treat runtime policy support as a negotiated capability; do not translate every provider into one permissive shell wrapper. |
| Codex host protocol | App-server uses separate JSON-RPC processing and outbound-write loops, initializes SQLite state, and has explicit shutdown/drain/recovery paths. [C02](https://github.com/openai/codex/blob/bf5ebd98c567931d82e873a4afdac7548bd85979/codex-rs/app-server/src/lib.rs#L170) | Prefer a typed, versioned adapter over scraping terminal prose where this host protocol is supported. Verify the exact binary/protocol pair. |
| Codex worker ownership | V2 resume checks recorded parent ownership; role loading restores runtime approval/profile boundaries. Residency is bounded and materializes rollout before eligible idle eviction. Tests encode eviction behavior, but were not run here. [C03](https://github.com/openai/codex/blob/bf5ebd98c567931d82e873a4afdac7548bd85979/codex-rs/core/src/agent/control/spawn.rs#L391) [C04](https://github.com/openai/codex/blob/bf5ebd98c567931d82e873a4afdac7548bd85979/codex-rs/core/src/agent/control/residency.rs#L139) [C05](https://github.com/openai/codex/blob/bf5ebd98c567931d82e873a4afdac7548bd85979/codex-rs/core/src/agent/control/residency_tests.rs#L23) | Store owner lineage, permission snapshots and durable state separately from the set of resident worker processes. Resume is an authorization decision. |
| OpenCode engine | The inspected task path derives child permissions, defaults nesting to one level, and gates background requests behind `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS`. It exposes completion/error state and cancellation wiring. The prompt loop integrates compaction; `agent.steps` has an unlimited fallback. [C07](https://github.com/anomalyco/opencode/blob/859106eb17d5b840475f5e4b78e64c9622f8750e/packages/opencode/src/tool/task.ts#L100) [C08](https://github.com/anomalyco/opencode/blob/859106eb17d5b840475f5e4b78e64c9622f8750e/packages/opencode/src/session/prompt.ts#L1178) | Preserve the actual fork and its native task lifecycle. Add explicit product budgets, rather than assuming a model’s final message or an unbounded loop is sufficient. |
| OpenCode background boundary | The inspected job module bridges an instance-scoped legacy service to a separate core registry. Its wrapper does not establish crash/restart durability. One initially selected `packages/core/src/session/prompt.ts` is only a schema re-export; the actual runner was followed into `packages/opencode/src/session/prompt.ts`. [C09](https://github.com/anomalyco/opencode/blob/859106eb17d5b840475f5e4b78e64c9622f8750e/packages/opencode/src/background/job.ts#L17) | Distinguish stored session history from a recoverable running job. The core background registry remains a specific follow-up audit target. |
| Orca ownership service | The guide separates liveness, settlement and unknown outcomes. Worker admission uses `BEGIN IMMEDIATE`, mutation receipts, explicit duplicate/unknown acceptance, task readiness/retry checks and commit/rollback. Race tests cover stale failure and concurrent claims. [C10](https://github.com/stablyai/orca/blob/34790ce0843affb73bb6340c9189b5b77e04a06b/skill-guides/orchestration.md#L34) [C11](https://github.com/stablyai/orca/blob/34790ce0843affb73bb6340c9189b5b77e04a06b/src/main/runtime/orchestration/db/worker-dispatch/worker-dispatch-start.ts#L46) [C12](https://github.com/stablyai/orca/blob/34790ce0843affb73bb6340c9189b5b77e04a06b/src/main/runtime/orchestration/db-task-dispatch-races.test.ts#L116) | Orca is a useful reference for task/attempt ownership and cross-provider execution, beyond opening more terminals. Do not copy a status badge without its transaction and recovery rules. |

A useful concrete cancellation rule already appears in Codex’s experimental native-verification documentation: signaling cancellation does not reverse completed effects, and a cancellation acknowledgment is separate from the original operation finishing. This is specific API evidence, not proof that every Codex operation has identical guarantees. [C06](https://github.com/openai/codex/blob/bf5ebd98c567931d82e873a4afdac7548bd85979/codex-rs/app-server/README.md#L16)

## Current Claude product distinctions

**Claude Code subagents** are documented per-session workers with their own contexts and configurable tools. Freshly fetched docs now allow nesting, with a default depth of three documented for v2.1.219 onward. Background permission prompts can surface in the main session; the former automatic denial behavior is explicitly historical. Current docs also distinguish spawn limits from depth limits and note exceptions around resumed/forked workers. These are vendor-documented capabilities, not independently tested runtime claims. [C13](https://code.claude.com/docs/en/sub-agents.md) [C14](https://code.claude.com/docs/en/sub-agents.md)

**Claude Code teams** add a lead, peer messaging and shared task coordination, but remain experimental. Their documented limits include missing in-process teammate restoration on resume, lagging task status, slow shutdown, fixed leadership and no nested teams. Team membership does not automatically provide worktree isolation; worktrees and agent-view dispatch are separate arrangements. A named team and a trustworthy result are different things. [C15](https://code.claude.com/docs/en/agent-teams.md) [C16](https://code.claude.com/docs/en/agents.md)

**Long-running work has multiple lifetimes.** Claude Code session scheduling only fires while the session is running and idle; missed intervals are not replayed individually. The docs distinguish session loops from cloud routines and desktop scheduled tasks. Agent SDK guidance separately covers turn/spend bounds and result subtypes, including events that can arrive after a result. Neither a scheduler firing nor a result message alone establishes an accepted deliverable. [C17](https://code.claude.com/docs/en/scheduled-tasks.md) [C26](https://code.claude.com/docs/en/agent-sdk/agent-loop.md)

**Cowork is a general-work product, not a public implementation of its internals.** Current official help describes cloud sessions in beta and parallel workstreams, with local files/browser/computer use reached through an open, connected desktop app. Current schedule documentation says runs continue remotely when the computer sleeps or the desktop app closes; those schedules use account files/connectors. This does not mean local computer access remains available offline. Do not reconstruct hidden Cowork architecture from its product claims. [C18](https://support.claude.com/en/articles/13345190-get-started-with-claude-cowork) [C19](https://support.claude.com/en/articles/13854387-schedule-recurring-tasks-in-claude-cowork)

## Current OpenAI product distinctions and documentation conflicts

The freshly fetched Work/Codex help separates fast conversational Chat, general multi-step Work and software-focused Codex. It describes cloud Work across surfaces, local desktop access through permissions, and a separate Codex desktop view/history. Work Local, Work Cloud and Codex Local access controls are separately described. This is evidence for a clear Hades/Helm product distinction; it does not show the internal implementation of the desktop product. [C20](https://help.openai.com/en/articles/20001275-chatgpt-work-and-codex)

There are important freshness conflicts:

- The current ChatGPT agent help article starts with a retirement notice directing users to Work, but lower sections still contain agent-mode availability/use instructions. Treat that lower body as legacy or unresolved documentation, not proof of current availability. [C21](https://help.openai.com/en/articles/11752874-chatgpt-agent)
- The pinned Codex CLI README still links a cloud-based Codex Web route. Therefore, the Work/Codex help’s desktop-view statement does **not** justify claiming that every Codex cloud product has been removed. [C22](https://github.com/openai/codex/blob/bf5ebd98c567931d82e873a4afdac7548bd85979/README.md#L8)
- Search-index excerpts for Claude still say subagents cannot nest and background prompts are auto-denied. The directly fetched Markdown version-qualifies and supersedes those statements. The raw search receipts retain the contradiction; cached snippets were not used as current behavioral truth.

For the product roadmap, match the visible division of responsibility and controls, rather than copying a supposedly shared closed architecture. Hades can own broad work, integrations and browser context; Helm can own repositories, coding runs, diffs, tests and source integration. That is a recommendation, not a discovered implementation fact.

## OpenWork: overview now, deeper implementation audit later

OpenWork describes an Electron/React desktop and core server platform, plus OpenWork Den for organization-level inference access, membership, desktop policy and capability distribution. This phase acquired its overview and licenses, not its executable enforcement paths. OpenCode powers the stated foundation, so OpenWork and OpenCode are not independent confirmation of the same engine’s quality. [C23](https://github.com/different-ai/openwork/blob/88b1eec4aa8bddd7a8abccbb39285c41bd1c7c36/README.md#L70)

The current root license distinguishes MIT content outside restricted components from `ee/`. The actual EE license requires appropriate production rights, with specified exceptions; notably its five-user exception excludes defined Enterprise Features. It also addresses later MIT conversion and restrictions on modifications/distribution. The README’s summary alone is insufficient for choosing reusable enterprise components. Build a file-level license/component inventory before phase-two reuse; do not import `ee/` wholesale under a blanket MIT assumption. This is a source inventory finding, not a legal clearance. [C24](https://github.com/different-ai/openwork/blob/88b1eec4aa8bddd7a8abccbb39285c41bd1c7c36/LICENSE#L13) [C25](https://github.com/different-ai/openwork/blob/88b1eec4aa8bddd7a8abccbb39285c41bd1c7c36/ee/LICENSE#L16)

## Concrete acceptance requirements to reconcile with the Helm audit

These are proposed acceptance tests, **not assertions that current Helm lacks them**.

1. **Provider boundary:** capability/version/auth readiness per adapter; unsupported events remain unsupported. A local binary existing is not authentication or a successful task.
2. **Durable attempts:** stable task and attempt IDs, persisted owner lineage and state before dispatch, idempotent mutation receipts, explicit unknown states after lost acknowledgments.
3. **Workspace ownership:** disjoint worktrees or declared file ownership, source fingerprint checks and conflict review before integration; the coordinator’s task graph must not hide same-file collisions.
4. **Recovery:** kill host/worker during launch, tool execution, approval and completion. Prove that restart neither duplicates work nor upgrades uncertainty into success. Preserve artifacts and an actionable recovery path.
5. **Context and limits:** explicit cost/turn/time/concurrency/depth limits; compaction preserves goals, permissions, workspace identity and evidence references. Resident-memory eviction must not erase ownership.
6. **Permission propagation:** workers cannot manufacture user consent through messages or loosen inherited authority by changing roles. Human interaction is available when an action genuinely needs it.
7. **Completion evidence:** require produced artifacts, test output and current source identity. Separate worker claims, process exit, completion settlement and independent acceptance.
8. **Long-running scheduling:** distinguish session-local loops, local persistent jobs and remote jobs. Show offline behavior, missed-run policy, cancellation and usage limits honestly.
9. **Usable supervision:** expose hierarchy, current action, blockers, cost and safe Stop/Resume/Review controls. Never label a stale/unknown worker as working or completed merely from a cached terminal badge.
10. **Regression probes:** rate-limit a background provider; lose its final notification; race cancellation against a follow-up; fail readiness after process launch; replay a mutation with the same ID; try a stale worker report against a completed task.

Challenge searches surfaced specific OpenCode background-task/429 and Orca readiness/dispatch reports. They are retained as version-specific test leads, not confirmed defects in these pinned snapshots. The source inspections show recovery mechanisms and tests, but this lane did not execute them or prove every report is fixed.

## Coverage, limits and handoff

The source cap was reached: **35 complete primary HTTP bodies**, four commit/tree/repository identity groups, and three discovery batches (12 neutral/challenge queries). HTML pages retain both full raw bodies and deterministic visible-text normalizations. No failed source fetch remains in the selected body set. Some selected files are bridges or re-exports; their limits are explicitly recorded instead of pretending they expose the entire implementation.

Source independence is organizational, not URL-count based: OpenAI docs/repository share one origin; Anthropic Code/Cowork docs share another; OpenCode and OpenWork share a dependency lineage; Orca documentation and tests remain maintainer evidence. Vendor documentation proves what is documented, source inspection proves what these paths contain, and neither proves live performance or enterprise readiness.

**Unknowns:** exact behavior of installed/released binaries; paid-provider reliability and cost; complete OpenCode background registry persistence; Orca full process-admission/remote recovery integration; closed Cowork/ChatGPT internals; OpenWork’s actual enterprise enforcement and full dependency/license inventory. Recommendations would change if root’s exact-SHA Helm audit already proves these acceptance conditions, or if later official releases change the documented limits.

Handoff artifacts: [source index](reference-sources/source-index.json), [raw HTTP receipts](reference-sources/source-receipts.json), [exact character/line/hash claim locators](reference-claim-locators.json), [discovery and screening log](reference-search-log.json). A different agent must review the complete dossier before labeling this independently accepted.
