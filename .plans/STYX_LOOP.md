# STYX Build Loop — the novel verifier-guided speculative swarm

Design: [`docs/STYX_ARCHITECTURE.md`](../docs/STYX_ARCHITECTURE.md). Thesis: make
**verification the first-class, calibrated, economically-priced object** — a
primitive with no prior art under any name (nearest: AlphaEvolve, Archon,
Sherlock). Every stage: parallel builders + ≥1 adversary attacking *external
validity*; `tsc` clean; suite green; real numbers only.

## Stages
- [x] **S1 — Trust kernel** (keyless). `styx/gate.ts` (conformal abstention, provable
  P(silent-wrong) ≤ ε), `styx/certificate.ts` (ed25519 proof-carrying output),
  `styx/tiers.ts` (verifier-tier router + label-free Dawid–Skene ensemble).
  **Adversary 24 tests: bound holds ~exactly at ε over 40 MC splits; cert
  unforgeable; liars demoted; correlated-bias limit demonstrated.** Suite 1652.
- [x] **S2 — Search kernel** (keyless). `styx/branches.ts` (speculative
  decomposition tree) + `styx/controller.ts` (UCB-over-branches bandit; reward =
  fitness-gain/$). **Adversary 121 tests: spent ≤ budget always; controller beats
  uniform by 1.88× verified-work-per-$ (bar was 1.2×); spend skewed ~10× to good
  branches; honest pruning (no refund).** Suite 1796.
- [ ] **S3 — Anti-gaming**. `styx/perturb.ts`: isomorphic-perturbation harness
  (a passing answer must keep passing under semantics-preserving rewrites) +
  held-out verifier rotation. Red-team suite: scripted gaming strategies must be
  caught; directly targets the S1 correlated-bias limitation.
- [ ] **S4 — Real-inference binding** (keyed). A Styx `AgentRunner` (speculate →
  bandit-race cheap workers → tier-route + ensemble-verify → conformal gate →
  certificate) over the multi-provider client; `hades bench styx` head-to-head vs
  single-agent and vs the Phase-1 verified-swarm. Records real V-TPH$. Refuses to
  print numbers without keys.
- [ ] **S5 — Verified-work-market settlement**. Certificate-gated acceptance in
  the swarm manager; incentive-compatible bid/settle loop (bids settled against
  the verifier; verification spend a decision variable).

## Falsifiable targets (from the design doc)
1. Styx V-TPH$ ≥ 3× single-agent (go/no-go), target 10× — **S4, keyed.**
2. Measured silent-wrong ≤ ε on held-out — **S1 ✓ (synthetic); S4 (real).**
3. Bandit beats uniform by ≥ 20% verified-work/$ — **S2 ✓ (measured 1.88×).**
4. Certificate rejects 100% of tampered outputs — **S1 ✓.**
5. Perturbation catches ≥ half of gaming attempts the raw ensemble misses — **S3.**

## Log
- **S1 complete.** Trust kernel built by 3 builders + 1 external-validity
  adversary (24 tests). The core novel claim — a distribution-free, tunable bound
  on silent-wrong — holds empirically and tightly (mean realized wrong-rate ≈ ε
  across 40 Monte-Carlo splits), with genuine unforgeable ed25519 certificates and
  label-free verifier calibration that demotes a lying verifier to 0.13 weight.
  Full suite green (1652 / 182 files).
