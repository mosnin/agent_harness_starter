/** Packaged CLI acceptance test. Real HTTP + disk + separate CLI processes;
 * model replies are deterministic fixtures, never a live-provider claim. */
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
const exec = promisify(execFile);
const scratch = await mkdtemp(join(tmpdir(), 'hades-cli-acceptance-'));
let calls = 0;
const server = createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  let text;
  if (calls++ === 0) text = 'TOOL: file_ops\nINPUT: {"op":"read","path":"input.txt"}';
  else if (calls === 2) {
    assert.match(body.messages.at(-1).content, /17/);
    text = 'TOOL: file_ops\nINPUT: {"op":"write","path":"answer.txt","content":"34"}';
  } else if (calls === 3) text = 'ANSWER: Saved 34 to answer.txt.';
  else {
    assert(body.messages.some((m) => m.role === 'assistant' && m.content.includes('Saved 34 to answer.txt.')));
    text = 'ANSWER: answer.txt';
  }
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ choices: [{ message: { content: text } }], usage: { prompt_tokens: 30, completion_tokens: 10 } }));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
try {
  await writeFile(join(scratch, 'input.txt'), '17');
  const binary = resolve('dist-hades/hades.js');
  const env = { PATH: process.env.PATH, HADES_PROVIDER: 'local', HADES_MODEL: 'fixture-model', HADES_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`, HADES_DATA_DIR: join(scratch, 'state') };
  const common = [binary, 'chat', '--root', scratch];
  const first = await exec(process.execPath, [...common, '--once', 'Double input.txt into answer.txt'], { env, timeout: 20000 });
  assert.match(first.stdout, /Saved 34/);
  assert.equal(await readFile(join(scratch, 'answer.txt'), 'utf8'), '34');
  assert.match(first.stderr, /cost unmeasured/);
  const id = first.stderr.match(/session ([a-f0-9-]+)/)[1];
  const second = await exec(process.execPath, [...common, '--session', id, '--once', 'Which file did you save?'], { env, timeout: 20000 });
  assert.match(second.stdout, /answer.txt/);
  const missing = await exec(process.execPath, [binary, 'chat', '--once', 'hello'], { env: { PATH: process.env.PATH, HADES_DATA_DIR: join(scratch, 'empty') }, timeout: 20000 }).then(() => false, (e) => e.code === 1 && /OPENAI_API_KEY/.test(e.stderr));
  assert.equal(missing, true);
  console.log(JSON.stringify({ packagedCli: 'passed', transport: 'local deterministic HTTP fixture', realFileEdit: true, resumedInNewProcess: true, missingCredentialsFail: true, modelCalls: calls }));
} finally {
  server.closeAllConnections(); await new Promise((r) => server.close(r));
  await rm(scratch, { recursive: true, force: true });
}
