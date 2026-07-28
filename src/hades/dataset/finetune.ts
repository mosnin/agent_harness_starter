/**
 * finetune.ts — the local fine-tune loop's planning + execution surface.
 *
 * ## The one rule this file exists to enforce
 *
 * Fine-tuning is INERT by default. `runFineTune` never spawns a training
 * process unless ALL of the following are simultaneously true:
 *
 *   1. the caller explicitly passed `enabled: true` (mirrors `hades dataset
 *      finetune --enable` — the flag defaults to off);
 *   2. `probeLocalModel` found a REAL model file/adapter on this machine
 *      (`model.present === true`) — never assumed, never guessed;
 *   3. the dataset's independently RECOMPUTED audit (`../dataset/audit`'s
 *      `auditDataset`, never trusted from the manifest alone) reports
 *      `ok: true` — a tampered or corrupt dataset is never trained on;
 *   4. the plan has at least one train record (`plan.trainRecords > 0`);
 *   5. the caller did not pass `dryRun: true`.
 *
 * If even one of those is false, `runFineTune` resolves to a typed
 * `{ status: "abstained", reason, detail }` and — critically — NEVER calls
 * `req.spawn`. The default `spawn` port is `undefined`: a caller that wires
 * every other condition but forgets to inject a real trainer gets an honest
 * `"no-trainer"` abstention, never a silent no-op dressed up as success.
 *
 * No loss, accuracy, perplexity, or wall-clock duration is ever reported
 * unless it was actually observed from the child process (`durationMs` comes
 * from the injected clock around the real `SpawnPort.run` call; `exitCode`,
 * `stdoutTail`, `stderrTail` are copied verbatim from what the child actually
 * returned). Abstained and planned outcomes report no metrics at all — there
 * is no field on those variants to fabricate one into.
 *
 * `hades dataset finetune` is never invoked by this repo's own tests or CI —
 * see `../cli/dataset-command.ts`'s module docs and `datasetHelpLines()`.
 *
 * ## `probeLocalModel` — a real, no-guessing format sniffer
 *
 * Detection is by MAGIC BYTES, never by file extension or a hopeful default:
 *   - `gguf`: the file's first 4 bytes are the ASCII magic `GGUF`.
 *   - `safetensors`: the first 8 bytes are a little-endian u64 header length
 *     `N`, and the following `N` bytes parse as a JSON object (the format's
 *     own self-describing tensor-metadata header).
 *   - `peft-dir`: a DIRECTORY containing `adapter_config.json` plus one of
 *     `adapter_model.safetensors` / `adapter_model.bin` (the standard PEFT/
 *     LoRA adapter directory shape).
 * Anything else — a missing path, an unreadable path, a zero-byte file, a
 * file whose bytes match none of the above, a directory missing the required
 * adapter files — returns `present: false` with an honest, specific `reason`
 * string. This function never THROWS; every failure mode is a typed result.
 *
 * ## argv safety (locked)
 *
 * `planFineTune` builds `argv` as a plain `string[]`, never a shell command
 * string — there is no string concatenation/interpolation anywhere in this
 * file that could let a hostile path or flag value escape its own argv slot.
 * Only PATHS, the manifest digest, the model path/format, and numeric
 * hyperparameters are ever placed into `argv`; this module never reads (and
 * has no import surface to read) individual `TrainingRecord` content, so
 * dataset RECORD text can never reach a spawned process's command line.
 */

import { join } from "node:path";
import {
  closeSync as nodeCloseSync,
  existsSync as nodeExistsSync,
  openSync as nodeOpenSync,
  readSync as nodeReadSync,
  readdirSync as nodeReaddirSync,
  statSync as nodeStatSync,
} from "node:fs";

import type { DatasetManifest } from "./exporter";
import type { DatasetAuditReport } from "./audit";

// ===========================================================================
// probeLocalModel
// ===========================================================================

export type ModelFormat = "gguf" | "safetensors" | "peft-dir" | "unknown";

export interface LocalModelProbe {
  present: boolean;
  path?: string;
  format: ModelFormat;
  sizeBytes?: number;
  reason: string;
}

export interface ProbeIo {
  existsSync: typeof nodeExistsSync;
  statSync: typeof nodeStatSync;
  readdirSync: typeof nodeReaddirSync;
  openSync?: typeof nodeOpenSync;
  readSync?: typeof nodeReadSync;
  closeSync?: typeof nodeCloseSync;
}

/** Env var consulted only when `opts.path` is absent/blank — mirrors the
 *  `$HADES_DATA_DIR`/`$HADES_SKILLS_DIR` env-driven-default convention this
 *  codebase already uses elsewhere for local machine configuration. */
