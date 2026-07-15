/* ------------------------------------------------------------------ *
 * STYX S4 — the REAL-INFERENCE BINDING.
 *
 * This is the adapter that hangs the full Styx pipeline
 * (`StyxOrchestrator`: speculate → race under the bandit → calibrated
 * verifier-ensemble fitness → conformal abstention gate → tier floor →
 * signed certificate) off a real, multi-provider `ModelClient` and
 * exposes the whole thing as a V-TPH$ {@link AgentRunner}. Swap the
 * injected `ModelClient` for `MultiProviderClient` + real keys and the
 * same code drives live models; inject a scripted fake and it tests
 * without any keys or network.
 *
 * ==================================================================
 * THE SYNC-ORCHESTRATOR vs ASYNC-LLM BRIDGE  (the load-bearing trick)
 * ==================================================================
 * The orchestrator's `Worker.run` and `VerifierPanel.vote` are
 * SYNCHRONOUS (locked API): the bandit peeks a branch's cost/fitness
 * as a *pure function of branch state*, which forbids awaiting an LLM
 * inside them. Real inference is async. We resolve this by
 * PRE-RESOLVING every model call in an async PREPARE phase
 * ({@link prepareStyxTask}) and then handing the orchestrator SYNC
 * closures that only ever read from the prepare-phase caches:
 *
 *   1. speculate  — one LLM call proposes the K divergent strategies.
 *   2. work       — one `AgentLoop` per strategy caches (output, cost).
 *   3. vote       — every verifier model votes PASS/FAIL on each cached
 *                   output; the votes are cached keyed by the output.
 *
 * The orchestrator then races those cached results. Two consequences,
 * both deliberate and documented:
 *
 *   - The bandit may EXPAND a hot branch into `${s}+refine` / `${s}+alt`
 *     child strategies we never pre-ran. The sync worker resolves such a
 *     name back to its base root (stripping the `+refine`/`+alt` suffix
 *     chain) and REPLAYS that root's cached answer — no new LLM call, so
 *     no un-accounted spend. Expanded children therefore carry the same
 *     answer/votes/fitness as their parent (a documented approximation:
 *     we race divergent ROOT strategies for real, and treat refinement
 *     as replay rather than a fresh async solve).
 *   - Because the worker only ever returns a cached ROOT output, every
 *     output the panel is asked to vote on is one we already voted on in
 *     prepare → the vote cache always hits. A genuine miss (defensive)
 *     returns fail-closed votes (all `passed:false`), never a fabricated
 *     pass.
 *
 * COST/TOKEN ACCOUNTING. `AgentRunResult.{tokensIn,tokensOut,usd}` is the
 * sum over EVERY real model call made in prepare (speculate + all worker
 * loops + all verifier votes) — collected once, up front. It is
 * deliberately independent of `StyxOutcome.spent` (the bandit's internal
 * per-advance cost total, which double-charges replayed branches and is
 * bounded by `budget`); the honest dollar figure the benchmark divides by
 * is what we actually paid the provider, which is the prepare total.
 *
 * DETERMINISM. Given a deterministic `ModelClient` the whole runner is a
 * pure function of its inputs: no `Math.random`, no clock (the cert
 * `issuedAt` is caller-supplied), and the signing key defaults to a fixed
 * deterministic seed so certificate signatures — and therefore the
 * provenance — reproduce byte-for-byte. Production deployments MUST inject
 * their own `privateKeyHex`.
 *
 * TOTALITY. The returned runner NEVER throws. `orchestrator.run` already
 * degrades internal faults to an abstention; the prepare phase (which does
 * the throwing async I/O) is wrapped so a failing client becomes a
 * zero-cost declined result, exactly as `runVtph` expects.
 * ------------------------------------------------------------------ */

