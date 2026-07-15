# Hades 10× Loop — Phase 0 + Phase 1 (agent-team driven)

**Goal:** execute Phases 0–1 of [`HADES_BEYOND_HERMES.md`](./HADES_BEYOND_HERMES.md):
build the honest **V-TPH$** scoreboard (Verified Tasks per Hour per Dollar) and
give Hades a **real brain** (real multi-provider inference, a real tool-calling
worker loop, MCP client, a real REPL brain). Multi-provider fan-out for inference.

**How every iteration runs (non-negotiable):**
1. Pick the next `[ ]` item.
2. Spawn a team of 2–4 subagents in parallel — each owns DISTINCT new files
   (never touch `index.ts`/existing files; the main loop wires exports). At least
   one **adversarial verifier**, and — new for this loop — that verifier attacks
   **external validity** ("is this fair to a real system / real model? is the cost
   accounting right? would this pass with a real LLM?"), not just internal
   consistency.
3. Integrate centrally: wire exports, `tsc --noEmit -p tsconfig.lib.json` clean,
   `npx vitest run` fully green.
4. **Real inference is behind injectable clients**: logic is unit-tested with
   fakes (keep the 1444 green); a **keyed smoke lane** runs the real path when
   provider keys are present (skipped, not failed, when absent).
5. Commit to `claude/hermes-swarm-framework-vbhrot`; tick the box + log; push.
6. Never regress a green iteration. No simulated numbers presented as real.

Baseline: 1444 tests / 169 files green. No real inference wired. Credibility reset
done (README/CHANGELOG/HADES_BENCHMARKS captions corrected).

---

## Phase 0 — Credibility reset & the real scoreboard
- [x] 0.1 **Credibility reset**: correct false README/CHANGELOG/benchmark claims (signed-by-default, "beats Hermes", routing/makespan captions). *(done centrally)*
- [x] 0.2 **V-TPH$ harness** (`bench/vtph.ts`): runs a task suite through an injectable `AgentRunner`, records verifiedCorrect / silentWrong / wallClock / tokens / usd / provenance, computes `vtph` and `vtphPerDollar`; `compareVtph` for head-to-head + markdown table. *(8 tests; adversary proved liar scores 0.)*
- [x] 0.3 **Eval suite** (`bench/eval-suite.ts`): 48 LLM-shaped but programmatically-gradable tasks (extraction / classification / transformation / reasoning / arithmetic / multi-part; 14 decomposable), each with a pure `grade(output)`. *(55 tests; every grader rejects wrong + empty.)*
- [x] 0.4 **Multi-provider model client** (`models/client.ts`): real `ModelClient` (OpenAI-dialect + Anthropic-native over injectable fetch) + `MultiProviderClient` fan-out with per-model **cost accounting** and rate-limit-aware concurrency. *(12 tests; cost accounting + concurrency ceiling proven.)*
- [x] 0.5 **Scoreboard CLI** (`hades bench vtph`): `bench` subcommand runs the suite through an injectable runner and prints the V-TPH$ table. Honest Phase-0 default declines every task → verified-correct 0 (the true baseline). *(Runs end-to-end; wired into the CLI router.)*
- [ ] 0.6 **`hades verify-claims`** *(salvaged idea)*: a command that maps each load-bearing README/docs claim to a runnable check and reports pass/fail, so the docs can never drift back into overselling. CI runs it.
- [ ] 0.7 **CI "reality lane"** *(salvaged idea)*: a test tag/lane that exercises real sockets, real child processes, and (when Docker is present) a real container — so the green-test count reflects integration, not only in-memory fakes. Feeds Phase 2/3.

## Phase 1 — Give it a brain + inherit Hermes' tools (MCP)
- [ ] 1.1 **Real worker brain wiring**: select a real model/executor in the default swarm path when keys exist (`--model`, `SWARM_MODEL` propagation); deterministic executor only when explicitly offline. (Central wiring + a new adapter file; keyed smoke test.)
- [x] 1.2 **Real tool-calling loop** (`agent/loop.ts`): a ReAct loop (ANSWER/TOOL protocol) over an injected `ModelClient` + `ToolRegistry`, hard step-cap so it always terminates, token/usd accounting, never throws. *(10 tests.)*
- [x] 1.3 **In-box real toolset** (`agent/tools.ts`): 8 real sandboxed tools — `calc` via a hand-written parser (NO eval; rejects code payloads), extract/json/transform helpers — behind a total `ToolRegistry`. *(15 tests; adversary confirmed no eval, safe.)*
- [x] 1.2b **Verification-gated runner** (`agent/runner.ts`): `verifiedSwarmRunner` (worker loop + a SEPARATE, optionally stronger, fail-closed verifier model call; counts both costs) and `singleAgentRunner` (self-trust baseline). Wired into `hades bench vtph --swarm|--single` and `hades bench headtohead` (go/no-go table + 3x gate; honest "needs keys — no simulated numbers" without keys). *(11 tests; brain adversary 16 tests proved the gate drives silent-wrong 0 vs the baseline's 1 on an identical wrong answer.)*
- [ ] 1.4 **MCP client** (`hades/mcp/client.ts`): speak MCP (stdio + HTTP) so external MCP tool servers plug in — inherit the ecosystem instead of rebuilding it. Conformance test against a local mock MCP server.
- [ ] 1.5 **Real REPL brain** (`repl` wiring): construct a real `ConversationBrain` over the multi-provider client so `hades chat` holds a real conversation (keyed).
- [~] 1.6 **GO/NO-GO — real head-to-head**: `hades bench headtohead` is fully wired (single-agent vs verified-swarm over the 48-task suite, real multi-provider client from env keys, V-TPH$ table + 3× gate verdict). Proven end-to-end on fake clients (16 adversary tests). **Awaiting a keyed run** in an environment with `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` to record the true number — the command refuses to print simulated numbers without keys.

---

## Iteration log
_(newest last)_

- **Phase 1 core — Hades has a brain.** Team: 3 builders (toolset / ReAct loop / verification-gated runner) + 1 brain adversary. `agent/tools.ts` (8 sandboxed tools, calc via a real parser — no eval), `agent/loop.ts` (a terminating ReAct tool-calling loop over an injected `ModelClient`), `agent/runner.ts` (`verifiedSwarmRunner` = worker loop + a separate fail-closed verifier model that counts its own cost, and `singleAgentRunner` = the self-trusting baseline). Wired into `hades bench vtph --swarm|--single` and `hades bench headtohead` (real multi-provider client from env keys; go/no-go V-TPH$ table + 3× gate; honest "needs keys, no simulated numbers" otherwise). **The brain adversary (16 tests) proved the whole thesis in code:** the gate catches a lying worker — swarm `silentWrong=0` (declines) vs single-agent `silentWrong=1` (trusts the same wrong answer) — the verifier's spend is counted (no V-TPH$ lie), calc can't be exploited, and the loop always terminates. Builders 15+10+11 + adversary 16 tests. Full suite green (1584 / 177 files). The only thing between here and a real 10× number is a keyed run.

- **0.2–0.5 — the honest scoreboard is live.** Team: 3 builders + 1 external-validity adversary. `bench/vtph.ts` computes **V-TPH$** and classifies every task as verified-correct / silent-wrong / declined; `bench/eval-suite.ts` is 48 decomposable gradable tasks; `models/client.ts` is a real multi-provider client with exact cost accounting + a concurrency semaphore. The adversary (13 tests) proved the metric is **un-gameable**: a runner claiming "verified" on all 48 wrong answers scores `vtph=0`, `vtphPerDollar=0`, `silentWrong=48` — lying earns zero throughput and maxes the trust-failure counter; graders have teeth; cost accounting is real; concurrency ceilings bind. `hades bench vtph` runs end-to-end and prints the honest baseline (**48 tasks, 0 verified — no brain yet**), which is exactly what Phase 1 must move. Builders 8+55+12 + adversary 13 tests. Full suite green (1532 / 173 files).

- **0.1 — credibility reset.** Corrected README (security "opt-in not default-wired", routing = count ratio, makespan = virtual-clock model with wall-clock favoring flat, connectors/backends real-status table, dropped "more capable than Hermes"), CHANGELOG + HADES_BENCHMARKS scope notes, all pointing at the honest V-TPH$ roadmap. No code claims left that the audit falsified.
