# STYX — a provenance-carrying, abstention-by-default, verifier-guided speculative swarm

*(Named for the river of Hades: the oath sworn on the Styx is the one even gods
cannot break. Styx is the oath system for agent output.)*

## What this is, in one sentence

**Styx races cheap workers down divergent task-decomposition branches, scores
every branch with a calibrated, tool-grounded verifier ensemble that acts as a
fitness function, allocates compute across the live branch tree with a
budget-optimal bandit whose reward is verified-work-per-dollar, and emits ONLY
results that clear a conformal abstention gate — each wrapped in a signed
Verification Certificate — so the silent-wrong rate is a provable, tunable bound
(ε), not a hope.**

No weight updates. Pure inference-time orchestration.

## Why this is new (novelty audit, from three independent literature maps)

Every *component* has prior art. The *fusion* does not exist under any name:

| Component | Closest prior art | What Styx does differently |
|---|---|---|
| Population + evaluator-as-fitness | FunSearch (Nature 2023), AlphaEvolve (2025) | Fitness domain is **general task-decomposition branches**, not programs; fitness is a **calibrated LLM/tool verifier ensemble**, not unit tests |
| Speculative execution + rollback | Speculative decoding (arXiv:2211.17192), Sherlock (2511.00330), SpecBranch (2506.01979) | Those are **latency-first & lossless** (same trajectory, faster). Styx is **quality-first**: divergent branches are raced and most are *discarded by design* — pruning is the mechanism, not waste |
| Verifiable rewards | RLVR (Tülu-3, DeepSeek-R1), TTRL (2504.16084) | Those apply the reward as a **training gradient** (TTRL still updates weights at test time). Styx uses the verifiable reward as a **pure orchestration signal** — zero training |
| Test-time compute allocation | Snell (2408.03314), bandit BoN (2506.12721), BaSE (2605.29268), Archon (2409.15254) | Those allocate over **i.i.d. answer samples** or **offline pipelines**. Styx runs an **online bandit over a live, speculatively-expanding decomposition tree**, reward = verifier-fitness per dollar |
| Cost routing | RouteLLM (2406.18665), FrugalGPT (2305.05176) | Those optimize **predicted** quality at fixed cost. Styx optimizes **verified**-correct-work-per-dollar with **verification spend itself a decision variable** — the gap the multi-agent map ranked #1 unoccupied |
| Verification | GenRM (2408.15240), Weaver (2506.18203), Clover (2310.17807), conformal factuality (2402.10978) | Each exists in isolation. Styx composes them into a **verifier-tier router → calibrated ensemble → conformal gate → signed certificate** closed loop |

**The single nearest whole system is AlphaEvolve** — which lacks speculative
decomposition, LLM-verifier fitness, general-agentic scope, and provenance.

## The five load-bearing design constraints (from the literature, non-negotiable)

1. **Naive self-verification collapses.** LLMs cannot reliably self-correct
   (Huang et al., 2310.01798); same-family judges rubber-stamp (self-preference
   bias, 2410.21819). → Every Styx verifier must hold an **information edge**
   over the generator: tool execution, reference retrieval, a clean context
   (Cross-Context review), or a different model family. A same-context "are you
   sure?" is worth zero and is banned as a tier.
2. **A single LLM verifier fails at scale.** Verifier-guided search can
   *underperform* plain best-of-N as N grows, because false positives compound
   (Scaling Flaws, 2502.00271); precision, not recall, is the bottleneck.
   → Fitness = a **Weaver-style label-free weighted ensemble** of weak verifiers,
   distillable to a cheap gate, with calibration-aware discounting *inside* the
   controller.
3. **Verifiers get gamed.** RLVR reward-hacking is inevitable under sustained
   optimization of an imperfect proxy (Verification Horizon; 2604.15149).
   → Standing **isomorphic-perturbation checks** (a passing answer must keep
   passing under semantics-preserving rewrites) + held-out verifier rotation.
