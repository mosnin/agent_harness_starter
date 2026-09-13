/** Opt-in real MCP smoke test. Pass a locally installed context-mode cli.bundle.mjs. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { connectMcp } from '../src/desktop/core/mcp-stdio';

async function main() {
  assert.ok(process.argv[2], 'Usage: npx tsx scripts/check-context-mode.ts /path/to/context-mode/cli.bundle.mjs');
  const entry = resolve(process.argv[2]);
  const pkg = JSON.parse(await readFile(join(dirname(entry), 'package.json'), 'utf8'));
  assert.equal(pkg.name, 'context-mode');
  assert.equal(pkg.version, '1.0.169', 'This acceptance test pins context-mode 1.0.169');
  const root = await mkdtemp(join(tmpdir(), 'hades-context-mode-'));
  const aRoot = join(root, 'project-a'), bRoot = join(root, 'project-b');
  await Promise.all([mkdir(aRoot), mkdir(bRoot)]);
  const wrapper = join(root, 'server.mjs');
  await writeFile(wrapper, `process.env.CONTEXT_MODE_DATA_DIR=${JSON.stringify(join(root, 'data'))};\nawait import(${JSON.stringify(pathToFileURL(entry).href)});\n`);
  const server = { name: 'context-mode', command: process.execPath, args: [wrapper], enabled: true };
  const connect = (cwd: string) => connectMcp(server, cwd, new AbortController().signal);
  type Connection = Awaited<ReturnType<typeof connect>>;
  const call = async (connection: Connection, name: string, args: unknown) => {
    const tool = connection.tools.find(t => t.name.endsWith('_' + name));
    assert.ok(tool, `Missing ${name}`);
    const result = await tool.run(JSON.stringify(args));
    assert.equal(result.ok, true, result.output);
    return result.output;
  };
  const evidence: Record<string, unknown> = { package: `${pkg.name}@${pkg.version}`, node: process.version };
  const a = await connect(aRoot);
  let b: Connection | undefined;
  try {
    b = await connect(bRoot);
    evidence.toolCount = a.tools.length;
    evidence.indexA = await call(a, 'ctx_index', { source: 'hades-qa', content: '# Hades garden\nThe orchid belongs to alpha.' });
    evidence.indexB = await call(b, 'ctx_index', { source: 'hades-qa', content: '# Hades garden\nThe maple belongs to beta.' });
    const searchA = await call(a, 'ctx_search', { queries: ['Hades garden'], source: 'hades-qa' });
    const searchB = await call(b, 'ctx_search', { queries: ['Hades garden'], source: 'hades-qa' });
    assert.match(searchA, /orchid belongs to alpha/); assert.doesNotMatch(searchA, /maple belongs to beta/);
    assert.match(searchB, /maple belongs to beta/); assert.doesNotMatch(searchB, /orchid belongs to alpha/);
    Object.assign(evidence, { searchA, searchB });
  } finally { a.close(); b?.close(); }
  const restored = await connect(aRoot);
  try {
    const result = await call(restored, 'ctx_search', { queries: ['Hades garden'], source: 'hades-qa', sort: 'timeline' });
    assert.match(result, /orchid belongs to alpha/); assert.doesNotMatch(result, /maple belongs to beta/);
    evidence.restored = result;
  } finally { restored.close(); }
  await writeFile(join(root, 'evidence.json'), JSON.stringify(evidence, null, 2));
  console.log(`PASS: indexing, retrieval, default project separation, restart retrieval. Evidence: ${root}/evidence.json`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