import type { ModelClient, ChatMessage } from "../models/client";
import type { AgentRunner, EvalTask, AgentRunResult } from "../bench/vtph";
import { AgentLoop } from "../agent/loop";
import { builtinRegistry, type ToolRegistry } from "../agent/tools";
import { CertificateAuthority, generatePrivateKeyHex } from "./certificate";
import type { CalibrationPoint } from "./gate";
import type { TaskSignals, VerifierVote } from "./tiers";
import {
  StyxOrchestrator,
  type Speculator,
  type Worker,
  type VerifierPanel,
  type StyxTask,
  type StyxConfig,
} from "./orchestrator";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface StyxRunnerOptions {
  workerModel: string;
  /** Verifier panel; each model casts a separate PASS/FAIL vote. */
  verifierModels: string[];
  /** K divergent strategies to speculate. Default 3. */
  strategies?: number;
  /** Conformal silent-wrong bound P(wrong | emitted). Default 0.1. */
  epsilon?: number;
  /** $ budget per task for the bandit. Default 1.0. */
  budget?: number;
  /** Worker `AgentLoop` step cap. */
  maxSteps?: number;
  /** Gate calibration set; must hold >= 20 points. Default {@link defaultCalibration}. */
  calibration?: CalibrationPoint[];
  /** Caller-supplied certificate timestamp (no `Date.now` inside). */
  issuedAt: number;
  /**
   * 32-byte hex ed25519 seed used to sign certificates. Defaults to a FIXED
   * deterministic seed so the runner is reproducible out of the box; real
   * deployments MUST inject their own key.
   */
  privateKeyHex?: string;
  /** Tool registry for the worker loop. Default {@link builtinRegistry}. */
  tools?: ToolRegistry;
}

/** Fixed deterministic signing seed (see {@link StyxRunnerOptions.privateKeyHex}). */
export const DEFAULT_STYX_KEY = generatePrivateKeyHex(
  (n) => new Uint8Array(n).fill(0x5a),
);

const DEFAULT_STRATEGIES = 3;
const DEFAULT_EPSILON = 0.1;
const DEFAULT_BUDGET = 1.0;

/** Parser fallback when the speculator produces nothing usable. */
export const FALLBACK_STRATEGIES = ["direct", "decompose", "verify-first"];

// ---------------------------------------------------------------------------
// Usage accounting
// ---------------------------------------------------------------------------

export interface Usage {
  tokensIn: number;
  tokensOut: number;
  usd: number;
}

function zeroUsage(): Usage {
  return { tokensIn: 0, tokensOut: 0, usd: 0 };
}

