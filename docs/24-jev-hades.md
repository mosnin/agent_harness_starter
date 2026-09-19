# Hades — Jev theory, install, and everything that was wired

Hades is the Jev-powered preset for this harness. It follows the LangChain pattern from [Building a Harness with Jev](https://www.langchain.com/blog/building-a-harness-with-jev):

> Use an LLM for open-ended reasoning and generation, and Jev for fast, structured decisions along the way.

This document is the install guide and the theory of record for what shipped.

---

## 1. Theory

### What Jev is

Jev is TypeSafe’s **System One** model. It is not a chat model. It does not write prose, plans, or tool calls. You send:

1. A **state** object (the evidence: user message, tool args, draft, passages, …)
2. A map of **typed questions**

You get back calibrated answers in ~70–500ms. Every question in one request is evaluated **in parallel**. Adding a noul barely changes latency.

Three question types:

| Type | Meaning | Answer |
|---|---|---|
| `noul` | Probability that a proposition is true (0–1) | `{ type: "noul", noul }` |
| `choice` | Closed catalog with named criteria | `{ type: "choice", choice, probabilities, confidence }` |
| `score` | Ordered Likert / severity scale | `{ type: "score", score, legend, probabilities, confidence }` |

Code owns thresholds. Jev owns the scores. That split is the whole design.

### Why this is an order of magnitude better than LLM-as-judge

An LLM judge is another generator. It can waffle, invert a label, or invent a rubric. Jev cannot generate; it can only fill a typed schema. The harness then applies **gates**:

- minimum `confidence`
- minimum `P(chosen option)`
- minimum margin vs runner-up (`P(winner) − P(second)`)

If a gate fails, the action is `review` or `fallback` — never a silent auto-approve on a mushy distribution.

### Fail-open vs fail-closed

| Hop | When Jev is down / unconfigured |
|---|---|
| Model / skill routing | **Fail open** — keep the current Qwen route |
| Input screen, output screen, Auto Mode, RAG filter, git-risk | **Fail closed** — block the hop or drop the data |
| Stop-hook | **Fail open** — do not discard a finished draft because the hook could not run |
| Voice intent | **Fail to clarify** — do not execute |

That is the LangChain + jev-router / jev-judgment contract: routing may be cheap and optimistic; security may not.

### What Qwen and OpenAI are for

- **Qwen via OpenRouter** — the only component that writes. Fast / balanced / powerful routes.
- **OpenAI** — Whisper STT and TTS only. Voice never decides.
- **Jev** — every structured decision on the path.

```
OpenAI STT ─┐
User text ──┼─► Jev screen + route ─► Qwen (OpenRouter) ─► Jev Auto Mode on tools
Tool results┘         │                      │
                      │                      ▼
                      └──────────────► Jev output screen ─► OpenAI TTS
```

---

## 2. Install

### Environment

Copy `.env.example` → `.env.local`:

```bash
AGENT_PROVIDER=hades

# Required for decisions
TYPESAFE_API_KEY=...          # https://typesafe.ai
JEV_MODEL=jev-latest
JEV_TIMEOUT_MS=2500

# Required for generation
OPENROUTER_API_KEY=...
HADES_MODEL=qwen/qwen-2.5-72b-instruct
HADES_FAST_MODEL=qwen/qwen3-32b
HADES_BALANCED_MODEL=qwen/qwen-2.5-72b-instruct
HADES_POWERFUL_MODEL=qwen/qwen3-235b-a22b

# Required only for voice
OPENAI_API_KEY=...
HADES_STT_MODEL=whisper-1
HADES_TTS_MODEL=gpt-4o-mini-tts
HADES_TTS_VOICE=alloy

# Optional: expose jev_* on /api/mcp (auth required)
HADES_MCP_JEV=false
```

Without `TYPESAFE_API_KEY`, `createJevAsker().ask()` returns `{ ok: false, reason: "jev-unconfigured" }`. Routing stays fail-open; screens and Auto Mode stay fail-closed.

### Drop-in files

| File | Where it goes |
|---|---|
| `routes/hades/route.ts` | `app/api/hades/route.ts` |
| `routes/voice/route.ts` | `app/api/voice/route.ts` |
| `routes/agent/route.ts` | `app/api/agent/route.ts` (already uses Hades when `AGENT_PROVIDER=hades`) |
| `components/AgentChat` | any client page |

### One-liner

```ts
import { createHadesHarness } from "@/agents";

const hades = createHadesHarness({
  name: "Hades",
  instructions: "You are Hades. Jev already routed this task; do the work.",
  tools: ["web_search"],
  memoryKey: "userId",
});

const result = await hades.run({
  messages: [{ role: "user", content: "Summarize yesterday's incidents." }],
});
```

Or set `AGENT_PROVIDER=hades` and keep calling `/api/agent`. The research / code / hades example agents all run through `createHadesHarness` in that mode.

Registered example: `agentName: "hades"` (`src/agents/examples/hades-agent.ts`).

### Verify the install

```bash
npx tsc --noEmit
npx vitest run
```

Expected: TypeScript clean, full suite green (612+ tests). Jev unit coverage lives in `src/agents/__tests__/jev.test.ts`, `hades.test.ts`, and `jev-live-paths.test.ts`.

---

## 3. How a run actually moves

1. **Ingress** — `/api/agent`, `/api/hades`, or `/api/voice` (auth required). Voice clips larger than 8 MiB are rejected (`413`).
2. **Voice intent** (voice only) — heuristic cancel, then `classifyVoiceIntent`. `unsafe` / `out_of_scope` / `clarify` never reach Qwen.
3. **`withJev.onBeforeRun`**
   - `screenExternal` (injection / secrets / substance). Jev-down → **block**.
   - Optional `decideCompaction` on long threads.
   - `routeModel` → `ctx.hadesModel` / `hadesRoute` (Qwen fast/balanced/powerful).
   - `routeSkill` (map-reduce if the catalog is > 8).
   - Each decision is queued as a `jev_decision` SSE event.
4. **`withMemory`** — retrieve, then `filterPassages`. Jev-down → **drop all memories** (no poisoned prompt).
5. **Qwen generates** and may call tools.
6. **`wrapTools`**
   - `assessToolRisk` (Auto Mode). Git-looking commands get `assessGitRisk` first. Jev-down → **block**.
   - `review` → HITL approval. `block` → `GuardrailBlockError`.
   - `web_search` results are planned + reranked (`planAndRerankSearch`).
   - Failed `shell_exec` output is classified (`classifyCommandFailure`); secret-leaking stderr is blocked.
7. **`onAfterRun`** — `screenOutput` (Jev-down → **block**), then limpet `stopHook` (advisory event).
8. **TTS** if this was a voice turn.

Core (`src/agents/core.ts`) drains `pendingPluginEvents` after `onBeforeRun` and after `onAfterRun`, so the UI sees Jev decisions even when no tool ran.

---

## 4. Module map (everything that was built)

All under `src/agents/jev/`:

| File | Job | Lineage |
|---|---|---|
| `questions.ts` | `noul` / `choice` / `score` builders + hardening | TypeSafe cookbooks |
| `validate.ts` | Strict answer shape, probability sum, choice ∈ criteria | super-jev / jcm-router |
| `client.ts` | HTTP `POST https://api.typesafe.ai/v1/systemone`, mock client | official wire format |
| `policy.ts` | Gates, `NOUL`/`SCORE` thresholds, fail-open/closed | jev-router, jev-judgment |
| `catalog.ts` | Qwen routes + default skills + Likert legends | LangChain ModelRouter |
| `router.ts` | `routeModel`, `routeSkill`, `routeIntent` | LangChain + jev-router / jcm / notra / GodsBoy |
| `mapreduce.ts` | Batch Choice over large catalogs, beam tree | jev-bfs, hierarchical classification |
| `auto-mode.ts` | Destructive / exfil / scope + git pre-pass | AutoModeMiddleware, jev-judgment |
| `guardrails.ts` | Input/output screens, citations, malware | safer-with-jev, jev-review, is-malicious |
| `scoring.ts` | Slop / quality / rerank / page grade | JevSlop, jev-search, pagegrade |
| `decisions.ts` | quiet-ask, completion, compaction, browser step, cmd fail | pi-quiet-ask, limpet, Foreman |
| `rag.ts` | Passage relevance + injection filter | TypeSafe RAG cookbook, jev-search |
| `extract.ts` | find / extract / compare / bind / SDE cascade | jev-mcp cookbooks |
| `search.ts` | Time window + source nouls + rerank | jev-search |
| `hooks.ts` | Stop-hook, heed policy, git-risk, voice intent | limpet, pi-heed, jev-git |
| `orchestrate.ts` | Specialist router, `jevWhen`/`jevUntil`, swarm pick | GodsBoy, notra |
| `events.ts` | Queue `jev_decision` onto the harness stream | this harness |
| `curate.ts` / `eval.ts` | Triage, labels, Brier / accuracy | jev-curate, calibration repos |
| `symbolic.ts` | Foreman supervisor, patch verdict | Foreman, jev-code |
| `company.ts` | Company-OS action approval | opencompany |
| `audit.ts` | In-process decision log | — |
| `mcp.ts` | `jev_*` tools (opt-in, auth required) | jev-mcp / decide-mcp |

Plugins / presets:

- `src/agents/plugins/jev.ts` — `withJev`
- `src/agents/plugins/memory.ts` — `jevFilter`
- `src/agents/hades/index.ts` — `createHadesHarness`
- `src/agents/orchestrator.ts` — `jevRouter: true`
- `src/agents/workflow` — `jevWhen` / `jevUntil`
- `src/agents/swarm/coordinator.ts` — `submitTaskJev`

---

## 5. Live-path integrations

These sit on real hops, not helper-only APIs:

| Path | What Jev does |
|---|---|
| `withMemory({ jevFilter: true })` | Drop injected / irrelevant RAG passages. Empty set if Jev is down. |
| `routeSkill` | Map-reduce over catalogs larger than 8 |
| `createOrchestrator({ jevRouter: true })` | Pick a specialist before the LLM router |
| `jevWhen` / `jevUntil` | Workflow branch + loop stop |
| `SwarmCoordinator.submitTaskJev` | Assign among capable agents |
| `withJev` stop-hook | Incomplete-reply check (event only) |
| `assessToolRisk` | Extra git-risk pass on `git` / `shell_exec` |
| `web_search` wrap | Intent + sources, then rerank |
| `shell_exec` wrap | Classify failures; block secret leaks |
| `voiceTurn` | `execute_now` / `clarify` / `out_of_scope` / `unsafe` |
| `AGENT_PROVIDER=hades` | `/api/agent` uses `createHadesHarness` |
| Agent Chat | Streams `jev_decision`; optional Voice button → `/api/voice` |

```ts
import { createOrchestrator, createWorkflow, jevWhen, jevUntil, branch, loop } from "@/agents";

const orch = createOrchestrator({
  routerAgent,
  specialists: [billing, engineering],
  jevRouter: true,
});

const workflow = createWorkflow("review")
  .add(branch("risk", [
    { when: jevWhen({ question: "Does this draft need a human reviewer?" }), step: reviewStep },
  ], autoStep))
  .add(loop("polish", draftStep, { until: jevUntil({}), maxIterations: 3 }))
  .build();
```

---

## 6. Middleware mapping (LangChain)

```ts
import { withJev, createHadesHarness } from "@/agents";

const harness = createHadesHarness({
  name: "Support",
  instructions: "...",
});
```

| LangChain | Hades |
|---|---|
| `ModelRouterMiddleware({ fast, powerful })` | `routeModel` / `HADES_QWEN_ROUTES` |
| `AutoModeMiddleware(tools=["bash"])` | `assessToolRisk` inside `wrapTools` |
| `TypeSafeClassifier.invoke(state, questions)` | `createJevAsker().ask(...)` |

Default Qwen routes:

| Route | Model | When |
|---|---|---|
| `fast` | `qwen/qwen3-32b` | Lookups, extraction, greetings |
| `balanced` | `qwen/qwen-2.5-72b-instruct` | Typical agent work |
| `powerful` | `qwen/qwen3-235b-a22b` | Architecture, high-stakes, novel debugging |

Overrides: `!fast`, `!balanced`, `!powerful` in the user message. Follow-ups with `is_followup ≥ 0.55` reuse the pinned route (jcm-router). Low-confidence *upgrades* are capped. Downgrades that would bust a large prompt cache are skipped.

---

## 7. Question catalog (what we actually ask)

- **Routing** — complexity score, `requires_tools`, `is_followup`, route choice
- **Skills** — specialist vs `__no_skill__` vs `__review__` + need/review nouls
- **Guardrails** — injection, substance, secret leak, output policy, citations, malware
- **Auto Mode** — destructive / exfil / beyond-scope + impact + authorized/routine
- **Git** — force-push, unrecoverable, authorized
- **RAG** — per-passage relevance + “instructions to an agent”
- **Search** — time window, per-source nouls, per-result relevance
- **Decisions** — quiet-ask, completion, compaction, browser step, command failure
- **Voice** — execute / clarify / cancel / unsafe
- **Stop-hook** — plan-instead-of-artifact, missing verification, unearned success
- **Symbolic** — Foreman supervisor, patch verdict
- **Company OS** — authorized + routine (`deploy_prod`, transfers, key rotation always HITL)
- **Curation / eval** — triage, keep/skip, Brier + accuracy

---

## 8. Using Jev directly

```ts
import { choice, noul, createJevAsker } from "@/agents";

const asked = await createJevAsker().ask({
  state: { ticket: "I was charged twice. Fix this ASAP." },
  questions: {
    urgent: noul("Does this need attention right now?"),
    team: choice("Which team?", { billing: "Money", technical: "Bugs", other: "Else" }),
  },
});

if (asked.ok && asked.result.answers.urgent.type === "noul") {
  if (asked.result.answers.urgent.noul > 0.9) { /* page on-call */ }
}
```

`createMockJevClient` validates answers against the question map — tests cannot smuggle an illegal choice.

---

## 9. Voice

```ts
const spoken = await hades.voiceTurn(audioBuffer);
// spoken.transcript, spoken.finalOutput, spoken.audio
```

Pipeline: OpenAI transcribe → heuristic + Jev intent → (maybe) Hades run → OpenAI speak.

AgentChat (`agentName="hades"` or `NEXT_PUBLIC_AGENT_PROVIDER=hades`) posts SSE to `/api/hades` and shows `Jev <node>: <action> → <decision>`. The Voice button records via `MediaRecorder` and posts to `/api/voice`.

---

## 10. MCP

Off by default. Set `HADES_MCP_JEV=true` (or `createHadesHarness({ registerMcp: true })`).

Every `jev_*` tool requires `ctx.userId` unless `HADES_MCP_JEV_ANON=true`.

Tools: `jev_screen`, `jev_verify`, `jev_decide`, `jev_rerank`, `jev_quiet_ask`, `jev_auto_mode`, `jev_find`, `jev_extract`, `jev_compare`, `jev_bind`, `jev_search`, `jev_filter_passages`, `jev_stop`, `jev_git`.

---

## 11. Security notes (from the install sweep)

Fixed in this tree:

- Input screen fail-closed when Jev is unavailable (`failMode: "closed"` in `withJev`).
- Output screen fail-closed (no secret-bearing draft ships because Jev timed out).
- RAG filter returns `[]` if Jev cannot score passages (blocks indirect injection via memory).
- Auto Mode was already fail-closed; git force-push is an extra closed hop.
- `jev_*` MCP tools are opt-in and auth-gated.
- `/api/voice` rejects bodies over 8 MiB.
- Jev HTTP `baseUrl` is env-only (no request-controlled SSRF).
- `/api/hades` and `/api/voice` use `auth.requireAuth`.

Still true by design: routing fail-open; stop-hook is advisory; `!powerful` only overrides the model, not screens or Auto Mode.

---

## 12. Files touched (implementation inventory)

**Decision core:** `src/agents/jev/*`  
**Harness:** `src/agents/plugins/jev.ts`, `plugins/memory.ts`, `core.ts`, `hades/index.ts`, `orchestrator.ts`, `workflow/index.ts`, `swarm/coordinator.ts`  
**Providers:** `src/agents/providers/openrouter.ts`, `providers/voice.ts`  
**Routes:** `routes/hades/route.ts`, `routes/voice/route.ts`, `routes/agent/route.ts`  
**UI:** `components/AgentChat/index.tsx`  
**Example:** `src/agents/examples/hades-agent.ts`  
**Tests:** `src/agents/__tests__/jev.test.ts`, `hades.test.ts`, `jev-live-paths.test.ts`, `core.test.ts`  
**Docs / env:** this file, `docs/12-plugin-architecture.md`, `.env.example`, `README.md`
