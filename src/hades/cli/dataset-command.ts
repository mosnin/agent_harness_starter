/**
 * `hades dataset <sub>` — the terminal surface over the real dataset flywheel
 * (`../dataset/exporter`, `../dataset/audit`, `../dataset/corpus`, and this
 * team's own `../dataset/finetune`).
 *
 *   hades dataset export   [--out DIR] [--schema S] [--shard-size N]
 *                          [--holdout F] [--compression gzip|none]
 *                          [--include-mock] [--since T] [--until T]
 *                          [--min-pcorrect P] [--overwrite] [--json]
 *   hades dataset import   <file.json> [--source run|bench|import] [--json]
 *   hades dataset stats    [--dir D] [--json]
 *   hades dataset verify   [--dir D] [--with-corpus] [--json]
 *   hades dataset finetune [--dir D] [--model PATH] [--enable] [--dry-run]
 *                          [--epochs N] [--json]
 *   hades dataset help
 *
 * Terminal-free (returns `{ code, lines }`) so it unit-tests without a shell
 * or real stdout, matching `../cli/eval-command.ts`'s house pattern: this
 * module never calls `console.*` or `process.exit`, and the only filesystem
 * access it ever performs directly is the same optional
 * `readFile`/`fileExists` override pair `eval-command.ts`'s `cmdGate` uses
 * (defaulting to real `node:fs` only when the caller does not inject one) —
 * every OTHER piece of state (the corpus, the exporter, the auditor, the
 * fine-tune loop) goes through {@link DatasetCliDeps}.
 *
 * ## Exit codes (the CI contract)
 *
 *   0  success / clean.
 *   1  usage error, or an operation that could not run (a bad flag, an
 *      unreadable import file, ANY rejected import item, an export
 *      refusal, or a fine-tune request that could not run once enabled).
 *   2  `hades dataset verify` found the dataset audit FAILED with at least
 *      one fatal finding — so `verify` is CI-gateable directly.
 *   3  `hades dataset verify --with-corpus` found the REFERENCED corpus's
 *      own hash chain broken (checked independently of, and before, the
 *      dataset audit itself) — distinct from an ordinary audit FAILURE so a
 *      CI caller can tell "this dataset's bytes are wrong" (2) apart from
 *      "the corpus this dataset claims to be built from is not trustworthy
 *      at all" (3), exactly as `../cli/eval-command.ts`'s `history --verify`
 *      keeps its own chain-broken exit code (3) distinct from a gate BLOCK
 *      (2).
 *
 * ## `finetune` is OFF by default (read this before wiring `deps.runFineTune`)
 *
 * `hades dataset finetune` never trains anything unless the caller passes
 * `--enable` AND a real local model is present on this machine AND the
 * dataset's independently recomputed audit is clean — see
 * `../dataset/finetune.ts`'s module header for the exact, ANDed precondition
 * list `runFineTune` enforces. This command is NEVER invoked by this
 * repo's own test suite or CI pipeline (every fine-tune test lives in
 * `../dataset/__tests__/finetune.test.ts` and drives `runFineTune` directly
 * with a spy `SpawnPort`, never through this CLI, and never with a real
 * trainer process). No loss, accuracy, or perplexity metric is ever
 * synthesized here — this module only ever prints what
 * `../dataset/finetune.ts`'s real outcome actually observed.
 */

import { existsSync, readFileSync } from "node:fs";

import type { CliResult } from "./cli";

import { readManifest, type DatasetManifest, type ExportSpec, type ExportResult } from "../dataset/exporter";
import { formatAuditReport, formatStatsReport, computeStats, type DatasetAuditReport } from "../dataset/audit";
import { VerifiedTrajectoryCorpus, type CorpusAdmission, type CorpusChainVerification } from "../dataset/corpus";
import type { TrainingRecord } from "../dataset/example";
import type { VerifiedTrajectory } from "../skills/synthesize";
import type { LocalModelProbe, FineTuneOptions, FineTuneOutcome } from "../dataset/finetune";
import { formatFineTuneOutcome } from "../dataset/finetune";