function addUsage(into: Usage, add: Usage): void {
  into.tokensIn += add.tokensIn;
  into.tokensOut += add.tokensOut;
  into.usd += add.usd;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Collapse whitespace so a provenance/label line stays single-line. */
function collapse(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Task → signals mapping (documented, deliberately simple)
// ---------------------------------------------------------------------------

/**
 * Infer verifier-tier {@link TaskSignals} from an eval task. We only claim the
 * ONE signal we can honestly assert offline: an oracle-checkable category
 * (math / arithmetic / code / compute) is `executable` → routes to T0. Every
 * other task leaves all signals false → T4-consistency, the weakest tier with
 * the highest confidence floor. Nothing here fabricates a reference source, a
 * rubric, or a second family — asserting those without the machinery would
 * launder a weaker guarantee into a stronger-looking one.
 */
export function signalsForTask(task: EvalTask): TaskSignals {
  const category = (task.category ?? "").toLowerCase();
  const executable = /\b(math|arith|calc|code|program|compute)\w*/.test(category);
  return { executable };
}

// ---------------------------------------------------------------------------
// Default calibration
// ---------------------------------------------------------------------------

/**
 * A small, sane default calibration set (40 points, > the gate's 20-point
 * minimum). High verifier scores are reliably correct, low scores wrong, so
 * the conformal threshold at ε = 0.1 lands well below a unanimous-pass fitness
 * of 1.0 — a strongly-verified answer clears the gate, a rejected one does not.
 * Deployments should replace this with real (score, correct) history.
 */
export function defaultCalibration(): CalibrationPoint[] {
  const points: CalibrationPoint[] = [];
  for (let i = 0; i < 24; i++) points.push({ score: 0.95, correct: true });
  for (let i = 0; i < 8; i++) points.push({ score: 0.8, correct: true });
  for (let i = 0; i < 8; i++) points.push({ score: 0.2, correct: false });
  return points;
}

// ---------------------------------------------------------------------------
// #1 SPECULATOR — ask the model for K divergent strategy labels
// ---------------------------------------------------------------------------

const SPECULATOR_SYSTEM =
  "You are a strategy speculator for a problem solver. Propose divergent, " +
  "one-line strategy labels for tackling the task — genuinely different plans " +
  "and decompositions, NOT restatements of one plan. Reply with a numbered " +
  "list, one short label per line, and nothing else.";

const LIST_ITEM_RE = /^\s*(?:\d+[.)]|[-*•])\s*(.+?)\s*$/;

/**
 * Parse a numbered/bulleted list of strategy labels out of model text. Strips
 * list markers, surrounding backticks/quotes, dedupes (case-insensitively),
 * and keeps at most `k`. Falls back to {@link FALLBACK_STRATEGIES} (trimmed to
 * `k`) when nothing usable is found.
 */
export function parseStrategyList(text: string, k: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const rawLine of (text ?? "").split(/\r?\n/)) {
    const m = rawLine.match(LIST_ITEM_RE);
    const candidate = (m ? m[1] : "").replace(/^[`"']+|[`"']+$/g, "").trim();
    if (!candidate) continue;
    const key = candidate.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(candidate);
    if (out.length >= k) break;
  }
  if (out.length === 0) return FALLBACK_STRATEGIES.slice(0, Math.max(1, k));
  return out;
}

/** One speculation call → K divergent strategy labels + its token/usd usage. */
export async function speculateStrategies(
  client: ModelClient,
  model: string,
  taskInput: string,
  k: number,
): Promise<{ strategies: string[]; usage: Usage }> {
  const messages: ChatMessage[] = [
    { role: "system", content: SPECULATOR_SYSTEM },
    {
      role: "user",
      content: `TASK:\n${taskInput}\n\nList ${k} divergent strategy labels now.`,
    },
  ];
  const res = await client.chat({ model, messages, temperature: 0 });
  return {
    strategies: parseStrategyList(res.text ?? "", k),
    usage: {
      tokensIn: res.tokensIn ?? 0,
      tokensOut: res.tokensOut ?? 0,
      usd: res.usd ?? 0,
    },
  };
}

// ---------------------------------------------------------------------------
// #2 WORKER — run the agent loop for a strategy
// ---------------------------------------------------------------------------

/**
 * Execute one strategy via the tool-calling {@link AgentLoop}, folding the
 * strategy into the system prompt. Returns the answer, the loop's own dollar
 * cost (used by the bandit as the branch cost), and the full usage. The loop is
 * total — a failing client yields an empty answer, never a throw.
 */
export async function runWorkerStrategy(
  client: ModelClient,
  model: string,
  taskInput: string,
  strategy: string,
  tools: ToolRegistry,
  maxSteps?: number,
): Promise<{ output: string; cost: number; usage: Usage }> {
  const loop = new AgentLoop(client, tools, {
    model,
    maxSteps,
    temperature: 0,
    system: `Apply this solution strategy: "${strategy}". Follow it, then give your final answer.`,
  });
  const result = await loop.run(taskInput);
  return {
    output: result.answer,
    cost: result.usd,
    usage: { tokensIn: result.tokensIn, tokensOut: result.tokensOut, usd: result.usd },
  };
}

// ---------------------------------------------------------------------------
// #3 VERIFIER PANEL — each model votes PASS/FAIL (fail-closed)
// ---------------------------------------------------------------------------

const VERDICT_RE = /VERDICT:\s*(PASS|FAIL)\b/i;

/**
 * One verifier model independently judges `output` against the task and returns
 * PASS/FAIL. Fail-closed: an unparseable/missing verdict counts as FAIL, so an
 * unsure verifier declines rather than rubber-stamps.
 */
export async function verifierVote(
  client: ModelClient,
  model: string,
  taskInput: string,
  output: string,
): Promise<{ passed: boolean; usage: Usage }> {
  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        "You are a strict, independent verifier. Judge whether the ANSWER " +
        "correctly and completely solves the TASK. Do not solve it yourself; " +
        "check the given answer. Reply with EXACTLY one line: `VERDICT: PASS` " +
        "if the answer is correct, or `VERDICT: FAIL` otherwise. If unsure, FAIL.",
    },
    {
      role: "user",
      content:
        `TASK: ${taskInput}\n\nANSWER: ${output}\n\n` +
        "Reply now with VERDICT: PASS or VERDICT: FAIL.",
    },
  ];
  const res = await client.chat({ model, messages, temperature: 0 });
  const match = (res.text ?? "").match(VERDICT_RE);
  return {
    passed: match ? match[1].toUpperCase() === "PASS" : false,
    usage: {
      tokensIn: res.tokensIn ?? 0,
      tokensOut: res.tokensOut ?? 0,
      usd: res.usd ?? 0,
    },
  };
}

