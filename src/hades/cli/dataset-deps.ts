/**
 * dataset-deps.ts — CENTRAL INTEGRATION of `hades dataset`'s deps seam.
 *
 * `dataset-command.ts` was built terminal-free against an injected
 * {@link DatasetCliDeps} (engine types only, per its locked import
 * boundary). This module is the product wiring that fills that seam with the
 * real thing — every capability below is the genuine article; nothing here
 * returns a constant, synthesizes a metric, or fabricates a report.
 *
 *   dataDir    -> `env.HADES_DATA_DIR ?? ".hades"`, the EXACT convention every
 *                  other `src/hades/cli/*-deps.ts` module already uses (see
 *                  `defaultEvalCliDeps`, `defaultStateDeps`, `openTrustStack`).
 *   corpus     -> a real {@link VerifiedTrajectoryCorpus} rooted at
 *                  `<dataDir>/dataset/corpus`, opened LAZILY and cached: the
 *                  constructor takes a real cross-process lock on
 *                  `<root>/.lock` and writes a header, so `hades dataset help`
 *                  (and `stats`/`verify` over an already-exported directory)
 *                  must never touch it, while every subcommand that does need
 *                  it within one process shares one instance.
 *   root       -> `<dataDir>/dataset/export`, the default dataset directory
 *                  for `stats` / `verify` / `finetune` when no `--dir` is
 *                  given. Deliberately a SIBLING of the corpus root, never the
 *                  corpus root itself — `exportDataset` refuses to write into
 *                  a non-empty directory without `--overwrite`, and an
 *                  overwrite that landed on the corpus would destroy the
 *                  ledger the dataset is derived from.
 *   exportDataset / auditDataset / readManifest / readRecords / probeModel
 *              -> the real `../dataset/*` functions, unwrapped.
 *   runFineTune -> the real composition the CLI cannot do for itself: read the
 *                  real manifest, probe for a real local model, run the real
 *                  independent audit, build the real plan, and hand all four
 *                  to the real `runFineTune` safety gate.
 *
 * ## Why the audit always really runs
 *
 * `runFineTune`'s signature demands a `DatasetAuditReport`. There is exactly
 * one honest way to produce one: run `auditDataset` for real. This module
 * therefore always audits before calling the gate — even for a request that
 * will abstain earlier (e.g. `--enable` not passed), because the alternative
 * is to hand the gate a hand-built "ok" report, which is precisely the
 * fabrication the whole subsystem exists to refuse.
 *
 * ## The trainer is opt-in, and can never be shell-injected
 *
 * A `SpawnPort` is wired ONLY when `$HADES_FINETUNE_TRAINER` names a real
 * executable on this machine. Absent (the default), `runFineTune` gets no
 * spawn port at all and honestly abstains with `"no-trainer"` — this repo
 * ships no trainer binary and never pretends to. When it IS set, the value is
 * used as a SINGLE argv[0] token (never split on whitespace, never passed
 * through a shell): the port spawns with `shell: false` and an argv array, so
 * no path, flag value, or dataset content can escape its own argv slot.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { VerifiedTrajectoryCorpus } from "../dataset/corpus";
import {
  exportDataset as coreExportDataset,
  readManifest as coreReadManifest,
  type ExportSpec,
  type ExportResult,
  type DatasetManifest,
} from "../dataset/exporter";
import { auditDataset as coreAuditDataset, readDatasetRecords, type DatasetAuditReport } from "../dataset/audit";
import {
  probeLocalModel,
  planFineTune,
  runFineTune as coreRunFineTune,
  type FineTuneOptions,
  type FineTuneOutcome,
  type FineTunePlan,
  type LocalModelProbe,
  type SpawnPort,
} from "../dataset/finetune";
import type { DatasetCliDeps } from "./dataset-command";

/** Names a real trainer executable. Unset -> no `SpawnPort` is wired and
 *  `hades dataset finetune --enable` abstains with `"no-trainer"`. */
const TRAINER_ENV_VAR = "HADES_FINETUNE_TRAINER";

export interface DatasetDepsOptions {
  env?: NodeJS.ProcessEnv;
  /** Overrides the computed `dataDir` (same override semantics as
   *  `$HADES_DATA_DIR`) — the corpus root is always `<dataDir>/dataset/corpus`
   *  and the default dataset directory `<dataDir>/dataset/export`. Primarily
   *  so a test can bind a real, isolated temp directory without mutating
   *  `process.env`. */
  dataDir?: string;
  /** Overrides the corpus factory (a real corpus over a different root, say).
   *  Absent -> a real corpus at `<dataDir>/dataset/corpus`. */
  corpus?: () => VerifiedTrajectoryCorpus;
  /** Overrides the trainer process port. Absent -> derived from
   *  `$HADES_FINETUNE_TRAINER`; still absent -> no port, so nothing can be
   *  spawned and `runFineTune` abstains honestly. */
  spawnPort?: SpawnPort | null;
}

/**
 * A real child-process port: argv array, `shell: false`, no string
 * interpolation anywhere. Kills the child on timeout and reports `timedOut`
 * truthfully so `runFineTune` can force a non-zero exit code rather than let
 * a killed trainer read as success.
 */
