# Changelog

## Hermes-Swarm runtime (`src/swarm-runtime/`)

A lightweight, Hermes-inspired swarm harness added on top of the agent library: a
manager agent decomposes a goal, spawns isolated worker agents (Docker / OS
process / inline), delegates tasks, and accepts a result only after it clears a
layered anti-hallucination + anti-rogue trust pipeline. Built across 40
iterations (see [`.plans/SWARM_ROADMAP.md`](./.plans/SWARM_ROADMAP.md)).

### Anti-hallucination / anti-rogue
- Verification gate: per-result grounding — cited evidence must trace to the
  worker's actual tool output; fabricated evidence is auto-rejected.
- Redundant-worker consensus voting (majority agreement required).
- Cross-claim contradiction detection across a goal's results.
- Evidence provenance store (confirmed-evidence audit trail + grounding rate).
- Semantic grounding judge (embeddings) and independent adversarial verifier.
- Anti-rogue guardrail: kills workers on destructive / exfil / sandbox-escape /
  self-preservation / runaway behaviour.

### Orchestration
- Isolation providers: Docker (hardened: cap-drop, no-new-privileges,
  read-only rootfs, pids-limit, cpu/mem), OS process, inline.
- Priority DAG scheduler with backpressure; worker autoscaling; dead-worker
  detection + task requeue; hierarchical sub-swarms; per-goal budgets;
  cancellation; persistent (crash-recoverable) state.

### Integrations & modes
- Pull-based HTTP control plane with token rotation; MCP tools; expanded REST
  API; cron-scheduled goals; harness-backed + tool + LLM executors; provider
  abstraction (OpenAI / Anthropic / Nous / OpenRouter / Together / Groq /
  local); chat gateways (Slack / Discord / Telegram); worker skills.

### GUI / UX / ops
- Web dashboard (DAG, logs, evidence viewer, goal history, live kill/scale
  controls, metrics) + SSE; terminal UI; `hermes-swarm` CLI (run/serve/tui/doctor).
- Dashboard auth; `/healthz`; Prometheus `/metrics`; structured ndjson logging;
  config file (defaults < file < env); graceful shutdown; chaos + e2e +
  benchmark suites.

**699 tests. Zero-config quickstart:** `npm run swarm:demo`.

---

## Hades — the learning agent (`src/hades/`)

The fuller agent layered on the Hermes-Swarm core: it remembers, learns, and
lives where you do, without bypassing the swarm's verification gate. Built across
a second 40 iterations (see [`.plans/HADES_ROADMAP.md`](./.plans/HADES_ROADMAP.md)).
Everything is injectable, so the whole tree tests without real credentials, a
network, an LLM, or a real clock.

### Closed learning loop (Phase A)
- Cross-session memory store (ranked by lexical overlap · salience · recency)
  and session store with FTS-style search.
- Agent-curated memory extraction; memory nudges; autonomous skill creation
  (`SkillForge`) and skill self-improvement (`SkillTuner`) from trajectories.
- Durable dialectic user model; memory-augmented executor that injects learned
  context into worker prompts.

### Platform connectors (Phase B)
- `ConnectorHub` (one handler, many channels; rate-limit + mirror) with
  Telegram / Slack / Discord / WhatsApp Cloud / Signal connectors over injectable
  transports; voice pipeline (injectable STT/TTS); cross-platform conversation
  continuity (one identity + session across channels with a link-code flow).

### Execution backends (Phase C)
- `RemoteBackend` registry beyond local isolation: SSH, Modal (serverless),
  Daytona (persistent serverless), Singularity/Apptainer (HPC); `ScaleToZeroManager`
  idle-hibernate + wake-on-demand.

### Protocols, models, plugins (Phase D)
- ACP adapter (server + session model, streamed updates) with edit-approval,
  permissions, and a provenance log; model-switching UX (`hades model`);
  `HadesPlugin` system + example plugins (browser/kanban/achievements) + local
  registry; domain skill packs (devops/research/finance) + loader.

