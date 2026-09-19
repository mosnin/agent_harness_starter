# 24 — Jev / Hades: theory, install, and everything that shipped

Hades is the Jev-powered preset for this harness. It follows the LangChain pattern from [Building a Harness with Jev](https://www.langchain.com/blog/building-a-harness-with-jev):

> Use an LLM for open-ended reasoning and generation, and Jev for fast, structured decisions along the way.

This is the theory of record, the install guide, and the inventory of every hop that was wired.

---

## 1. Theory

### What Jev is (and is not)

Jev is TypeSafe’s **System One** model. It is not a chat model. It does not write prose, plans, patches, or tool calls. You send:

1. A **state** object — the evidence (user message, tool args, draft, passages, page text, …)
2. A map of **typed questions**

You get back calibrated answers in roughly 70–500ms. Every question in one request is evaluated **in parallel**. Adding another noul barely changes latency.

The public HTTP contract:

```
POST https://api.typesafe.ai/v1/systemone
Authorization: Bearer $TYPESAFE_API_KEY
Content-Type: application/json

{
  "model": "jev-latest",
  "state": { ... },
  "questions": { "urgent": { "type": "noul", "instructions": "..." }, ... }
}
```

There is no official SDK required. `src/agents/jev/client.ts` speaks this wire format. `createJevAsker().ask()` never throws: it returns `{ ok: true, result }` or `{ ok: false, reason }`. **Code** then decides fail-open vs fail-closed.

### The three question types

| Type | Meaning | Answer shape |
|---|---|---|
| `noul` | Probability that a proposition is true, in `[0, 1]` | `{ type: "noul", noul }` |
| `choice` | Closed catalog. Every option has a criterion. Always include an escape (`other`, `__review__`, `ask_user`). | `{ type: "choice", choice, probabilities, confidence }` |
| `score` | Ordered Likert / severity scale | `{ type: "score", score, legend, probabilities, confidence }` |

`noul` / `choice` / `score` builders in `questions.ts` harden instructions so untrusted evidence in `state` is not treated as instructions to Jev.

### Why this is better than LLM-as-judge

An LLM judge is another generator. It can waffle, invert a label, or invent a rubric mid-sentence. Jev cannot generate; it can only fill a typed schema. The harness then applies **gates** (`src/agents/jev/policy.ts`):

| Gate | min confidence | min P(chosen) | min margin |
|---|---|---|---|
| `routing` | 0.65 | 0.70 | 0.20 |
| `classification` | 0.85 | 0.85 | 0.50 |
| `verification` | 0.80 | 0.80 | 0.20 |
| `voice` | 0.85 | 0.85 | 0.50 |
| `quietAskAuto` | 0.90 | 0.90 | 0.20 |

Margin is `P(winner) − P(runner-up)`. If a gate fails, the action is `review` or `fallback` — never a silent auto-approve on a mushy distribution.

Selected noul thresholds:

| Symbol | Value | Used for |
|---|---|---|
| `injectionBlock` | 0.75 | Block jailbreaks |
| `injectionReview` | 0.25 | HITL / drop untrusted page |
| `secretLeak` | 0.90 | Block secrets |
| `destructive` | 0.90 | Auto Mode block |
| `exfiltration` | 0.70 | Auto Mode block |
| `beyondScope` | 0.85 | Auto Mode HITL |
| `followupReuse` | 0.55 | Keep the pinned Qwen route |
| `finish` | 0.85 | Completion |
| `stopHook` | 0.80 | Incomplete-reply flag |

### Fail-open vs fail-closed

This is the most important policy in the install.

| Hop | When Jev is down / unconfigured |
|---|---|
| Model / skill routing | **Fail open** — keep the current Qwen route |
| Input screen, output screen, Auto Mode, git-risk, RAG filter, citation (when evidence exists), browser page screen, command-failure / stderr | **Fail closed** — block the hop or drop the data |
| Patch / company-OS / malware (Jev down) | **Fail to HITL or block** — `judgePatch` reviews (HITL); `scanMalicious` and `approveCompanyAction` block |
| Stop-hook, quality, completion, heedPolicy | **Advisory** — emit `jev_decision`, do not discard the draft |
| Voice intent | **Fail to clarify** — do not execute |

Routing may be cheap and optimistic. Security may not.

### What each vendor is for

| Vendor | Job | Must not do |
|---|---|---|
| **Jev (TypeSafe)** | Every structured decision | Write prose |
| **Qwen via OpenRouter** | Generation and tool use | Make policy |
| **OpenAI** | Whisper STT + TTS only | Decide or route |

```
OpenAI STT ─┐
User text ──┼─► Jev screen + route + heed ─► Qwen (OpenRouter) ─► Jev Auto Mode / git / malware / patch / company
Tool results┘              │                         │
                           │                         ▼
                           └──────────► Jev output screen + quality + completion + citations ─► OpenAI TTS
```

---

## 2. Install

### 2.1 Copy

From this repo into your Next.js app (see [01 — Integration](01-integration.md)):

| This repo | Your app |
|---|---|
| `src/agents/jev/` | `src/agents/jev/` |
| `src/agents/hades/` | `src/agents/hades/` |
| `src/agents/plugins/jev.ts` | same |
| `src/agents/providers/openrouter.ts`, `voice.ts` | same |
| `routes/hades/route.ts` | `src/app/api/hades/route.ts` |
| `routes/voice/route.ts` | `src/app/api/voice/route.ts` |
| `routes/agent/route.ts` | `src/app/api/agent/route.ts` (or merge `AGENT_PROVIDER=hades`) |
| `components/AgentChat/` | `src/components/AgentChat/` |
| `.env.example` Hades block | `.env.local` |

Package exports already include `@/agents`, `@/agents/jev`, and `@/agents/hades`.

### 2.2 Environment

Copy `.env.example` → `.env.local`:

```bash
AGENT_PROVIDER=hades

# Decisions (required for Jev to run; without it, security hops fail closed)
TYPESAFE_API_KEY=...          # https://typesafe.ai
JEV_MODEL=jev-latest
JEV_TIMEOUT_MS=2500
# TYPESAFE_BASE_URL=https://api.typesafe.ai/v1/systemone   # optional override

# Generation (required)
OPENROUTER_API_KEY=...
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
HADES_MODEL=qwen/qwen-2.5-72b-instruct
HADES_FAST_MODEL=qwen/qwen3-32b
HADES_BALANCED_MODEL=qwen/qwen-2.5-72b-instruct
HADES_POWERFUL_MODEL=qwen/qwen3-235b-a22b

# Voice (required only if you call /api/voice)
OPENAI_API_KEY=...
HADES_STT_MODEL=whisper-1
HADES_TTS_MODEL=gpt-4o-mini-tts
HADES_TTS_VOICE=alloy

# MCP jev_* tools — off by default, auth required
HADES_MCP_JEV=false
# HADES_MCP_JEV_ANON=true     # only for trusted local inspectors

# Chat UI: point AgentChat at /api/hades
NEXT_PUBLIC_AGENT_PROVIDER=hades
```

Without `TYPESAFE_API_KEY`, `createJevAsker().ask()` returns `{ ok: false, reason: "jev-unconfigured" }`.

### 2.3 One-liner

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

Or set `AGENT_PROVIDER=hades` and keep calling `/api/agent`. Example agent name: `"hades"` (`src/agents/examples/hades-agent.ts`).

### 2.4 Verify the install

```bash
npx tsc --noEmit
npx vitest run
```

Jev tests: `src/agents/__tests__/jev.test.ts`, `hades.test.ts`, `jev-live-paths.test.ts`. Core event drain: `core.test.ts` (`pendingPluginEvents`).

---

## 3. How a run actually moves

1. **Ingress** — `/api/agent`, `/api/hades`, or `/api/voice`. All require `auth.requireAuth`. Voice clips larger than 8 MiB → `413`.
2. **Voice intent** (voice only) — `voiceIntentHint`, then `classifyVoiceIntent`. Execution requires `action === "auto"` **and** `value === "execute_now"` (`shouldExecuteVoice`). Anything else clarifies, cancels, or refuses. Qwen never sees cancelled / unsafe / low-confidence audio.
3. **`withJev.onBeforeRun`**
   - `screenExternal` (injection / secrets / substance). Jev-down → **block**. Injection/secret *review* → HITL error.
   - `decideCompaction` when the thread has ≥ 8 messages.
   - `routeModel` → `ctx.hadesModel` / `hadesRoute` (Qwen fast / balanced / powerful). Overrides: `!fast`, `!balanced`, `!powerful`. Follow-up reuse at `is_followup ≥ 0.55`.
   - `routeSkill` (map-reduce if the catalog is > 8).
   - `heedPolicy` — lift / narrow standing rules. Stored on `ctx.jevPolicyDeltas`.
   - Each decision is queued as a `jev_decision` SSE event.
4. **`withMemory`** — retrieve, then `filterPassages`. Jev-down → **drop all memories**.
5. **Qwen generates** and may call tools. `core.ts` drains `pendingPluginEvents` after `onBeforeRun` so the UI sees Jev decisions even before the first token.
6. **`wrapTools`**
   - `assessToolRisk` (Auto Mode). Git-looking commands get `assessGitRisk` first. Jev-down → **block**.
   - `scanMalicious` on `sandbox_run_code` / `modal_run`.
   - `judgePatch` on `file_patch`.
   - `approveCompanyAction` on deploy / composio / transfer / rotate / prod tools. `deploy_prod`, `wire_transfer`, `delete_account`, `rotate_keys` always HITL.
   - `review` → approval event. `block` → `GuardrailBlockError`.
   - `web_search` → `planAndRerankSearch`; snippets stored as `jevEvidence`.
   - `browser_*` → `screenExternal` on page text. Block **and** injection/secret review. Surviving text appended to `jevEvidence`.
   - Failed `shell_exec` → `classifyCommandFailure`. Secret-leaking stderr is blocked. Jev-down → **block** (stderr never reaches Qwen).
7. **`onAfterRun`**
   - `screenOutput` — Jev-down → **block**.
   - `stopHook` — advisory (limpet).
   - `decideCompletion` — advisory (Foreman).
   - `scoreQuality` — advisory (JevSlop).
   - `verifyCitation` against `jevEvidence` — Jev-down or contradiction → **block**.
8. **TTS** if this was a voice turn.

---

## 4. Module map (everything that was built)

All under `src/agents/jev/`:

| File | Job | Lineage |
|---|---|---|
| `questions.ts` | `noul` / `choice` / `score` builders + hardening | TypeSafe cookbooks |
| `validate.ts` | Strict answer shape, probability sum, choice ∈ criteria | super-jev / jcm-router |
| `client.ts` | HTTP System One client + mock that re-validates | official wire format |
| `policy.ts` | Gates, `NOUL`/`SCORE`, fail-open/closed | jev-router, jev-judgment |
| `catalog.ts` | Qwen routes + default skills + Likert legends | LangChain ModelRouter |
| `router.ts` | `routeModel`, `routeSkill`, `routeIntent` | LangChain + jev-router / jcm / notra / GodsBoy |
| `mapreduce.ts` | Batch Choice over large catalogs, beam tree | jev-bfs |
| `auto-mode.ts` | Destructive / exfil / scope + git pre-pass | AutoModeMiddleware, jev-judgment |
| `guardrails.ts` | Input/output screens, citations, malware | safer-with-jev, jev-review, is-malicious |
| `scoring.ts` | Slop / quality / rerank / page grade | JevSlop, jev-search, pagegrade |
| `decisions.ts` | quiet-ask, completion, compaction, browser step, cmd fail | pi-quiet-ask, limpet, Foreman |
| `rag.ts` | Passage relevance + injection filter | TypeSafe RAG cookbook |
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

Harness glue:

- `src/agents/plugins/jev.ts` — `withJev`
- `src/agents/plugins/memory.ts` — `jevFilter`
- `src/agents/hades/index.ts` — `createHadesHarness`, `shouldExecuteVoice`
- `src/agents/core.ts` — drains `pendingPluginEvents`
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
| `stopHook` | Incomplete-reply check (event) |
| `assessToolRisk` | Extra git-risk pass on `git` / `shell_exec` |
| `web_search` wrap | Intent + sources, then rerank |
| `shell_exec` wrap | Classify failures; block secret leaks; Jev-down blocks stderr |
| `voiceTurn` | Execute only on confident `execute_now` |
| `heedPolicy` | Lift / narrow standing rules |
| `scoreQuality` | JevSlop label on the draft |
| `decideCompletion` | Foreman-style “are we done?” |
| `scanMalicious` | Hostile-code check on sandbox / run_code |
| `judgePatch` | jev-code verdict on `file_patch` |
| `approveCompanyAction` | opencompany HITL on deploy / composio / transfer |
| `verifyCitation` | Block drafts that contradict retrieved evidence (fail-closed) |
| `browser_*` wrap | Screen scraped page text; review-band injection is blocked |
| `AGENT_PROVIDER=hades` | `/api/agent` uses `createHadesHarness` |
| Agent Chat | Streams `jev_decision`; Voice → `/api/voice` |

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

## 6. LangChain mapping + Qwen routes

| LangChain | Hades |
|---|---|
| `ModelRouterMiddleware({ fast, powerful })` | `routeModel` / `HADES_QWEN_ROUTES` |
| `AutoModeMiddleware(tools=["bash"])` | `assessToolRisk` inside `wrapTools` |
| `TypeSafeClassifier.invoke(state, questions)` | `createJevAsker().ask(...)` |

| Route | Default model | When |
|---|---|---|
| `fast` | `qwen/qwen3-32b` | Lookups, extraction, greetings |
| `balanced` | `qwen/qwen-2.5-72b-instruct` | Typical agent work |
| `powerful` | `qwen/qwen3-235b-a22b` | Architecture, high-stakes, novel debugging |

Low-confidence *upgrades* are capped at balanced. Downgrades that would bust a prompt cache larger than 20k tokens are skipped.

---

## 7. Using Jev directly

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

`createMockJevClient` re-runs `validateResult` — tests cannot smuggle an illegal choice.

---

## 8. Voice

```ts
const spoken = await hades.voiceTurn(audioBuffer);
// spoken.transcript, spoken.finalOutput, spoken.audio
```

Pipeline: OpenAI transcribe → heuristic + Jev intent → **only then** Hades run → OpenAI speak.

AgentChat (`agentName="hades"` or `NEXT_PUBLIC_AGENT_PROVIDER=hades`) posts SSE to `/api/hades` and shows `Jev <node>: <action> → <decision>`. The Voice button records via `MediaRecorder` and posts to `/api/voice`.

---

## 9. MCP

Off by default. Set `HADES_MCP_JEV=true` or `createHadesHarness({ registerMcp: true })`.

Every `jev_*` tool requires `ctx.userId` unless `HADES_MCP_JEV_ANON=true`.

`jev_screen`, `jev_verify`, `jev_decide`, `jev_rerank`, `jev_quiet_ask`, `jev_auto_mode`, `jev_find`, `jev_extract`, `jev_compare`, `jev_bind`, `jev_search`, `jev_filter_passages`, `jev_stop`, `jev_git`.

---

## 10. Security sweep (current tree)

Fixed:

- Input screen fail-closed when Jev is unavailable.
- Output screen fail-closed.
- RAG filter returns `[]` if Jev cannot score passages.
- Auto Mode + git-risk fail-closed.
- Citation check fail-closed when evidence exists.
- Browser scrape treats injection/secret *review* as a block (same as ingress).
- Voice executes only on `auto` + `execute_now`.
- Failed `shell_exec` classification fail-closed (stderr never reaches Qwen if Jev is down).
- `jev_*` MCP tools opt-in and auth-gated.
- `/api/voice` rejects bodies over 8 MiB.
- Jev HTTP `baseUrl` is env-only (no request-controlled SSRF).
- `/api/hades` and `/api/voice` use `auth.requireAuth`.

Still true by design: routing fail-open; stop-hook / quality / completion are advisory; `!powerful` only overrides the model; `heedPolicy` records deltas and does not silently lift Auto Mode; citation *uncertainty* (Jev up, `says_nothing`) is review not block.

Residual (accepted): `web_search` snippets are reranked but not run through `screenExternal` (browser scrapes are). Search evidence still goes through `verifyCitation` on the final draft.

---

## 11. Debug sweep checklist

| Check | How |
|---|---|
| Types | `npx tsc --noEmit` |
| Tests | `npx vitest run` — Jev files listed in §2.4 |
| Provider switch | `AGENT_PROVIDER=hades` → `routes/agent/route.ts` uses `createHadesHarness` |
| Exports | `package.json` `./jev` and `./hades`; `tsup.config.ts` entries |
| Env | `.env.example` Hades / Jev / OpenRouter / voice / MCP block |
| UI | AgentChat `jev_decision` + Voice when `agentName="hades"` |
| Docs index | [QUICKSTART.md](../QUICKSTART.md) row 24 |

---

## 12. Troubleshooting

| Symptom | Likely cause |
|---|---|
| Every message blocked immediately | Missing `TYPESAFE_API_KEY` (input screen fail-closed) |
| Tools always HITL / blocked | Jev down (Auto Mode fail-closed) or `alwaysApprove` |
| Memories never injected | `jevFilter: true` and Jev down (empty set is correct) |
| Voice always “say that again” | Intent not `auto`/`execute_now`, or Jev unconfigured |
| No `jev_*` on `/api/mcp` | `HADES_MCP_JEV` is not `true` |
| SSE has no `jev_decision` | Plugin not installed, or events not drained (need current `core.ts`) |
| Qwen 401 | Missing `OPENROUTER_API_KEY` |
| Voice 413 | Audio larger than 8 MiB |

---

## 13. Files touched (implementation inventory)

**Decision core:** `src/agents/jev/*`  
**Harness:** `plugins/jev.ts`, `plugins/memory.ts`, `core.ts`, `hades/index.ts`, `orchestrator.ts`, `workflow/index.ts`, `swarm/coordinator.ts`  
**Providers:** `providers/openrouter.ts`, `providers/voice.ts`  
**Routes:** `routes/hades/route.ts`, `routes/voice/route.ts`, `routes/agent/route.ts`  
**UI:** `components/AgentChat/index.tsx`  
**Example:** `src/agents/examples/hades-agent.ts`  
**Tests:** `src/agents/__tests__/jev.test.ts`, `hades.test.ts`, `jev-live-paths.test.ts`, `core.test.ts`  
**Package:** `package.json` exports `./jev` and `./hades`; `tsup.config.ts` entries `jev/index`, `hades/index`; root barrel `src/agents/index.ts`  
**Docs / env:** this file, `docs/12-plugin-architecture.md`, `docs/01-integration.md`, `QUICKSTART.md`, `.env.example`, `README.md`

---

## 14. What was built (wave by wave)

This is the record of the Hades/Jev work, not just the current file list.

### Wave 1 — Decision core + Hades preset

Researched TypeSafe System One (no official SDK) and the LangChain harness post. Built `src/agents/jev/` as an injectable HTTP client (`createJevAsker` never throws) plus a mock that re-validates answers. Policy gates, Qwen route catalog, `withJev` plugin (ModelRouter + Auto Mode + screens), `createHadesHarness`, OpenRouter/Qwen provider, `/api/hades`, tests, package exports.

### Wave 2 — Live hops that were helper-only

Wired unused helpers onto real paths: `jevFilter` on memory RAG, map-reduce skill routing, `createOrchestrator({ jevRouter: true })`, `jevWhen`/`jevUntil`, `SwarmCoordinator.submitTaskJev`, stop-hook, voice STT/TTS + intent, search rerank, `AGENT_PROVIDER=hades`, AgentChat `jev_decision` + Voice.

### Wave 3 — Remaining helpers on tool/draft hops

Quality (JevSlop), completion (Foreman), `heedPolicy`, `scanMalicious`, `judgePatch`, company-OS, citations, browser page screen. Git-risk pre-pass on shell/git tools. Command-failure classification on `shell_exec`.

### Wave 4 — Security remediations

Fail-closed: input, output, RAG, Auto Mode, git-risk, citations, command-failure. Browser injection/secret *review* blocks. Voice execute only on `auto` + `execute_now`. MCP `jev_*` opt-in + `userId`. Voice 8 MiB cap. Env-only System One URL.

### Wave 5 — This document + install sweep

`npx tsc --noEmit` and `npx vitest run` as the install check. QUICKSTART row 24. Integration copy map for `/api/hades` and `/api/voice`.

---

## 15. Debug / install sweep (how to prove it is installed)

Run from the repo root:

```bash
npx tsc --noEmit
npx vitest run
```

Expected: TypeScript clean; the Jev suites in `jev.test.ts`, `hades.test.ts`, and `jev-live-paths.test.ts` pass (including fail-closed cases for input, RAG, citations, command-failure, and `shouldExecuteVoice`).

Static install checks (already in this tree):

| Artifact | Must exist |
|---|---|
| `src/agents/jev/*.ts` | 24 modules listed in §4 |
| `src/agents/hades/index.ts` | `createHadesHarness`, `shouldExecuteVoice` |
| `src/agents/plugins/jev.ts` | `withJev` |
| `src/agents/providers/openrouter.ts`, `voice.ts` | Qwen + Whisper/TTS |
| `routes/hades/route.ts`, `routes/voice/route.ts` | Auth-gated ingress |
| `src/agents/examples/hades-agent.ts` | Registered name `"hades"` |
| `package.json` `exports["./jev"]`, `exports["./hades"]` | Library consumers |
| `tsup.config.ts` `jev/index`, `hades/index` | Dist build |
| `.env.example` Hades block | `AGENT_PROVIDER`, `TYPESAFE_API_KEY`, OpenRouter, voice, MCP |
| `src/agents/index.ts` | Re-exports `createHadesHarness`, `withJev`, `noul`/`choice`/`score` |

Without `TYPESAFE_API_KEY` the client returns `{ ok: false, reason: "jev-unconfigured" }`. Security hops then block; routing keeps the current Qwen model. That is correct, not a broken install.

Live keys (`TYPESAFE_API_KEY`, `OPENROUTER_API_KEY`, `OPENAI_API_KEY`) are not required for the unit suite — tests use `createMockJevClient`.
