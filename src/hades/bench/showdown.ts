/* ------------------------------------------------------------------ *
 * showdown.ts — the one killer demo: `hades showdown`.
 *
 * Runs a deterministic 200-task suite (4 real task families — arithmetic
 * pipelines, structured extraction, text transform, checksum/derivation —
 * each graded by REAL code against ground truth computed by construction)
 * through TWO lanes over the IDENTICAL tasks:
 *
 *   1. "swarm"    — the REAL verification-gated swarm engine
 *                   ({@link createInlineSwarm} / the real `SwarmManager`,
 *                   never a stub of it). Outcomes are read from its real
 *                   `task:verified` / `task:rejected` / `task:failed`
 *                   events — never inferred.
 *   2. "baseline" — a single agent that trusts itself (`claimedVerified`
 *                   is always `true`, exactly Hermes-style self-report).
 *
 * V-TPH$ (correct-work-per-dollar) for both lanes comes ONLY from the
 * real {@link runVtph} / {@link compareVtph} in `./vtph` — this module
 * never reimplements that math. Every task outcome, on both lanes, is
 * appended to a hash-chained {@link AuditRecord} ledger (same `sha256Hex`
 * engine as `src/hades/browser/trace.ts`, never a hand-rolled hash) so the
 * whole run is independently re-verifiable with {@link verifyAuditChain}.
 *
 * MODE RULE (hard, honesty-critical):
 *   - `mode: "modeled"` runs deterministic SCRIPTED providers (no network,
 *     no API key, byte-reproducible for a fixed seed) and stamps
 *     `mode: "modeled"` on every {@link AuditRecord} and on the result.
 *   - `mode: "real"` throws an honest `Error` at startup — before any
 *     work happens — when no provider key is configured. It NEVER
 *     silently downgrades to the scripted providers. With a key present
 *     it wires the REAL model client + the REAL swarm-runtime LLM
 *     executor (`../../swarm-runtime/worker/llm-executor`) and the REAL
 *     single-agent baseline (`../agent/runner`) — the same production
 *     code paths `hades bench` uses — unless the caller injects its own
 *     `opts.swarm.executor` / `opts.baselineRunner`.
 *
 * There is no code path in this module that emits a number without a
 * mode label attached somewhere in the returned/rendered artifact.
 * ------------------------------------------------------------------ */

import { sha256Hex } from "../styx/certificate";
import { runVtph, compareVtph } from "./vtph";
import type { AgentRunner, AgentRunResult, EvalTask, VtphComparison, VtphReport } from "./vtph";
import { createInlineSwarm } from "../../swarm-runtime/factory";
import type { InlineSwarmOptions } from "../../swarm-runtime/factory";
import type { SwarmManager } from "../../swarm-runtime/manager/manager";
import type { Planner, PlannedTask } from "../../swarm-runtime/manager/planner";
import type { Claim, ToolCallRecord, WorkerTask } from "../../swarm-runtime/types";
import type { ExecutionOutput, TaskExecutor, WorkerContext } from "../../swarm-runtime/worker/executor";
import { LLMExecutor, type ChatFn, type ChatMessage as LlmChatMessage } from "../../swarm-runtime/worker/llm-executor";
import { HttpModelClient, type ModelClient, type ProviderConfig } from "../models/client";
import { singleAgentRunner } from "../agent/runner";

// ===========================================================================
// Deterministic PRNG (mulberry32 — no Math.random anywhere in this module)
// ===========================================================================

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randInt(rng: () => number, minInclusive: number, maxInclusive: number): number {
  return minInclusive + Math.floor(rng() * (maxInclusive - minInclusive + 1));
}

function pickOne<T>(rng: () => number, pool: readonly T[]): T {
  return pool[Math.floor(rng() * pool.length) % pool.length];
}

function pickUnique(rng: () => number, pool: readonly string[], count: number): string[] {
  const copy = [...pool];
  const chosen: string[] = [];
  for (let i = 0; i < count && copy.length > 0; i++) {
    const idx = Math.floor(rng() * copy.length) % copy.length;
    chosen.push(copy[idx]);
    copy.splice(idx, 1);
  }
  return chosen;
}

