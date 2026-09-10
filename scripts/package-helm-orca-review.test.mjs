import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, writeFileSync, readFileSync, rmSync, mkdirSync, symlinkSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stageOrcaPackage } from './package-helm-orca.mjs';
import { HelmOrcaRuntime } from '../src/desktop/core/helm-orca-runtime.ts';

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'hades-package-review-')));
  const source = join(root, 'artifact');
  mkdirSync(join(source, 'native'), { recursive: true });
  const files = ['orcad.js', 'daemon-entry.js', 'parcel-watcher-process-entry.js', 'native/fixture.node'].map(path => {
    const bytes = Buffer.from('inert package fixture: ' + path);
    writeFileSync(join(source, path), bytes, { mode: path.endsWith('.node') ? 0o755 : 0o644 });
    return { path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  });
  writeFileSync(join(source, 'helm-orca-build.json'), JSON.stringify({ sourceRevision: 'bf4e2705046cf9ef9c915929a9646da85717af07', platform: process.platform, arch: process.arch, files }));
  return { root, source, close: () => rmSync(root, { recursive: true, force: true }) };
}

test('staged Resources/helm-orca is consumed by the actual Hades artifact validator without a checkout override', () => {
  const f = fixture();
  try {
    const artifacts = join(f.root, 'Hades.app', 'Contents', 'Resources', 'helm-orca');
    const staged = stageOrcaPackage(f.source, artifacts);
    const runtime = new HelmOrcaRuntime(join(f.root, 'owned-runtime-state'), artifacts);
    try {
      assert.deepEqual(runtime.validateArtifacts(), staged);
      assert.equal(statSync(join(artifacts, 'native/fixture.node')).mode & 0o777, 0o755);
    } finally { runtime.close(); }
  } finally { f.close(); }
});

test('native bytes changed after staging are rejected by the real consumer, without rewriting provenance', () => {
  const f = fixture();
  try {
    const artifacts = join(f.root, 'Resources', 'helm-orca');
    stageOrcaPackage(f.source, artifacts);
    const manifest = readFileSync(join(artifacts, 'helm-orca-build.json'));
    writeFileSync(join(artifacts, 'native/fixture.node'), 'different bytes after signing');
    const runtime = new HelmOrcaRuntime(join(f.root, 'owned-runtime-state'), artifacts);
    try { assert.throws(() => runtime.validateArtifacts(), /hash mismatch/); }
    finally { runtime.close(); }
    assert.deepEqual(readFileSync(join(artifacts, 'helm-orca-build.json')), manifest);
  } finally { f.close(); }
});

test('an interior directory symlink cannot package external native code or destroy a prior tree', () => {
  const f = fixture();
  try {
    const external = join(f.root, 'external');
    mkdirSync(external);
    writeFileSync(join(external, 'fixture.node'), 'outside');
    rmSync(join(f.source, 'native'), { recursive: true });
    symlinkSync(external, join(f.source, 'native'), 'dir');
    const prior = join(f.root, 'Resources', 'helm-orca');
    mkdirSync(prior, { recursive: true });
    writeFileSync(join(prior, 'retained'), 'prior build');
    assert.throws(() => stageOrcaPackage(f.source, prior), /symlink/);
    assert.equal(readFileSync(join(prior, 'retained'), 'utf8'), 'prior build');
    assert.equal(readFileSync(join(external, 'fixture.node'), 'utf8'), 'outside');
  } finally { f.close(); }
});
