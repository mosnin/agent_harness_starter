# 24 — Jev / Hades: theory, install, and everything that shipped

Hades is the Jev-powered preset for this harness. It follows the LangChain pattern from [Building a Harness with Jev](https://www.langchain.com/blog/building-a-harness-with-jev):

> Use an LLM for open-ended reasoning and generation, and Jev for fast, structured decisions along the way.

This is the theory of record, the install guide, and the inventory of every hop that was wired.

Hades the product is a **desktop application**. This package is the harness that application attaches to (Tauri sidecar + optional Hades Cut `cap` binary). HTTP routes are the other surface. See [25 — Hades desktop](25-hades-desktop.md).

---

## 1. Theory

### What Jev is (and is not)

Jev is TypeSafe’s **System One** model. It is not a chat model. It does not write prose, plans, patches, or tool calls. You send:

1. A **state** object — the evidence (user message, tool args, draft, passages, page text, …)
2. A map of **typed questions**

You get back calibrated answers in roughly 70–500ms. Every question in one request is evaluated **in parallel**. Adding another noul barely changes latency. That is the whole speed story: TypeSafe reports **70–500ms** and up to **~200×** vs an LLM judge on the same structured task. Hades therefore **must not** fire sequential Jev HTTP hops.

`runPreflight` / `runPostflight` / `runToolGate` are one System One call each. Preflight now also asks `needs_clarify` and `is_factual` (quiet-ask). Postflight scores each sentence against `jevEvidence` (citation-verifier). Tool loops batch Auto Mode + malware + patch + company instead of stacking RTTs (ultrafast speculative heads). Exact greetings still **screen** then skip Qwen. Vague asks skip Qwen with a clarify. A factual lookup whose search ask already picked a `best` snippet (`hasAnswer` + no conflict + `is_factual ≥ 0.7`) sets `jevDirectReply` and **stops the generator** — Qwen does not rewrite a found fact. Ungrounded drafts are **rewritten to an abstain**, not shipped. A circuit breaker fail-fasts after three Jev outages. Hedged fetch (default 200ms) aborts the loser. Identical asks are cached/coalesced for ~20s so desktop `chat.prefetch` makes `chat.send` a cache hit.

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
| Desktop inspect (`targets`, project get) | **Fail open** |
| Desktop writes (record, patch, export) | **Fail closed** — `cap` is not spawned |

Routing may be cheap and optimistic. Security may not.

### What each vendor is for

| Vendor | Job | Must not do |
|---|---|---|
| **Jev (TypeSafe)** | Every structured decision | Write prose |
| **Qwen via OpenRouter** | Generation and tool use | Make policy |
| **OpenAI** | Whisper STT + TTS only | Decide or route |

```
Tauri window ── hades_command ──► Node sidecar (this package)
     ▲                                    │
     └── hades_event ◄── Jev + Qwen ──────┤
                                          ▼
                                 desktop.act / cap (Hades Cut)

OpenAI STT ─┐
User text ──┼─► Jev screen + route + heed ─► Qwen (OpenRouter) ─► Jev Auto Mode / git / malware / patch / company / desktop
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
JEV_TIMEOUT_MS=1500
JEV_HEDGE_MS=200
JEV_CACHE_TTL_MS=20000
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

Jev tests: `src/agents/__tests__/jev.test.ts`, `hades.test.ts`, `jev-live-paths.test.ts`, `hades-desktop.test.ts`, `jev-speed.test.ts`, `jev-ground.test.ts`, `jev-redact.test.ts`, `thread-history.test.ts`, `convex-auth.test.ts`, `db-owner.test.ts`. Core event drain: `core.test.ts` (`pendingPluginEvents`).

---

## 3. How a run actually moves

1. **Ingress** — `/api/agent`, `/api/hades`, or `/api/voice`. All require `auth.requireAuth`. Voice clips larger than 8 MiB → `413`. JSON bodies larger than 64 KiB → `413`. Client `tools` may only enable names the agent already has (config + skills); `shell_exec` cannot be added to a research agent. `/api/hades`, `/api/agent`, and `/api/voice` refuse another user's `threadId` (404) and load the last 40 redacted turns so Jev follow-up reuse and compaction actually see the thread. Desktop `chat.send` / `voice.turn` keep the same buffer per `threadId`. `/api/voice` does not echo raw exception text.
2. **Voice intent** (voice only) — `voiceIntentHint`, then `classifyVoiceIntent`. Execution requires `action === "auto"` **and** `value === "execute_now"` (`shouldExecuteVoice`). Anything else clarifies, cancels, or refuses. Qwen never sees cancelled / unsafe / low-confidence audio.
3. **`withJev.onBeforeRun`** — **one** System One call (`runPreflight`). Exact greetings still screen; Qwen is skipped with a canned reply only after the screen passes (or when `screenInput: false`).
   - `screenExternal` (injection / secrets / substance). Jev-down → **block**. Injection/secret *review* → HITL error.
   - `routeModel` → `ctx.hadesModel` / `hadesRoute` (Qwen fast / balanced / powerful). Follow-up reuse at `is_followup ≥ 0.55`.
   - `routeSkill` + `heedPolicy` in the same request.
   - `skip_llm` / `canned` / `needs_clarify` → `ctx.jevDirectReply`; core short-circuits the generator. Vague asks get a clarify instead of a guessed essay.
   - Each decision is queued as a `jev_decision` SSE event.
4. **`withMemory`** — retrieve, then `filterPassages`. Jev-down → **drop all memories**.
5. **Qwen generates** and may call tools. When the thread has more than one turn, `core.ts` passes typed `AgentInputItem`s to `run()` (not just the latest user string) so Qwen sees the conversation. `core.ts` drains `pendingPluginEvents` after `onBeforeRun` so the UI sees Jev decisions even before the first token.
6. **`wrapTools`**
   - `runToolGate` — Auto Mode + malware + patch + company + `invented_args` + `wrong_fn` in **one** ask. Git-looking commands include git nouls in that same request. Hallucinated paths/URLs or a tool that does not bind to the request → HITL or block. Jev-down → **block**. Canned exfil/SSRF targets (`/etc/passwd`, `../.env`, `169.254.169.254`, `file://`, `python3 -c open(...)`, `echo x > /etc/passwd`, `grep` / `cp` / `tee` against those paths) are `target-local` at zero RTT even on "safe read" tools. A raw key in tool args is `leaks-secret-local` even when Auto Mode is off.
   - Every tool result is **redacted** (API keys, tokens, private keys, connection strings) then harvested into `jevEvidence` with no extra Jev call. Search/browser evidence uses the same `mergeEvidence` path — raw secrets never reach Qwen, the compacted thread, memories, or persisted chat.
   - `scanMalicious` on `sandbox_run_code` / `modal_run`.
   - `judgePatch` on `file_patch`.
   - `approveCompanyAction` on deploy / composio / transfer / rotate / prod tools. `deploy_prod`, `wire_transfer`, `delete_account`, `rotate_keys` always HITL.
   - `review` → approval event. `block` → `GuardrailBlockError`.
   - `web_search` → `planAndRerankSearch` in **one** ask (window + sources + relevance + injection + SDE presence + contradiction). Injected snippets are dropped. Results that contradict each other on a material fact are not harvested as facts. Snippets stored as `jevEvidence`. Tool SSE `tool_call` / `tool_result` events are redacted before they leave the harness.
   - `browser_*` → `screenBrowserPage` in **one** ask (injection / substance / secret + next `action` / `target` / done / stuck + pagegrade). Local jailbreak or secret → zero-RTT block. Jev-down → **block**. Injection/secret *review* → HITL error. Spam-graded pages block. Poor pages extract instead of click. Stuck / blocked steps throw `jev_browser_step` so Qwen cannot keep clicking. Surviving pages attach `jevBrowser`; instructions tell Qwen the typed next step (or to stop on DONE / EXTRACT). Harvested into `jevEvidence`.
   - Failed `shell_exec` → `classifyCommandFailure`. Secret-leaking stderr is blocked. Canned ENOENT / EACCES / ETIMEDOUT / TypeError are `failure-local` at zero RTT and returned to Qwen with `jevFailure`. Ambiguous stderr + Jev-down → **block**.
7. **`onAfterRun`** — **one** System One call (`runPostflight`).
   - `screenOutput` — Jev-down → **block**.
   - `stopHook` — advisory (limpet).
   - `decideCompletion` — advisory (Foreman).
   - `scoreQuality` — advisory (JevSlop).
   - `verifyCitation` against `jevEvidence` — Jev-down or contradiction → **block**.
   - Sentence-level grounding + `invented_numbers` / `invented_sources` / `needs_abstain`. Ungrounded drafts are replaced with a deterministic abstain (citation-verifier), not a second Qwen pass. Abstain snippets and the returned draft are redacted again so a leaked key cannot ride out on the last hop.
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
| `browser.ts` | One-ask scrape screen + next browser step | decideBrowserStep + safer-with-jev |
| `rag.ts` | Passage relevance + injection filter | TypeSafe RAG cookbook |
| `extract.ts` | find / extract / compare / bind / SDE cascade | jev-mcp cookbooks |
| `search.ts` | Window + sources + rerank + injection drop in one ask | jev-search |
| `hooks.ts` | Stop-hook, heed policy, git-risk, voice intent | limpet, pi-heed, jev-git |
| `orchestrate.ts` | Specialist router, `jevWhen`/`jevUntil`, swarm pick | GodsBoy, notra |
| `events.ts` | Queue `jev_decision` onto the harness stream | this harness |
| `preflight.ts` / `postflight.ts` | One System One call per hop (the speed path) | TypeSafe parallel questions |
| `cache.ts` | LRU + in-flight coalesce of successful asks | desktop prefetch / retries |
| `compact.ts` | Apply keep/summarize/aggressive to the injected thread | pi-fast-jev-compaction |
| `toolgate.ts` | One ask for Auto Mode + malware + patch + company + invented args | jev-ultrafast speculative heads |
| `target.ts` | Zero-RTT exfil path / metadata URL block | safer-with-jev + invented_args |
| `inject.ts` | Zero-RTT canned jailbreak labels | detectInjection |
| `destructive.ts` | Zero-RTT wipe / force-git labels | AutoModeMiddleware |
| `failure.ts` | Zero-RTT canned shell-error class | classifyCommandFailure |
| `lib/thread-history.ts` | Own-thread check + last-40 redacted turns for the harness | follow-up reuse / compaction |
| `harvest.ts` | Zero-RTT evidence cards from tool results (secrets stripped) | citation-verifier "code splits" |
| `redact.ts` | Zero-RTT secret / PII strip before Qwen, memory, desktop, DB | safer-with-jev + guidance `secretsGate` |
| `ground.ts` | Sentence split + abstain rewrite | citation-verifier + pi-quiet-ask |
| `curate.ts` / `eval.ts` | Triage, labels, Brier / accuracy | jev-curate, calibration repos |
| `symbolic.ts` | Foreman supervisor, patch verdict | Foreman, jev-code |
| `company.ts` | Company-OS action approval | opencompany |
| `audit.ts` | In-process decision log | — |
| `mcp.ts` | `jev_*` tools (opt-in, auth required) | jev-mcp / decide-mcp |

Harness glue:

- `src/agents/plugins/jev.ts` — `withJev`
- `src/agents/plugins/memory.ts` — `jevFilter`
- `src/agents/hades/index.ts` — `createHadesHarness`, `shouldExecuteVoice`
- `src/agents/hades/desktop/` — Tauri sidecar host, IPC contract, Cap runner
- `src/agents/jev/desktop.ts` — desktop write/read policy (`shouldExecuteDesktop`)
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
| `SwarmCoordinator.completeTaskJev` | Foreman (`superviseWorker`) accept / continue / escalate before marking done |
| `stopHook` | Incomplete-reply check (event) |
| `assessToolRisk` | Extra git-risk pass on `git` / `shell_exec` |
| `web_search` wrap | Window + sources + rerank + injection in one ask |
| `shell_exec` wrap | Classify failures; canned ENOENT/EACCES/timeouts are local; secrets and unknown Jev-down stderr block |
| `voiceTurn` | Execute only on confident `execute_now` |
| `heedPolicy` | Lift / narrow standing rules |
| `scoreQuality` | JevSlop label on the draft |
| `decideCompletion` | Foreman-style “are we done?” |
| `scanMalicious` | Hostile-code check on sandbox / run_code |
| `judgePatch` | jev-code verdict on `file_patch` |
| `approveCompanyAction` | opencompany HITL on deploy / composio / transfer |
| `verifyCitation` | Block drafts that contradict retrieved evidence (fail-closed) |
| `browser_*` wrap | One-ask screen + next step + pagegrade (`jevBrowser`); local jailbreak/secret, spam, Jev-down, and stuck/BLOCKED stop the loop |
| `AGENT_PROVIDER=hades` | `/api/agent` uses `createHadesHarness` |
| Agent Chat | Streams `jev_decision`; Voice → `/api/voice` |
| Desktop sidecar | `createDesktopHost` / `npm run desktop:sidecar`; local target/secret labels then Jev before `cap` |
| `runToolGate` | One System One call for Auto Mode + malware + patch + company + invented args; local wipe / target labels first |
| Thread history | Last 40 owned, redacted turns on `/api/hades`, `/api/agent`, and desktop `chat.send` |
| `DELETE /api/threads/[id]` | 404 unless `getOwnedThread` matches the caller |
| Convex `agent_*` | Internal functions + identity/ownership; adapter acts as the HTTP user |
| DB adapters | `userId` hides foreign threads; Supabase service-role + RLS |
| Tool harvest | Append evidence cards with no extra Jev call |
| Secret redaction | Strip keys from tool output, evidence, stream, memory, desktop `cap`, persisted threads |
| Postflight grounding | Sentence-level support; ungrounded drafts become an abstain |
| Quiet-ask | `needs_clarify` skips Qwen instead of guessing |

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
| `AutoModeMiddleware(tools=["bash"])` | `runToolGate` inside `wrapTools` |
| `TypeSafeClassifier.invoke(state, questions)` | `createJevAsker().ask(...)` |

| Route | Default model | When |
|---|---|---|
| `fast` | `qwen/qwen3-32b` | Lookups, extraction, greetings |
| `balanced` | `qwen/qwen-2.5-72b-instruct` | Typical agent work |
| `powerful` | `qwen/qwen3-235b-a22b` | Architecture, high-stakes, novel debugging |

Low-confidence *upgrades* are capped at balanced. Downgrades that would bust a prompt cache larger than 20k tokens are skipped.

### Why Hades feels ~10–200× faster than LLM-as-judge

People posting Jev timings on X are measuring **structured decisions**, not generation. An LLM judge is 3–15s per hop. Jev is 70–500ms, and every extra noul in the same request is free. Hades keeps that advantage by:

1. **One preflight / one postflight / one tool-gate** — never screen then route then skill, or Auto Mode then malware then patch, as separate HTTP hops.
2. **Hedged fetch** — a second request at 200ms; the loser is aborted so a slow tail does not add a full timeout.
3. **Circuit breaker** — three failures → 8s fail-fast (`jev-circuit-open`). Security still fail-closes; routing fail-opens.
4. **Ask cache + coalesce** — identical `state + questions` reuse answers for 20s. Desktop `chat.prefetch` while the user types makes send a cache hit.
5. **Skip Qwen** on exact greetings / thanks after the screen passes, and on quiet-ask clarifies (`needs_clarify`).
6. **Skip Auto Mode** on an allowlist of read-only tools (`file_read`, `web_search`, desktop inspect). Writes still fail-closed.
7. **Warmup** on `runtime.start` so TLS to `api.typesafe.ai` is already open.
8. **Zero-RTT harvest** — every tool result becomes an evidence card. Postflight then scores each sentence against that card (citation-verifier). Ungrounded drafts are replaced with an abstain, not a second LLM pass.
9. **Compaction is applied** — when the thread is over 55% of the token budget, the same preflight ask picks keep / summarize / aggressive. Code then prunes middle tool blobs (pi-fast-jev-compaction) and injects the compact thread + `jevEvidence` via `onResolveInstructions`. Qwen actually **runs the routed model** (`ctx.hadesModel` → `Agent.model`). A fast-route pick that never reached the generator was wasting the whole ModelRouter hop.

`jev_decision` events carry `latencyMs` and `cached` so the desktop can show the same 70ms badge people are posting.

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
- Failed `shell_exec` classification fail-closed for **unknown** stderr when Jev is down. Canned ENOENT / EACCES / ETIMEDOUT / TypeError are local and reach Qwen. Secrets never do.
- `jev_*` MCP tools opt-in and auth-gated.
- `/api/voice` rejects bodies over 8 MiB.
- Jev HTTP `baseUrl` is env-only (no request-controlled SSRF).
- `/api/hades` and `/api/voice` use `auth.requireAuth`.
- `/api/hades`, `/api/agent`, and `/api/anthropic-agent` reject JSON bodies over 64 KiB (`413`) and ignore client `tools` that are not already on the agent (config + skills).
- `/api/mcp` tool execution (POST and SSE GET) requires auth unless `HADES_MCP_ANON=true`. Discovery JSON GET stays public. `POST /api/threads` rejects oversized JSON and caps title length.
- `/api/hades`, `/api/agent`, and `/api/anthropic-agent` POST return 404 unless `thread.userId` matches the caller. They load thread history (redacted, last 40) instead of a single-line cold start.
- `/api/agent/[runId]/approve` and `/cancel` return 404 unless the caller owns the run's thread (`getOwnedRun`).
- `DELETE /api/threads/[id]` returns 404 unless the caller owns the thread (`getOwnedThread`). `db.deleteThread` is never called on another user's id.
- SSE / desktop `message_delta` events go through `createRedactStream` so a key split across two chunks is held until it can be replaced. `message_done` still rewrites the full text.
- Tool stdout, search/browser evidence, compacted threads, streamed deltas, abstains, memories, desktop `cap` output, and persisted `/api/hades` + `/api/agent` + `/api/anthropic-agent` messages are locally redacted (`redactSecrets`) before they reach Qwen or storage.
- System One `state` is sanitized the same way. Severe labels (`API_KEY`, `AWS_KEY`, env-style `*_SECRET=*`, …) force `secret_leak` / `leaks_secret` to 1.0 in code. TypeSafe never receives the raw key.
- Screens, preflight, postflight, `runToolGate`, wrapTools, and `classifyCommandFailure` short-circuit on `hasSevereSecret` (`leaks-secret-local`) so a pasted key is a zero-RTT block even when Jev is down or Auto Mode is off. EMAIL is PII-redacted but not a severe block.
- The same screens, plus search/RAG filters, short-circuit canned jailbreaks with `hasLocalInjection` (`injection-local`) so "ignore previous instructions" / DAN / fake system tags never wait on TypeSafe and never leave the box. Ambiguous injection still goes to Jev.
- Auto Mode / `runToolGate` short-circuit canned destructive commands as `destructive-local`. Wipes (`rm -rf`, `DROP TABLE`, `dd`, `curl | bash`, `bash -c "$(curl …)"`) block; force-git (`push --force`, `reset --hard`) is HITL. Only `command` / `cmd` / `args` are scanned so a README that mentions those strings is not blocked.
- Safe-read tools (`file_read`, `web_search`, …) skipped Jev entirely, so `/etc/passwd`, `../.env`, and `http://169.254.169.254/` never got a screen. `localTargetDecision` now blocks those on path/url keys (`target-local`) at zero RTT, including when Auto Mode is off. A search *query* that mentions `/etc/passwd` is not blocked.
- Failed shells used to ask Jev (or fail-closed) for every nonzero exit. Canned ENOENT / EACCES / ETIMEDOUT / TypeError are `failure-local` and reach Qwen with a typed class. Unknown stderr still fail-closed when Jev is down. Secrets still `leaks-secret-local`.
- Desktop writes (`desktop.act`) apply the same local target / secret labels before Cap. An export of `/etc/passwd` or a patch that embeds `sk-` is `target-local` / `leaks-secret-local` at zero RTT.
- `shell_exec` `cat /etc/passwd` / `curl 169.254.169.254` is `target-local` at zero RTT. Writes and extra reads (`echo x > /etc/passwd`, `cp … ~/.ssh/authorized_keys`, `grep root /etc/passwd`) are the same label. `/var/run/docker.sock` is the same class. An echo that only *mentions* `/etc/passwd` is not blocked.
- Desktop writes with a canned jailbreak in `userRequest` / args are `injection-local`. `DELETE /api/threads/[id]` 404s unless the caller owns the thread (`getOwnedThread`).
- Convex `threads` / `messages` / `runs` are internal and require `ctx.auth.getUserIdentity()`. The HTTP adapter calls them with `CONVEX_ADMIN_KEY` acting as the signed-in user. A leaked `CONVEX_URL` cannot spoof `userId`.
- Memory / Supabase / Prisma adapters hide foreign threads when `userId` is passed (same contract as Convex). Supabase requires `SUPABASE_SERVICE_ROLE_KEY` (never the anon key) and ships RLS so a browser JWT cannot read another user's rows.
- `python3 -c "open('/etc/passwd')"` / `node -e "require('fs').readFileSync('/etc/passwd')"` is `target-local` at zero RTT. An echo that only mentions those tokens still passes.
- `echo pwned > /etc/passwd`, `cp notes.txt ~/.ssh/authorized_keys`, and `grep root /etc/passwd` are `target-local` at zero RTT. A warning that only mentions `>` and `/etc/passwd` still passes.
- Browser scrapes screen the page and pick the next step in the same System One call. Canned jailbreaks / severe secrets on the page are `injection-local` / `leaks-secret-local` at zero RTT. Jev-down blocks the scrape (Qwen never guesses the next click from an unscreened blob). Pagegrade (`scorePage`) runs in that same ask: spam trust blocks; a poor grade extracts instead of clicking. Stuck / blocked steps throw so the agent cannot keep clicking a login wall.
- Swarm `completeTaskJev` uses unused `superviseWorker`. A stuck or off-track worker is failed instead of marked done. Jev-down does not accept the work.
- Search rerank now includes unused `sdeCascade` / `compareTexts` presence questions on the same ask. Material contradiction empties `ranked` and harvests a conflict card so Qwen cannot pick a side. `wrong_fn` on `runToolGate` blocks a tool that does not bind to the user request (`unbound-tool`).
- Search also asks unused `semanticFind` `best` on that same hop. A factual turn (`is_factual ≥ 0.7`) with `hasAnswer` and a ranked `best` snippet sets `jevEvidenceAnswer` / `jevDirectReply`. Core aborts the remaining Qwen tokens; `onAfterRun` ships the grounded reply and skips postflight.

Still true by design: routing fail-open; stop-hook / quality / completion are advisory; `!powerful` only overrides the model; `heedPolicy` records deltas and does not silently lift Auto Mode; citation *uncertainty* (Jev up, `says_nothing`) is review not block.

Residual (accepted): Ambiguous injection (no canned pattern) still needs a Jev noul. EMAIL is not treated as a severe local block. Approve / cancel 404 if the run's thread is missing (same as a non-owner). `completeTask` without Jev still exists for callers that do not want Foreman. Coding / non-factual turns still generate after search (the `best` snippet is attached for Qwen). Standalone `extractValue` / `judge` / `triageItems` / `beamClassify` helpers remain for MCP and callers that want a dedicated hop.

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
| Docs index | [QUICKSTART.md](../QUICKSTART.md) rows 24–25 |
| Desktop sidecar | `npm run desktop:sidecar`; tests in `hades-desktop.test.ts` |

---

## 12. Troubleshooting

| Symptom | Likely cause |
|---|---|
| Every message blocked immediately | Missing `TYPESAFE_API_KEY` (input screen fail-closed) |
| Tools always HITL / blocked | Jev down (Auto Mode fail-closed) or `alwaysApprove` |
| Memories never injected | `jevFilter: true` and Jev down (empty set is correct) |
| Voice always “say that again” | Intent not `auto`/`execute_now`, or Jev unconfigured |
| No `jev_*` on `/api/mcp` | `HADES_MCP_JEV` is not `true` |
| `/api/mcp` 401 on tool calls | Missing auth; set `HADES_MCP_ANON=true` only for a trusted local inspector |
| SSE has no `jev_decision` | Plugin not installed, or events not drained (need current `core.ts`) |
| Qwen 401 | Missing `OPENROUTER_API_KEY` |
| Voice 413 | Audio larger than 8 MiB |

---

## 13. Files touched (implementation inventory)

**Decision core:** `src/agents/jev/*` (including `browser.ts`, `target.ts`, `failure.ts`)  
**Harness:** `plugins/jev.ts`, `plugins/memory.ts`, `core.ts`, `hades/index.ts`, `orchestrator.ts`, `workflow/index.ts`, `swarm/coordinator.ts`, `lib/thread-history.ts`, `lib/run-owner.ts`  
**Providers:** `providers/openrouter.ts`, `providers/voice.ts`  
**Routes:** `routes/hades/route.ts`, `routes/voice/route.ts`, `routes/agent/route.ts`, `routes/anthropic-agent/route.ts`, `routes/threads/route.ts`, `routes/threads/[id]/route.ts`  
**UI:** `components/AgentChat/index.tsx`  
**Example:** `src/agents/examples/hades-agent.ts`  
**Tests:** `src/agents/__tests__/jev.test.ts`, `hades.test.ts`, `jev-live-paths.test.ts`, `jev-speed.test.ts`, `jev-ground.test.ts`, `jev-redact.test.ts`, `thread-history.test.ts`, `convex-auth.test.ts`, `db-owner.test.ts`, `core.test.ts`  
**Package:** `package.json` exports `./jev`, `./hades`, `./hades/desktop`; `tsup.config.ts` entries `jev/index`, `hades/index`, `hades/desktop/index`; root barrel `src/agents/index.ts`  
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

### Wave 6 — Desktop attachment

The harness is what the Hades **desktop** app spawns. Added `createDesktopHost` / stdio sidecar, Jev fail-closed writes before `cap`, IPC contract (`hades_command` / `hades_event`), and [25 — Hades desktop](25-hades-desktop.md).

### Wave 32 — Evidence-answer skip Qwen

`hasAnswer` on the search ask was advisory: Qwen still wrote a reply (and could invent over a found fact) and postflight still ran. Unused `semanticFind` now rides that same ask as `best`. When the turn is factual (`is_factual ≥ 0.7`), there is no contradiction, and `best` is a ranked snippet, the plugin sets `jevDirectReply`. Core aborts the remaining generator tokens. `onAfterRun` ships the redacted snippet (title + source + grounded fields) and does not pay a postflight hop. A coding turn that happens to search still generates — only the `bestId` is attached.

### Wave 31 — MCP tool calls require auth

`/api/mcp` exposed every registered tool (`shell_exec`, `file_write`, …) with non-fatal auth. Unauthenticated callers got a working server and no `userId`. Tool execution now requires `auth.requireAuth` unless `HADES_MCP_ANON=true` (local inspector). Discovery GET without `Accept: text/event-stream` stays public. `POST /api/threads` uses the same 64 KiB cap and a 200-character title.

### Wave 30 — Client tool allowlist + JSON body cap

`/api/hades` and `/api/agent` appended client `tools` onto the agent and resolved them from the global registry. A caller could enable `shell_exec` / `deploy_prod` on a research agent. Requested names are now intersected with the agent's configured tools and skill bundles. JSON bodies larger than 64 KiB return `413` before parse (same class as the voice 8 MiB cap). `vaultIds` on `/api/anthropic-agent` is capped.

### Wave 29 — Tool-arg secrets when Auto Mode is off

Desktop writes already blocked a pasted `sk-` before Cap. HTTP `file_write` / `shell_exec` did not: with Auto Mode off the gate was skipped, so a key in `content` / `command` reached disk. `hasSevereSecret` now runs in `wrapTools` and `runToolGate` (before `alwaysApprove`). The tool does not execute. A note that only mentions "API key" still goes to Jev.

### Wave 28 — Remote-exec pipes and docker.sock

`rm -rf` was `destructive-local`, but `curl … | bash` and `bash -c "$(curl …)"` still reached the shell. Those are now the same wipe-class block. `/var/run/docker.sock` is `target-local` like `/etc/passwd`. A warning that only *mentions* piping curl to bash still passes.

### Wave 27 — Secret-path writes and grep

`cat /etc/passwd` was `target-local`, but `echo pwned > /etc/passwd`, `cp … ~/.ssh/authorized_keys`, and `grep root /etc/passwd` still reached the shell (or waited on Jev). Write verbs, redirects whose destination is a secret path, and extra read verbs (`grep` / `sed` / `awk` / `dd`) now share that zero-RTT label. A warning that only *mentions* `>` and `/etc/passwd` still passes.

### Wave 26 — Search SDE + unbound-tool bind

`sdeCascade` and `compareTexts` were helper-only. Adding a second hop after search would throw away Jev's parallel-question speed. Field presence (`has_answer`, `sde_number` / `sde_date` / `sde_source`) and a contradiction noul now ride the existing `planAndRerankSearch` ask. Material contradiction (`contradicts ≥ 0.75`) empties `ranked` and harvests a conflict card — Qwen does not treat both sides as facts. A missing answer still returns snippets but tells the model not to invent the fact. `wrong_fn` rides `runToolGate` next to `invented_args`: "read README" + `deploy_prod` is `unbound-tool` in the same RTT.

### Wave 25 — Foreman on swarm completion

`superviseWorker` existed and was unused on the live swarm path. `completeTask` still marks any result done. `completeTaskJev` now asks Foreman in one hop: stuck / off-track / needs-human fails the task; Jev-down is the same (do not accept unsupervised work); "continue" keeps the assignment; only an accept marks the task done.

### Wave 24 — Pagegrade on the browser ask

`scorePage` existed and was unused on the live path. Adding a second hop would have thrown away Jev's parallel-question speed. Clarity / SEO / trust now ride on the existing `screenBrowserPage` ask. Spam trust (`pagegrade-spam`) blocks the scrape; a poor grade turns a CLICK into EXTRACT so Qwen does not follow a junk page.

### Wave 23 — Adapter ownership + Supabase RLS

HTTP routes already 404 on a foreign `threadId`, but memory / Supabase / Prisma still loaded the row if you knew the id. Every adapter now hides or refuses foreign threads when `userId` is passed. Memory cascade-deletes runs. The Supabase adapter requires the service role key (the anon key is not a fallback). `supabase/migrations/002_agent_rls.sql` enables RLS so a user JWT can only see its own rows.

### Wave 22 — Convex identity + interpreter exfil

HTTP ownership checks did not protect the Convex deployment. `threads.create` / `get` / `listByUser` / `deleteThread` (and messages / runs) took a spoofable `userId` with no `ctx.auth.getUserIdentity()`. Those functions are now **internal**, require an identity, and refuse rows the subject does not own. The HTTP adapter calls them with `CONVEX_ADMIN_KEY` (or `CONVEX_DEPLOY_KEY`) acting as the signed-in user and maps `_id` → `id`. Delete cascades messages and runs. `python3 -c "open('/etc/passwd')"` is `target-local` the same way `cat /etc/passwd` is.

### Wave 21 — Desktop jailbreak + owned thread delete

`desktop.act` still asked Jev after a canned "ignore previous instructions" in `userRequest` / args. That is now `injection-local` at zero RTT; Cap does not start. `/api/threads` advertised `DELETE /:id` but the route did not exist, and `db.deleteThread` has no owner check. `DELETE /api/threads/[id]` now 404s unless `getOwnedThread` matches the caller.

### Wave 20 — Command-line exfil / SSRF

`localTargetDecision` only scanned path/url keys, so `shell_exec { command: "cat /etc/passwd" }` and `curl 169.254.169.254` skipped the label. Those strings are now classified from `command` / `cmd` / `args` when a read/fetch verb is present. `echo` / README mentions still pass.

### Wave 19 — Desktop local target + secret labels

`desktop.act` asked Jev (or fail-closed) before every write, but `/etc/passwd`, `../.env`, and a pasted `sk-` in export args still reached TypeSafe or waited on a hop. `assessDesktopAction` now runs `localTargetDecision` and `hasSevereSecret` first — Cap never starts, and reads that carry an exfil path are no longer auto-allowed.

### Wave 18 — Local-first command-failure class

Every failed `shell_exec` paid a Jev hop, and Jev-down blocked even a missing fixture (`ENOENT`). `localFailureDecision` now labels permission / transient / environment / code_bug / user_error from the stderr string. Qwen sees `jevFailure` and can retry or fix. Ambiguous stderr still fail-closed when Jev is down; secrets still never leave.

### Wave 17 — Local-first exfil / SSRF targets

`file_read` and `web_search` are "safe reads" and skipped Auto Mode, so a hallucinated `/etc/passwd`, `../.env`, or cloud-metadata URL never reached Jev. `localTargetDecision` scans path/url-shaped keys and blocks those strings in process. Search queries that mention the same tokens still pass. Wave 20 also scans `command` / `cmd` / `args`.

### Wave 16 — Stop looping on a stuck browser

`jevBrowser` was advisory. Qwen could still click a login wall after Jev said `stuck` / `BLOCKED`. Those steps now throw `jev_browser_step`. DONE / EXTRACT / CLICK are written into the instruction extras so the next generation uses the typed step instead of inventing a control.

### Wave 15 — One-ask browser screen + next step

`browser_*` paid a `screenExternal` hop, then Qwen guessed the next click. `decideBrowserStep` existed and was unused. `screenBrowserPage` now asks injection / substance / secret / action / target / done / stuck together. Local jailbreak or a pasted key is zero-RTT. Jev-down blocks both the screen and the step. The plugin attaches `jevBrowser` so Qwen sees the typed action instead of inventing one.

### Wave 14 — Local-first destructive commands

Auto Mode asked Jev whether `rm -rf /` or `git push --force` was destructive. Those strings are decided in process (`localDestructiveDecision`) so the tool never starts and TypeSafe is not consulted. Wipes block; force-git is HITL. File-write content is not scanned — only `command` / `cmd` / `args`.

### Wave 13 — Local-first jailbreak block

`detectInjection` already lived in `src/agents/guardrails/injection.ts` and was unused on the Hades path. Screens, preflight, search, and RAG now call `hasLocalInjection` first. A canned override is `injection-local` at zero RTT; those snippets are dropped before the System One body is built. Jev still scores borderline injection.

### Wave 12 — Split-key streams + owned approve/cancel

`createRedactStream` existed but live `onEvent` still redacted each SSE delta on its own, so `sk-` + the rest of the key leaked until `message_done`. The plugin and desktop sidecar now hold a 64-character tail per run. Approve / cancel only trusted `runId` after auth; they now load the run's thread and 404 unless the caller owns it. Desktop `approval.required` input and error strings are redacted before they hit the webview.

### Wave 11 — Secrets never leave for TypeSafe

Qwen-facing redaction still left raw keys in System One `state` (user text, stderr, page blobs) so Jev could score `secret_leak`. That shipped credentials to TypeSafe and, when Jev was down, only failed closed after a wasted hop. `sanitizeJevRequest` now redacts every payload; `hasSevereSecret` blocks screens / preflight / postflight / command-failure locally (`leaks-secret-local`); the asker overlays `secret_leak` / `leaks_secret` = 1.0 if a severe label was present. `/api/anthropic-agent` now matches Hades: owner check, redacted persistence, last-40 history.

### Wave 10 — Qwen sees the thread; voice shares it

Loading history into `input.messages` was not enough: `run(agent, userMessage)` still sent Qwen a single string. Core now converts the compacted thread to `AgentInputItem[]`. Voice (`/api/voice` + desktop `voice.turn`) uses the same owned thread, persists the turn, and returns a generic error if the pipeline throws.

### Wave 9 — One-RTT search + redacted tool events

`planAndRerankSearch` used a second System One call to rerank after planning. Those questions now share one request, and `inj_*` drops jailbroken snippets. `withJev.onEvent` redacts `tool_call` / `tool_result` so a key in stdout cannot ride the SSE stream to the desktop or browser.

### Wave 8 — Thread continuity + invented tool args

`/api/hades`, `/api/agent`, and desktop `chat.send` were one-line cold starts. Jev `is_followup` never saw the previous reply, compaction had nothing to prune, and Qwen re-solved every turn. Ingress now refuses another user's thread and loads the last 40 redacted turns. The same tool-gate ask also scores `invented_args` so a hallucinated path/URL is HITL or blocked without a second RTT.

### Wave 7 — Zero-RTT secret redaction

Jev screens drafts, but a key in tool stdout used to land in `jevEvidence` and the next Qwen prompt before postflight. `redactSecrets` now strips keys locally on every Qwen-facing surface: tool results, harvest/merge, compacted threads, streamed deltas, abstains, memory store/retrieve, desktop `cap` output, and persisted `/api/hades` + `/api/agent` messages. Wave 11 also sanitizes System One `state` and blocks severe secrets in code before the hop.

---

## 15. Debug / install sweep (how to prove it is installed)

Run from the repo root:

```bash
npx tsc --noEmit
npx vitest run
```

Expected: TypeScript clean; the Jev suites in `jev.test.ts`, `hades.test.ts`, `jev-live-paths.test.ts`, and `hades-desktop.test.ts` pass (including fail-closed cases for input, RAG, citations, command-failure, voice, and desktop writes).

Static install checks (already in this tree):

| Artifact | Must exist |
|---|---|
| `src/agents/jev/*.ts` | modules listed in §4 including `redact.ts` |
| `src/agents/hades/index.ts` | `createHadesHarness`, `shouldExecuteVoice` |
| `src/agents/hades/desktop/` | Sidecar host + IPC + Cap runner |
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