// ===========================================================================
// Task families — 4 real, independently-graded families
// ===========================================================================

export type ShowdownFamily = "arithmetic" | "extraction" | "transform" | "checksum";

interface ArithmeticSpec {
  family: "arithmetic";
  start: number;
  ops: Array<["add" | "sub" | "mul", number]>;
}
interface ExtractionSpec {
  family: "extraction";
  record: Record<string, string>;
  field: string;
}
interface TransformSpec {
  family: "transform";
  text: string;
  op: "reverse" | "upper" | "lower" | "rot13" | "wordcount";
}
interface ChecksumSpec {
  family: "checksum";
  text: string;
}
type ShowdownSpec = ArithmeticSpec | ExtractionSpec | TransformSpec | ChecksumSpec;

/** Deterministic FNV-1a 32-bit checksum, rendered as 8 lowercase hex chars. */
function fnv1aHex(s: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function rot13(s: string): string {
  return s.replace(/[a-zA-Z]/g, (c) => {
    const base = c <= "Z" ? 65 : 97;
    return String.fromCharCode(((c.charCodeAt(0) - base + 13) % 26) + base);
  });
}

/** The ONE ground-truth function every family's `grade` AND every honest
 *  worker (scripted or real) computes through — real code, never a
 *  precomputed constant threaded around. */
function computeSpec(spec: ShowdownSpec): string {
  switch (spec.family) {
    case "arithmetic": {
      const result = spec.ops.reduce((acc, [op, val]) => {
        if (op === "add") return acc + val;
        if (op === "sub") return acc - val;
        return acc * val;
      }, spec.start);
      return String(result);
    }
    case "extraction":
      return spec.record[spec.field] ?? "";
    case "transform": {
      switch (spec.op) {
        case "reverse":
          return spec.text.split("").reverse().join("");
        case "upper":
          return spec.text.toUpperCase();
        case "lower":
          return spec.text.toLowerCase();
        case "rot13":
          return rot13(spec.text);
        case "wordcount":
          return String(spec.text.trim().split(/\s+/).filter(Boolean).length);
      }
      break;
    }
    case "checksum":
      return fnv1aHex(spec.text);
  }
}

const SPEC_TRAILER =
  "\nRespond with only the exact result and nothing else.";

function withSpec(lines: string[], spec: ShowdownSpec): string {
  return [...lines, "", `SPEC:${JSON.stringify(spec)}${SPEC_TRAILER}`].join("\n");
}

const ARITH_OPS = ["add", "sub", "mul"] as const;

function buildArithmeticTask(rng: () => number): { prompt: string; spec: ArithmeticSpec } {
  const start = randInt(rng, -20, 20);
  const opCount = randInt(rng, 2, 4);
  const ops: Array<["add" | "sub" | "mul", number]> = [];
  for (let k = 0; k < opCount; k++) {
    const op = pickOne(rng, ARITH_OPS);
    const value = op === "mul" ? randInt(rng, -4, 4) : randInt(rng, -15, 15);
    ops.push([op, value]);
  }
  const spec: ArithmeticSpec = { family: "arithmetic", start, ops };
  const stepsText = ops
    .map(([op, val]) => (op === "add" ? `add ${val}` : op === "sub" ? `subtract ${val}` : `multiply by ${val}`))
    .join(", then ");
  const prompt = withSpec(
    [`Evaluate this arithmetic pipeline: start at ${start}, then ${stepsText}.`],
    spec
  );
  return { prompt, spec };
}

const EXTRACTION_FIELDS = ["id", "name", "status", "owner", "region", "priority"] as const;
const NAME_WORDS = ["orbit", "signal", "quartz", "harbor", "lumen", "cipher", "delta", "meadow", "vertex", "ember"];
const STATUS_WORDS = ["active", "paused", "closed", "pending"];
const REGION_WORDS = ["us-east", "us-west", "eu-central", "ap-south"];

function randomFieldValue(rng: () => number, field: string): string {
  switch (field) {
    case "id":
      return String(randInt(rng, 100, 999));
    case "name":
      return `${pickOne(rng, NAME_WORDS)}-${randInt(rng, 1, 99)}`;
    case "status":
      return pickOne(rng, STATUS_WORDS);
    case "owner":
      return pickOne(rng, NAME_WORDS);
    case "region":
      return pickOne(rng, REGION_WORDS);
    case "priority":
      return String(randInt(rng, 1, 5));
    default:
      return "unknown";
  }
}

function buildExtractionTask(rng: () => number): { prompt: string; spec: ExtractionSpec } {
  const fieldCount = randInt(rng, 3, Math.min(5, EXTRACTION_FIELDS.length));
  const chosenFields = pickUnique(rng, EXTRACTION_FIELDS, fieldCount);
  const record: Record<string, string> = {};
  for (const f of chosenFields) record[f] = randomFieldValue(rng, f);
  const field = chosenFields[randInt(rng, 0, chosenFields.length - 1)];
  const spec: ExtractionSpec = { family: "extraction", record, field };
  const rendered = chosenFields.map((f) => `${f}: ${record[f]}`).join("; ");
  const prompt = withSpec(
    [`Given the record below, extract the exact value of the field "${field}".`, "", `RECORD: ${rendered}`],
    spec
  );
  return { prompt, spec };
}

const TRANSFORM_WORDS = ["orbit", "signal", "quartz", "harbor", "lumen", "cipher", "delta", "meadow", "vertex", "ember"];
const TRANSFORM_OPS = ["reverse", "upper", "lower", "rot13", "wordcount"] as const;

function buildTransformTask(rng: () => number): { prompt: string; spec: TransformSpec } {
  const wordCount = randInt(rng, 3, 6);
  const words: string[] = [];
  for (let i = 0; i < wordCount; i++) words.push(pickOne(rng, TRANSFORM_WORDS));
  const text = words.join(" ");
  const op = pickOne(rng, TRANSFORM_OPS);
  const spec: TransformSpec = { family: "transform", text, op };
  const prompt = withSpec(
    [`Apply the "${op}" transform to the following text and give the result.`, "", `TEXT: ${text}`],
    spec
  );
  return { prompt, spec };
}

function buildChecksumTask(rng: () => number): { prompt: string; spec: ChecksumSpec } {
  const wordCount = randInt(rng, 2, 5);
  const words: string[] = [];
  for (let i = 0; i < wordCount; i++) words.push(pickOne(rng, TRANSFORM_WORDS));
  const text = `${words.join("-")}-${randInt(rng, 100, 999)}`;
  const spec: ChecksumSpec = { family: "checksum", text };
  const prompt = withSpec(
    [
      "Compute the FNV-1a 32-bit checksum (lowercase 8-hex-digit) of the following text.",
      "",
      `TEXT: ${text}`,
    ],
    spec
  );
  return { prompt, spec };
}

function buildTask(family: ShowdownFamily, rng: () => number): { prompt: string; spec: ShowdownSpec } {
  switch (family) {
    case "arithmetic":
      return buildArithmeticTask(rng);
    case "extraction":
      return buildExtractionTask(rng);
    case "transform":
      return buildTransformTask(rng);
    case "checksum":
      return buildChecksumTask(rng);
  }
}

const SHOWDOWN_FAMILIES: ShowdownFamily[] = ["arithmetic", "extraction", "transform", "checksum"];

/**
 * Generate the deterministic showdown suite. Same `seed` (and `taskCount`)
 * ⇒ byte-identical prompts and ground truth every time (mulberry32, no
 * `Math.random`). At least 4 real task families, cycled round-robin so a
 * 200-task suite has 50 of each. Every task's `grade` runs REAL code
 * ({@link computeSpec}) against ground truth computed by construction —
 * never a fabricated/precomputed label detached from how the task works.
 */
export function generateShowdownSuite(opts: { taskCount?: number; seed: number }): EvalTask[] {
  const taskCount = opts.taskCount ?? 200;
  if (!Number.isInteger(taskCount) || taskCount <= 0) {
    throw new Error(`generateShowdownSuite: taskCount must be a positive integer, got ${String(opts.taskCount)}`);
  }
  if (!Number.isFinite(opts.seed)) {
    throw new Error(`generateShowdownSuite: seed must be a finite number, got ${String(opts.seed)}`);
  }

  const rng = mulberry32(opts.seed >>> 0);
  const tasks: EvalTask[] = [];

  for (let i = 0; i < taskCount; i++) {
    const family = SHOWDOWN_FAMILIES[i % SHOWDOWN_FAMILIES.length];
    const { prompt, spec } = buildTask(family, rng);
    const expected = computeSpec(spec).trim();
    const id = `showdown-${String(i).padStart(4, "0")}-${family}`;
    tasks.push({
      id,
      prompt,
      category: family,
      decomposable: false,
      grade: (output: string) => typeof output === "string" && output.trim() === expected,
    });
  }

  return tasks;
}

/** Parse the `SPEC:{...}` block a generated prompt carries, and solve it
 *  with the SAME {@link computeSpec} the grader used — this is the honest
 *  "worker does the work" path, not a shortcut back to the expected value. */
function solveShowdownTask(prompt: string): string {
  const m = prompt.match(/SPEC:(\{[\s\S]*?\})\nRespond/);
  if (!m) throw new Error("solveShowdownTask: no SPEC block found in prompt — not a showdown task");
  const spec = JSON.parse(m[1]) as ShowdownSpec;
  return computeSpec(spec);
}

/** Deterministically "get it wrong" — always produces a different string
 *  than `value` (drops the last character; falls back to a fixed wrong
 *  literal for the degenerate empty case). Never random. */
function corruptAnswer(value: string): string {
  if (value.length === 0) return "WRONG";
  return value.slice(0, -1);
}

// ===========================================================================
// Cost model (modeled mode) — deterministic, labeled, never fabricated as real
// ===========================================================================

const MODELED_PRICE_IN_PER_TOK = 3 / 1_000_000;
const MODELED_PRICE_OUT_PER_TOK = 15 / 1_000_000;

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function modeledCost(tokensIn: number, tokensOut: number): number {
  return tokensIn * MODELED_PRICE_IN_PER_TOK + tokensOut * MODELED_PRICE_OUT_PER_TOK;
}

/** Which tasks (by index into the generated suite) a scripted worker gets
 *  wrong on. Deterministic (mulberry32, seed folded so it's an independent
 *  stream from suite generation), same across both lanes so swarm and
 *  baseline face the identical difficulty distribution — an honest,
 *  apples-to-apples comparison. */
function deriveDishonestFlags(taskCount: number, seed: number, rate = 0.15): boolean[] {
  const rng = mulberry32((seed ^ 0x9e3779b9) >>> 0);
  const flags: boolean[] = [];
  for (let i = 0; i < taskCount; i++) flags.push(rng() < rate);
  return flags;
}

// ===========================================================================
// Scripted "modeled" providers
// ===========================================================================

/**
 * Deterministic scripted single-agent baseline: computes the real answer via
 * {@link solveShowdownTask}, corrupts it on the tasks the difficulty stream
 * marks dishonest — and ALWAYS self-declares `claimedVerified: true`
 * regardless. This is the Hermes-style "trust yourself" baseline; its
 * `silentWrong` is exactly the dishonest-task count, measured, not asserted.
 */
function defaultModeledBaselineRunner(taskIndex: Map<string, number>, dishonestFlags: boolean[]): AgentRunner {
  return async (task: EvalTask): Promise<AgentRunResult> => {
    const idx = taskIndex.get(task.id) ?? -1;
    const solved = solveShowdownTask(task.prompt);
    const dishonest = idx >= 0 && dishonestFlags[idx];
    const output = dishonest ? corruptAnswer(solved) : solved;
    const tokensIn = estimateTokens(task.prompt);
    const tokensOut = estimateTokens(output);
    return {
      output,
      claimedVerified: true,
      tokensIn,
      tokensOut,
      usd: modeledCost(tokensIn, tokensOut),
      provenance: [],
    };
  };
}

/**
 * Deterministic scripted swarm worker. On an honest-flagged task it computes
 * the real answer and grounds it in a real recorded tool call (evidence that
 * genuinely traces to the tool trace) — the real {@link VerificationGate}
 * accepts it on the merits. On a dishonest-flagged task it asserts a WRONG
 * answer with ZERO backing claims — the real gate's `evidence-traceable`
 * check hard-fails (critical, weight ≥ 3) and the verdict is `reject`,
 * regardless of score. This is what drives swarm `silentWrong` to 0 by
 * measurement: the mechanism is real gate logic, not a hardcoded 0.
 */
class ShowdownExecutor implements TaskExecutor {
  constructor(
    private readonly taskIndex: Map<string, number>,
    private readonly dishonestFlags: boolean[]
  ) {}

  async execute(task: WorkerTask, ctx: WorkerContext): Promise<ExecutionOutput> {
    const prompt = String((task.input as { prompt?: unknown }).prompt ?? task.description);
    const taskId = String((task.input as { taskId?: unknown }).taskId ?? "");
    const idx = this.taskIndex.get(taskId) ?? -1;
    const solved = solveShowdownTask(prompt);
    const dishonest = idx >= 0 && this.dishonestFlags[idx];

    if (!dishonest) {
      const trace: ToolCallRecord[] = [
        {
          tool: "solve_showdown_task",
          args: { taskId },
          ok: true,
          output: `result=${solved}`,
          at: Date.now(),
        },
      ];
      const claims: Claim[] = [
        {
          statement: `The computed result is ${solved}.`,
          evidence: [`result=${solved}`],
          confidence: 0.95,
        },
      ];
      ctx.log(`showdown worker solved ${taskId} honestly`);
      const tokensIn = estimateTokens(prompt);
      const tokensOut = estimateTokens(solved);
      return { output: solved, claims, toolTrace: trace, costUsd: modeledCost(tokensIn, tokensOut) };
    }

    // Dishonest path: assert a wrong answer, cite nothing. The real gate's
    // has-claims / evidence-present / evidence-traceable checks fail this
    // outright (evidence-traceable is a critical, verdict-deciding check).
    const wrong = corruptAnswer(solved);
    ctx.log(`showdown worker fabricated an ungrounded answer for ${taskId}`);
    const tokensIn = estimateTokens(prompt);
    const tokensOut = estimateTokens(wrong);
    return { output: wrong, claims: [], toolTrace: [], costUsd: modeledCost(tokensIn, tokensOut) };
  }
}

// ===========================================================================
// "real" mode — genuine provider wiring, never fabricated
// ===========================================================================

const REAL_MODE_NO_KEY_MESSAGE =
  'runShowdown: mode "real" requires a configured provider API key — set ANTHROPIC_API_KEY or ' +
  "OPENAI_API_KEY in the environment before running a real showdown. Refusing to silently fall " +
  'back to modeled numbers; pass mode: "modeled" if a scripted, labeled demo is what you want.';

interface DetectedProvider {
  name: "anthropic" | "openai";
  apiKey: string;
  baseUrl: string;
  model: string;
}

function detectProviderEnv(env: Record<string, string | undefined>): DetectedProvider | null {
  if (env.ANTHROPIC_API_KEY) {
    return { name: "anthropic", apiKey: env.ANTHROPIC_API_KEY, baseUrl: "https://api.anthropic.com", model: "claude-sonnet-5" };
  }
  if (env.OPENAI_API_KEY) {
    return {
      name: "openai",
      apiKey: env.OPENAI_API_KEY,
      baseUrl: env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
      model: "gpt-4o-mini",
    };
  }
  return null;
}

/** Throws {@link REAL_MODE_NO_KEY_MESSAGE} (naming the exact env vars) if no
 *  provider key is configured. Never returns a "downgrade to modeled" signal
 *  — the caller either gets a real client or an honest error. */
function ensureRealModeKey(env: Record<string, string | undefined>): DetectedProvider {
  const detected = detectProviderEnv(env);
  if (!detected) throw new Error(REAL_MODE_NO_KEY_MESSAGE);
  return detected;
}

function buildRealModeDefaults(detected: DetectedProvider): { executor: TaskExecutor; baselineRunner: AgentRunner } {
  const providerConfig: ProviderConfig = {
    name: detected.name,
    kind: detected.name === "anthropic" ? "anthropic" : "openai",
    baseUrl: detected.baseUrl,
    apiKey: detected.apiKey,
    models: [detected.model],
  };
  const client: ModelClient = new HttpModelClient(providerConfig);

  const chat: ChatFn = async (messages: LlmChatMessage[]) => {
    const res = await client.chat({ model: detected.model, messages });
    return res.text;
  };

  return {
    executor: new LLMExecutor(chat),
    baselineRunner: singleAgentRunner(client, { model: detected.model }),
  };
}

// ===========================================================================
// Single-task-per-goal planner — no synthesis wrapper, exact 1:1 mapping
// ===========================================================================

class ShowdownPlanner implements Planner {
  constructor(private readonly tasksById: Map<string, EvalTask>) {}

  async plan(objective: string, availableCapabilities: string[]): Promise<PlannedTask[]> {
    const task = this.tasksById.get(objective);
    if (!task) throw new Error(`ShowdownPlanner: unknown showdown task id "${objective}"`);
    const cap = availableCapabilities[0] ?? "general";
    return [
      {
        description: task.prompt,
        requiredCapabilities: [cap],
        input: { taskId: task.id, prompt: task.prompt, category: task.category },
        dependsOn: [],
        priority: 5,
      },
    ];
  }
}

// ===========================================================================
// Public contract (locked)
// ===========================================================================

export type ShowdownMode = "modeled" | "real";

export interface ShowdownOptions {
  mode: ShowdownMode;
  seed: number;
  taskCount?: number;
  swarm?: InlineSwarmOptions;
  baselineRunner?: AgentRunner;
  now?: () => number;
  onProgress?: (done: number, total: number) => void;
}

export interface AuditRecord {
  seq: number;
  taskId: string;
  lane: "swarm" | "baseline";
  verdict: string;
  elapsedMs: number;
  usd: number;
  mode: ShowdownMode;
  prevHash: string;
  hash: string;
}

export interface ShowdownResult {
  mode: ShowdownMode;
  seed: number;
  taskCount: number;
  swarmReport: VtphReport;
  baselineReport: VtphReport;
  comparison: VtphComparison;
  audit: AuditRecord[];
}

// ===========================================================================
// Hash-chained audit ledger — real sha256Hex, same engine as browser/trace.ts
// ===========================================================================

const SHOWDOWN_GENESIS: string = sha256Hex("hades.bench.showdown.v1");

function canonicalizeAuditFields(r: Omit<AuditRecord, "hash">): string {
  // Fixed field order, JSON.stringify over plain finite primitives only —
  // deterministic and reproducible across processes for identical inputs.
  return JSON.stringify({
    seq: r.seq,
    taskId: r.taskId,
    lane: r.lane,
    verdict: r.verdict,
    elapsedMs: r.elapsedMs,
    usd: r.usd,
    mode: r.mode,
    prevHash: r.prevHash,
  });
}

/**
 * Pure re-verification of the whole audit chain: re-derives every record's
 * hash from scratch (never trusts the stored `hash`), checks dense `seq`
 * numbering from 0, and checks `prevHash` linkage from {@link SHOWDOWN_GENESIS}
 * onward. Returns the first broken index (ascending order), or `ok: true`.
 */
export function verifyAuditChain(records: AuditRecord[]): { ok: boolean; brokenAt?: number } {
  if (!Array.isArray(records)) return { ok: false, brokenAt: 0 };

  let prevHash = SHOWDOWN_GENESIS;
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (
      !r ||
      typeof r.seq !== "number" ||
      typeof r.taskId !== "string" ||
      (r.lane !== "swarm" && r.lane !== "baseline") ||
      typeof r.verdict !== "string" ||
      typeof r.elapsedMs !== "number" ||
      typeof r.usd !== "number" ||
      (r.mode !== "modeled" && r.mode !== "real") ||
      typeof r.prevHash !== "string" ||
      typeof r.hash !== "string"
    ) {
      return { ok: false, brokenAt: i };
    }
    if (r.seq !== i) return { ok: false, brokenAt: i };
    if (r.prevHash !== prevHash) return { ok: false, brokenAt: i };

    let expectedHash: string;
    try {
      expectedHash = sha256Hex(prevHash + "\n" + canonicalizeAuditFields(r));
    } catch {
      return { ok: false, brokenAt: i };
    }
    if (expectedHash !== r.hash) return { ok: false, brokenAt: i };

    prevHash = r.hash;
  }

  return { ok: true };
}

