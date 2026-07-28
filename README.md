# Next.js Agentic Starter Kit

Drop this into your existing Next.js SaaS and get 80% of your agentic infrastructure done correctly — streaming agents, tool registry, MCP server, multi-agent orchestration, and swappable DB/auth adapters, all pre-wired.

**This is not a standalone app.** It's a set of modules you copy into your existing project, connect to your existing auth and database, and wire up with your domain-specific tools.

---

## 🐝 Hermes-Swarm — dockerized agent swarms

A lightweight, Hermes-inspired swarm runtime ships in [`src/swarm-runtime/`](./src/swarm-runtime/):
a **manager agent** decomposes a goal, **spawns each worker agent in its own
isolated container**, delegates tasks, and accepts a result only after it clears
an **anti-hallucination verification gate** and **anti-rogue guardrail**. See
[**ARCHITECTURE.md**](./ARCHITECTURE.md) for the full design.

```bash
# Zero-config end-to-end demo (no Docker, no API keys)
npm run swarm:demo

# Run a goal locally (inline/process modes)
npm run swarm -- run "Summarize the repo architecture" --caps research,code
npm run swarm -- doctor          # which isolation backends are available?

# Live web dashboard (DAG, agents, evidence, metrics, controls) + terminal UI
npm run swarm:dashboard          # → http://127.0.0.1:8080
npm run swarm -- tui --manager-url http://127.0.0.1:8080

# Full container swarm: manager spawns hardened worker containers
docker build -f docker/swarm/worker.Dockerfile -t hermes-swarm-worker:latest .
docker compose -f docker-compose.swarm.yml up --build
```

| Capability | Where |
|---|---|
| Manager agent (plan → dispatch → verify → synthesize) | `src/swarm-runtime/manager/` |
| Isolated workers (inline / process / hardened docker) | `src/swarm-runtime/providers/` |
| Anti-hallucination: gate, consensus, contradiction, provenance, semantic + adversarial | `src/swarm-runtime/verification/` |
| Anti-rogue behavioural guardrail | `src/swarm-runtime/verification/guardrails.ts` |
| Autoscaling · recovery · budgets · cancellation · persistence | `src/swarm-runtime/manager/`, `persistence/` |
| MCP tools · cron · gateways · skills · provider abstraction | `mcp/`, `scheduling/`, `gateway/`, `skills/`, `worker/providers.ts` |
| Dashboard · TUI · REST · Prometheus `/metrics` · structured logs | `server/`, `tui/`, `observability/` |
| CLI (`hermes-swarm`) | `src/swarm-runtime/cli.ts` |

Full reference: [**ARCHITECTURE.md**](./ARCHITECTURE.md), [**docs/24-swarm-runtime.md**](./docs/24-swarm-runtime.md), [**CHANGELOG.md**](./CHANGELOG.md).

Library usage:

```typescript
import { createInlineSwarm } from "hades-agent/swarm-runtime";

const swarm = await createInlineSwarm({ capabilities: ["research", "code"], poolSize: 3 });
const goal = await swarm.runGoal("Describe the module architecture");
console.log(goal.status, goal.synthesis);   // "completed", <grounded synthesis>
await swarm.shutdown();
```

---

## 🔱 Hades — the learning agent on top of the swarm

Where the swarm *executes and verifies*, Hades adds the surfaces of a personal
agent — memory, a learning loop, connectors, an ACP editor bridge, a REPL and CLI.
It ships in [`src/hades/`](./src/hades/) as a second 40-iteration build on top of
the swarm core. **Honest status (see [`.plans/HADES_BEYOND_HERMES.md`](./.plans/HADES_BEYOND_HERMES.md)):**
much of this is well-tested *scaffolding with injectable seams* — the plumbing and
logic are real and unit-tested, but several subsystems (a default LLM brain, the
inbound half of most connectors, real remote backends) are not yet wired
end-to-end. Closing that gap to genuinely surpass Hermes is the active roadmap.