// ---------------------------------------------------------------------------
// PREPARE — do all the async model work up front, hand back sync closures
// ---------------------------------------------------------------------------

export interface PreparedStyxTask {
  styxTask: StyxTask;
  spec: Speculator;
  worker: Worker;
  panel: VerifierPanel;
  /** Total usage across every model call made during prepare (frozen after). */
  usage: Usage;
  /** The proposed root strategies, in order. */
  strategies: string[];
}

export interface PrepareOptions {
  workerModel: string;
  verifierModels: string[];
  strategies?: number;
  maxSteps?: number;
  tools?: ToolRegistry;
}

/**
 * Resolve an (possibly bandit-expanded) strategy name back to a known root by
 * stripping the `+refine` / `+alt` suffix chain the controller appends. Falls
 * back to the first root when nothing matches.
 */
function resolveBaseStrategy(
  strategy: string,
  known: Map<string, { output: string; cost: number }>,
  roots: string[],
): string {
  let s = strategy;
  if (known.has(s)) return s;
  // Peel documented controller suffixes: "s+refine", "s+alt", chained.
  while (true) {
    const stripped = s.replace(/\+(?:refine|alt)$/, "");
    if (stripped === s) break;
    s = stripped;
    if (known.has(s)) return s;
  }
  return known.has(s) ? s : roots[0];
}

/**
 * The async bridge: speculate, run every root strategy, collect every
 * verifier's vote on every produced answer, cache it all, and return SYNC
 * closures (plus the frozen usage total) the {@link StyxOrchestrator} can drive
 * without ever awaiting.
 */
export async function prepareStyxTask(
  client: ModelClient,
  task: EvalTask,
  opts: PrepareOptions,
): Promise<PreparedStyxTask> {
  const tools = opts.tools ?? builtinRegistry();
  const k = Math.max(1, Math.floor(opts.strategies ?? DEFAULT_STRATEGIES));
  const usage = zeroUsage();

  // 1. SPECULATE.
  const spec = await speculateStrategies(client, opts.workerModel, task.prompt, k);
  addUsage(usage, spec.usage);
  const strategies = spec.strategies;

  // 2. WORK — one loop per root strategy; cache (output, cost).
  const workerByStrategy = new Map<string, { output: string; cost: number }>();
  for (const strategy of strategies) {
    if (workerByStrategy.has(strategy)) continue;
    const r = await runWorkerStrategy(
      client,
      opts.workerModel,
      task.prompt,
      strategy,
      tools,
      opts.maxSteps,
    );
    addUsage(usage, r.usage);
    workerByStrategy.set(strategy, { output: r.output, cost: r.cost });
  }

  // 3. VOTE — every verifier votes on every distinct produced answer; cache by
  //    output so an answer shared across strategies is only judged once.
  const votesByOutput = new Map<string, VerifierVote[]>();
  for (const strategy of strategies) {
    const cached = workerByStrategy.get(strategy);
    if (!cached || votesByOutput.has(cached.output)) continue;
    const votes: VerifierVote[] = [];
    for (let i = 0; i < opts.verifierModels.length; i++) {
      const model = opts.verifierModels[i];
      const v = await verifierVote(client, model, task.prompt, cached.output);
      addUsage(usage, v.usage);
      // Distinct id per panel slot so duplicate model ids don't collide in the
      // ensemble's reliability estimation.
      votes.push({ verifierId: `v${i}:${model}`, passed: v.passed });
    }
    votesByOutput.set(cached.output, votes);
  }

  const roots = strategies;
  const failClosed = (): VerifierVote[] =>
    opts.verifierModels.map((model, i) => ({ verifierId: `v${i}:${model}`, passed: false }));

  const styxTask: StyxTask = {
    id: task.id,
    input: task.prompt,
    signals: signalsForTask(task),
  };

  const speculator: Speculator = { propose: () => [...roots] };

  const worker: Worker = {
    run: (_t, strategy) => {
      const base = resolveBaseStrategy(strategy, workerByStrategy, roots);
      const cached = workerByStrategy.get(base);
      return { output: cached?.output ?? "", cost: cached?.cost ?? 0 };
    },
  };

  const panel: VerifierPanel = {
    vote: (_t, output) => votesByOutput.get(output) ?? failClosed(),
  };

  return { styxTask, spec: speculator, worker, panel, usage, strategies };
}

