# `hades showdown` — the correct-work-per-dollar demo

`hades showdown` runs a deterministic multi-family task suite through TWO
lanes over the **identical** tasks:

1. **swarm** — the real verification-gated swarm engine (`createInlineSwarm`
   / the real `SwarmManager`, the same engine `src/swarm-runtime` runs in
   production). Every worker result must clear the real anti-hallucination
   verification gate before it counts as "done".
2. **baseline** — a single agent that trusts itself: it always self-declares
   its output verified, with no independent check. This is the Hermes-style
   "one model, no second opinion" baseline.

Both lanes are scored with **V-TPH$ (Verified Tasks per Hour per Dollar)** —
the correct-work-per-dollar north star defined in
`src/hades/bench/vtph.ts` — computed by the real `runVtph` /
`compareVtph`, never reimplemented here. Every task outcome, on both lanes,
is appended to a hash-chained audit ledger (`sha256Hex`, the same engine
`src/hades/browser/trace.ts` uses) so the whole run is independently
re-verifiable after the fact, byte for byte.

## What is actually measured

For each task the harness records, per lane:

- **verified-correct** — the lane claimed the result was trustworthy AND an
  independent, pure ground-truth grader (`EvalTask.grade`, real code, not
  the agent's opinion) confirms it. This is the only work that counts toward
  V-TPH$.
- **silent-wrong** — the lane claimed "verified" but the grader says the
  output is wrong. This is the **trust-failure metric**. A single agent with
  no verification gate reports "done" whether or not it is actually right;
  a real verification gate is supposed to catch that and decline instead of
  lying. `silentWrong` is not asserted to be a particular value anywhere in
  the harness — it is *measured* from what the real gate and the real
  baseline runner actually did.
- **declined** — the lane did not claim the result was trustworthy (includes
  a task the real gate rejected, and a task the real gate sent back for
  revision until attempts ran out).
- **V-TPH** / **V-TPH$** — verified-correct work per wall-clock hour, and per
  dollar spent. This is the number that answers "does paying for
  verification actually buy more *trustworthy* throughput per dollar, or
  just more throughput?"

Every outcome on both lanes also lands in a hash-chained `AuditRecord`
ledger (`seq`, `taskId`, `lane`, `verdict`, `elapsedMs`, `usd`, `mode`,
`prevHash`, `hash`). `verifyAuditChain` re-derives every hash from scratch
and reports the exact broken index if anything — a value, an ordering, a
dropped record — was tampered with after the fact.

## The task suite

Four independently-graded task families, generated deterministically from a
seed (mulberry32 PRNG — no `Math.random` anywhere in the generator):

| Family | What it asks | Ground truth |
| --- | --- | --- |
| `arithmetic` | Evaluate a short pipeline of add/subtract/multiply steps | Computed by real code from the same operation list embedded in the prompt |
| `extraction` | Pull one named field's exact value out of a rendered record | The field's real value, present in the record by construction |
| `transform` | Apply reverse / upper / lower / rot13 / word-count to text | Computed by real code applying that exact transform |
| `checksum` | Compute the FNV-1a 32-bit checksum of a string | Computed by real code (standard FNV-1a, 8 lowercase hex digits) |

Every task's `grade` function is a pure closure around ground truth computed
*by construction* at generation time — never a fabricated label bolted on
afterward. The same seed and task count always produce byte-identical
prompts and ground truth.

## Modeled vs. real — the honesty rule

`hades showdown` has exactly two modes, and there is no code path that
prints a number without saying which one produced it:

- **`--mode modeled`** (the default) uses deterministic, scripted providers:
  no network call, no API key, and the same seed always produces the same
  answers, the same difficulty distribution, and byte-identical audit
  hashes. Every figure this mode produces is labeled `(modeled)` in both the
  text and markdown renderers — in the report table, in the terminal
  summary, everywhere a number appears.
- **`--mode real`** requires a configured provider key
  (`ANTHROPIC_API_KEY` or `OPENAI_API_KEY`). If neither is set, `hades
  showdown run --mode real` fails immediately with an error naming the
  missing variable — it never silently falls back to the modeled numbers.
  With a key present it wires the real model client and the real
  swarm-runtime LLM executor / single-agent runner (the same production code
  paths `hades bench` uses) unless you inject your own worker/executor.

Modeled numbers are a **reproducible, labeled demonstration of the
mechanism** (does a real verification gate actually drive silent-wrong to
zero on tasks a scripted dishonest worker gets wrong?) — they are not a
claim about live-model accuracy or cost. Only a `--mode real` run, with a
live provider, is a claim about that.

## Running it

```
hades showdown run [--tasks N] [--seed S] [--mode modeled|real] [--out dir]
hades showdown verify <dir>
```

- `--tasks` — suite size (default 200).
- `--seed` — PRNG seed for the suite and the (modeled-mode) difficulty
  stream (default 42). Same seed + same task count ⇒ byte-identical audit
  hashes across runs.
- `--mode` — `modeled` (default, no key needed) or `real` (needs a provider
  key).
- `--out dir` — also write `report.md`, `audit.jsonl` (one `AuditRecord`
  JSON object per line), and `result.json` (the full `ShowdownResult`) into
  `dir`, via atomic tmp-then-rename writes.

`hades showdown verify <dir>` re-reads `<dir>/audit.jsonl` and independently
re-verifies the hash chain from scratch — it does not trust anything the
file claims about itself. It catches a truncated log (a crash mid-write, or
a malformed line), a reordered log, and a log with even one tampered field
in one record, and reports the exact record index where verification broke.

## Live runs — the keyed, budgeted, manifested exit lane

```
hades showdown live --out <dir> [--tasks N] [--seed S] [--max-wall-ms MS]
hades showdown live-verify <dir>
```

`live` runs `mode: "real"` through the same engine, with extra discipline
because real money is spent:

- **No key, no run**: without `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` it
  refuses and says so. There is no modeled fallback — live numbers exist
  only when a real, keyed run actually happened.
- **Spending guards**: `--tasks` defaults to 12 and is hard-capped at 50;
  `--max-wall-ms` (default 15 min) refuses to publish a run that overran.
- **Refusal to publish**: a result whose mode isn't `"real"`, or whose audit
  hash chain fails an independent re-check, is thrown away — no artifacts.
- **`manifest.json`**: written atomically after the artifacts, carrying the
  provider/model/seed/task-count/wall-clock plus a sha256 over the exact
  on-disk bytes of `report.md` / `audit.jsonl` / `result.json`.

`live-verify` re-reads all four files and re-derives every claim: JSON
validity, the audit hash chain, audit-vs-result cross-checks (catches
truncation), per-file sha256 vs the manifest, and a fresh `compareVtph`
recomputation of the V-TPH$ multiple — a hand-edited multiple is caught even
when it "looks" internally consistent. It collects every finding instead of
stopping at the first.

## Example output shape (not real numbers — run it yourself)

```
$ hades showdown run --tasks 200 --seed 42

SHOWDOWN — mode: MODELED (deterministic scripted demo, not live inference)
seed=42  tasks=200  audit-records=400 (chain verified OK)

Swarm (verification-gated):
  tasks:              200 (modeled)
  verified-correct:   <your measured value> (modeled)
  silent-wrong:       <your measured value> (modeled)
  declined:           <your measured value> (modeled)
  ...
  V-TPH$ (north star): <your measured value> (modeled)

Baseline (self-trusting single agent):
  ...
  silent-wrong:       <your measured value> (modeled)

Trust: baseline silent-wrong = <your measured value>, swarm silent-wrong = <your measured value>.
```

Every `<your measured value>` above is exactly that — a number this repo
does not print anywhere until you run the command. Re-run with `--seed 42`
(or any seed you pick) and you will get the same numbers back, every time,
with a hash chain that proves it.