| Capability | Where |
|---|---|
| Closed learning loop: cross-session memory, curation, skill forge/tuner, user model | `src/hades/memory/`, `src/hades/learning/` |
| Messaging gateway — six connectors (Telegram, Discord, Slack, WhatsApp, Signal, Email/IMAP+SMTP), DM pairing + trust store, cross-channel continuity, STYX trust badges, `hades gateway start/status/pair/send/bench` (agent engine defaults to an honest self-announcing mock until a swarm engine is wired) | `src/hades/gateway/`, `hades gateway` |
| Remote backends — SSH + Docker/process (real); Modal/Daytona/Singularity (interface-only until Phase 2) | `src/hades/backends/` |
| ACP adapter: editor sessions, streamed updates, edit-approval + provenance | `src/hades/acp/` |
| Model switching · plugin system + examples · domain skill packs | `src/hades/models/`, `plugins/`, `skill-packs/` |
| Trajectory recording · batch generation · training-data compression | `src/hades/research/` |
| **`hades chat` — a real conversation**, not a pointer at an API: interactive REPL (multiline, history, slash commands), piped stdin, and a scriptable one-shot `hades chat --once "…"`. All three drive the same memory-augmented loop, so retrieval, the user model, context files and session persistence behave identically. With `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` it talks to a real model (`HADES_CHAT_MODEL` / `*_BASE_URL` override); with neither it answers as a self-announcing `[mock]` echo and says so on every turn — no path fabricates a model answer. It shares one guarded memory store with `hades memory`, so `/remember` in chat is findable from the CLI | `src/hades/chat/`, `src/hades/repl/`, `hades chat` |
| Unified `hades` CLI · layered config + env + i18n · Docker/installer | `src/hades/cli/`, `config/`, `bin/` |
| **Migrate off Hermes/OpenClaw in one command** — cross-platform discovery (env override / XDG / dotfile / macOS / Windows / legacy `clawdbot`+`moltbot`), real readers for JSON/JSONC config, dotenv, Markdown context files, JSONL sessions, SKILL.md skills and **SQLite** (dependency-free reader), a deterministic hash-stable plan with a real conflict engine, and a transactional apply with hash-chained receipts + full rollback. API keys move into a 0600 `secrets.env` and are never printed. `hades migrate scan/plan/apply/report/selftest`, plus the desktop app's **Import from Hermes / OpenClaw** card (same engine, same `<dataDir>`) | `src/hades/migrate/`, `hades migrate`, `src/desktop/core/migrate-service.ts` |
| Install/verify this build on a real machine: launcher + PATH plan, portable bundle with a sha256 manifest, tamper-checking verify — `hades install plan/bundle/verify/doctor` | `src/hades/install/`, `hades install` |
| **One trust gate every emitted output passes** — a single verifier registry over every shipped verifier (10 tool verifiers, the exec provenance chain, the memory write-guard, the user-model auditor, message-citation and procedure-structure verifiers, plus the two verifiers **above the T4 floor**: a `T1-reference` recompute gate that derives the answer from the request and rejects a mismatch, and a conditional `T3-agreement` cross-model gate). Registration alone never counts as coverage: a verifier that cannot vote here (no provider key) reports an unmet requirement and `hades trust doctor` counts **effective** voters, so a domain with two registrations but one working voter is still reported as unable to certify, naming the variable that would fix it. Label-free ensemble fusion, a hard strong-tier-dissent veto, per-domain split-conformal thresholds fitted **only from real labeled runs**, ed25519 certificates, and a hash-chained trust budget that refuses to spend rather than silently reset. An uncalibrated — or calibrated-but-non-discriminating — domain abstains and `hades trust doctor` FAILS it. `hades trust status/verifiers/calibrate/admit/budget/riskeval/doctor` | `src/hades/trust/`, `hades trust`, `src/desktop/core/trust-service.ts` |

Everything is built to test **without real credentials** — every connector,
backend, client, LLM/brain, clock, and transport is injectable.

```bash
./scripts/install-hades.sh    # Node 18+, installs, type-checks, drops `hades` on PATH
hades help

# Coming from Hermes or OpenClaw? Nothing is written until you pass --yes:
hades migrate scan            # what's on this machine (API keys reported by NAME only)
hades migrate plan            # the deterministic plan, with conflicts and blockers
hades migrate apply --yes     # transactional import; rolled back in full on any failure
hades migrate report          # verify the hash-chained receipt log

# What is this agent actually allowed to certify, and on what evidence?
hades trust verifiers         # every verifier, with its registered tier and prior ceiling
hades trust calibrate --from-eval   # fit from REAL graded runs (reports the AUC, honestly)
hades trust doctor            # fails loudly when a domain cannot certify — exit 0 iff healthy
```

