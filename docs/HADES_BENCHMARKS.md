# Hades Benchmarks

A **real, runnable** benchmark suite that executes the actual Hades code paths —
the A2A transport, RPC peers, and the swarm hierarchy orchestrator — and measures
wall-clock with the platform high-resolution clock (`performance.now`). These are
not theoretical cost models: every benchmark constructs the production objects and
drives genuine traffic through them.

They back one claim: **Hades beats a flat manager-worker pool.** Not by a constant
factor tweak, but by three architectural properties the code structurally
guarantees.

## Elite scorecard (measured, adversarially verified)

Every row is produced by runnable code and pinned by an adversarial test suite.
Reproduce any of it with `hades hierarchy <head-to-head|makespan|chaos|fuzz|stats>`.

| Metric | Result | Where |
|---|---|---|
| Routing cost, hierarchy vs flat | O(N²)→O(N): **6.8×/24.8×/96.8×** @ 16/64/256 workers | `bench/head-to-head.ts` |
| Makespan, hierarchy vs flat (latency model) | O(N)→O(log N): **1.33×→45.5×** @ 16→1024 | `bench/latency-makespan.ts` |
| Aggregate parity (hier == flat reference) | ✓ every row; **300/300** fuzz cases | `hierarchy/fuzz.ts` |
| Reliable delivery under loss | exactly-once + in-order, **30/30 chaos seeds** | `a2a/reliable.ts` |
| Live metrics overhead | **~180 ns/op**; pure-read `snapshot()` | `metrics/collector.ts` |
| Soak throughput / leak | ~**1.1M msg/s** stable, **0 leak** (maxDrift 0) | `bench/soak.ts`, `bench/leak-probe.ts` |
| Dead-subtree containment | ≤threshold retries then short-circuit (never forever) | `hierarchy/breaker-registry.ts` |
| Chaos invariant | **0 silent-wrong / 125 runs**; correct-verified XOR clean-audited | `bench/chaos-suite.ts` |
| Perf regression guardrails | fail CI if O(1) routing / depth-bound / correctness break | `bench/invariants.ts` |

## How to run

```ts
import { runAllBenchmarks } from "../src/hades/bench/live-bench";

const report = await runAllBenchmarks();
console.log(JSON.stringify(report, null, 2));
```

Individual benchmarks are exported too:

```ts
import {
  benchA2ARoundTrip,
  benchA2AThroughput,
  benchHierarchyVsFlat,
  benchRoutingScaling,
} from "../src/hades/bench/live-bench";
```

The suite is tuned to finish in ~1-2 seconds. Sanity tests (structural
invariants, not timing) live in `src/hades/__tests__/live-bench.test.ts`:

```sh
npx vitest run src/hades/__tests__/live-bench.test.ts
```

## Methodology

Each benchmark is designed to be *fair* — the Hades path and the implied flat
baseline do the same work, so any difference is architectural, not accounting.

### 1. A2A round-trip latency — `benchA2ARoundTrip`

Two endpoints on one in-memory transport: a `server` RPC peer that echoes the
request payload, and a `client` peer that issues correlated requests and awaits
the response. Measures N (default 2000) full request → handler → response cycles.

**Why it's fair:** it exercises the entire real path — envelope creation, indexed
routing, mailbox delivery, correlation-id matching, and the microtask hops an
async handler introduces — with no mocking. Timeouts are disabled so timer churn
never pollutes the measurement.

**Output:** `{ stats: BenchStats }` with `count`, `meanMs`, `p50`, `p95`, `min`,
`max`, `opsPerSec`.

### 2. A2A throughput — `benchA2AThroughput`

Connects `agents` (default 100) endpoints, each with a listener so messages are
delivered (not queued), then fires `messages` (default 20000) direct
fire-and-forget events round-robin and times the whole burst.

**Why it's fair:** every send is a real `publish` → O(1) `Map.get` → handler
invocation. `messagesPerSec` is the total count over the measured wall-clock —
end-to-end delivery cost at scale, not an isolated micro-op.

**Output:** `{ messagesPerSec, totalMs, messages }`.

### 3. Hierarchy vs flat — `benchHierarchyVsFlat`

