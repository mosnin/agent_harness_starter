#!/usr/bin/env node
import { readFileSync, writeFileSync, readdirSync, lstatSync, realpathSync, mkdirSync, mkdtempSync, copyFileSync } from "node:fs";
import { resolve, join, relative, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
const base = resolve(dirname(fileURLToPath(import.meta.url)), "../benchmarks/helm-enterprise");
const FROZEN_SHA = "a67e3dc67333c838a262e8548fb388d6e10fb791f83c01a35322a4dc412f59b3";
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const json = path => JSON.parse(readFileSync(path, "utf8"));
function tree(root) {
  const result = {};
  function walk(dir) {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name), stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw Error("Symlinks are not accepted");
      if (stat.isDirectory()) walk(path);
      else if (stat.isFile()) {
        if (stat.size > 1024 * 1024) throw Error("File exceeds 1 MiB bound");
        result[relative(root, path)] = sha(readFileSync(path));
      } else throw Error("Only regular files accepted");
      if (Object.keys(result).length > 1000) throw Error("Too many files");
    }
  }
  walk(root); return result;
}
export function verify() {
  const frozen = readFileSync(join(base, "FROZEN.json"));
  if (sha(frozen) !== FROZEN_SHA) throw Error("Frozen catalog integrity failure");
  const expected = JSON.parse(frozen), actual = tree(base); delete actual["FROZEN.json"];
  if (!isDeepStrictEqual(actual, expected.files)) throw Error("Fixture/oracle integrity failure");
  return { sha256: FROZEN_SHA, coding: json(join(base, "coding.json")), scenarios: json(join(base, "scenarios.json")) };
}
export function prepare(id, metadata = {}) {
  const catalog = verify(), fixture = catalog.coding.find(item => item.id === id);
  if (!fixture) throw Error("Unknown coding fixture");
  const trial = metadata.trial ?? 1;
  if (!Number.isInteger(trial) || trial < 1 || trial > 3) throw Error("Trial must be 1, 2 or 3");
  const directory = mkdtempSync(join(tmpdir(), "helm-benchmark-")), workspace = join(directory, "workspace");
  mkdirSync(workspace, { mode: 0o700 });
  const source = join(base, fixture.directory, "workspace");
  for (const path of Object.keys(tree(source))) { mkdirSync(dirname(join(workspace, path)), { recursive: true }); copyFileSync(join(source, path), join(workspace, path)); }
  copyFileSync(join(base, fixture.directory, "PROMPT.md"), join(workspace, "PROMPT.md"));
  const manifest = { schema: 1, fixture: id, trial, trialId: randomUUID(), preparedAt: new Date().toISOString(), workspace, frozenSHA: FROZEN_SHA, initial: tree(workspace), metadata };
  writeFileSync(join(directory, "trial.json"), JSON.stringify(manifest, null, 2), { mode: 0o600 });
  return { directory, workspace, manifest: join(directory, "trial.json"), status: "prepared", classification: "unexecuted" };
}
export function grade(manifestPath, candidate, metadata = {}) {
  const started = Date.now(), catalog = verify(), manifest = json(manifestPath);
  const fixture = catalog.coding.find(item => item.id === manifest.fixture);
  if (!fixture || manifest.frozenSHA !== FROZEN_SHA || !Number.isInteger(manifest.trial) || manifest.trial < 1 || manifest.trial > 3) throw Error("Invalid trial manifest");
  const receipt = { schema: 1, fixture: fixture.id, trial: manifest.trial, trialId: manifest.trialId, timestamp: new Date().toISOString(), frozenSHA: FROZEN_SHA, classification: metadata.reference ? "synthetic-oracle-calibration" : "local-candidate-oracle", productWin: false, status: "unavailable", elapsedMs: 0, candidateRevision: metadata.candidateRevision ?? null, harness: metadata.harness ?? null, model: metadata.model ?? null, usage: metadata.usage ?? null, interventions: metadata.interventions ?? null, suppliedElapsedMs: metadata.elapsedMs ?? null, cases: [] };
  if (!candidate) return { ...receipt, reason: "No candidate workspace supplied; no provider invoked" };
  const root = realpathSync(candidate);
  if (root === base || root.startsWith(base + "/") || base.startsWith(root + "/")) throw Error("Candidate must be isolated from frozen benchmark");
  const original = tree(root), baseline = tree(join(base, fixture.directory, "workspace"));
  baseline["PROMPT.md"] = sha(readFileSync(join(base, fixture.directory, "PROMPT.md")));
  const changed = [...new Set([...Object.keys(original), ...Object.keys(baseline)])].filter(path => original[path] !== baseline[path]);
  receipt.candidateHashes = original; receipt.changedFiles = changed;
  const reference = tree(join(base, fixture.directory, "reference"));
  if (fixture.allowedChanges.every(path => original[path] === reference[path])) receipt.classification = "synthetic-oracle-calibration";
  if (changed.some(path => !fixture.allowedChanges.includes(path)) || fixture.allowedChanges.some(path => !original[path])) {
    return { ...receipt, status: "failed", reason: "Unrelated files changed or required files missing", elapsedMs: Date.now() - started };
  }
  const oracle = json(join(base, fixture.directory, "oracle.json")), runner = join(base, "runner.mjs");
  for (const [index, test] of oracle.entries()) {
    const run = spawnSync(process.execPath, ["--permission", "--allow-fs-read=" + root, "--allow-fs-read=" + runner, runner, join(root, fixture.entry)], {
      input: JSON.stringify({ input: test.input, signal: test.signal }), encoding: "utf8", timeout: 2000, maxBuffer: 128 * 1024,
      cwd: root, env: { PATH: dirname(process.execPath), NODE_NO_WARNINGS: "1" },
    });
    let output;
    try { output = JSON.parse(run.stdout); } catch {}
    const passed = !run.error && run.status === 0 && output && !output.mutated && (test.maxDurationMs === undefined || output.durationMs <= test.maxDurationMs) && (test.throws ? output.outcome === "threw" : output.outcome === "returned" && isDeepStrictEqual(output.value, test.expected));
    receipt.cases.push({ index, status: passed ? "passed" : "failed", reason: passed ? null : run.error?.code ?? (output?.mutated ? "input-mutated" : "oracle-mismatch-or-invalid-result") });
  }
  verify();
  if (!isDeepStrictEqual(tree(root), original)) throw Error("Candidate mutated while grading");
  return { ...receipt, status: receipt.cases.every(item => item.status === "passed") ? "passed" : "failed", elapsedMs: Date.now() - started };
}
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    const [command, arg, candidate, metadata] = process.argv.slice(2);
    const result = command === "list" ? verify() : command === "prepare" ? prepare(arg, candidate ? JSON.parse(candidate) : {}) : command === "grade" ? grade(arg, candidate === "-" ? undefined : candidate, metadata ? JSON.parse(metadata) : {}) : (() => { throw Error("Usage: list | prepare FIXTURE [JSON metadata] | grade MANIFEST CANDIDATE|- [JSON metadata]"); })();
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    if (result.status === "failed") process.exitCode = 1;
    if (result.status === "unavailable") process.exitCode = 2;
  } catch (error) { process.stderr.write(JSON.stringify({ status: "failed", error: error.message }) + "\n"); process.exitCode = 1; }
}
