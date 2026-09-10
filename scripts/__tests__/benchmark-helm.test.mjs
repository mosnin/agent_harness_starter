import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, cpSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { verify, prepare, grade } from "../benchmark-helm.mjs";
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const base = join(repo, "benchmarks/helm-enterprise");
test("frozen 24-case inventory maps three trials to actual named Hades tests", () => {
  const catalog = verify();
  assert.equal(catalog.coding.length, 8); assert.equal(catalog.scenarios.length, 16);
  for (const item of [...catalog.coding, ...catalog.scenarios]) assert.equal(item.trials, 3);
  for (const item of catalog.scenarios) {
    assert.ok(existsSync(join(repo, item.source)));
    assert.ok(readFileSync(join(repo, item.testFile), "utf8").includes(item.testName));
    assert.equal(item.defaultStatus, "unavailable");
  }
});
for (const fixture of verify().coding) {
  test(fixture.id + ": original fails, reference passes only as synthetic calibration", () => {
    const prepared = prepare(fixture.id, { trial: 2 });
    try {
      assert.equal(existsSync(join(prepared.workspace, "oracle.json")), false);
      assert.equal(grade(prepared.manifest).status, "unavailable");
      assert.equal(grade(prepared.manifest, prepared.workspace).status, "failed");
      for (const name of fixture.allowedChanges) cpSync(join(base, fixture.directory, "reference", name), join(prepared.workspace, name));
      const passed = grade(prepared.manifest, prepared.workspace);
      assert.equal(passed.status, "passed", JSON.stringify(passed));
      assert.equal(passed.productWin, false);
      assert.equal(passed.classification, "synthetic-oracle-calibration");
      assert.equal(passed.usage, null); assert.equal(passed.interventions, null); assert.equal(passed.trial, 2);
    } finally { rmSync(prepared.directory, { recursive: true, force: true }); }
  });
}
test("extra files and premature process exit cannot produce a pass", () => {
  const prepared = prepare("money-allocation");
  try {
    writeFileSync(join(prepared.workspace, "extra.txt"), "unrelated");
    assert.match(grade(prepared.manifest, prepared.workspace).reason, /Unrelated/);
    rmSync(join(prepared.workspace, "extra.txt"));
    writeFileSync(join(prepared.workspace, "index.mjs"), "process.exit(0)");
    assert.equal(grade(prepared.manifest, prepared.workspace).status, "failed");
  } finally { rmSync(prepared.directory, { recursive: true, force: true }); }
});
test("copied corpus tampering fails without changing original corpus", () => {
  const temp = mkdtempSync(join(tmpdir(), "helm-integrity-test-"));
  try {
    cpSync(base, join(temp, "benchmarks/helm-enterprise"), { recursive: true });
    mkdirSync(join(temp, "scripts"));
    cpSync(join(repo, "scripts/benchmark-helm.mjs"), join(temp, "scripts/benchmark-helm.mjs"));
    writeFileSync(join(temp, "benchmarks/helm-enterprise/coding/money-allocation/oracle.json"), "[]");
    const run = spawnSync(process.execPath, [join(temp, "scripts/benchmark-helm.mjs"), "list"], { encoding: "utf8" });
    assert.equal(run.status, 1); assert.match(run.stderr, /integrity failure/);
    assert.ok(verify());
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