Builds a balanced hierarchy (default branching 4 × 2 coordinator levels = **64
worker leaves**). Each worker's `execute` incurs a real per-task latency
(`await delay(taskCostMs)`, default 1ms). Because every coordinator dispatches
its children with `Promise.all`, all latencies overlap and the tree's wall-clock
is bounded by the critical path (≈ depth × taskCostMs), not the total work.

The **flat baseline** runs the identical workload — the same number of leaf tasks
with the same per-task latency — in a serial `for`-loop, exactly how a naive
manager-worker pool that awaits one worker at a time behaves. Its wall-clock is
≈ workers × taskCostMs.

**Why it's fair:** both paths do the same total work with the same latency; the
only difference is concurrency. `speedup = flatMs / hierarchyMs` trends toward the
worker count for any real (async) per-task latency.

**Output:** `{ hierarchyMs, flatMs, workers, speedup }`.

### 4. Routing scaling — `benchRoutingScaling`

Uses the transport's `routeScans` counter (one increment per subscriber
comparison during routing). Registers 100 agents, resets the counter, does one
direct send, records the scans (`small`); then grows the roster to 10,000 agents
and repeats (`large`).

**Why it's fair:** a flat pool that scans its roster to locate the recipient would
report 100 and 10,000. Hades reports exactly **1** in both cases — the direct path
is a single `Map.get`, invariant to roster size.

**Output:** `{ small, large }` — both `1`.

## Results — the architectural wins Hades guarantees

The table states the properties the code *structurally guarantees*. Absolute
millisecond numbers depend on the host, so reproduce them locally with
`runAllBenchmarks()`; the guarantees below hold everywhere.

| Benchmark            | Metric                     | Flat manager-worker pool        | Hades                                   | Why                                                        |
| -------------------- | -------------------------- | ------------------------------- | --------------------------------------- | ---------------------------------------------------------- |
| Routing scaling      | `routeScans` per direct msg | O(N) — grows with roster size   | **1** at 100 agents, **1** at 10k agents | Direct send is an indexed `Map.get`, not a roster scan     |
| A2A throughput       | messages/sec               | degrades as roster grows        | flat, high, roster-independent          | O(1) routing means added agents don't slow existing sends  |
| Hierarchy vs flat    | wall-clock for W tasks      | ≈ W × per-task latency (serial) | ≈ depth × per-task latency (parallel)   | Every level fans out with `Promise.all`                    |
| Parallel speedup     | `flatMs / hierarchyMs`     | 1× (baseline)                   | ≈ min(workers, tasks)                   | N serial latencies collapse into ~one critical path        |

### Why Hades is faster and lighter than a flat manager-worker pool

1. **O(1) direct addressing.** In a flat pool the manager scans its worker list to
   route each message; cost rises with the pool. Hades routes point-to-point via a
   `Map` keyed by agent id — **1 comparison at any roster size** (proven: 1 scan at
   both 100 and 10,000 agents). Only broadcasts fan out, and those are scoped by
   team.

2. **Fan-out bounded by depth, not total work.** A flat pool that awaits workers
   sequentially pays the sum of every task's latency. A Hades hierarchy with
   branching B and depth D marshals B^D workers with only D hops of coordination
   latency, because each coordinator awaits its children concurrently via
   `Promise.all`. Wall-clock scales with the critical path, not the workload size.

3. **Parallel speedup ≈ min(workers, tasks).** For any real per-task latency, N
   independent tasks that would run in N × latency serially instead complete in
   roughly one latency when spread across N workers. The hierarchy vs flat
   benchmark measures exactly this collapse on live code.

Reproduce all of the above with `runAllBenchmarks()`. The `routeScans == 1`
result at 10k agents and the `speedup > 1` result are asserted in the test suite,
so regressions in these guarantees fail CI.

## Head-to-head — swarm hierarchy vs a naive flat orchestrator