4. **Verification is provably worth it.** Verifier-based test-time scaling beats
   verifier-free by Ω(√H) (2502.12118); coverage scales as a power law with
   samples but converting coverage→accuracy is bottlenecked entirely by
   selection (Large Language Monkeys, 2407.21787). Styx's whole bet sits on the
   right side of this theorem.
5. **Provenance ≠ truth.** Signed traces prove *what ran*, never that the answer
   is *correct*. The certificate keeps the two legs separate: a correctness leg
   (calibrated P(correct), conformal ε) and an integrity leg (signed, replayable
   trace). Neither may masquerade as the other.

## Architecture

```
            task
              │
     ┌────────▼────────┐
     │  SPECULATOR      │  propose K divergent decomposition branches
     │  (cheap models)  │  (plans, not answers — different splits/strategies)
     └────────┬────────┘
              │ branches
     ┌────────▼────────────────────────────────┐
     │  BANDIT CONTROLLER (budget-optimal)      │
     │  arms = live branches × worker configs   │
     │  reward = calibrated fitness Δ per $      │
     │  expand / advance / prune / stop          │◄─── budget, deadline
     └────────┬────────────────────────────────┘
              │ allocations
     ┌────────▼────────┐        ┌───────────────────────────────┐
     │  CHEAP WORKERS   │ ─────► │  VERIFIER-TIER ROUTER          │
     │  execute branch  │ result │  T0 execution oracle (Clover-  │
     │  steps in        │        │     style: 0 false positives)  │
     │  isolation       │        │  T1 reference/retrieval        │
     └─────────────────┘        │     entailment                 │
                                 │  T2 GenRM rubric (clean ctx,   │
                                 │     different family)          │
                                 │  T3 cross-model agreement      │
                                 │  T4 consistency-only           │
                                 │  → Weaver-style calibrated     │
                                 │    ensemble score              │
                                 └──────────────┬────────────────┘
                                                │ calibrated P(correct)
                                 ┌──────────────▼────────────────┐
                                 │  CONFORMAL ABSTENTION GATE     │
                                 │  emit iff P(correct) clears τ(ε,│
                                 │  tier); else escalate tier or   │
                                 │  ABSTAIN (never silent-wrong)   │
                                 └──────────────┬────────────────┘
                                                │ accepted result
                                 ┌──────────────▼────────────────┐
                                 │  VERIFICATION CERTIFICATE      │
                                 │  ed25519-signed: output hash,  │
                                 │  tier, score, P(correct), ε,   │
                                 │  trace hash, verifier versions │
                                 └───────────────────────────────┘
```

### The six primitives

1. **Speculative Decomposition Market** — the speculator proposes K *divergent*
   decompositions (not K samples of one plan). Branches execute speculatively in
   parallel on cheap models. Pruning a branch is success, not waste — the
   quality-first inversion of speculative execution.
2. **Verifier-tier router** — route every branch result to the *strongest
   applicable* verifier tier (T0 execution oracle → T4 consistency). The
   abstention threshold **rises as the tier weakens**: weak verifier ⇒ higher
   confidence bar or decline.
3. **Calibrated ensemble fitness** — many weak verifiers, label-free
   accuracy-weighted aggregation (Dawid–Skene-style), producing one calibrated
   P(correct) per branch state. This number is simultaneously (a) the bandit's
   reward signal, (b) the gate's input, (c) the certificate's correctness leg.
4. **Budget-optimal bandit controller** — arms are (branch × action) pairs
   {expand, advance, verify-harder, prune}; reward is expected calibrated-fitness
   gain per dollar; stops when marginal verified-value < marginal cost. V-TPH$
   is the objective *inside* the loop, not just the scoreboard outside it.
5. **Conformal abstention gate** — calibration set + conformal risk control give
   a **distribution-free bound: P(silent-wrong) ≤ ε** at a user-set ε, with
   abstention minimized subject to that. "Never deliver an unverified result" as
   a theorem-shaped property, not a slogan.