interface LaneSlot {
  verdict: string;
  elapsedMs: number;
  usd: number;
}

/** Build the hash chain in a FIXED order — task index, then lane
 *  (swarm before baseline) — never in real completion-race order, so the
 *  same seed always produces byte-identical hashes regardless of how the
 *  concurrent lanes actually interleaved on the wall clock. */
function buildAuditTrail(
  tasks: EvalTask[],
  swarmSlots: Array<LaneSlot | undefined>,
  baselineSlots: Array<LaneSlot | undefined>,
  mode: ShowdownMode
): AuditRecord[] {
  const records: AuditRecord[] = [];
  let prevHash = SHOWDOWN_GENESIS;
  let seq = 0;

  for (let i = 0; i < tasks.length; i++) {
    for (const lane of ["swarm", "baseline"] as const) {
      const slot = (lane === "swarm" ? swarmSlots[i] : baselineSlots[i]) ?? {
        verdict: "failed",
        elapsedMs: 0,
        usd: 0,
      };
      const base: Omit<AuditRecord, "hash"> = {
        seq,
        taskId: tasks[i].id,
        lane,
        verdict: slot.verdict,
        elapsedMs: Math.max(0, slot.elapsedMs),
        usd: slot.usd,
        mode,
        prevHash,
      };
      const hash = sha256Hex(prevHash + "\n" + canonicalizeAuditFields(base));
      records.push({ ...base, hash });
      prevHash = hash;
      seq += 1;
    }
  }

  return records;
}