### Research/training + REPL (Phase E)
- Trajectory recording (goal→task→tool→result); batch generation runner;
  compression → JSONL training data; interactive REPL (multiline, history,
  slash commands + autocomplete + interrupt) wired to memory + a conversational
  agent loop.

### Packaging / polish (Phase F)
- Unified `hades` CLI; layered config + `HADES_*` env + i18n (en/es);
  `Dockerfile.hades` + `scripts/install-hades.sh`; guide + architecture docs +
  a runnable example; an end-to-end suite composing gateway + backend + learning
  loop + REPL.

**Swarm + Hades: 909 tests.**

---

## Hades v2 — Teams, A2A & on-demand parallel swarms (`src/hades/{a2a,teams,modules,parallel,security,bench}/`)

A third 30-iteration build makes Hades team-native — closing the remaining gaps
against Hermes on capability, security, and footprint. Everything is injectable,
so teams of containerized agents test without containers, a network, or
credentials. See [`.plans/HADES_V2_ROADMAP.md`](./.plans/HADES_V2_ROADMAP.md).

### A2A communication (Phase G)
- Agent-to-agent addressing + envelope; per-agent mailbox + in-memory bus;
  topic pub/sub + team broadcast; correlated request/response RPC (timeout,
  error propagation); ordered lossless streaming.

### Teams & dynamic spawning (Phase H)
- Role registry + `TeamBlueprint`; `TeamFormer` (task → validated roster);
  `Team` spawn over an injectable spawner — in-process or **containerized** on a
  RemoteBackend (Modal/SSH/Daytona/Singularity); form→work→disband lifecycle with
  failure-aware teardown; `TeamCoordinator` (addressed + broadcast).

### Modular skills & plugins (Phase I)
- Module manifests with semver dependency resolution + topological load order;
  hot skill-module load/unload/reload; plugin packages with deny-by-default
  declared permissions; a unified skill+plugin registry with conflict checks.

### Parallel execution (Phase J)
- Fan-out (shared-queue map across the roster); work-stealing load balancer
  (retry + quarantine); map-reduce (scatter/gather/reduce); assembly-line role
  pipeline; deterministic speedup + efficiency metrics.

### Security hardening (Phase K)
- Per-agent capability tokens (NHI); HMAC A2A signing with tamper-reject;
  least-privilege team permission scopes; an append-only audit trail (who talked
  to whom, what spawned); secure-by-default spawn policy (no network, read-only
  root, caps dropped, resource ceilings, egress allowlist).

### Benchmarks / lightweight / release (Phase L)
- Latency/throughput/round-trip benchmark harness; lazy-loading footprint pass;
  `hades team` CLI; teams/A2A docs + a runnable parallel-team example; a secure
  end-to-end team scenario.

**Swarm + Hades + Hades v2: 1054 tests.**

---

## Hades v2 performance level-up + signature swarm hierarchy mode

Built with a team of subagents working in parallel (distributed hierarchy, live
benchmarks, scale tests), integrated and verified centrally.

- **O(1) A2A routing.** Direct messages (all RPC + streaming) dispatch by an
  indexed `Map.get(agentId)` lookup — a 10,000-agent roster resolves a
  point-to-point send in exactly one comparison, not 10,000. Only broadcasts fan
  out. Instrumented via `routeScans`.
- **Swarm hierarchy mode** (`src/hades/hierarchy/`). Recursive coordinator→worker
  tree with parallel fan-out at every level: B^D workers in D coordination hops.
  `buildBalancedHierarchy` + `hierarchyStats` + in-process `HierarchyOrchestrator`
  + `DistributedHierarchy` (the same tree over the real A2A bus — each node its
  own endpoint + RPC peer). Scale-tested to 2048 workers deep / 243 wide.
- **Runnable benchmarks** (`src/hades/bench/live-bench.ts`, `docs/HADES_BENCHMARKS.md`):
  ~2.4M A2A messages/sec, ~230k RPC round-trips/sec, ~28–42× hierarchy-vs-serial
  speedup on 64 workers, and O(1) routing confirmed at 10k agents.