Full reference: [**docs/HADES.md**](./docs/HADES.md),
[**docs/HADES_ARCHITECTURE.md**](./docs/HADES_ARCHITECTURE.md),
[`.plans/HADES_ROADMAP.md`](./.plans/HADES_ROADMAP.md).

### 🤝 Hades v2 — teams, A2A & on-demand parallel swarms

A third 30-iteration build makes Hades **team-native**: a task forms the right
team of role-specialized agents in isolated containers, they coordinate directly
over an agent-to-agent (A2A) bus (HMAC-signing transport available, opt-in), work
runs **in parallel** in-process, and the team disbands. The differentiated bet vs
Hermes is **verification-first, isolated, auditable** swarm execution — a moat
[`.plans/HADES_BEYOND_HERMES.md`](./.plans/HADES_BEYOND_HERMES.md) aims to turn
into a measured order-of-magnitude win on *verified work per dollar*.

| Capability | Where |
|---|---|
| A2A: addressing, mailbox/bus (**O(1) routing**), pub/sub, RPC, streaming | `src/hades/a2a/` |
| **Swarm hierarchy mode**: recursive coordinator→worker tree, in-process + **distributed over A2A** | `src/hades/hierarchy/` |
| Teams: roles, `TeamFormer`, spawn (in-process **or containerized**), lifecycle, coordinator | `src/hades/teams/` |
| Modular skills/plugins: manifests, semver resolution, hot load/unload, permissioned packages | `src/hades/modules/` |
| Parallel: fan-out, work-stealing balancer, map-reduce, assembly-line pipeline, speedup metric | `src/hades/parallel/` |
| Security: capability tokens (NHI), A2A signing, least-privilege scopes, audit, secure-by-default spawn | `src/hades/security/` |
| Benchmarks + lightweight: **runnable** latency/throughput harness, lazy-loading footprint | `src/hades/bench/` |

```bash
hades team roles              # the role vocabulary
hades team plan "<objective>" # preview the team that would form
```

**Signature swarm hierarchy mode** — a tree of coordinators recursively
decomposes a goal (root → sub-coordinators → workers) with parallel fan-out at
every level, so branching **B** and depth **D** marshal **B^D workers in D
coordination hops**. It runs in-process (`HierarchyOrchestrator`) or
**distributed over the real A2A bus** (`DistributedHierarchy` — each node its own
endpoint + RPC peer, so any node can live in its own container). Scale-tested to
**2048 workers deep** and **243 wide**.

**Measured performance** (runnable — `src/hades/bench/live-bench.ts`):

| Benchmark | Result |
|---|---|
| A2A throughput | **~2.4M messages/sec** |
| A2A RPC round-trip | **~230k ops/sec** (~0.004ms mean) |
| Hierarchy vs flat serial (64 workers) | **~28–42× speedup** |
| Direct routing scan @ 100 **and** 10,000 agents | **1** (O(1), not O(N)) |

Security primitives (opt-in, not yet default-wired): containerized workers *can*
be launched with **no network, read-only root, all Linux capabilities dropped,
resource ceilings** (when spawn limits are set); a **capability-token** checker
and an **HMAC-signing** A2A transport exist and are unit-tested. Honest status:
these are built and tested but **not engaged by the default execution path** —
wiring them on by default (and replacing shared-secret HMAC with real ed25519
signatures) is Phase 3 of [`.plans/HADES_BEYOND_HERMES.md`](./.plans/HADES_BEYOND_HERMES.md).
Full reference: [**docs/HADES_TEAMS.md**](./docs/HADES_TEAMS.md),
[**docs/HADES_BENCHMARKS.md**](./docs/HADES_BENCHMARKS.md),
[`.plans/HADES_V2_ROADMAP.md`](./.plans/HADES_V2_ROADMAP.md).

#### ⚡ Elite performance loop — the swarm hierarchy vs a flat baseline

