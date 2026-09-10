# Hades → Beyond Hermes: an order-of-magnitude plan

**Author's honest premise.** A prior brutal audit established what Hades actually
is today: a well-engineered, exhaustively unit-tested *simulation* of an agent
swarm. No shipped entrypoint calls a model (the default worker counts words),
connectors have no inbound half, "distributed" is a loopback wire, the learning
loop is template strings, the verification gate is a self-consistency linter, and
the security primitives are unwired. Hermes, by contrast, is a shipping product:
real inference every turn, ~90 tools, 7 live surfaces, MCP both ways, a real
learning loop, 215k stars.

You do not beat that on breadth. This plan wins on a **different axis**, closes the
credibility gaps that make the current claims false, and then compounds a moat
Hermes cannot easily copy.

---

## 1. What "an order of magnitude more powerful" means (pick the axis)

"Power" is not one number. Trying to be 10× on *everything* is how you end up 0×
on the thing that matters. We commit to ONE North-Star axis where 10× is both
achievable and defensible, and we refuse to chase the axes we will lose.

### North Star — **V-TPH$: Verified Tasks per Hour per Dollar**

> The number of **independently-verified-correct** task completions per wall-clock
> hour, divided by total LLM dollars spent — under a hard constraint of
> **zero silent-wrong** results and a complete provenance trail.

This single metric fuses the four things a swarm can dominate a single agent on:
- **Throughput** (parallel isolated workers vs one serial agent),
- **Correctness** (a verification gate that rejects ungrounded output),
- **Cost** (many cheap-model workers + one verifier vs one frontier model), and
- **Trust** (0 silent-wrong + provenance — a *categorical* advantage, not a
  percentage one: it unlocks regulated/enterprise work Hermes cannot touch).

**Target: 10× the V-TPH$ of a single-frontier-model agent** (the Hermes execution
model) on a decomposable benchmark suite, measured on real inference.

### Where we will NOT try to win (and will say so)
- Breadth of native tools — we inherit Hermes-class tools via **MCP** instead.
- Messaging-surface count — we ship the few that matter, done right.
- Single hard *sequential* reasoning tasks — one frontier model wins those; our
  swarm targets *decomposable* and *verifiable* work.
- Community/stars/velocity — not a competition we can enter this quarter.

---

## 2. Why 10× is real, not marketing

The bet has three multiplicative factors on decomposable workloads:

1. **Parallelism (≈N×).** On N independent subtasks, a swarm running workers
   concurrently collapses wall-clock from ~N·t to ~t. This is the one thing the
   hierarchy already does correctly in-process — we make it real over real LLM
   calls (which are I/O-bound, so concurrency is genuine, not GIL-bound).
2. **Cost inversion (≈3–8× per-dollar).** A cheap worker model (Haiku-class) doing
   a *narrow decomposed subtask*, gated by a strong verifier that rejects bad
   output, can reach frontier-level *accuracy on that subtask* at a fraction of
   the dollars a frontier model spends doing the whole thing. **The verification
   gate is what makes cheap-model output trustworthy** — that is the entire
   product thesis.
3. **Trust (categorical).** 0 silent-wrong + provenance is not "20% better" — it
   is the difference between "cannot deploy for audited work" and "can." That
   converts a capability gap into a market Hermes doesn't serve.

Factors 1 and 2 alone, multiplied, clear 10× on the right workloads. Factor 3 is
the moat that keeps it.

**Falsifiable up front:** if, after Phase 1, a real head-to-head shows the verified
swarm cannot beat a single frontier agent on V-TPH$ by ≥3× on decomposable tasks,
the thesis is wrong and we pivot. We measure before we believe.

---

## 3. The plan — 7 phases, run as agent-team /loops

Each phase is a `/loop` of iterations in the established pattern: every iteration
built by a **team of 2–4 parallel subagents with a dedicated adversarial
verifier**, integrated centrally, `tsc` clean + suite green, **real measurements
recorded (never simulated numbers presented as real)**. Phases are ordered by
leverage: you cannot be "more powerful than an agent" until you are an agent
(Phase 1), and you cannot claim a moat you haven't wired (Phases 3–4).

### Phase 0 — Credibility reset & the real scoreboard  *(fast, do first)*
The audit found headline claims the code contradicts. Fix them, then build the
one benchmark that actually matters so every later phase has a number to move.
- Correct README/CHANGELOG: drop "signed & audited by default", reframe the
  routing/makespan benchmarks with honest captions (count-ratio; virtual-clock
  model; wall-clock currently favors flat), delete "beats Hermes on every metric".
- Build **`bench/vtph.ts`**: a real task-suite runner that executes a batch of
  decomposable tasks end-to-end against real models, recording verified-correct
  count, wall-clock, tokens, dollars, silent-wrong rate, provenance completeness.
- Assemble a **decomposable eval set** (30–50 tasks: multi-part research, batch
  code edits, extraction-over-many-docs) with programmatic graders.