// ===========================================================================
// Locked deps seam
// ===========================================================================

export interface DatasetCliDeps {
  root: string;
  corpus: () => VerifiedTrajectoryCorpus;
  exportDataset: (spec: Partial<ExportSpec>, outDir: string, overwrite: boolean) => ExportResult;
  auditDataset: (dir: string, opts?: { withCorpus?: boolean }) => Promise<DatasetAuditReport>;
  readManifest: (dir: string) => DatasetManifest;
  readRecords: (dir: string) => { records: TrainingRecord[]; errors: unknown[] };
  probeModel: (path?: string) => LocalModelProbe;
  runFineTune: (req: {
    enabled: boolean;
    dryRun: boolean;
    datasetDir: string;
    modelPath?: string;
    opts: FineTuneOptions;
  }) => Promise<FineTuneOutcome>;
  readFile?: (p: string) => string;
  fileExists?: (p: string) => boolean;
  now?: () => number;
}

// ===========================================================================
// Small local helpers (own copies — see `../cli/eval-command.ts`'s note on
// this convention: each CLI command module keeps its own tiny formatting/
// parsing helpers rather than sharing a grab-bag utility module).
// ===========================================================================

function describeErr(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

/** Duck-types an optional `.code` string off a thrown value (e.g. the real
 *  exporter's `ExportRefusal`) WITHOUT importing that class — this module's
 *  locked import surface does not grant it, and this module must stay
 *  correct even if a differently-wired `deps.exportDataset` throws a plain
 *  `Error` instead. */
function errCode(err: unknown): string | undefined {
  if (err !== null && typeof err === "object" && "code" in err) {
    const c = (err as { code: unknown }).code;
    if (typeof c === "string" && c.length > 0) return c;
  }
  return undefined;
}

function usageError(sub: string, message: string): CliResult {
  return { code: 1, lines: [`dataset ${sub}: ${message}`, "", ...datasetHelpLines()] };
}

function errOut(sub: string, message: string, code: number): CliResult {
  return { code, lines: [`dataset ${sub}: ${message}`] };
}

function jsonResult(payload: Record<string, unknown>, code: number): CliResult {
  return { code, lines: JSON.stringify({ ...payload, code }, null, 2).split("\n") };
}

// ---------------------------------------------------------------------------
// Flag parsing — mirrors `../cli/eval-command.ts`'s `parseFlags`/`numFlag`:
// every token is a recognized boolean flag, a recognized valued flag
// (consuming the NEXT token, an error rather than a silent drop if missing),
// or a positional; an unrecognized `-`-prefixed token is always an error.
// ---------------------------------------------------------------------------

interface FlagSpec {
  valued: ReadonlySet<string>;
  boolean: ReadonlySet<string>;
}

interface ParsedFlags {
  values: Map<string, string>;
  set: Set<string>;
}

type ParseFlagsResult = { ok: true; parsed: ParsedFlags; positionals: string[] } | { ok: false; error: string };

function parseFlags(args: readonly string[], spec: FlagSpec): ParseFlagsResult {
  const values = new Map<string, string>();
  const set = new Set<string>();
  const positionals: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const tok = args[i];
    if (spec.boolean.has(tok)) {
      set.add(tok);
      continue;
    }
    if (spec.valued.has(tok)) {
      const val = args[i + 1];
      if (val === undefined) return { ok: false, error: `${tok} requires a value` };
      values.set(tok, val);
      i++;
      continue;
    }
    if (tok.startsWith("-")) {
      return { ok: false, error: `unknown flag: ${tok}` };
    }
    positionals.push(tok);
  }

  return { ok: true, parsed: { values, set }, positionals };
}

interface NumFlagOpts {
  integer?: boolean;
  min?: number;
  max?: number;
}

type NumFlagResult = { ok: true; value: number | undefined } | { ok: false; error: string };