A 16-iteration performance-engineering pass (each iteration built by a **team of
parallel agents with a dedicated adversarial verifier**; see
[`.plans/HADES_ELITE_LOOP.md`](./.plans/HADES_ELITE_LOOP.md)) pits the signature
swarm hierarchy against a **naive flat manager→worker orchestrator**. Run them
yourself:

```bash
hades hierarchy head-to-head   # routing + makespan: hierarchy vs flat baseline
hades hierarchy makespan       # O(N)→O(log N) makespan under a latency model
hades hierarchy chaos          # correct-verified XOR clean-audited under faults
hades hierarchy fuzz 300       # hierarchy result == flat reference, 300 random cases
hades hierarchy stats 4 3      # tree shape (workers/depth/nodes)
```

| Metric (hierarchy vs flat) | 16 workers | 64 | 256 | 1024 |
|---|---|---|---|---|
| **Routing** — `routeScans` count ratio¹ | 6.8× | 24.8× | **96.8×** | — |
| **Makespan** — discrete-event latency *model*² | 1.33× | 4.1× | 13.5× | **45.5×** |
| Aggregate correctness (hier == flat reference) | ✓ | ✓ | ✓ | ✓ |

> ¹ An **operation-count ratio, not wall-clock**: the flat baseline routes by an
> un-indexed linear scan (O(N²)); an indexed-`Map` flat orchestrator would also be
> O(N) — so this measures *indexed vs linear lookup*, a real but narrow result.
> ² A **virtual-clock simulation** of a serialized-sender cost model; no Hades
> runtime executes in it. It illustrates the textbook reduction-tree property. In
> the *measured wall-clock* head-to-head the flat baseline is currently **faster**
> (the hierarchy does more aggregation work) — an honest finding this repo does
> not hide. **These prove in-process correctness and complexity properties, not
> end-to-end agent throughput** — that is what [`.plans/HADES_BEYOND_HERMES.md`](./.plans/HADES_BEYOND_HERMES.md)
> sets out to measure on real inference.

Genuinely solid, honest results from the same loop: **live metrics** at ~180 ns/op;
**soak** holds ~1.1M in-process msg/s with **zero leak**; **circuit breakers**
short-circuit a dead subtree; **property-based** correctness (300 random
trees/reductions all match a flat reducer); a **chaos** pass returning a correct
verified aggregate **or** a clean audited failure — **0 silent-wrong across 125
fault runs**; and **regression guardrails** in CI. Every claim is backed by an
adversarial test suite. **Swarm + Hades + Hades v2 + Elite: 1444 tests** (≈95%
in-memory units — real-inference integration is the next frontier).

---

## Why this over alternatives?

- **Governance engine built-in** — policy enforcement, ethics checks, and compliance audit trails are first-class, not afterthoughts.
- **Capability tokens per run (NHI)** — every agent run is scoped with non-human identity tokens, enabling fine-grained per-run tool authorization.
- **MCP server out of the box** — every registered tool is instantly available to Claude Desktop, Cursor, or any MCP client at `/api/mcp` with no extra config.
- **Copy-don't-inherit** — you own the source; no SDK lock-in, no hidden abstractions, no breaking upgrades forced on you.
- **OpenAI Agents SDK native** — built on the official `@openai/agents` SDK, so handoffs, tracing, and model updates come from the source.

---

## What you get

```
Agentic capability                    Already handled
────────────────────────────────────────────────────────────
Streaming agent runs (SSE)          ✓ routes/agent/route.ts
Multi-agent handoffs                ✓ src/agents/orchestrator.ts
Tool registry                       ✓ src/agents/tools/registry.ts
MCP server + client                 ✓ src/agents/mcp/ + routes/mcp/
Cancellation + retry                ✓ src/agents/harness.ts
Web search (Tavily)                 ✓ src/agents/tools/web/tavily.ts
Parallel browser sessions           ✓ src/agents/tools/web/browser.ts
Sandboxed code execution            ✓ src/agents/tools/sandbox/
Composio OAuth (100+ APIs)          ✓ src/agents/tools/composio/
Thread + message persistence        ✓ src/agents/db/
Auth adapter interface              ✓ src/agents/auth/
Supabase / Convex / Prisma support  ✓ DB_PROVIDER env var
Clerk / Auth0 support               ✓ AUTH_PROVIDER env var
Chat UI component                   ✓ components/AgentChat/
```

