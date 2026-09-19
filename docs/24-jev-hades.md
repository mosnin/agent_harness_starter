# Hades — Jev decisions, Qwen generation, OpenAI voice

Hades is the Jev-powered preset for this harness. It follows the LangChain pattern from [Building a Harness with Jev](https://www.langchain.com/blog/building-a-harness-with-jev):

> Use an LLM for open-ended reasoning and generation, and Jev for fast, structured decisions along the way.

Jev is TypeSafe’s System One model. It does **not** generate text. You send a `state` and typed questions (`noul` / `choice` / `score`); you get calibrated probabilities back in ~70–500ms. Hades uses those answers to decide. Qwen (via OpenRouter) writes. OpenAI only hears and speaks.

```
OpenAI STT ─┐
User text ──┼─► Jev screen + route ─► Qwen (OpenRouter) ─► Jev Auto Mode on tools
Tool results┘         │                      │
                      │                      ▼
                      └──────────────► Jev output screen ─► OpenAI TTS
```

## Why this is an order of magnitude better

Every hop that used to be an LLM judge is now a typed Jev call:

| Old harness hop | Hades |
|---|---|
| Heuristic / LLM model picker | `routeModel` — LangChain ModelRouterMiddleware + jev-router / jcm-router policy |
| Regex jailbreak list | `screenExternal` — safer-with-jev nouls |
| Static `requireApprovalFor` | `assessToolRisk` — LangChain AutoModeMiddleware + jev-judgment |
| LLM-as-judge quality | `scoreQuality` / `verifyCitation` / `scanMalicious` |
| “Are we done?” LLM call | `decideCompletion` / Foreman supervisor |
| “Should I ask the user?” | `quietAsk` (pi-quiet-ask) |

Jev evaluates every question in a request **in parallel**. Adding a noul barely changes latency.

## Quick start

```bash
# .env.local
AGENT_PROVIDER=hades
TYPESAFE_API_KEY=...
OPENROUTER_API_KEY=...
OPENAI_API_KEY=...          # voice only
HADES_MODEL=qwen/qwen-2.5-72b-instruct
```

```ts
import { createHadesHarness } from "@/agents";

const hades = createHadesHarness({
  name: "Hades",
  instructions: "You are Hades. Jev already routed this task; do the work.",
  tools: ["web_search"],
});

const result = await hades.run({
  messages: [{ role: "user", content: "Summarize yesterday's incidents." }],
});
```

SSE: drop `routes/hades/route.ts` at `app/api/hades/route.ts`.
Voice: drop `routes/voice/route.ts` at `app/api/voice/route.ts`.

## Middleware (the LangChain mapping)

```ts
import { withJev } from "@/agents";
import { createCustomHarness } from "@/agents/core";

const harness = createCustomHarness({
  name: "Support",
  instructions: "...",
  plugins: [
    withJev(),          // Model router + Auto Mode + screens
  ],
});
```

| LangChain | Hades |
|---|---|
| `ModelRouterMiddleware({ fast, powerful })` | `routeModel` / `HADES_QWEN_ROUTES` |
| `AutoModeMiddleware(tools=["bash"])` | `assessToolRisk` inside `wrapTools` |
| `TypeSafeClassifier.invoke(state, questions)` | `createJevAsker().ask(...)` |

Default Qwen routes Jev chooses from:

| Route | Model | When |
|---|---|---|
| `fast` | `qwen/qwen3-32b` | Lookups, extraction, greetings |
| `balanced` | `qwen/qwen-2.5-72b-instruct` | Typical agent work |
| `powerful` | `qwen/qwen3-235b-a22b` | Architecture, high-stakes, novel debugging |

Overrides: `!fast`, `!balanced`, `!powerful` in the user message. Follow-ups with `is_followup ≥ 0.55` reuse the pinned route (jcm-router). Low confidence fails **open** to the current route. Auto Mode fails **closed**.

## Question catalog

Imported from the open-source Jev ecosystem (routers, jev-review, jev-judgment, jev-mcp, JevSlop, jev-search, Foreman, opencompany, jev-curate, …):

- **Routing** — complexity score, requires_tools noul, follow-up noul, route choice
- **Skills** — specialist vs `__no_skill__` vs `__review__` with need/review nouls
- **Guardrails** — injection, substance, secret leak, output policy, citations, malware
- **Auto Mode** — destructive / exfil / beyond-scope nouls + impact score + authorized/routine
- **Decisions** — quiet-ask, completion, compaction, browser step, command failure
- **Symbolic** — Foreman worker supervisor, jev-code patch verdict
- **Company OS** — authorized + routine (always-HITL for `deploy_prod`, transfers, key rotation)
- **Curation / eval** — triage, label keep/skip, Brier + accuracy calibration

## Using Jev directly

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

Without `TYPESAFE_API_KEY`, `askJev` returns `{ ok: false, reason: "jev-unconfigured" }`. Routing stays fail-open; security stays fail-closed.

## Live-path integrations

These sit on real harness hops, not just helper libraries:

| Path | What Jev does |
|---|---|
| `withMemory({ jevFilter: true })` | Drop injected / irrelevant RAG passages before they reach Qwen |
| `routeSkill` | Map-reduce over catalogs larger than 8 (GodsBoy / jev-bfs) |
| `createOrchestrator({ jevRouter: true })` | Pick a specialist before the LLM router |
| `jevWhen` / `jevUntil` | Workflow branch + loop stop conditions |
| `SwarmCoordinator.submitTaskJev` | Assign a task among capable agents |
| `withJev` stop-hook | Limpet-style incomplete-reply check on the draft |
| `assessToolRisk` | Extra git-risk pass on `git` / `shell_exec` |
| `web_search` wrap | Intent + source plan, then rerank |
| `shell_exec` wrap | Classify failures (retry / env / secret leak) |
| `voiceTurn` | Jev intent (`execute_now` / `clarify` / `out_of_scope` / `unsafe`) |
| `AGENT_PROVIDER=hades` | Main `/api/agent` uses `createHadesHarness` |
| Agent Chat | Streams `jev_decision` status + optional OpenAI voice |

```ts
import { createOrchestrator, createWorkflow, jevWhen, jevUntil } from "@/agents";

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

## Voice

OpenAI transcribes, Jev classifies intent, Qwen generates only when the transcript is actionable, OpenAI speaks:

```ts
const spoken = await hades.voiceTurn(audioBuffer);
// spoken.transcript, spoken.finalOutput, spoken.audio
```

Ambiguous or cancelled utterances never reach Qwen.

## MCP

`registerJevMcpTools()` (called by `createHadesHarness`) exposes `jev_screen`, `jev_verify`, `jev_decide`, `jev_rerank`, `jev_quiet_ask`, `jev_auto_mode`, plus `jev_find`, `jev_extract`, `jev_compare`, `jev_bind`, `jev_search`, `jev_filter_passages`, `jev_stop`, and `jev_git` on `/api/mcp`.