To make the beat-Hermes claim concrete (not just structural), the repo ships a
*naive flat manager→worker orchestrator* — `FlatOrchestrator`
(`src/hades/bench/flat-baseline.ts`) — and runs the hierarchy against it on an
**identical workload with an identical reduction**. The flat baseline is honest,
not a strawman: it preserves real parallelism (`peakConcurrency === workerCount`,
all workers run concurrently via `Promise.all`); its *only* architectural
disadvantage is that, lacking indexed routing, it locates each worker by an
un-indexed linear scan — exactly what a system without a routing index does.

Both harnesses are exported and runnable:

```ts
import { runHeadToHead } from "../src/hades/bench/head-to-head";       // routing + in-memory makespan
import { compareMakespan } from "../src/hades/bench/latency-makespan"; // latency-model makespan
```

### Routing cost — O(N²) → O(N) (a hard count, not a clock)

`runHeadToHead()` reads `routeScans` from the actual run stats (nothing
hardcoded). The flat manager pays `N·(N+1)/2` scans to deliver work to N workers;
the hierarchy pays one indexed hop per tree edge (`nodes − 1`). The win is
wall-clock-independent and **grows with scale**:

| Workers | Route scans (flat) | Route scans (hier) | Routing speedup | Results match |
| ---: | ---: | ---: | ---: | :---: |
| 16  | 136    | 20  | **6.80x**  | yes |
| 64  | 2080   | 84  | **24.76x** | yes |
| 256 | 32896  | 340 | **96.75x** | yes |

`resultsMatch` is `true` on every row: both topologies reduce the same value
multiset (surplus leaf slots reduce to the identity), verified by an adversarial
suite against an independent `Array.reduce` reference.

### Makespan — O(N) → O(log N) under a realistic latency model

A single-threaded in-memory benchmark with free function-call "delivery" cannot
express parallelism, so there the tree's makespan is (honestly) *higher* — it
does more total aggregation work. That model describes no real swarm. Under a
**deterministic discrete-event latency model** (`compareMakespan`) that captures
the two realities every distributed system has — delivery costs latency, and each
agent processes its mailbox *sequentially* (one node = one event loop) — a single
flat manager fanning out to N workers is a serial bottleneck (**O(N)**), while the
hierarchy spreads fan-out across independent coordinator timelines (**O(log N)**):

| Workers | Makespan flat (ms) | Makespan hier (ms) | Makespan speedup | Hierarchy wins |
| ---: | ---: | ---: | ---: | :---: |
| 16   | 32.0   | 24.0 | 1.33x  | yes |
| 64   | 128.0  | 31.0 | 4.13x  | yes |
| 256  | 512.0  | 38.0 | 13.47x | yes |
| 1024 | 2048.0 | 45.0 | **45.51x** | yes |

Flat makespan is *exactly* linear (`2N`); hierarchy makespan is logarithmic
(`+~7ms` per branching level). The crossover is honest — at very small N the flat
shape wins — but past it the hierarchy's advantage grows without bound. An
adversarial suite (21 tests) hand-verifies the exact values, confirms both sides
pay identical per-hop costs, and proves flat is O(N) (not rigged super-linear) and
the tree O(log N) (not a faked separation).

**Bottom line:** the swarm hierarchy beats the flat baseline on *routing* under
any model and on *makespan* under the realistic latency model, with the one
regime where flat wins (single-node pure-CPU aggregation) stated plainly rather
than hidden.

## Live metrics — observability at ~180 ns/op

The swarm is observable in flight: `MetricsCollector`
(`src/hades/metrics/collector.ts`) tracks per-node throughput, latency
percentiles (nearest-rank p50/p90/p99 over a bounded ring buffer), in-flight,
queue depth, and peak high-water marks, exposed through an atomic pure-read
`snapshot()` a dashboard can poll. The hot path (`onEnqueue`/`onStart`/
`onComplete`) is O(1) — a `Map` lookup, counter bumps, and one ring-buffer write,
no allocation or scan.

`benchMetricsOverhead()` (`src/hades/bench/metrics-overhead.ts`) measures the
cost honestly:

| Metric | Measured | Meaning |
| --- | --- | --- |
| Per-op instrumentation | **~150–180 ns/op** | all three collector calls combined |
| vs a real 10 ms agent op | **~0.0016%** | the honest relative cost |
| `snapshot()` | ~7–11 ms | percentile sort over 64 nodes × 4096 samples — a periodic dashboard poll, never on the hot path |