**Swarm + Hades + Hades v2: 1076 tests across 133 files.**

## Hades Elite — high-performance hierarchy vs a flat baseline (in-process)

> Scope note: the routing/makespan headlines below are an operation-count ratio
> and a virtual-clock model respectively — they prove in-process complexity and
> correctness properties, not end-to-end agent throughput. The measured wall-clock
> head-to-head currently favors the flat baseline. Real verified-throughput
> measurement is the [`.plans/HADES_BEYOND_HERMES.md`](./.plans/HADES_BEYOND_HERMES.md)
> roadmap.


A 16-iteration performance-engineering loop
([`.plans/HADES_ELITE_LOOP.md`](./.plans/HADES_ELITE_LOOP.md)) run under a sustained
autonomous `/loop`. **Every iteration was built by a team of 2–4 parallel subagents
with a dedicated adversarial verifier** trying to break the others' work; the main
loop integrated centrally, kept `tsc` clean and the suite green, ran the real
benchmark, and recorded only measured numbers. The adversarial passes caught and
forced fixes for real bugs (an over-provisioning tree search, a chaos-harness leaf
crash) rather than rubber-stamping.

### Beat-the-flat-baseline proof
- **Head-to-head harness** (`bench/flat-baseline.ts`, `bench/head-to-head.ts`): a
  naive flat manager→worker orchestrator (honest, still concurrent) vs the swarm
  hierarchy on an identical workload. **Routing cost O(N²)→O(N)**: measured **6.8×
  @16, 24.8× @64, 96.8× @256 workers** (hard `routeScans` counts, not wall-clock),
  aggregate parity proven every row.
- **Makespan O(N)→O(log N)** (`bench/latency-makespan.ts`): under a realistic
  discrete-event latency model (delivery costs latency; each agent is one
  sequential event loop) flat makespan is linear, hierarchy logarithmic —
  **1.33×→4.1×→13.5×→45.5×** speedup growing with N. The one regime where flat wins
  (single-node pure-CPU aggregation) is stated plainly, not hidden.

### Resilience, correctness & observability
- **Reliable delivery** (`a2a/reliable.ts`): exactly-once, in-order over a lossy
  link (seq/ACK/retransmit/dedupe) — property-tested across 30 chaos seeds.
- **Live metrics** (`metrics/collector.ts`): per-node throughput / nearest-rank
  latency percentiles / queue depth with an atomic pure-read `snapshot()` at
  **~180 ns/op** overhead.
- **Soak + leak probe** (`bench/soak.ts`, `bench/leak-probe.ts`): ~1.1M msg/s stable
  under sustained load, **zero leak** (endpoints return to baseline, maxDrift 0).
- **Circuit breakers + timeouts** (`hierarchy/circuit-breaker.ts`,
  `breaker-registry.ts`): a persistently failing subtree is short-circuited
  (≤threshold retries, never forever); per-hop timeouts feed the same breaker.
- **Property-based correctness** (`hierarchy/fuzz.ts`): 300 random trees ×
  reductions × workloads — hierarchy result **==** flat reference every time.
- **Chaos pass** (`hierarchy/chaos.ts`, `bench/chaos-suite.ts`): under
  drops/delays/reorders/node-deaths the swarm returns a correct **verified**
  aggregate **or** a clean **audited** failure — **0 silent-wrong across 125 runs**.
- **Regression guardrails** (`bench/invariants.ts`): perf-invariant tests that fail
  CI if O(1) routing, the depth-bounded critical path, or aggregation correctness
  ever regress.
- **CLI**: `hades hierarchy <head-to-head|makespan|chaos|fuzz|stats>` runs any of
  the above from the terminal.

**Swarm + Hades + Hades v2 + Elite: 1444 tests across 169 files.**

## Hades > Hermes, Phase 1 — Programmatic Tool Calling (`src/hades/exec/`)