const LOCAL_MODEL_PATH_ENV_VAR = "HADES_LOCAL_MODEL_PATH";

const GGUF_MAGIC = Buffer.from([0x47, 0x47, 0x55, 0x46]); // ASCII "GGUF"
/** A sane upper bound on a safetensors JSON header (real headers are at most
 *  a few MB even for huge tensor counts); anything claiming more is refused
 *  as "not safetensors" rather than trusted into a giant allocation. */
const SAFETENSORS_MAX_HEADER_BYTES = 64 * 1024 * 1024;

const PEFT_ADAPTER_CONFIG_FILE = "adapter_config.json";
const PEFT_ADAPTER_MODEL_FILES: readonly string[] = ["adapter_model.safetensors", "adapter_model.bin"];

function describeErr(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

const defaultProbeIo: Required<ProbeIo> = {
  existsSync: nodeExistsSync,
  statSync: nodeStatSync,
  readdirSync: nodeReaddirSync,
  openSync: nodeOpenSync,
  readSync: nodeReadSync,
  closeSync: nodeCloseSync,
};

function resolveIo(io: ProbeIo | undefined): Required<ProbeIo> {
  return { ...defaultProbeIo, ...io };
}

function probeDirectory(path: string, io: Required<ProbeIo>): LocalModelProbe {
  let names: string[];
  try {
    const entries = io.readdirSync(path) as (string | { name: string })[];
    names = entries.map((e) => (typeof e === "string" ? e : e.name));
  } catch (err) {
    return { present: false, path, format: "unknown", reason: `could not list directory "${path}": ${describeErr(err)}` };
  }
  const names_ = new Set(names);
  const hasConfig = names_.has(PEFT_ADAPTER_CONFIG_FILE);
  const modelFile = PEFT_ADAPTER_MODEL_FILES.find((f) => names_.has(f));
  if (hasConfig && modelFile !== undefined) {
    return {
      present: true,
      path,
      format: "peft-dir",
      reason: `directory contains a peft/LoRA adapter (${PEFT_ADAPTER_CONFIG_FILE} + ${modelFile})`,
    };
  }
  const missing: string[] = [];
  if (!hasConfig) missing.push(PEFT_ADAPTER_CONFIG_FILE);
  if (modelFile === undefined) missing.push(`one of [${PEFT_ADAPTER_MODEL_FILES.join(", ")}]`);
  return {
    present: false,
    path,
    format: "unknown",
    reason: `directory "${path}" is missing required peft adapter file(s): ${missing.join(" and ")}`,
  };
}

function probeFile(path: string, size: number, io: Required<ProbeIo>): LocalModelProbe {
  let fd: number | undefined;
  try {
    fd = io.openSync(path, "r");

    const head = Buffer.alloc(8);
    const headRead = io.readSync(fd, head, 0, 8, 0);

    if (headRead >= 4 && head.subarray(0, 4).equals(GGUF_MAGIC)) {
      return { present: true, path, format: "gguf", sizeBytes: size, reason: "first 4 bytes match the GGUF magic" };
    }

    if (headRead >= 8) {
      const headerLen = head.readBigUInt64LE(0);
      if (headerLen > 0n && headerLen <= BigInt(SAFETENSORS_MAX_HEADER_BYTES) && headerLen <= BigInt(Math.max(0, size - 8))) {
        const headerBuf = Buffer.alloc(Number(headerLen));
        const bodyRead = io.readSync(fd, headerBuf, 0, headerBuf.length, 8);
        if (bodyRead === headerBuf.length) {
          try {
            const parsed: unknown = JSON.parse(headerBuf.toString("utf8"));
            if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
              return {
                present: true,
                path,
                format: "safetensors",
                sizeBytes: size,
                reason: "first 8 bytes are a valid little-endian header length whose JSON header parses",
              };
            }
          } catch {
            /* not a safetensors JSON header — fall through to "unknown" */
          }
        }
      }
    }

    return {
      present: false,
      path,
      format: "unknown",
      sizeBytes: size,
      reason: `no recognized model magic bytes at "${path}" (checked gguf, safetensors)`,
    };
  } catch (err) {
    return {
      present: false,
      path,
      format: "unknown",
      sizeBytes: size,
      reason: `could not read "${path}" to sniff its format: ${describeErr(err)}`,
    };
  } finally {
    if (fd !== undefined) {
      try {
        io.closeSync(fd);
      } catch {
        /* best-effort close only */
      }
    }
  }
}

/**
 * Real, no-guessing local-model probe. See the module header for the exact
 * detection rules. Never throws — every failure mode is a typed
 * `{ present: false, reason }`.
 */