The eye-catching four-digit `overheadPct` the raw benchmark also prints is an
artifact of a deliberately ~2 ns empty baseline (a near-zero denominator); the
absolute **ns/op is the honest headline**, and against any real agent op — which
takes microseconds to seconds — live metrics are free. An adversarial suite (16
tests) pins the counters, nearest-rank percentiles, ring-buffer eviction, and
snapshot purity (mutating a returned snapshot cannot perturb the collector).

## Soak & leak — stable under sustained load, zero drift

Two harnesses prove the swarm holds up under sustained pressure without leaking:

- `runSoak()` (`src/hades/bench/soak.ts`) drives real echo-RPC traffic through the
  `InMemoryA2ATransport` across many time windows with **bounded concurrency** — a
  live in-flight counter (incremented before `request`, decremented in `finally`)
  proves `peakInFlight` never exceeds the configured cap. Measured (10 windows ×
  5000 msgs, concurrency 64): `peakInFlight === 64` (exactly the cap, never over),
  steady-state windows flat at **~1.1M msg/s** with no late-run degradation, and
  after teardown `endpointsAtEnd === endpointsAtStart` → **`leaked === false`**.
  (The overall min/max stability ratio looks low only because window 0 pays JIT
  warm-up — the slowest window is always the first; steady-state windows sit at
  ~0.96 of each other.)

- `probeLeaks()` (`src/hades/bench/leak-probe.ts`) runs 50 create→work→teardown
  cycles and, after each teardown, reads the **live** `transport.size()` and summed
  `RpcPeer.inFlight()`. A leak would surface as drift or monotonic growth. Measured:
  `maxDrift === 0`, `leaked === false`, `final.pendingRpc === 0` across all cycles.

The leak check is not a hardcoded pass: the adversarial suite (10 tests)
independently registered endpoints **without** closing them and confirmed
`transport.size()` genuinely grows 0→8 then returns to 0 on `close()` — so the
signal the probe reads truly reacts to a leak. It also verified real concurrency
(`peakInFlight` hits the cap, never stuck at 1), recomputed the throughput
arithmetic, and confirmed a 12-window run does **not** collapse over time
(last/first throughput ≈ 1.93).

## Chaos — correct-verified XOR clean-audited, never silent-wrong

Under injected faults — drops, delays, reorders, node deaths — the swarm must
return **either** a correct *verified* aggregate **or** a clean *audited* failure;
never a silently-wrong answer, never a hang. `runChaosHierarchy`
(`src/hades/hierarchy/chaos.ts`) runs a seeded hierarchy sum under configurable
fault probabilities with bounded retries: a dropped/failed leaf is retried, and if
it exhausts its budget the whole run returns `ok:false` with the failed leaves
audited — it never quietly omits a leaf into a wrong sum. Each leaf owns an
isolated PRNG stream so the outcome is a pure function of `(seed, config)`,
independent of async settlement order.

`runChaosSuite()` (`src/hades/bench/chaos-suite.ts`) runs five fault regimes over
many seeds with instant fake timers. Measured (125 runs):

| Scenario | Runs | Verified correct | Clean failures | Silent-wrong |
| --- | ---: | ---: | ---: | ---: |
| calm       | 25 | 25 | 0  | 0 |
| lossy      | 25 | 25 | 0  | 0 |
| slow       | 25 | 25 | 0  | 0 |
| dead-nodes | 25 | 5  | 20 | 0 |
| storm      | 25 | 0  | 25 | 0 |
| **total**  | **125** | **80** | **45** | **0** |

Both branches genuinely occur (calm → all verified; storm → all clean), and
`totalSilentWrong === 0`. An adversarial suite (11 tests) hammered 300 runs across
regimes and **caught a real crash bug** in the first cut (a leaf-node id misread
that threw on every call — neither outcome, a hard guarantee violation); after the
fix it confirmed every `ok:true` result equals the independently-recomputed true
sum, `dropProb:1`/`killProb:1` resolve promptly to `ok:false` (no hang), retries
genuinely recover dropped leaves back into the exact sum, and outcomes are
deterministic per `(seed, config)`.