Hermes-parity `execute_code` with the STYX twist ([roadmap](./.plans/HADES_PAST_HERMES_20.md)):
a model writes ONE program that chains every allowed tool through a typed RPC
bridge, instead of spending one conversational turn per tool call — and every
in-sandbox tool dispatch still lands in a hash-chained, tamper-evident
provenance ledger, so the single-inference pipeline stays fully auditable.

- **Tool-RPC bridge** (`exec/tool-rpc.ts`): locked request/response protocol over
  the real `ToolRegistry` with allow/deny capability policy (deny wins), a call
  budget, per-call timeouts, a UTF-8-byte-safe output cap (via `string_decoder`,
  never splitting a code point), and one sha256-hashed `ProvenanceEvent` per
  dispatched call.
- **JS sandbox** (`exec/sandbox-js.ts`): user code runs only inside a
  `worker_threads` Worker (`tools.call` + captured console as the ambient
  surface); hard `terminate()` kill on timeout; never rejects. Honest about
  being crash/hang isolation, not an adversarial security boundary.
- **Python sandbox** (`exec/sandbox-py.ts`): a real `python3 -I` subprocess
  (`shell: false`, base64-embedded source), line-framed RPC over stdio with
  per-run frame auth so output that merely *looks* like a protocol frame is
  provably inert; SIGTERM→SIGKILL hard kill; honest `python_unavailable`.
- **Provenance ledger** (`exec/provenance.ts`): canonical serialization +
  hash-chained records; `verify()`/`fromJSON`/`verifyJSON` agree via one shared
  chain walker; any edit/reorder/deletion/splice is detected with a structured
  reason; `traceSha256()` drops straight into `CertificatePayload.traceSha256`.
- **`execute_code` tool** (`exec/code-tool.ts`): `#lang: python|js` directive,
  fresh bridge + fresh ledger per invocation, structural self-recursion denial,
  always returns a JSON `ExecuteCodeReport` with the trace hash.
- **Phase 1 checkpoint** (`exec/pipeline-bench.ts`, `hades exec bench`): the same
  real search→extract→summarize pipeline run as a multi-turn ReAct loop vs one
  `execute_code` call — every number counted from real execution (the only mock
  is the clearly-labelled scripted LLM driving the ReAct side): 8 model turns
  collapse to 1 (87.5% step reduction), identical tool work, agreeing answers,
  and only the programmatic side carries a verifiable trace.
- **CLI**: `hades exec run [--lang js|python] [--file <path>] [code]` runs a
  program against the builtin tools and prints the report plus a from-genesis
  ledger re-verification; `hades exec bench` prints the checkpoint;
  `execEnabledRegistry()` wires `execute_code` into any registry for the agent
  loop / MCP server.

## Hades > Hermes, Phase 14 — one-command migration off Hermes / OpenClaw (`src/hades/migrate/`)

The switching cost *is* the moat. This phase makes moving an existing
Hermes/OpenClaw install into Hades a single, reversible, auditable command —
and reachable from the terminal AND the desktop app.

- **Discovery** (`migrate/discovery.ts`): a 12-entry declarative layout table
  (Hermes/OpenClaw × env override / XDG / dotfile / macOS App Support /
  Windows APPDATA, plus the legacy pre-rename `~/.clawdbot` and `~/.moltbot`),
  scored per (layout, root) pair — never first-match-wins. Pure over an
  `FsProbe` seam; defends against symlink loops, symlink escapes, depth bombs,
  oversized directories and EACCES without ever throwing. Refuses (loudly) to
  treat Hades' own data dir as a source.
- **Readers**: real parsers for JSON/JSONC config, dotenv (a real scanner, not
  shell evaluation), Markdown context files, JSONL sessions, SKILL.md skills,
  and a **dependency-free SQLite reader** (`migrate/sqlite-read.ts`) that
  hand-parses table b-trees, the record format, overflow chains and every
  serial type — cross-validated row-for-row against real `node:sqlite`
  fixtures, with adversarial files (encrypted, truncated, page-looped,
  lying rootpage) failing closed with a documented code.