function numFlag(values: Map<string, string>, name: string, opts: NumFlagOpts = {}): NumFlagResult {
  const raw = values.get(name);
  if (raw === undefined) return { ok: true, value: undefined };
  if (raw.trim().length === 0) return { ok: false, error: `${name} must be a finite number; got ${JSON.stringify(raw)}` };
  const n = Number(raw);
  if (!Number.isFinite(n)) return { ok: false, error: `${name} must be a finite number; got ${JSON.stringify(raw)}` };
  if (opts.integer === true && !Number.isInteger(n)) return { ok: false, error: `${name} must be an integer; got ${JSON.stringify(raw)}` };
  if (opts.min !== undefined && n < opts.min) return { ok: false, error: `${name} must be >= ${opts.min}; got ${n}` };
  if (opts.max !== undefined && n > opts.max) return { ok: false, error: `${name} must be <= ${opts.max}; got ${n}` };
  return { ok: true, value: n };
}

// ===========================================================================
// export
// ===========================================================================

const VALID_SCHEMAS: ReadonlySet<string> = new Set(["sft-prompt-completion", "chat-messages", "tool-trace"]);

function formatExportResultLines(r: ExportResult): string[] {
  const m = r.manifest;
  return [
    "Dataset export",
    `  out dir        : ${r.outDir}`,
    `  format version : ${m.formatVersion}`,
    `  spec hash      : ${m.specHash}`,
    `  digest         : ${m.digest}`,
    `  corpus genesis : ${m.corpus.genesis}`,
    `  corpus head    : ${m.corpus.head}`,
    `  records        : ${m.counts.records} (train=${m.counts.train}, holdout=${m.counts.holdout})`,
    `  skipped        : ${m.counts.skipped}`,
    `  mock excluded  : ${m.counts.mockTaintedExcluded}`,
    `  duplicates     : ${m.counts.duplicatesDropped}`,
    `  redactions     : ${m.counts.redactions}`,
    `  shards         : ${m.shards.length}`,
    `  bytes written  : ${r.bytesWritten}`,
  ];
}

function cmdExport(args: string[], deps: DatasetCliDeps): CliResult {
  const parsed = parseFlags(args, {
    valued: new Set(["--out", "--schema", "--shard-size", "--holdout", "--compression", "--since", "--until", "--min-pcorrect"]),
    boolean: new Set(["--include-mock", "--overwrite", "--json"]),
  });
  if (!parsed.ok) return usageError("export", parsed.error);
  if (parsed.positionals.length > 0) return usageError("export", `unexpected argument: ${parsed.positionals[0]}`);
  const { values, set } = parsed.parsed;
  const wantJson = set.has("--json");

  const outDir = values.get("--out");
  if (outDir === undefined || outDir.trim().length === 0) return usageError("export", "--out DIR is required");

  const schema = values.get("--schema");
  if (schema !== undefined && !VALID_SCHEMAS.has(schema)) {
    return usageError("export", `--schema must be one of ${[...VALID_SCHEMAS].join(", ")}; got ${JSON.stringify(schema)}`);
  }

  const compression = values.get("--compression");
  if (compression !== undefined && compression !== "gzip" && compression !== "none") {
    return usageError("export", `--compression must be "gzip" or "none"; got ${JSON.stringify(compression)}`);
  }

  const shardSize = numFlag(values, "--shard-size", { integer: true, min: 1 });
  if (!shardSize.ok) return usageError("export", shardSize.error);
  const holdout = numFlag(values, "--holdout", { min: 0, max: 1 });
  if (!holdout.ok) return usageError("export", holdout.error);
  const since = numFlag(values, "--since");
  if (!since.ok) return usageError("export", since.error);
  const until = numFlag(values, "--until");
  if (!until.ok) return usageError("export", until.error);
  if (since.value !== undefined && until.value !== undefined && since.value > until.value) {
    return usageError("export", "--since must be <= --until");
  }
  const minPCorrect = numFlag(values, "--min-pcorrect", { min: 0, max: 1 });
  if (!minPCorrect.ok) return usageError("export", minPCorrect.error);

  const spec: Partial<ExportSpec> = {
    ...(schema !== undefined ? { schema: schema as ExportSpec["schema"] } : {}),
    ...(shardSize.value !== undefined ? { shardSize: shardSize.value } : {}),
    ...(compression !== undefined ? { compression: compression as ExportSpec["compression"] } : {}),
    ...(holdout.value !== undefined ? { holdoutFraction: holdout.value } : {}),
    filter: {
      ...(set.has("--include-mock") ? { realityClass: "mock-tainted" as const } : {}),
      ...(since.value !== undefined ? { since: since.value } : {}),
      ...(until.value !== undefined ? { until: until.value } : {}),
      ...(minPCorrect.value !== undefined ? { minPCorrect: minPCorrect.value } : {}),
    },
  };

  let result: ExportResult;
  try {
    result = deps.exportDataset(spec, outDir, set.has("--overwrite"));
  } catch (err) {
    const code = errCode(err);
    return errOut("export", `export refused${code ? ` [${code}]` : ""}: ${describeErr(err)}`, 1);
  }

  if (wantJson) return jsonResult({ outDir: result.outDir, bytesWritten: result.bytesWritten, manifest: result.manifest }, 0);
  return { code: 0, lines: formatExportResultLines(result) };
}