- **Exit:** `hades bench vtph --baseline single-agent` prints a real V-TPH$ table
  (baseline may be near-zero verified until Phase 1 — that's the honest starting
  line).

### Phase 1 — Give it a brain + inherit Hermes' tools via MCP  *(highest leverage)*
The single biggest lie to retire and the single biggest capability to gain.
- **Wire `LLMExecutor` into the default worker path.** `hermes-swarm run` and the
  swarm factory must select a real model when keys exist (add `--model`, propagate
  `SWARM_MODEL`), falling back to the deterministic executor only when explicitly
  offline. The client already exists (`worker/llm-executor.ts`, `providers.ts`) —
  it just needs to be *reached*.
- **Real tool-calling loop in the worker**: a worker must call tools (shell, files,
  http, code-exec) in a ReAct/function-calling loop, not emit a template. Build a
  minimal but real in-box toolset, sandboxed by the existing docker/process
  providers.
- **MCP client** (`a2a`/`tools` layer): speak MCP so Hades inherits the entire
  Hermes/Anthropic tool ecosystem *for free* rather than rebuilding 90 tools. This
  is how we neutralize Hermes' breadth advantage with one protocol.
- **Real `ConversationBrain`** wired into `hades chat` so the REPL actually talks
  to a model.
- **Exit:** `hades chat` holds a real conversation; a worker completes a real
  tool-using task end-to-end; V-TPH$ baseline is now non-trivial and the
  swarm-vs-single-agent head-to-head runs on real inference. **This is the
  go/no-go gate for the whole thesis.**

### Phase 2 — Real I/O surfaces (make it deployable)
Enough real ingress/egress to run unattended in the world.
- **Inbound gateway server**: one webhook HTTP server with Slack/WhatsApp
  signature verification and a **Discord Gateway WebSocket** client (the missing
  inbound half). Telegram long-poll already ~works — finish it.
- **One real distributed wire**: a WebSocket `Wire` for `RemoteA2ATransport` so
  "distributed A2A" stops being a loopback and nodes genuinely cross processes.
- **One real remote backend**: make Docker+SSH first-class and production-tested
  (real container start in CI), or a real Modal/Daytona HTTP client — pick one,
  make it real, delete the other's claim.
- **Exit:** a user connects Telegram/Discord with a token and no glue code; two
  Hades nodes run the same hierarchy across two processes over a socket.

### Phase 3 — The moat: turn the verification gate into real grounding + engage security
Upgrade the self-consistency linter into something an adversarial LLM cannot game,
and make the security story true.
- **Grounded verification**: replace substring/token-overlap with (a) tool-output
  cross-checks (claim must be entailed by *actual* tool results, not the prompt),
  (b) the existing `SemanticGroundingJudge` **wired on by default**, (c)
  **cross-model adjudication** — a different model verifies the worker's claim, so
  a model quoting its own prompt no longer passes.
- **Retrieval-checked claims**: factual claims checked against a retrieved source
  set, not the worker's own trace.
- **Engage the security primitives that already exist but nothing calls**: real
  **ed25519** signatures (the dependency is already in `package.json`, used by
  nothing) replacing shared-secret HMAC; capability-token enforcement on the
  spawn/A2A paths; **hardened-by-default docker** (set the `limits` the flags gate
  on, and add a CI test that starts a real hardened container).
- **Exit:** an adversarial "lie convincingly" red-team suite drives real models
  trying to pass fabricated claims; the gate's real catch-rate is measured and
  reported; every A2A message in a shipped path is genuinely signed; docker
  workers come up network-isolated + read-only in a real container test.

### Phase 4 — The 10× run: scale + parallelism on real work
Now prove the North Star.
- **Real decomposition** of real tasks across isolated workers (the manager
  pipeline already models plan→dispatch→verify — feed it real planners/executors).
- **Cheap-worker / strong-verifier configuration**: Haiku-class workers, frontier
  verifier only on gate decisions — the cost-inversion engine.
- **Adaptive concurrency** to saturate provider rate limits without thrashing.
- **Run `bench vtph` head-to-head at scale** and iterate until the verified swarm
  clears **10× V-TPH$** vs the single-agent baseline on the decomposable suite,
  with silent-wrong held at 0.
- **Exit:** a published, reproducible V-TPH$ table (`hades bench vtph`) showing
  ≥10×, with full provenance artifacts — the honest replacement for today's
  microbenchmark headline.

### Phase 5 — Self-improvement that actually changes behavior
Close the learning loop for real so V-TPH$ *rises across runs on a fixed suite*.
- **Retrieved memory**: wire the real embedding service into memory so recalled
  facts are actually injected into worker/verifier prompts (today memory is
  keyword-scored and unused by any brain).
- **Skill distillation validated by the gate**: a distilled skill is kept only if
  it *raises verified success* on a holdout — learning gated by the verifier, not
  by template heuristics.