export function probeLocalModel(opts: { path?: string; env?: Record<string, string | undefined>; io?: ProbeIo } = {}): LocalModelProbe {
  const io = resolveIo(opts.io);

  const explicit = typeof opts.path === "string" ? opts.path.trim() : "";
  const fromEnv = explicit.length === 0 ? (opts.env?.[LOCAL_MODEL_PATH_ENV_VAR] ?? "").trim() : "";
  const path = explicit.length > 0 ? explicit : fromEnv;

  if (path.length === 0) {
    return {
      present: false,
      format: "unknown",
      reason: `no model path given (pass --model, or set ${LOCAL_MODEL_PATH_ENV_VAR})`,
    };
  }

  let exists: boolean;
  try {
    exists = io.existsSync(path);
  } catch (err) {
    return { present: false, path, format: "unknown", reason: `existsSync("${path}") threw: ${describeErr(err)}` };
  }
  if (!exists) {
    return { present: false, path, format: "unknown", reason: `no file or directory found at "${path}"` };
  }

  let stat: ReturnType<typeof nodeStatSync>;
  try {
    stat = io.statSync(path);
  } catch (err) {
    return {
      present: false,
      path,
      format: "unknown",
      reason: `could not stat "${path}" (unreadable path): ${describeErr(err)}`,
    };
  }

  if (stat.isDirectory()) return probeDirectory(path, io);
  if (!stat.isFile()) {
    return { present: false, path, format: "unknown", reason: `"${path}" is neither a regular file nor a directory` };
  }
  if (stat.size === 0) {
    return { present: false, path, format: "unknown", sizeBytes: 0, reason: `file "${path}" is empty (0 bytes)` };
  }
  return probeFile(path, stat.size, io);
}

// ===========================================================================
// planFineTune
// ===========================================================================

export interface FineTunePlan {
  datasetDir: string;
  manifestDigest: string;
  modelPath: string;
  modelFormat: ModelFormat;
  trainRecords: number;
  holdoutRecords: number;
  epochs: number;
  batchSize: number;
  learningRate: number;
  seed: number;
  adapter: "lora";
  outputDir: string;
  argv: string[];
  cwd: string;
  estimatedSteps: number;
}

export interface FineTuneOptions {
  epochs?: number;
  batchSize?: number;
  learningRate?: number;
  seed?: number;
  outputDir?: string;
  trainerArgv?: string[];
}

const DEFAULT_EPOCHS = 3;
const DEFAULT_BATCH_SIZE = 4;
const DEFAULT_LEARNING_RATE = 2e-4;
const DEFAULT_SEED = 0;
/** Documents the plug point, not a shipped binary — a real deployment
 *  injects its own trainer via `FineTuneOptions.trainerArgv`. */
const DEFAULT_TRAINER_ARGV: readonly string[] = ["hades-finetune-trainer"];

/**
 * Build a deterministic, pure (no clock, no I/O) fine-tune plan from a real
 * exported dataset's manifest and a real model probe. Throws `RangeError` on
 * out-of-contract options (never silently clamps a caller's explicit bad
 * value into something else); `datasetDir`/`model`/`manifest` are trusted
 * inputs the caller (`../cli/dataset-command.ts`'s deps wiring) is
 * responsible for having already validated against real disk state.
 */