// ===========================================================================
// import
// ===========================================================================

const VALID_SOURCES: ReadonlySet<string> = new Set(["run", "bench", "import"]);

function looksLikeVerifiedTrajectory(v: unknown): v is VerifiedTrajectory {
  if (v === null || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    o.trajectory !== undefined &&
    o.trajectory !== null &&
    typeof o.trajectory === "object" &&
    o.certificate !== undefined &&
    o.certificate !== null &&
    typeof o.certificate === "object"
  );
}

interface ImportItemResult {
  index: number;
  ok: boolean;
  code?: string;
  detail?: string;
  seq?: number;
  trajectorySha256?: string;
}

async function cmdImport(args: string[], deps: DatasetCliDeps): Promise<CliResult> {
  const parsed = parseFlags(args, { valued: new Set(["--source"]), boolean: new Set(["--json"]) });
  if (!parsed.ok) return usageError("import", parsed.error);
  const { values, set } = parsed.parsed;
  const wantJson = set.has("--json");

  if (parsed.positionals.length === 0) return usageError("import", "usage: hades dataset import <file.json> [--source run|bench|import] [--json]");
  if (parsed.positionals.length > 1) return usageError("import", `unexpected argument: ${parsed.positionals[1]}`);
  const file = parsed.positionals[0];

  const sourceRaw = values.get("--source") ?? "import";
  if (!VALID_SOURCES.has(sourceRaw)) {
    return usageError("import", `--source must be one of ${[...VALID_SOURCES].join(", ")}; got ${JSON.stringify(sourceRaw)}`);
  }
  const source = sourceRaw as "run" | "bench" | "import";

  const fileExists = deps.fileExists ?? existsSync;
  const readFile = deps.readFile ?? ((p: string): string => readFileSync(p, "utf8"));

  let exists: boolean;
  try {
    exists = fileExists(file);
  } catch {
    exists = false;
  }
  if (!exists) return errOut("import", `file not found: "${file}"`, 1);

  let raw: string;
  try {
    raw = readFile(file);
  } catch (err) {
    return errOut("import", `could not read "${file}": ${describeErr(err)}`, 1);
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (err) {
    return errOut("import", `"${file}" is not valid JSON: ${describeErr(err)}`, 1);
  }

  const items: unknown[] = Array.isArray(parsedJson) ? parsedJson : [parsedJson];
  if (items.length === 0) return errOut("import", `"${file}" contains an empty array — nothing to import`, 1);

  let corpus: VerifiedTrajectoryCorpus;
  try {
    corpus = deps.corpus();
  } catch (err) {
    return errOut("import", `could not open the corpus: ${describeErr(err)}`, 1);
  }

  const results: ImportItemResult[] = [];
  let accepted = 0;
  let rejected = 0;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!looksLikeVerifiedTrajectory(item)) {
      rejected++;
      results.push({ index: i, ok: false, code: "malformed", detail: "item is not a {trajectory, certificate} object" });
      continue;
    }
    let admission: CorpusAdmission;
    try {
      admission = await corpus.admit(item, { source });
    } catch (err) {
      rejected++;
      results.push({ index: i, ok: false, code: "malformed", detail: `corpus.admit threw: ${describeErr(err)}` });
      continue;
    }
    if (admission.ok) {
      accepted++;
      results.push({ index: i, ok: true, seq: admission.entry.seq, trajectorySha256: admission.entry.trajectorySha256 });
    } else {
      rejected++;
      results.push({ index: i, ok: false, code: admission.rejection.code, detail: admission.rejection.detail });
    }
  }

  const code = rejected > 0 ? 1 : 0;

  if (wantJson) return jsonResult({ file, source, total: items.length, accepted, rejected, results }, code);

  const lines: string[] = [];
  lines.push(`Dataset import: ${file}`);
  lines.push(`  source : ${source}`);
  lines.push(`  total=${items.length} accepted=${accepted} rejected=${rejected}`);
  lines.push("");
  for (const r of results) {
    lines.push(
      r.ok
        ? `  [${r.index}] ACCEPTED seq=${r.seq} trajectorySha256=${r.trajectorySha256}`
        : `  [${r.index}] REJECTED code=${r.code} detail=${r.detail}`,
    );
  }
  lines.push("");
  lines.push(`EXIT CODE: ${code}`);
  return { code, lines };
}