You bring: your existing auth, your existing database, and your domain-specific tools.

---

## How to add it to your project

### 1. Copy the modules

```bash
# Clone the starter
git clone https://github.com/mosnin/agent_harness_starter /tmp/agent-starter

# Copy into your existing project
cp -r /tmp/agent-starter/src/agents    your-project/src/agents
cp -r /tmp/agent-starter/routes        your-project/src/app/api    # merge into existing api/
cp -r /tmp/agent-starter/components    your-project/src/components  # merge
```

> The entire agent infrastructure lives under `src/agents/`. It doesn't touch your existing code.

### 2. Install dependencies

```bash
# Core (always required)
npm install @openai/agents zod@^4 @modelcontextprotocol/sdk

# Tools you want to use
npm install @tavily/core                        # web search
npm install @browserbasehq/sdk playwright-core  # browser automation
npm install composio-core                        # OAuth for 100+ APIs
npm install @daytonaio/sdk                       # code sandboxes

# Fix Zod version conflict between @openai/agents and composio-core
```

Add to `package.json`:
```json
"overrides": {
  "composio-core>zod": "^3.24.0"
}
```

### 3. Add environment variables

```bash
# Minimum to get started
OPENAI_API_KEY=sk-...

# Match your existing setup
DB_PROVIDER=supabase          # supabase | convex | prisma
AUTH_PROVIDER=clerk           # clerk | auth0
```

Full reference: [`.env.example`](./.env.example)

### 4. Wire to your existing auth and DB

If you already use Clerk: set `AUTH_PROVIDER=clerk` — done.
If you already use Supabase: set `DB_PROVIDER=supabase`, run the migration SQL — done.

See **[docs/02-connecting-your-app.md](./docs/02-connecting-your-app.md)** for all providers including NextAuth, custom JWT, MongoDB, DynamoDB, etc.

### 5. Add your first agent to a page

```tsx
import { AgentChat } from "@/components/AgentChat";

export default function DashboardPage() {
  return (
    <div>
      {/* ... your existing dashboard UI ... */}
      <AgentChat agentName="research" placeholder="Ask me about your data..." />
    </div>
  );
}
```

---

## How it works

```
User types in AgentChat
        ↓
POST /api/agent  (routes/agent/route.ts)
        ↓
auth.requireAuth()  →  your existing auth
        ↓
createHarness(agentConfig)  →  @openai/agents run()
        ↓
Agent calls tools  →  your registered tools
        ↓
SSE stream → AgentChat renders events in real time
        ↓
db.saveMessage()  →  your existing database
```

---

## Adding tools for your product

Tools connect your domain data and actions to the agent. Register them once; they're available everywhere:

```typescript
// src/agents/tools/crm/contacts.ts
import { z } from "zod";
import { registerTool } from "@/agents/tools/registry";

export const searchContactsTool = registerTool({
  name: "crm_search_contacts",
  description: "Search CRM contacts by name, email, or company.",
  parameters: z.object({
    query: z.string(),
    limit: z.number().default(10),
  }),
  async execute({ query, limit }, ctx) {
    // ctx.userId = authenticated user from your auth adapter
    return YourContactService.search({ query, limit, userId: ctx.userId });
  },
});
```

Add to `src/agents/tools/index.ts`:
```typescript
export * from "./crm/contacts";
```

The tool is now available to agents AND the MCP server at `/api/mcp` — no extra config.

---

## Multi-agent orchestration

```typescript
import { createOrchestrator } from "@/agents/orchestrator";

const support = createOrchestrator({
  routerAgent: {
    name: "Router",
    model: "gpt-4o-mini",        // cheap: just routing
    instructions: "Route to Billing or Technical support.",
  },
  specialists: [
    {
      name: "BillingAgent",
      model: "gpt-4o",
      instructions: "Handle billing questions...",
      tools: ["billing_get_invoice", "billing_create_refund"],
    },
    {
      name: "TechnicalAgent",
      model: "gpt-4o",
      instructions: "Debug technical issues...",
      tools: ["dev_get_logs", "search_docs", "web_search"],
    },
  ],
});

const result = await support.run({
  messages: [{ role: "user", content: userMessage }],
  context: { userId },
});
```

---