- **Canonical IR** (`migrate/ir.ts`): deterministic key-sorted JSON with a
  pinned cross-run digest, sha256 item hashes, a documented key grammar, and
  `validateBundle` — which the pipeline now enforces as a real gate, including
  a secret-material detector so key material can never reach a plan.
- **Planner** (`migrate/plan.ts`, `migrate/report.ts`): a pure, deterministic
  conflict engine (per-kind resolvers, five policies, jail-safe renames,
  idempotency via prior receipts) producing an order-independent `planHash`;
  no plan with an unresolved blocker may propose a destructive action. The
  renderer's `[dry run]` banner cannot be omitted and its "NOT IMPORTED"
  section is never truncated.
- **Applier** (`migrate/apply.ts`): transactional writes against the REAL
  engine (memory through the STYX write-guard, sessions, config, model
  selection, the SKILL.md library, context files, a 0600 `secrets.env`), a
  hash-chained JSONL receipt log, resume/idempotency, a cross-process lock,
  and byte-identical rollback on first failure. It refuses to apply a plan
  marked `dryRun`, and after a rollback it reports *nothing* as applied.
- **Surfaces**: `hades migrate scan|plan|apply|report|selftest` (apply is a
  DRY RUN without `--yes`; `selftest` runs the whole pipeline twice against
  real materialized fixtures in a sandbox and proves idempotency), and the
  desktop app's **Import from Hermes / OpenClaw** card over a real `migrate.*`
  IPC lane (`src/desktop/ipc/migrate-contract.ts`,
  `src/desktop/core/migrate-service.ts`) — the same pipeline, the same
  `<dataDir>`, applying only on explicit confirmation.
- **Secrets never travel**: discovered API keys live in a leak-proof
  `SecretVault` (private field, no `toJSON`/`toString`/inspect path) and reach
  disk only as `<dataDir>/secrets.env` at mode 0600. Every other surface —
  terminal output, JSON dumps, IPC events, receipts — carries env-var NAMES.
- Also wired this cycle: `hades install plan|bundle|verify|doctor`, which
  shipped previously but had no route in the command router.

## Hades > Hermes, Phase 15 — the unified trust gate (`src/hades/trust/`)

Every verification primitive this repo had was real but *disconnected*: the
STYX ensemble, the conformal gate, the certificate authority, the tool
verifiers, the memory write-guard and the user-model auditor each knew their
own corner and nothing else. This phase joins them into ONE admission
decision every emitted output passes, and makes it reachable from the
terminal, the desktop app and the TUI.

- **The spine** (`trust/registry.ts`): one canonical shape every subsystem
  speaks (`TrustSubject` / `UniversalVerifier` / `UniversalVerdict` /
  `FusedVerification`) plus `VerifierRegistry`, which selects, runs
  (timeout- and throw-isolated), normalizes and fuses verdicts through the
  REAL `WeakVerifierEnsemble`. `normalizeVerdict` is the single choke point
  every raw verifier return passes: malformed shapes, non-boolean `passed`,
  out-of-range confidence and thrown/timed-out verifiers all abstain with
  machine-readable codes and are never counted as a pass. A verdict claiming
  a stronger tier than its verifier's registered one is clamped; the fused
  tier is always the WEAKEST contributing tier, so a cheap T4 self-check can
  never borrow an oracle's credibility by co-voting. `subjectKey` /
  `canonicalTrace` encode every field individually, so no delimiter-boundary
  trick can make two distinct subjects collide.
- **Adapters** (`trust/action-adapters.ts`, `trust/emission-adapters.ts`):
  every verifier the build already ships, adapted and never re-implemented —
  the ten real `toolVerifiers()` (tier/prior read verbatim from the real
  calibration table), the real `ProvenanceLedger` chain check, the real
  `verifyMemoryWrite`, the real `auditUserModel` — plus two new deterministic
  verifiers for the domains that had none: outbound-message certificate
  binding and procedure-run structure.