// ---------------------------------------------------------------------------
// styxRunner — the V-TPH$ AgentRunner
// ---------------------------------------------------------------------------

/**
 * Build a V-TPH$ {@link AgentRunner} backed by the full Styx pipeline over a
 * real (or fake) {@link ModelClient}.
 *
 *  - `output`          = the emitted answer when Styx emits, else `""`.
 *  - `claimedVerified` = `StyxOutcome.emitted` (Styx only "claims" what cleared
 *                        the conformal gate + tier floor — a hallucinating
 *                        worker caught by the panel abstains, never silent-wrong).
 *  - `tokensIn/out/usd`= summed across EVERY prepare-phase model call
 *                        (speculate + workers + verifiers).
 *  - `provenance`      = `StyxOutcome.provenance`, plus a `certificate:<sig>`
 *                        breadcrumb when a certificate was issued.
 *
 * Never throws.
 */
export function styxRunner(client: ModelClient, opts: StyxRunnerOptions): AgentRunner {
  const tools = opts.tools ?? builtinRegistry();
  const epsilon = opts.epsilon ?? DEFAULT_EPSILON;
  const budget = opts.budget ?? DEFAULT_BUDGET;
  const calibration = opts.calibration ?? defaultCalibration();
  const ca = new CertificateAuthority(opts.privateKeyHex ?? DEFAULT_STYX_KEY);

  return async (task: EvalTask): Promise<AgentRunResult> => {
    try {
      const prep = await prepareStyxTask(client, task, {
        workerModel: opts.workerModel,
        verifierModels: opts.verifierModels,
        strategies: opts.strategies,
        maxSteps: opts.maxSteps,
        tools,
      });

      const cfg: StyxConfig = {
        epsilon,
        budget,
        ca,
        calibration,
        issuedAt: opts.issuedAt,
      };

      const orchestrator = new StyxOrchestrator(prep.spec, prep.worker, prep.panel, cfg);
      const outcome = await orchestrator.run(prep.styxTask);

      const provenance = [...outcome.provenance];
      if (outcome.certificate) {
        provenance.push(`certificate:${outcome.certificate.signature}`);
      }
      provenance.push(`styx:${collapse(outcome.reason)} tier=${outcome.tier}`);

      return {
        output: outcome.emitted ? outcome.output ?? "" : "",
        claimedVerified: outcome.emitted,
        tokensIn: prep.usage.tokensIn,
        tokensOut: prep.usage.tokensOut,
        usd: prep.usage.usd,
        provenance,
      };
    } catch (err) {
      // The prepare phase does the throwing async I/O; degrade any failure to a
      // zero-cost declined result so `runVtph` never crashes.
      return {
        output: "",
        claimedVerified: false,
        tokensIn: 0,
        tokensOut: 0,
        usd: 0,
        provenance: [`error:${messageOf(err)}`],
      };
    }
  };
}