export function planFineTune(
  manifest: DatasetManifest,
  model: LocalModelProbe,
  datasetDir: string,
  opts: FineTuneOptions = {},
): FineTunePlan {
  if (typeof datasetDir !== "string" || datasetDir.length === 0) {
    throw new RangeError("planFineTune: datasetDir must be a non-empty string");
  }

  const epochs = opts.epochs ?? DEFAULT_EPOCHS;
  if (!Number.isInteger(epochs) || epochs < 1) {
    throw new RangeError(`planFineTune: epochs must be a positive integer; got ${JSON.stringify(opts.epochs)}`);
  }
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new RangeError(`planFineTune: batchSize must be a positive integer; got ${JSON.stringify(opts.batchSize)}`);
  }
  const learningRate = opts.learningRate ?? DEFAULT_LEARNING_RATE;
  if (!Number.isFinite(learningRate) || learningRate <= 0) {
    throw new RangeError(`planFineTune: learningRate must be a positive finite number; got ${JSON.stringify(opts.learningRate)}`);
  }
  const seed = opts.seed ?? DEFAULT_SEED;
  if (!Number.isInteger(seed) || seed < 0) {
    throw new RangeError(`planFineTune: seed must be a non-negative integer; got ${JSON.stringify(opts.seed)}`);
  }

  const outputDir = opts.outputDir ?? join(datasetDir, "finetune", "lora-adapter");
  const trainRecords = manifest.counts.train;
  const holdoutRecords = manifest.counts.holdout;
  const estimatedSteps = trainRecords > 0 ? Math.ceil(trainRecords / batchSize) * epochs : 0;
  const modelPath = model.path ?? "";

  const baseArgv = opts.trainerArgv !== undefined && opts.trainerArgv.length > 0 ? opts.trainerArgv : DEFAULT_TRAINER_ARGV;
  // Every element pushed below is either a fixed flag literal or one of:
  // datasetDir, manifest.digest, modelPath, model.format, outputDir, or a
  // stringified hyperparameter — never dataset RECORD content, and never
  // built via string concatenation into a shell command.
  const argv: string[] = [
    ...baseArgv,
    "--dataset-dir",
    datasetDir,
    "--manifest-digest",
    manifest.digest,
    "--model-path",
    modelPath,
    "--model-format",
    model.format,
    "--output-dir",
    outputDir,
    "--epochs",
    String(epochs),
    "--batch-size",
    String(batchSize),
    "--learning-rate",
    String(learningRate),
    "--seed",
    String(seed),
    "--adapter",
    "lora",
  ];

  return {
    datasetDir,
    manifestDigest: manifest.digest,
    modelPath,
    modelFormat: model.format,
    trainRecords,
    holdoutRecords,
    epochs,
    batchSize,
    learningRate,
    seed,
    adapter: "lora",
    outputDir,
    argv,
    cwd: datasetDir,
    estimatedSteps,
  };
}

// ===========================================================================
// runFineTune — the safety gate
// ===========================================================================

export type FineTuneAbstainReason = "flag-not-set" | "no-model" | "audit-failed" | "empty-dataset" | "no-trainer";

export type FineTuneOutcome =
  | { status: "abstained"; reason: FineTuneAbstainReason; detail: string; plan?: FineTunePlan }
  | { status: "planned"; plan: FineTunePlan }
  | {
      status: "ran";
      plan: FineTunePlan;
      exitCode: number;
      durationMs: number;
      stdoutTail: string[];
      stderrTail: string[];
      checkpointDir: string | null;
    };

export interface SpawnPort {
  run(argv: string[], opts: { cwd: string; timeoutMs: number }): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }>;
}

const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour
/** POSIX `timeout(1)`'s own convention for "the child was killed for running
 *  over budget" — used ONLY to force a non-zero exit code when the injected
 *  `SpawnPort` reports `timedOut: true` but (as some real process runners do
 *  for a killed child) still reports `exitCode: 0`. Never presented as a
 *  measured metric; it exists solely so a timeout can never read as success. */
const TIMEOUT_EXIT_CODE = 124;
/** Forced non-zero exit code when `spawn.run` itself rejects (the trainer
 *  process could not even be started) — same "never a fake success" rule. */
const SPAWN_ERROR_EXIT_CODE = 1;
const MAX_TAIL_LINES = 200;

function tailLines(text: string): string[] {
  if (typeof text !== "string" || text.length === 0) return [];
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.length > MAX_TAIL_LINES ? lines.slice(lines.length - MAX_TAIL_LINES) : lines;
}

/**
 * The safety gate. See the module header for the exact, ANDed precondition
 * list — every one of the five conditions must hold before `req.spawn` is
 * ever called. Returns a typed outcome; never throws (a `spawn.run` promise
 * rejection is itself caught and surfaced as a non-zero-exit-code `"ran"`
 * outcome, never left unhandled and never reported as success).
 */