- **The gate** (`trust/unified-gate.ts`): registry fusion -> a hard
  strong-tier-dissent veto (a crowd of weak-tier PASSes may never out-vote a
  T0/T1 FAIL) -> the per-domain split-conformal threshold -> the tier
  confidence floor -> the trust budget -> a REAL ed25519 certificate. Its
  invariant, asserted everywhere: `accepted === (certificate !== undefined)`.
- **The budget** (`trust/budget.ts`): a durable, hash-chained, tamper-evident
  ledger of every unit of residual risk ever spent. Any edit, deletion,
  reorder or forged tail is caught by recomputing every hash from the
  persisted bytes; a failed chain refuses further spending and reports the
  budget as fully spent rather than trusting numbers edited to look safer.
- **The checkpoint** (`trust/risk-eval.ts`): drives the real eval corpus
  through an injected admission port, grades with each task's own
  ground-truth grader (never the gate's score), and independently re-audits
  every certificate issued. A zero-coverage run reports DEGENERATE, never
  PASS.
- **Central wiring** (`trust/wiring.ts`): `openTrustStack()` — the one
  assembly the CLI, the desktop sidecar and anything added later share, so
  all of them use one verifier set, one ed25519 identity (persisted 0600 at
  `<dataDir>/trust/signing-key`, so a certificate issued in a terminal still
  verifies tomorrow), one budget chain and one persisted calibration.
- **Surfaces**: `hades trust status|verifiers|calibrate|admit|budget|riskeval|doctor`
  (`npm run trust:*`), the desktop `trust.*` IPC lane
  (`src/desktop/ipc/trust-contract.ts`, `src/desktop/core/trust-service.ts`)
  where calibrating requires explicit confirmation and the private key never
  crosses the wire, and a pure TRUST GATE TUI pane
  (`src/swarm-runtime/tui/trust-gate-pane.ts`).

### Honesty: what this gate will not claim

Calibration is fitted only from REAL labeled observations — either recorded
from graded admissions or derived by `--from-eval`, which fuses genuine
verifier votes over the real `EVAL_TASKS` corpus and labels every point with
that task's own grader. There is no default threshold and no seeded
calibration set anywhere; an uncalibrated domain abstains and says so.

Because conformal calibration cannot manufacture discrimination the
verifiers do not have, the surfaces report the rank AUC alongside every fit
and `hades trust doctor` FAILS a "calibrated" domain whose scores do not
separate correct from wrong. On this build the `procedure` domain's only
verifier is structural, so `--from-eval` correctly yields AUC 0.5 and a
`+Infinity` threshold — an honest abstain-on-everything, reported as such
rather than dressed up as a working gate. `doctor` also FAILS the domains
that ship a single verifier (`procedure`, `message`), because a lone voter
is always `degraded-evidence` and can never certify however it is calibrated.

## Hades > Hermes, Phase 16 — the verified-work market (`src/hades/market/`)

Phase 15 made a certificate *provable*. This phase makes it *worth something*:
a market in which the only way to get paid is to attach a certificate that
independently re-derives, and in which asserting verified work you cannot
prove is economically fatal rather than merely embarrassing.

- **Reputation** (`market/reputation.ts`): a hash-chained, tamper-evident
  ledger of (forecast, outcome) events per participant, scored with a
  Murphy-decomposed Brier SKILL score (`brier = reliability - resolution +
  uncertainty`), exponential time decay, difficulty weighting and
  population-prior shrinkage. A forecaster with no *resolution* — one who
  never distinguishes hard cases from easy ones — cannot out-score a
  genuinely calibrated one no matter how favourable their task pool's base
  rate is. Any adjudged fabrication forces the score to a hard,
  unamortizable zero, and 1000 perfect events do not average it away.
- **Claims** (`market/claims.ts`): `ClaimAdjudicator` re-derives claim truth
  from the REAL ed25519 crypto in `styx/certificate` — signature, issuer,
  output binding, task binding, trace binding, tier, epsilon, freshness,
  verifier versions, score domain, claim-vs-certificate ceiling and replay.
  No certificate = honest abstention (`unverified`, score 0, not a lie). A
  certificate failing ANY check = `fabricated`, score EXACTLY 0. Numbers are
  only ever read from a payload whose signature already verified.
- **Economy** (`market/economy.ts`): escrow, the REAL `settlementPayment`
  Brier rule, slashing, treasury conservation across three buckets, and a
  hysteresis-guarded `active -> probation -> demoted -> banned` standing
  machine whose recovery path requires consecutive certified passes — never a
  single lucky result. A proven fabrication bans in ONE settlement.
- **Exchange** (`market/exchange.ts`): a trust-gated, second-price order book
  that ranks offers by REPUTATION-ADJUSTED expected verified value per
  dollar, closing the selection-stage gap `styx/market.ts` documents but does
  not fix: a same-price blusterer with a bad track record no longer beats an
  honest bidder at selection time and only bleeds money later.
- **Convergence** (`market/convergence.ts`): a seeded cohort driven through
  the real engine, measuring whether reputation rank order converges on true
  reliability. Explicitly and permanently labelled a MODEL — its numbers are
  never mixed into live market state, and the contract guard on the desktop
  lane REJECTS a simulation view whose model banner has been stripped.
- **Central wiring** (`market/wiring.ts`): `openMarket()` — the one assembly
  the CLI, the desktop sidecar and the TUI share, rooted at `<dataDir>/market`
  and trusting the SAME `<dataDir>/trust/signing-key` identity the trust gate
  signs with, so a certificate minted by `hades trust admit` in a terminal
  spends as real money here. Reputation, economy and the certificate replay
  registry are all durable; a reputation ledger whose hash chain does not
  re-verify is REFUSED, not silently loaded.
- **Surfaces**: `hades market status|reputation|ledger|book|explain|simulate|doctor`
  (`npm run market:*`), the desktop `market.*` IPC lane
  (`src/desktop/ipc/market-contract.ts`, `src/desktop/core/market-service.ts`),
  and a pure MARKET TUI pane (`src/swarm-runtime/tui/market-pane.ts`).

### Honesty: what this market will not claim

A Brier SKILL score divides by the variance of a participant's own realized
outcomes, so until they have both a pass and a fail on record it is
mathematically UNDEFINED. Every surface reports that as `n/a` / `—` /
`scoreDefined: false` — never as `0.000`, which would read as "scored
terribly" when the truth is "not scoreable yet". The economy's
minimum-reputation gate is likewise not applied to an undefined score: before
this, an honest worker was permanently barred from the market by the first
job they did right.

An install with no trust-gate identity trusts NO issuer, and says so in
`status`, in `doctor` (which FAILS) and in the TUI pane — an empty
fabrication count on an install that would reject every certificate is not
evidence that nobody cheated.

### Adversarial fixes found during central integration

- **Certificate theft.** The replay registry keyed only on (signature ->
  task, output), so a second participant re-presenting a stolen but
  byte-identical certificate passed every content check and adjudicated
  `verified`. The binding now includes the participant that consumed it.
- **Replay-registry poisoning.** The registry was written by the FIRST
  presentation, valid or not — so anyone who could observe a signature could
  pre-bind it to a bogus task and the legitimate holder's own correct
  submission came back `replayed-certificate` -> fabricated -> slashed and
  banned. Only a fully-valid consumption binds now.
- **Budget overrun.** The exchange's second price `A_w / V_r` is unbounded
  above; a weak runner-up drove the clearing price far past the `maxPrice`
  the requester declared and every offer was gated against. Capped at the
  order's own budget, which (being a property of the ORDER, not the winner's
  bid) leaves the truthfulness argument intact.
- **Treasury insolvency.** Payments are drawn from the treasury with no
  solvency check, so a long run of successful settlements drove `treasury()`
  negative while `totalTokens()` still "conserved" — conservation across
  three buckets is not solvency. Payment is now floored at what exists.
- **A raw NUL byte** in `exchange.ts`'s source (a delimiter written
  literally), which made the whole file read as binary to git and grep — the
  same defect the previous two cycles had to fix. Now an escape, with a test
  that scans every market source for raw control bytes.
