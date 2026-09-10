import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The review never launches Orca, a provider, or a listener.
const processFixture = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: processFixture.spawn }));
import { HelmOrcaService, type HelmOrcaConnection } from '../core/helm-orca-service';
import { HelmOrcaRuntime } from '../core/helm-orca-runtime';

const directories: string[] = [];
const services: HelmOrcaService[] = [];
const runtimes: HelmOrcaRuntime[] = [];

beforeEach(() => {
  let pid = 900000;
  processFixture.spawn.mockReset().mockImplementation(() => {
    const child = new EventEmitter() as EventEmitter & { pid: number; kill: ReturnType<typeof vi.fn> };
    child.pid = ++pid;
    child.kill = vi.fn(() => true);
    return child;
  });
});

afterEach(async () => {
  services.splice(0).forEach(service => service.close());
  runtimes.splice(0).forEach(runtime => runtime.close());
  await Promise.resolve();
  await Promise.resolve();
  directories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true }));
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'helm-orca-review-'));
  directories.push(root);
  const scope = { root, profile: 'owner' };
  const directory = join(root, 'intents');
  const call = vi.fn<HelmOrcaConnection['call']>(async method => {
    if (method === 'orchestration.runCreate') return { run: { id: 'run-owned' } };
    if (method === 'orchestration.workerStop') return { state: 'stopped', dispatchId: 'dispatch-owned' };
    return { state: 'ready', dispatchId: 'dispatch-owned' };
  });
  const connection = { runtimeId: 'runtime-owned', coordinator: 'terminal-owned', repo: 'repo-owned', call };
  const connect = vi.fn(async () => connection);
  const service = new HelmOrcaService(directory, { connect });
  services.push(service);
  return { root, scope, directory, service, connect, call, input: { requestId: randomUUID(), prompt: 'Inspect fixture', agent: 'codex' as const } };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe('independent Orca adapter lifecycle review', () => {
  it('does not retain active worker capacity for an already-aborted start with zero external effects', async () => {
    const f = fixture(), controller = new AbortController();
    controller.abort();
    await f.service.start(f.scope, f.input, controller.signal).catch(() => undefined);
    expect(f.connect).not.toHaveBeenCalled();
    expect(f.call).not.toHaveBeenCalled();
    expect(f.service.hasActiveWork()).toBe(false);
  });

  it('does not retain active capacity after deterministic artifact rejection before spawn', async () => {
    const f = fixture(), artifact = join(f.root, 'artifact');
    mkdirSync(artifact);
    writeFileSync(join(artifact, 'helm-orca-build.json'), JSON.stringify({
      sourceRevision: 'bf4e2705046cf9ef9c915929a9646da85717af07', files: [],
    }));
    const runtime = new HelmOrcaRuntime(join(f.root, 'runtime'), artifact);
    runtimes.push(runtime);
    const service = new HelmOrcaService(join(f.root, 'preflight-intents'), {
      connect: (scope, signal) => runtime.connect(scope, signal),
    });
    services.push(service);
    await service.start(f.scope, f.input).catch(() => undefined);
    expect(processFixture.spawn).not.toHaveBeenCalled();
    expect(service.hasActiveWork()).toBe(false);
  });

  it('finishes an already-requested scoped stop when local startup returns its late dispatch identity', async () => {
    const f = fixture(), entered = deferred<void>(), startup = deferred<any>();
    f.call.mockImplementation(async method => {
      if (method === 'orchestration.runCreate') return { run: { id: 'run-owned' } };
      if (method === 'orchestration.workerStart') { entered.resolve(); return startup.promise; }
      if (method === 'orchestration.workerStop') return { state: 'stopped', dispatchId: 'dispatch-owned' };
      throw new Error('Unexpected fixture RPC: ' + method);
    });
    const pending = f.service.start(f.scope, f.input);
    await entered.promise;
    const stopping = f.service.stop(f.scope, f.input.requestId);
    startup.resolve({ state: 'ready', dispatchId: 'dispatch-owned' });
    const stopped = await stopping;
    await pending;
    expect(f.call.mock.calls.filter(call => call[0] === 'orchestration.workerStop')).toHaveLength(1);
    expect(stopped).toMatchObject({ state: 'stopped', active: false, dispatchId: 'dispatch-owned' });
  });

  it('persists an in-flight stop receipt before closing the private intent database', async () => {
    const f = fixture();
    const record = await f.service.start(f.scope, f.input);
    const entered = deferred<void>(), stopReceipt = deferred<any>();
    f.call.mockImplementation(async method => {
      if (method !== 'orchestration.workerStop') throw new Error('Unexpected fixture RPC: ' + method);
      entered.resolve();
      return stopReceipt.promise;
    });
    const stopping = f.service.stop(f.scope, record.id).then(value => ({ value }), error => ({ error }));
    await entered.promise;
    f.service.close();
    await Promise.resolve();
    await Promise.resolve();
    stopReceipt.resolve({ state: 'stopped', dispatchId: record.dispatchId });
    const settled = await stopping;
    expect(settled).toMatchObject({ value: { state: 'stopped', active: false } });
    const reopened = new HelmOrcaService(f.directory, { connect: f.connect });
    services.push(reopened);
    expect(reopened.get(f.scope, record.id)).toMatchObject({ state: 'stopped', active: false });
  });

  it('admits at most one runtime launch across managers before metadata is published', async () => {
    const f = fixture(), artifact = join(f.root, 'artifact'), directory = join(f.root, 'runtime');
    mkdirSync(artifact);
    const files = ['orcad.js', 'daemon-entry.js', 'parcel-watcher-process-entry.js'].map(path => {
      const content = '// inert review fixture; spawn is mocked\n';
      writeFileSync(join(artifact, path), content);
      return { path, sha256: createHash('sha256').update(content).digest('hex') };
    });
    writeFileSync(join(artifact, 'helm-orca-build.json'), JSON.stringify({
      sourceRevision: 'bf4e2705046cf9ef9c915929a9646da85717af07', files,
    }));
    const first = new HelmOrcaRuntime(directory, artifact), second = new HelmOrcaRuntime(directory, artifact);
    runtimes.push(first, second);
    const firstSignal = new AbortController(), secondSignal = new AbortController();
    const pending = Promise.allSettled([
      first.connect(f.scope, firstSignal.signal), second.connect(f.scope, secondSignal.signal),
    ]);
    firstSignal.abort();
    secondSignal.abort();
    await pending;
    expect(processFixture.spawn).toHaveBeenCalledTimes(1);
  });
});
