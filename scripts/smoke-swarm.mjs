/** Actual packaged inline/process workers over local HTTP; scripted model replies. */
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';

const exec = promisify(execFile);
const scratch = await mkdtemp(join(tmpdir(), 'hades-swarm-acceptance-'));
let calls = 0;
const server = createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw); calls++;
  const observed = body.messages.at(-1).content;
  const text = observed.includes('TOOL_RESULT:')
    ? 'ANSWER: The input is 17.'
    : 'TOOL: file_ops\nINPUT: {"op":"read","path":"input.txt"}';
  if (text.startsWith('ANSWER:')) assert.match(observed, /17/);
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ choices: [{ message: { content: text } }], usage: { prompt_tokens: 30, completion_tokens: 10 } }));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
try {
  await writeFile(join(scratch, 'input.txt'), '17');
  await symlink(resolve('dist-swarm'), join(scratch, 'dist-swarm'), 'dir');
  const binary = resolve('dist-swarm/cli.js');
  const env = { PATH: process.env.PATH, HADES_PROVIDER: 'local', HADES_MODEL: 'fixture-model', HADES_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`, HADES_DATA_DIR: join(scratch, 'state') };
  for (const mode of ['inline', 'process']) {
    const reservation = createServer();
    await new Promise((r) => reservation.listen(0, '127.0.0.1', r));
    const port = reservation.address().port;
    await new Promise((r) => reservation.close(r));
    const result = await exec(process.execPath, [binary, 'run', 'Read input.txt and report the number', '--mode', mode, '--workers', '1', '--control-port', String(port), '--json'], { env, cwd: scratch, timeout: 25000 });
    const goal = JSON.parse(result.stdout);
    assert.equal(goal.status, 'completed');
    assert.match(JSON.stringify(goal.synthesis), /17/);
  }
  const saved = JSON.parse(await readFile(join(scratch, 'state', 'swarm-state.json'), 'utf8'));
  assert.equal(saved.goals.length, 2, 'second CLI process must restore the first goal');
  for (const usage of Object.values(saved.usage)) {
    assert.equal(usage.providerUsage.tokensIn, 60);
    assert.equal(usage.providerUsage.tokensOut, 20);
    assert.equal(usage.providerUsage.costMeasured, false);
  }
  console.log(JSON.stringify({ packagedSwarm: 'passed', transport: 'local deterministic HTTP fixture', modes: ['inline', 'process'], restoredGoals: 2, providerTokensPreserved: true, modelCalls: calls }));
} finally {
  server.closeAllConnections(); await new Promise((r) => server.close(r));
  await rm(scratch, { recursive: true, force: true });
}