6. **Verification Certificate** — an ed25519-signed envelope binding output hash
   + verifier ids/versions + tier + calibrated score + ε + replayable trace
   hash. Downstream consumers verify cheaply and reject anything uncertified —
   proof-carrying code, generalized to agent work.

## Why it can outperform (the honest math)

- **Coverage is cheap:** pass@N scales as a power law with cheap samples
  (2407.21787) — a Haiku-class swarm buys coverage a frontier single-shot can't.
- **Selection is the bottleneck and we attack exactly that:** the ensemble
  verifier converts coverage into accuracy; Ω(√H) says this beats verifier-free
  scaling asymptotically (2502.12118).
- **Spend goes only where multi-agent provably wins:** parallel breadth with
  independent contexts (Anthropic's +90% research finding), never chat-consensus
  (the MAST failure sink).
- **The trust dimension is categorical:** a provable ε bound on silent-wrong +
  signed certificates unlocks audited work no self-trusting agent (Hermes
  included) can serve at any price.

## Falsifiable claims (what the V-TPH$ scoreboard must show)

1. On the decomposable eval suite with real inference, Styx's V-TPH$ ≥ 3× a
   single self-trusting frontier agent (go/no-go), targeting 10×.
2. Measured silent-wrong rate ≤ the configured ε on held-out tasks.
3. The bandit controller beats uniform allocation by ≥ 20% verified-work-per-$
   at equal budget.
4. Certificate verification rejects 100% of tampered outputs/traces.
5. Isomorphic perturbation catches ≥ half of injected verifier-gaming attempts
   that the raw ensemble misses.

If (1) fails after tuning, the thesis is wrong and we say so.

## Build order (each iteration: parallel builders + adversarial verifier)

- **S1 — Trust kernel (keyless):** conformal abstention gate (`styx/gate.ts`),
  ed25519 Verification Certificate (`styx/certificate.ts`), verifier-tier router
  + label-free ensemble calibration (`styx/tiers.ts`).
- **S2 — Search kernel (keyless):** speculative branch tree + bandit controller
  (`styx/branches.ts`, `styx/controller.ts`), simulated workers/verifiers with
  known ground truth so allocation optimality is *testable*.
- **S3 — Anti-gaming:** isomorphic perturbation harness + verifier rotation
  (`styx/perturb.ts`); red-team suite where scripted gaming strategies must be
  caught.
- **S4 — Real-inference binding:** Styx runner implementing the V-TPH$
  `AgentRunner` interface over the multi-provider client; `hades bench styx`
  head-to-head vs single-agent and vs the Phase-1 verified-swarm runner (keyed).
- **S5 — Verified-work-market settlement:** certificate-gated acceptance wired
  into the swarm manager; the incentive-compatible bid/settle loop.

## Key citations

Snell 2408.03314 · Brown (Monkeys) 2407.21787 · Setlur 2502.12118 · Scaling
Flaws 2502.00271 · GenRM 2408.15240 · Weaver 2506.18203 · Lightman 2305.20050 ·
Huang self-correct 2310.01798 · self-preference 2410.21819 · TTRL 2504.16084 ·
FunSearch Nature 2023 · AlphaEvolve 2025 · Sherlock 2511.00330 · SpecBranch
2506.01979 · spec decoding 2211.17192 · RouteLLM 2406.18665 · FrugalGPT
2305.05176 · MoA 2406.04692 · More-LLM-Calls 2403.02419 · MAST 2503.13657 ·
Khan debate 2402.06782 · Irving debate 1805.00899 · Clover 2310.17807 · conformal
factuality 2402.10978 · conformal abstention 2405.01563 · Trust-or-Escalate
2407.18370 · semantic entropy Nature 2024 · Archon 2409.15254 · BaSE 2605.29268 ·
PCC Necula & Lee 1996. (2026-dated IDs flagged unverified in the research logs.)