// ===========================================================================
// Orchestration
// ===========================================================================

/**
 * Run the showdown: the identical `taskCount`-task suite through the REAL
 * verification-gated swarm ({@link createInlineSwarm} / `SwarmManager`) and
 * a self-trusting single-agent baseline, scored with the real
 * {@link compareVtph}, and hash-chain audited end to end.
 */
export async function runShowdown(opts: ShowdownOptions): Promise<ShowdownResult> {
  if (opts.mode !== "modeled" && opts.mode !== "real") {
    throw new Error(`runShowdown: unknown mode "${String(opts.mode)}" — expected "modeled" or "real"`);
  }
  if (!Number.isFinite(opts.seed)) {
    throw new Error(`runShowdown: seed must be a finite number, got ${String(opts.seed)}`);
  }

  // MODE RULE: real mode fails fast, honestly, before any work begins.
  let realDefaults: { executor: TaskExecutor; baselineRunner: AgentRunner } | undefined;
  if (opts.mode === "real") {
    const detected = ensureRealModeKey(process.env);
    realDefaults = buildRealModeDefaults(detected);
  }

  const now = opts.now ?? Date.now;
  const tasks = generateShowdownSuite({ taskCount: opts.taskCount, seed: opts.seed });
  const taskIndex = new Map<string, number>(tasks.map((t, i) => [t.id, i]));
  const tasksById = new Map<string, EvalTask>(tasks.map((t) => [t.id, t]));
  const dishonestFlags = deriveDishonestFlags(tasks.length, opts.seed);

  const swarmExecutor: TaskExecutor =
    opts.swarm?.executor ?? realDefaults?.executor ?? new ShowdownExecutor(taskIndex, dishonestFlags);
  const baselineRunner: AgentRunner =
    opts.baselineRunner ?? realDefaults?.baselineRunner ?? defaultModeledBaselineRunner(taskIndex, dishonestFlags);

  const manager: SwarmManager = await createInlineSwarm({
    ...opts.swarm,
    executor: swarmExecutor,
    maxAttempts: opts.swarm?.maxAttempts ?? 2,
    poolSize: opts.swarm?.poolSize ?? 8,
    planner: new ShowdownPlanner(tasksById), // always forced — single-task-per-goal contract
  });
  await manager.ensurePool();

  const rejectedGoals = new Set<string>();
  manager.on("task:rejected", (task) => rejectedGoals.add(task.goalId));

  const total = tasks.length * 2;
  let done = 0;
  const tick = (): void => {
    done += 1;
    opts.onProgress?.(done, total);
  };

  const swarmSlots: Array<LaneSlot | undefined> = new Array(tasks.length);
  const baselineSlots: Array<LaneSlot | undefined> = new Array(tasks.length);

  const swarmRunner: AgentRunner = async (task: EvalTask): Promise<AgentRunResult> => {
    const idx = taskIndex.get(task.id) ?? -1;
    const start = now();
    try {
      const { goalId, done: goalDone } = await manager.startGoal(task.id, { timeoutMs: 120_000 });
      await goalDone;
      const wt = manager.listTasks(goalId)[0];
      const elapsedMs = Math.max(0, now() - start);
      const usd = manager.getUsage(goalId).costUsd;

      let verdict: string;
      let claimedVerified: boolean;
      let output: string;
      let provenance: string[];

      if (wt && wt.status === "verified" && wt.result) {
        verdict = "verified";
        claimedVerified = true;
        output = String(wt.result.output);
        provenance = (wt.result.claims ?? []).flatMap((c) => c.evidence);
      } else {
        verdict = rejectedGoals.has(goalId) ? "rejected" : "failed";
        claimedVerified = false;
        output = wt?.result ? String(wt.result.output) : "";
        provenance = [];
      }
      rejectedGoals.delete(goalId);

      if (idx >= 0) swarmSlots[idx] = { verdict, elapsedMs, usd };
      tick();

      return {
        output,
        claimedVerified,
        tokensIn: estimateTokens(task.prompt),
        tokensOut: estimateTokens(output),
        usd,
        provenance,
      };
    } catch (err) {
      const elapsedMs = Math.max(0, now() - start);
      if (idx >= 0) swarmSlots[idx] = { verdict: "failed", elapsedMs, usd: 0 };
      tick();
      return {
        output: "",
        claimedVerified: false,
        tokensIn: 0,
        tokensOut: 0,
        usd: 0,
        provenance: [`error:${err instanceof Error ? err.message : String(err)}`],
      };
    }
  };

  const wrappedBaselineRunner: AgentRunner = async (task: EvalTask): Promise<AgentRunResult> => {
    const idx = taskIndex.get(task.id) ?? -1;
    const start = now();
    try {
      const r = await baselineRunner(task);
      const elapsedMs = Math.max(0, now() - start);
      if (idx >= 0) {
        baselineSlots[idx] = { verdict: r.claimedVerified ? "verified" : "declined", elapsedMs, usd: r.usd };
      }
      tick();
      return r;
    } catch (err) {
      const elapsedMs = Math.max(0, now() - start);
      if (idx >= 0) baselineSlots[idx] = { verdict: "failed", elapsedMs, usd: 0 };
      tick();
      return {
        output: "",
        claimedVerified: false,
        tokensIn: 0,
        tokensOut: 0,
        usd: 0,
        provenance: [`error:${err instanceof Error ? err.message : String(err)}`],
      };
    }
  };

  let comparison: VtphComparison;
  try {
    comparison = await compareVtph(
      [
        { label: "swarm", runner: swarmRunner },
        { label: "baseline", runner: wrappedBaselineRunner },
      ],
      tasks,
      { concurrency: 8, now }
    );
  } finally {
    await manager.shutdown();
  }

  const swarmReport = comparison.reports[0];
  const baselineReport = comparison.reports[1];

  const audit = buildAuditTrail(tasks, swarmSlots, baselineSlots, opts.mode);

  return {
    mode: opts.mode,
    seed: opts.seed,
    taskCount: tasks.length,
    swarmReport,
    baselineReport,
    comparison,
    audit,
  };
}

// Re-exported for callers/tests that need the real V-TPH$ math without
// duplicating imports (this module never reimplements it).
export { runVtph, compareVtph };
export type { AgentRunner, EvalTask, VtphReport, VtphComparison };