// ===========================================================================
// stats
// ===========================================================================

function cmdStats(args: string[], deps: DatasetCliDeps): CliResult {
  const parsed = parseFlags(args, { valued: new Set(["--dir"]), boolean: new Set(["--json"]) });
  if (!parsed.ok) return usageError("stats", parsed.error);
  if (parsed.positionals.length > 0) return usageError("stats", `unexpected argument: ${parsed.positionals[0]}`);
  const { values, set } = parsed.parsed;
  const wantJson = set.has("--json");

  const dir = values.get("--dir") ?? deps.root;

  let records: TrainingRecord[];
  let errors: unknown[];
  try {
    ({ records, errors } = deps.readRecords(dir));
  } catch (err) {
    return errOut("stats", `readRecords threw: ${describeErr(err)}`, 1);
  }
  if (records.length === 0 && errors.length > 0) {
    return errOut("stats", `could not read any records from "${dir}" (${errors.length} error(s); first: ${describeErr(errors[0])})`, 1);
  }

  const stats = computeStats(records);

  let manifest: DatasetManifest | null = null;
  try {
    manifest = deps.readManifest(dir);
  } catch {
    manifest = null; // manifest not required for stats to succeed — best-effort cross-reference only
  }

  if (wantJson) {
    return jsonResult(
      {
        dir,
        stats,
        manifestDigest: manifest?.digest ?? null,
        manifestCounts: manifest?.counts ?? null,
        readErrors: errors.length,
      },
      0,
    );
  }

  const lines = [...formatStatsReport(stats)];
  if (manifest !== null) {
    const countsMatch =
      manifest.counts.records === stats.records && manifest.counts.train === stats.train && manifest.counts.holdout === stats.holdout;
    lines.push(`manifest digest        : ${manifest.digest}`);
    lines.push(`manifest counts match  : ${countsMatch ? "yes" : "NO — recomputed counts differ from the manifest"}`);
    lines.push("");
  }
  if (errors.length > 0) {
    lines.push(`WARNING: ${errors.length} record(s) failed to read cleanly while computing these stats.`);
  }
  return { code: 0, lines };
}

// ===========================================================================
// verify
// ===========================================================================