- **Trajectory → training export** that a real fine-tune/DSPy-style optimizer
  consumes (offline), mirroring Hermes' self-evolution but *verification-gated*.
- **Exit:** on a frozen task suite, V-TPH$ measurably improves run-over-run purely
  from accumulated memory/skills — a real learning curve, not a JSONL file.

### Phase 6 — Ecosystem & moat lock-in
Make the verified swarm something the rest of the agent world plugs into.
- **MCP server**: expose "run a verified, isolated, provenance-tracked swarm task"
  as an MCP tool that *any* agent — including Hermes — can call. Hades becomes the
  trusted execution substrate under other agents.
- **agentskills.io / Skills Hub compatibility** so the ecosystem's skills run here.
- **One killer demo + honest docs**: "give it 200 tasks, watch a cheap verified
  swarm beat a frontier agent on correct-work-per-dollar, with a full audit log."
- **Exit:** an external agent invokes Hades-as-MCP-tool and gets a verified,
  audited result back.

---

## 4. The 10× math (worked, so it's checkable)

On a batch of N decomposable subtasks, per-subtask latency t, worker token-cost
c_w, verifier token-cost c_v (only on gate decisions), frontier per-task cost C:

- **Single agent (Hermes model):** wall-clock ≈ N·t; cost ≈ N·C; verified only if
  it self-checks (it mostly doesn't) → silent-wrong > 0.
- **Verified swarm:** wall-clock ≈ t (concurrency, provider-limit bounded); cost ≈
  N·(c_w + α·c_v) with α<1 (verifier runs once per task, cheap models for work);
  silent-wrong = 0 (gate rejects/re-runs).

V-TPH$ ratio ≈ **(N·t / t)** (throughput) **× (C / (c_w + α·c_v))** (cost) — the
product clears 10× when N ≳ 10 and cheap-worker cost is ≲⅓ frontier, which is the
normal regime for decomposable work. **Assumptions we must validate in Phase 1/4:
that cheap-worker + verifier holds accuracy, and that provider rate limits leave
enough concurrency headroom.** If either fails, the number shrinks — we measure.

---

## 5. Risks & honest failure modes
- **Cheap-worker accuracy collapses** on hard subtasks → cost inversion evaporates.
  Mitigation: verifier-triggered escalation to a stronger model only on failure.
- **Provider rate limits** cap real concurrency below N → throughput factor drops.
  Mitigation: multi-provider fan-out, adaptive concurrency; report the real ceiling.
- **Verifier is itself an LLM** → who verifies the verifier? Mitigation: cross-model
  + tool-output entailment + retrieval, and a red-team suite that measures catch
  rate rather than assuming it.
- **Hermes is a moving target** shipping weekly. Mitigation: don't race their
  breadth; own the trust/verification axis they've barely started (their
  verification landed July 2026 and only runs project checks).
- **LLM cost of development** (real inference in CI/benches). Mitigation: tiered —
  deterministic fakes for logic tests (keep the 1,444), a small real-inference
  smoke suite gated behind a keyed CI lane, full V-TPH$ runs on demand.

---

## 6. What changes about how we work
- **Every benchmark from here runs on real inference or is labeled a model.** No
  more count-ratios or virtual clocks presented as throughput. The audit caught
  that; the North-Star metric is defined to be un-gameable that way.
- **Adversarial verification stays**, but at least one verifier per phase attacks
  *external validity* ("is this fair to a real system / a real model?"), not just
  internal consistency — the gap that let the strawman routing benchmark through.
- **Keys & budget are a Phase-0 decision**: which providers, what monthly ceiling
  for CI + benches. This gates Phase 1.

---

## 7. Sequencing summary

| Phase | Moves | North-Star effect | Gate |
|---|---|---|---|
| 0 Credibility + scoreboard | honest docs, `bench vtph`, eval set | defines the metric | real baseline printed |
| 1 Brain + MCP | real inference, tool loop, MCP client | baseline → real | **go/no-go: ≥3× visible** |
| 2 Real I/O | inbound gateway, WS wire, one remote backend | enables real runs | 2-process swarm runs |
| 3 Grounded verify + security | cross-model/tool grounding, ed25519, hardened docker | trust becomes real | red-team catch-rate measured |
| 4 Scale 10× | cheap-worker/strong-verifier, adaptive concurrency | **≥10× V-TPH$** | reproducible table |
| 5 Real learning | retrieved memory, gated skill distillation | V-TPH$ rises run-over-run | learning curve shown |
| 6 Ecosystem | MCP server, skills compat, demo | moat lock-in | external agent calls Hades |

**The one-sentence strategy:** stop counting Map lookups and start proving that a
cheap, isolated, verification-gated swarm does *more correct, auditable work per
dollar* than a single frontier agent — the one axis where 10× is real and the one
moat Hermes can't copy by shipping another 1,000 PRs.