export function nodeSpawnPort(): SpawnPort {
  return {
    run(argv: string[], opts: { cwd: string; timeoutMs: number }) {
      return new Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }>((resolve) => {
        const [cmd, ...rest] = argv;
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        let settled = false;

        const child = spawn(cmd, rest, { cwd: opts.cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, opts.timeoutMs);

        child.stdout?.on("data", (chunk: Buffer) => {
          stdout += chunk.toString("utf8");
        });
        child.stderr?.on("data", (chunk: Buffer) => {
          stderr += chunk.toString("utf8");
        });

        const settle = (exitCode: number): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({ exitCode, stdout, stderr, timedOut });
        };

        // A spawn error (ENOENT, EACCES, ...) is a real failure, never a
        // success: it settles with a non-zero code and the reason on stderr.
        child.on("error", (err: Error) => {
          stderr += `${stderr.length > 0 ? "\n" : ""}spawn failed: ${err.name}: ${err.message}`;
          settle(1);
        });
        child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
          // A signal-killed child has `code === null`; 128+signal is the
          // shell's long-standing convention and is never presented as a
          // measured value — it exists only so a killed run cannot be 0.
          settle(code ?? (signal !== null ? 128 : 1));
        });
      });
    },
  };
}

function resolveSpawnPort(opts: DatasetDepsOptions, env: NodeJS.ProcessEnv): SpawnPort | undefined {
  if (opts.spawnPort !== undefined) return opts.spawnPort ?? undefined;
  const trainer = env[TRAINER_ENV_VAR];
  if (typeof trainer !== "string" || trainer.trim().length === 0) return undefined;
  return nodeSpawnPort();
}

/** Build the real {@link DatasetCliDeps} for `runDatasetCommand`. */
export function defaultDatasetCliDeps(opts: DatasetDepsOptions = {}): DatasetCliDeps {
  const env = opts.env ?? process.env;
  const dataDir = opts.dataDir ?? env.HADES_DATA_DIR ?? ".hades";
  const corpusRoot = join(dataDir, "dataset", "corpus");
  const root = join(dataDir, "dataset", "export");

  let cachedCorpus: VerifiedTrajectoryCorpus | undefined;
  const corpus = (): VerifiedTrajectoryCorpus => {
    if (cachedCorpus === undefined) {
      cachedCorpus = opts.corpus ? opts.corpus() : new VerifiedTrajectoryCorpus({ root: corpusRoot });
    }
    return cachedCorpus;
  };

  const auditDataset = (dir: string, auditOpts?: { withCorpus?: boolean }): Promise<DatasetAuditReport> =>
    coreAuditDataset(dir, auditOpts?.withCorpus === true ? { corpus: corpus() } : {});

  const trainerArgv = ((): string[] | undefined => {
    const trainer = env[TRAINER_ENV_VAR];
    return typeof trainer === "string" && trainer.trim().length > 0 ? [trainer.trim()] : undefined;
  })();

  const runFineTune = async (req: {
    enabled: boolean;
    dryRun: boolean;
    datasetDir: string;
    modelPath?: string;
    opts: FineTuneOptions;
  }): Promise<FineTuneOutcome> => {
    // A manifest that cannot be read is a hard failure, not an abstention:
    // there is no honest plan to report without one. The CLI surfaces the
    // thrown message and exits 1.
    let manifest: DatasetManifest;
    try {
      manifest = coreReadManifest(req.datasetDir);
    } catch (err) {
      throw new Error(
        `no readable dataset manifest at "${req.datasetDir}" (${err instanceof Error ? err.message : String(err)}); ` +
          "run `hades dataset export --out <dir>` first, or pass --dir <dir>",
      );
    }

    const model: LocalModelProbe = probeLocalModel({ ...(req.modelPath !== undefined ? { path: req.modelPath } : {}), env });
    // Always the REAL independent audit — see the module header.
    const audit = await coreAuditDataset(req.datasetDir, { corpus: corpus() });

    const planOpts: FineTuneOptions = {
      ...req.opts,
      ...(req.opts.trainerArgv === undefined && trainerArgv !== undefined ? { trainerArgv } : {}),
    };
    let plan: FineTunePlan;
    try {
      plan = planFineTune(manifest, model, req.datasetDir, planOpts);
    } catch (err) {
      throw new Error(`fine-tune plan rejected: ${err instanceof Error ? err.message : String(err)}`);
    }

    const port = resolveSpawnPort(opts, env);
    return coreRunFineTune({
      enabled: req.enabled,
      dryRun: req.dryRun,
      plan,
      model,
      audit,
      ...(port !== undefined ? { spawn: port } : {}),
    });
  };

  return {
    root,
    corpus,
    exportDataset: (spec: Partial<ExportSpec>, outDir: string, overwrite: boolean): ExportResult =>
      coreExportDataset(corpus(), spec, { outDir, overwrite }),
    auditDataset,
    readManifest: (dir: string) => coreReadManifest(dir),
    readRecords: (dir: string) => readDatasetRecords(dir),
    probeModel: (path?: string) => probeLocalModel({ ...(path !== undefined ? { path } : {}), env }),
    runFineTune,
    readFile: (p: string) => readFileSync(p, "utf8"),
    fileExists: (p: string) => existsSync(p),
    now: () => Date.now(),
  };
}