async function cmdVerify(args: string[], deps: DatasetCliDeps): Promise<CliResult> {
  const parsed = parseFlags(args, { valued: new Set(["--dir"]), boolean: new Set(["--with-corpus", "--json"]) });
  if (!parsed.ok) return usageError("verify", parsed.error);
  if (parsed.positionals.length > 0) return usageError("verify", `unexpected argument: ${parsed.positionals[0]}`);
  const { values, set } = parsed.parsed;
  const wantJson = set.has("--json");
  const withCorpus = set.has("--with-corpus");

  const dir = values.get("--dir") ?? deps.root;

  let chain: CorpusChainVerification | null = null;
  if (withCorpus) {
    let corpus: VerifiedTrajectoryCorpus;
    try {
      corpus = deps.corpus();
    } catch (err) {
      return errOut("verify", `could not open the corpus: ${describeErr(err)}`, 1);
    }
    try {
      chain = corpus.verifyChain();
    } catch (err) {
      return errOut("verify", `corpus.verifyChain() threw: ${describeErr(err)}`, 1);
    }
  }

  let report: DatasetAuditReport;
  try {
    report = await deps.auditDataset(dir, withCorpus ? { withCorpus: true } : undefined);
  } catch (err) {
    return errOut("verify", `auditDataset threw: ${describeErr(err)}`, 1);
  }

  const code = chain !== null && !chain.ok ? 3 : report.ok ? 0 : 2;

  if (wantJson) return jsonResult({ dir, withCorpus, chain, report }, code);

  const lines: string[] = [...formatAuditReport(report)];
  if (chain !== null) {
    lines.push(
      chain.ok
        ? `corpus chain verified : true (${chain.entries} entries)`
        : `corpus chain verified : false (brokenAt=${String(chain.brokenAt)} reason=${chain.reason ?? "unknown"})`,
    );
    lines.push("");
  }
  lines.push(`EXIT CODE: ${code}`);
  return { code, lines };
}

// ===========================================================================
// finetune
// ===========================================================================

async function cmdFinetune(args: string[], deps: DatasetCliDeps): Promise<CliResult> {
  const parsed = parseFlags(args, {
    valued: new Set(["--dir", "--model", "--epochs"]),
    boolean: new Set(["--enable", "--dry-run", "--json"]),
  });
  if (!parsed.ok) return usageError("finetune", parsed.error);
  if (parsed.positionals.length > 0) return usageError("finetune", `unexpected argument: ${parsed.positionals[0]}`);
  const { values, set } = parsed.parsed;
  const wantJson = set.has("--json");

  const dir = values.get("--dir") ?? deps.root;
  const modelPath = values.get("--model");

  const epochs = numFlag(values, "--epochs", { integer: true, min: 1 });
  if (!epochs.ok) return usageError("finetune", epochs.error);

  const enabled = set.has("--enable");
  const dryRun = set.has("--dry-run");
  const opts: FineTuneOptions = {};
  if (epochs.value !== undefined) opts.epochs = epochs.value;

  let outcome: FineTuneOutcome;
  try {
    outcome = await deps.runFineTune({ enabled, dryRun, datasetDir: dir, modelPath, opts });
  } catch (err) {
    return errOut("finetune", `runFineTune rejected: ${describeErr(err)}`, 1);
  }

  let code: number;
  if (outcome.status === "abstained") {
    code = outcome.reason === "flag-not-set" ? 0 : 1;
  } else if (outcome.status === "planned") {
    code = 0;
  } else {
    code = outcome.exitCode === 0 ? 0 : 1;
  }

  if (wantJson) return jsonResult({ dir, modelPath: modelPath ?? null, enabled, dryRun, opts, outcome }, code);

  const lines = [...formatFineTuneOutcome(outcome), "", `EXIT CODE: ${code}`];
  return { code, lines };
}

// ===========================================================================
// help
// ===========================================================================