export async function runFineTune(req: {
  enabled: boolean;
  dryRun?: boolean;
  plan: FineTunePlan;
  model: LocalModelProbe;
  audit: DatasetAuditReport;
  spawn?: SpawnPort;
  now?: () => number;
  timeoutMs?: number;
}): Promise<FineTuneOutcome> {
  const { plan } = req;

  if (req.enabled !== true) {
    return {
      status: "abstained",
      reason: "flag-not-set",
      detail: "fine-tuning is off by default; pass --enable (a real local model and a clean dataset audit are also required) to run it.",
      plan,
    };
  }
  if (req.model.present !== true) {
    return {
      status: "abstained",
      reason: "no-model",
      detail: `no local model was detected at "${plan.modelPath || "(no path given)"}": ${req.model.reason}`,
      plan,
    };
  }
  if (req.audit.ok !== true) {
    const fatal = req.audit.findings.filter((f) => f.severity === "fatal");
    const codes = [...new Set(fatal.map((f) => f.code))].join(", ") || "unknown";
    return {
      status: "abstained",
      reason: "audit-failed",
      detail: `dataset audit for "${plan.datasetDir}" is not clean (${fatal.length} fatal finding(s): ${codes}); fine-tuning never trains on an unaudited or tampered dataset.`,
      plan,
    };
  }
  if (!(plan.trainRecords > 0)) {
    return {
      status: "abstained",
      reason: "empty-dataset",
      detail: `dataset at "${plan.datasetDir}" has zero train records; there is nothing to fine-tune on.`,
      plan,
    };
  }
  if (req.dryRun === true) {
    return { status: "planned", plan };
  }
  if (!req.spawn) {
    return {
      status: "abstained",
      reason: "no-trainer",
      detail: "no local trainer process is configured (SpawnPort absent); fine-tuning is never invoked without one.",
      plan,
    };
  }

  const now = req.now ?? Date.now;
  const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const startedAt = now();

  try {
    const result = await req.spawn.run(plan.argv, { cwd: plan.cwd, timeoutMs });
    const durationMs = now() - startedAt;
    let exitCode = result.exitCode;
    if (result.timedOut && exitCode === 0) exitCode = TIMEOUT_EXIT_CODE;
    const succeeded = !result.timedOut && exitCode === 0;
    return {
      status: "ran",
      plan,
      exitCode,
      durationMs,
      stdoutTail: tailLines(result.stdout),
      stderrTail: tailLines(result.stderr),
      checkpointDir: succeeded ? plan.outputDir : null,
    };
  } catch (err) {
    const durationMs = now() - startedAt;
    return {
      status: "ran",
      plan,
      exitCode: SPAWN_ERROR_EXIT_CODE,
      durationMs,
      stdoutTail: [],
      stderrTail: tailLines(`spawn.run rejected: ${describeErr(err)}`),
      checkpointDir: null,
    };
  }
}

// ===========================================================================
// formatFineTuneOutcome
// ===========================================================================

function formatPlanLines(p: FineTunePlan): string[] {
  return [
    `datasetDir      : ${p.datasetDir}`,
    `manifestDigest  : ${p.manifestDigest}`,
    `modelPath       : ${p.modelPath || "(none)"}`,
    `modelFormat     : ${p.modelFormat}`,
    `trainRecords    : ${p.trainRecords}`,
    `holdoutRecords  : ${p.holdoutRecords}`,
    `epochs          : ${p.epochs}`,
    `batchSize       : ${p.batchSize}`,
    `learningRate    : ${p.learningRate}`,
    `seed            : ${p.seed}`,
    `outputDir       : ${p.outputDir}`,
    `estimatedSteps  : ${p.estimatedSteps}`,
  ];
}

/** Aligned plain-ASCII lines describing a {@link FineTuneOutcome}, suitable
 *  for direct terminal output. Never prints a loss/accuracy/perplexity
 *  field — this module has no such field on any outcome variant to print. */
export function formatFineTuneOutcome(o: FineTuneOutcome): string[] {
  const lines: string[] = [];
  if (o.status === "abstained") {
    lines.push("Fine-tune: ABSTAINED (nothing was spawned)");
    lines.push(`  reason  : ${o.reason}`);
    lines.push(`  detail  : ${o.detail}`);
    lines.push("  metrics : none — an abstained run reports zero fine-tune metrics, never a fabricated number");
    if (o.plan) {
      lines.push("  plan:");
      lines.push(...formatPlanLines(o.plan).map((l) => "    " + l));
    }
    return lines;
  }
  if (o.status === "planned") {
    lines.push("Fine-tune: PLANNED (dry run — nothing was spawned)");
    lines.push(...formatPlanLines(o.plan).map((l) => "  " + l));
    return lines;
  }
  lines.push(`Fine-tune: RAN (exitCode=${o.exitCode})`);
  lines.push(`  duration      : ${o.durationMs}ms`);
  lines.push(`  checkpointDir : ${o.checkpointDir ?? "(none — the run did not complete successfully)"}`);
  lines.push("  plan:");
  lines.push(...formatPlanLines(o.plan).map((l) => "    " + l));
  lines.push("  stdout (tail):");
  lines.push(...(o.stdoutTail.length > 0 ? o.stdoutTail.map((l) => "    " + l) : ["    (empty)"]));
  lines.push("  stderr (tail):");
  lines.push(...(o.stderrTail.length > 0 ? o.stderrTail.map((l) => "    " + l) : ["    (empty)"]));
  lines.push("  note: only what the trainer process actually printed/returned is shown above — no loss, accuracy, or perplexity is ever synthesized.");
  return lines;
}