## MCP server

Your `/api/mcp` endpoint exposes every registered tool to any MCP client:

```bash
# Inspect
npx @modelcontextprotocol/inspector http://localhost:3000/api/mcp

# Claude Desktop
{ "mcpServers": { "myapp": { "url": "https://yourapp.com/api/mcp" } } }
```

Consume external MCP servers by adding them to `MCP_SERVERS` in `.env.local`.

---

## Documentation

| Guide | What it covers |
|---|---|
| **[01 — Integration](./docs/01-integration.md)** | Step-by-step: copy files, install deps, fix imports, first run |
| **[02 — Connecting Your App](./docs/02-connecting-your-app.md)** | Wire to your existing auth, DB, services, and user model |
| **[03 — Building Tools](./docs/03-building-tools.md)** | Tool anatomy, patterns, authorization, testing |
| **[04 — APIs and MCPs](./docs/04-apis-and-mcps.md)** | REST APIs, Composio OAuth, consuming/exposing MCP servers |
| **[05 — Model Configuration](./docs/05-model-configuration.md)** | Model selection, prompts, temperature, context, cost |
| **[06 — Harness and Orchestration](./docs/06-harness-orchestration.md)** | Streaming, cancellation, multi-agent patterns, observability |
| **[07 — Deployment](./docs/07-deployment.md)** | Vercel, Docker, migrations, rate limiting, cost controls |

---

## Domain examples

Copy these as starting points for your SaaS type:

| Directory | What's inside |
|---|---|
| [`examples/crm/`](./examples/crm/) | Contact search, deal updates, note-taking, outreach |
| [`examples/ecommerce/`](./examples/ecommerce/) | Order lookup, refunds, shipment tracking, address updates |
| [`examples/devtools/`](./examples/devtools/) | Repo status, issue management, CI monitoring, deployments |

---

## File structure

```
agent_harness_starter/
├── src/agents/                # Copy to: your-project/src/agents/
│   ├── harness.ts             # Streaming run loop, retry, cancellation
│   ├── orchestrator.ts        # Multi-agent handoffs and parallel runs
│   ├── types.ts               # AgentConfig, AgentEvent, RunInput, RunResult
│   ├── utils.ts               # Tool → OpenAI SDK adapter, JSON schema export
│   ├── tools/
│   │   ├── registry.ts        # registerTool, getAllTools, getTools
│   │   ├── types.ts           # ToolDefinition, ToolContext
│   │   ├── index.ts           # Import here to register your tools
│   │   ├── web/               # Tavily search, parallel browser scraping
│   │   ├── sandbox/           # Daytona and Modal code execution
│   │   └── composio/          # Per-user OAuth for 100+ APIs
│   ├── mcp/
│   │   ├── server.ts          # MCP server (exposes all tools)
│   │   └── client.ts          # MCP client (consume external servers)
│   ├── db/                    # DB adapters: memory | supabase | convex | prisma
│   ├── auth/                  # Auth adapters: none | clerk | auth0
│   ├── lib/
│   │   ├── config.ts          # Central env-var config
│   │   └── utils.ts           # SSE stream, retry, sleep
│   └── examples/              # Reference agent configs (research, code)
│
├── routes/                    # Copy to: your-project/src/app/api/
│   ├── agent/route.ts         # POST /api/agent — streaming SSE endpoint
│   ├── mcp/route.ts           # GET+POST /api/mcp — MCP server
│   ├── threads/route.ts       # GET/POST /api/threads
│   └── composio/connect/route.ts  # GET /api/composio/connect
│
├── components/                # Copy to: your-project/src/components/
│   ├── AgentChat/             # Drop-in streaming chat UI
│   └── AgentStatus/           # Running indicator with cancel button
│
├── examples/                  # Domain-specific starting points
│   ├── crm/                   # CRM SaaS tools + agent configs
│   ├── ecommerce/             # E-commerce tools + agent configs
│   └── devtools/              # Dev platform tools + agent configs
│
├── docs/                      # Integration guides
├── prisma/schema.prisma       # Add to your existing Prisma schema
├── convex/                    # Add to your existing Convex project
├── supabase/migrations/       # Run in your existing Supabase project
└── .env.example               # All env vars with documentation
```

---

## License

MIT