export function datasetHelpLines(): string[] {
  return [
    "Usage: hades dataset <command>",
    "",
    "Commands:",
    "  hades dataset export   [--out DIR] [--schema S] [--shard-size N]",
    "                         [--holdout F] [--compression gzip|none]",
    "                         [--include-mock] [--since T] [--until T]",
    "                         [--min-pcorrect P] [--overwrite] [--json]",
    "                         Export the verified corpus to a byte-reproducible",
    "                         on-disk dataset (sharded JSONL, deterministic gzip,",
    "                         a hash-pinned manifest). --include-mock exports",
    "                         mock-tainted trajectories INSTEAD OF real ones",
    "                         (real is always the default).",
    "",
    "  hades dataset import   <file.json> [--source run|bench|import] [--json]",
    "                         Admit one VerifiedTrajectory (or a JSON array of",
    "                         them) into the REAL verified corpus. Every item is",
    "                         independently re-verified (signature, trace-hash",
    "                         binding, gate consistency, duplicate check) — an",
    "                         unverified or tampered item is always rejected,",
    "                         never silently admitted. Exits non-zero if ANY",
    "                         item was rejected.",
    "",
    "  hades dataset stats    [--dir D] [--json]",
    "                         Read and report honest, non-extrapolated",
    "                         statistics over an exported dataset's records.",
    "",
    "  hades dataset verify   [--dir D] [--with-corpus] [--json]",
    "                         Independently RECOMPUTE a dataset's trustworthiness",
    "                         from bytes alone (shard hashes, record ids, splits,",
    "                         counts, digest) — trusts nothing the manifest",
    "                         claims. --with-corpus additionally cross-checks",
    "                         every record against a real corpus (certificate",
    "                         signatures, trace hashes, label consistency) and",
    "                         independently verifies the corpus's own hash",
    "                         chain. Exit 2 = audit FAILED; exit 3 = the",
    "                         referenced corpus's own chain is broken.",
    "",
    "  hades dataset finetune [--dir D] [--model PATH] [--enable] [--dry-run]",
    "                         [--epochs N] [--json]",
    "                         The local fine-tune loop. OFF BY DEFAULT: without",
    "                         --enable this only reports why it would abstain.",
    "                         Even with --enable, it never spawns a trainer",
    "                         unless a REAL local model is present on this",
    "                         machine (gguf / safetensors / a peft adapter dir —",
    "                         real magic-byte detection, never guessed) AND the",
    "                         dataset's independently recomputed audit is clean.",
    "                         --dry-run always stops at a printed plan, never",
    "                         spawning anything. This subcommand is never run by this repo's own tests or CI.",
    "                         No loss, accuracy, or perplexity metric is ever",
    "                         synthesized — only what a real trainer process",
    "                         actually printed/returned is ever shown.",
    "",
    "  hades dataset help     Show this help",
    "",
    "Exit codes:",
    "  0  success / clean.",
    "  1  usage error, or an operation that could not run (bad flag, unreadable",
    "     import file, any rejected import item, an export refusal, or a",
    "     fine-tune request that could not run once --enable was passed).",
    "  2  `verify` found the dataset audit FAILED with a fatal finding.",
    "  3  `verify --with-corpus` found the referenced corpus's own hash chain",
    "     broken.",
  ];
}

// ===========================================================================
// Router
// ===========================================================================

export async function runDatasetCommand(argv: string[], deps: DatasetCliDeps): Promise<CliResult> {
  try {
    const [sub, ...rest] = argv;
    switch (sub) {
      case undefined:
      case "help":
      case "--help":
      case "-h":
        return { code: 0, lines: datasetHelpLines() };
      case "export":
        return cmdExport(rest, deps);
      case "import":
        return await cmdImport(rest, deps);
      case "stats":
        return cmdStats(rest, deps);
      case "verify":
        return await cmdVerify(rest, deps);
      case "finetune":
        return await cmdFinetune(rest, deps);
      default:
        return { code: 1, lines: [`dataset: unknown subcommand "${sub}"`, "", ...datasetHelpLines()] };
    }
  } catch (err) {
    return { code: 1, lines: [`dataset: unexpected error: ${describeErr(err)}`] };
  }
}
