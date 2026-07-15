# HADES ASCENSION — from simulation to the agent that beats Hermes

**Mission:** take Hades up an order of magnitude — from a well-tested orchestration
simulation (0 users, no brain wired, no inbound I/O) to a real agent that is
**more powerful than Hermes where it matters**: verified work, swarm parallelism,
isolation-first security, and inherited ecosystems.

**Grounding:** this plan is built directly on the 2026-07-15 adversarial audit
(three-agent team: Hermes web research, Hades inventory, hollow-claims audit).
Every phase closes a named audit gap or widens a named advantage.

---

## Strategy — asymmetric, not imitative

Hermes' strengths are breadth (~90 tools, 7 platforms, marketplace) and velocity
(~1,000 PRs/release). We cannot out-breadth a 215k-star community, and we should
not try. The plan is asymmetric:

1. **Inherit ecosystems instead of rebuilding them.** First-class **MCP client**
   (thousands of existing tool servers become Hades tools) + implement the
   **agentskills.io standard** (Hermes' own Skills Hub becomes *our* skill
   library). One iteration of interop ≈ fifty iterations of tool-writing.
2. **Weaponize what Hermes lacks.** Hermes is one agent that trusts itself.
   Hades is a **swarm that proves its work**: manager → parallel workers →
   verification gate → consensus → audited synthesis. Nobody else ships this.
   Make "leave it alone overnight and trust what you find in the morning" the
   product.
3. **Truth as a feature.** The audit showed our own README oversold. The fix is
   structural: every claim in docs must be backed by a runnable check
   (`hades verify-claims`), and CI carries a **reality lane** (wire-protocol
   fakes over real sockets, real child processes, real containers) so
   "1,444 green tests" can never again mean "95% in-memory fakes."

**Definition of power (the Order-of-Magnitude Scorecard):**

| Metric | Today (audited baseline) | Target |
|---|---|---|
| Real end-to-end tasks completed autonomously | **0** (DemoExecutor counts words) | ≥80% on a 50-task suite (research, code, 