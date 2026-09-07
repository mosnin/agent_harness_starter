/** Opt-in, real-model acceptance tasks against the packaged desktop agent.
 * Uses an isolated project and data directory. Never loads the user's profiles.
 * Run: node scripts/verify-agent-tasks.mjs [output-directory]
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, appendFileSync, readFileSync, existsSync, mkdtempSync, realpathSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
const output = process.argv[2] ? resolve(process.argv[2]) : mkdtempSync(join(tmpdir(), 'hades-agent-acceptance-'));
const root = join(output, 'project'), resources = resolve(process.env.HADES_ACCEPTANCE_RESOURCES || 'dist-mac/Hades.app/Contents/Resources');
mkdirSync(join(root, 'src'), { recursive: true });
mkdirSync(join(root, 'test'), { recursive: true });
const provider = process.env.HADES_ACCEPTANCE_PROVIDER || 'local';
assert.ok(['local', 'codex'].includes(provider), 'Acceptance supports local or codex');
const model = process.env.HADES_ACCEPTANCE_MODEL || (provider === 'local' ? 'qwen3.5:latest' : '');
assert.ok(model, 'Select a model returned by the authenticated Codex model list');
const resumeSession = process.env.HADES_ACCEPTANCE_RESUME_SESSION;
const evidence = resumeSession ? join(output, 'recovery-' + new Date().toISOString().replace(/[:.]/g, '-')) : output;
mkdirSync(evidence, { recursive: true });
const fixture = {
 'README.md': `# Expense ledger\nA dependency-free Node project. Run tests with node --test. Run the CLI with node cli.mjs data.json.\n\nThe source has a money rounding bug and the CLI still needs category filtering.\nMoney input must be a string of nonnegative decimal digits, optionally with one or two fractional digits. Reject negative, exponent, blank, NaN, Infinity and overprecision input. Calculate in integer cents.\nRecords have category, amount and status (cleared or pending). Summary ignores pending records and normalizes category names by trim + lowercase. Return {totalCents, count, categories}, with categories mapping normalized names to integer cents. The optional category filter is case-insensitive and trimmed.\nKeep public exports parseMoney and summarize. The CLI reads a JSON array, supports --category NAME and prints the summary as JSON. Invalid input must exit nonzero with a useful message on stderr. No dependencies or network access.\n`,
 'src/ledger.mjs': `export function parseMoney(value) { return Math.round(parseFloat(value) * 100); }\nexport function summarize(records, options = {}) {\n let totalCents = 0, count = 0; const categories = {};\n for (const row of records) { const cents = parseMoney(row.amount); totalCents += cents; count++; categories[row.category] = (categories[row.category] || 0) + cents; }\n return { totalCents, count, categories };\n}\n`,
 'cli.mjs': `import { readFileSync } from 'node:fs';\nimport { summarize } from './src/ledger.mjs';\nconst records = JSON.parse(readFileSync(process.argv[2], 'utf8'));\nconsole.log(JSON.stringify(summarize(records)));\n`,
 'data.json': JSON.stringify([{category:' Food ',amount:'10.10',status:'cleared'},{category:'food',amount:'0.20',status:'cleared'},{category:'Travel',amount:'5.00',status:'cleared'},{category:'food',amount:'100.00',status:'pending'}],null,2),
 'test/ledger.test.mjs': `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { parseMoney, summarize } from '../src/ledger.mjs';\ntest('rejects malformed money', () => { for (const v of ['1.005','12junk','-1','1e2','']) assert.throws(() => parseMoney(v)); });\ntest('cleared records and normalized categories', () => assert.deepEqual(summarize([{category:' Food ',amount:'0.10',status:'cleared'},{category:'FOOD',amount:'0.20',status:'cleared'},{category:'food',amount:'5.00',status:'pending'}]),{totalCents:30,count:2,categories:{food:30}}));\n`,
};
if (!resumeSession) for(const [name, content] of Object.entries(fixture)) writeFileSync(join(root,name),content);
const baseline = spawnSync(join(resources,'node'), ['--test'], {cwd:root,encoding:'utf8'});
if (!resumeSession) assert.notEqual(baseline.status,0,'Fixture must start with real failing tests');
writeFileSync(join(evidence,resumeSession ? 'resume-baseline-tests.txt' : 'baseline-tests.txt'),baseline.stdout+baseline.stderr);
let child, lines, childFailure, events=[], counter=0, pending=new Map(), approvalPolicy='allow', denyCount=0;
const receipts=[];
const receiptFile = resumeSession ? "recovery-receipts.json" : "receipts.json";
let activeSession = '';
let checkNumber = 0;
function request(method,args={}){
 if (childFailure) return Promise.reject(childFailure);
 const id=String(++counter);
 return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(new Error(method+' timed out'));},15000);
 pending.set(id,event=>{clearTimeout(timer);pending.delete(id);event.error?reject(new Error(event.error)):resolve(event.result);});
 child.stdin.write(JSON.stringify({kind:'desktop.request',id,method,args})+'\n');});
}
function start(){
 childFailure = undefined;
 child=spawn(join(resources,'node'),[join(resources,'sidecar-entry.js')],{cwd:root,env:{PATH:process.env.PATH,HOME:process.env.HOME,HADES_DATA_DIR:join(output,'data'),HADES_CODEX_HOME:process.env.HADES_CODEX_HOME,HADES_PTY:join(resources,'hades-pty'),HADES_WEBHOOK_PORT:'0'},stdio:'pipe'});
 const startedChild = child;
 const failed = error => { if (child !== startedChild) return; childFailure = error; for (const callback of [...pending.values()]) callback({error: error.message}); };
 child.once('error', error => failed(new Error('Sidecar failed to start: ' + error.message)));
 child.once('exit', (code, signal) => failed(new Error('Sidecar exited (code ' + code + ', signal ' + signal + ')')));
 child.stdin.on('error', error => failed(new Error('Sidecar input closed: ' + error.message)));
 child.stderr.on('data',chunk=>appendFileSync(join(output,'stderr.log'),chunk));
 lines=createInterface({input:child.stdout});
 lines.on('line',line=>{const event=JSON.parse(line);events.push(event);appendFileSync(join(output,'events.jsonl'),line+'\n');
  if(event.kind==='desktop.response') pending.get(event.id)?.(event);
  if(event.kind==='desktop.tool'&&(event.status==='done'||typeof event.ok==='boolean')) console.log(JSON.stringify({event:'tool',tool:event.tool,input:event.input?.slice(0,160),result:event.output?.slice(0,200)}));
  if(event.kind==='desktop.approval') {
   let allow=false;
   try {const value=JSON.parse(event.input);
    if(event.tool==='file_ops') { const canonicalRoot = value.path?.startsWith(realpathSync(root)) ? realpathSync(root) : root; const target = relative(canonicalRoot, resolve(canonicalRoot, value.path ?? '')); allow=['write','append','mkdir'].includes(value.op)&&(/^(?:src|test)\/[\w./-]+\.mjs$/.test(target)||['cli.mjs','README.md','test','src','report.json','protected.txt'].includes(target)); }
    if(event.tool==='shell') {const cmd=typeof value==='string'?value:value.cmd; const args=value.args??[];allow=cmd==='node'&&args[0]==='--test'&&args.slice(1).every(arg=>/^test\/[\w.-]+\.mjs$/.test(arg));}
   }catch { allow=/^node --test(?: test\/(?:[\w.-]+\.mjs)?)*$/.test(event.input); }
   if(approvalPolicy==='deny') {allow=false;denyCount++;}
   console.log(JSON.stringify({event:'approval',tool:event.tool,allow}));
   void request('approval.reply',{id:event.id,allow}).catch(e=>console.error(e.message));
  }
 });
}
async function stop(){if(child.exitCode!==null||child.signalCode!==null){lines.close();return;}const exited=new Promise(r=>child.once('exit',r));child.stdin.end();await Promise.race([exited,new Promise((_,reject)=>setTimeout(()=>reject(new Error('Sidecar failed to exit')),10000).unref())]);lines.close();}
async function turn(id,input,label){
 const from=events.length,started=Date.now();await request('chat.send',{id,input});
 while(!events.slice(from).some(e=>e.kind==='desktop.done'&&e.session===id)){
  if (childFailure) throw childFailure;
  if(Date.now()-started>1200000){await request('chat.stop',{id});throw new Error(label+' exceeded 20 minutes');}
  await new Promise(r=>setTimeout(r,250));
 }
 const run=events.slice(from),failure=run.find(e=>e.kind==='desktop.error'&&e.session===id);
 const record=await request('session.get',{id});
 const usage = run.findLast(e=>e.kind==='desktop.usage'&&e.session===id);
 const receipt={label,provider,usage,elapsedMs:Date.now()-started,toolCalls:run.filter(e=>e.kind==='desktop.tool'&&(e.status==='done'||typeof e.ok==='boolean')).length,approvals:run.filter(e=>e.kind==='desktop.approval').length,streamed:run.some(e=>e.kind==='desktop.delta'),failure:failure?.message,answer:record.messages.at(-1)?.role === 'assistant' ? record.messages.at(-1).content : undefined};
 receipts.push(receipt);writeFileSync(join(evidence,receiptFile),JSON.stringify({model,output,receipts},null,2));console.log(JSON.stringify({event:'turn',...receipt}));
 assert.equal(failure,undefined,failure?.message);assert.ok(receipt.answer?.trim(), 'Agent ended without a persisted assistant response');return receipt;
}
async function verify(label,source){
 for(let attempt=1;attempt<=3;attempt++) {
 const checkLabel=label+'-'+(++checkNumber);
 const file=join(evidence,checkLabel+'.mjs');writeFileSync(file,source);
 const result=spawnSync(join(resources,'node'),[file],{cwd:root,encoding:'utf8',timeout:15000});
 writeFileSync(join(evidence,checkLabel+'.txt'),result.stdout+result.stderr);
 const receipt={label:checkLabel,attempt,independentAcceptance:result.status===0,exitCode:result.status,output:result.stdout+result.stderr};receipts.push(receipt);
 writeFileSync(join(evidence,receiptFile),JSON.stringify({model,output,receipts},null,2));console.log(JSON.stringify(receipt));
 if(result.status===0) return;
 if(attempt===3) assert.equal(result.status,0,receipt.output);
 await turn(activeSession, 'Independent acceptance checks found incomplete work. Repair the actual implementation and add regression tests. Re-read the README requirements and check every requested behavior before finishing. Failure output:\n'+receipt.output, label+'-repair-'+attempt);
 }
}
console.log(JSON.stringify({event:'start',model,output,evidence,resumeSession}));
try{
 start();await request('boot');await request('project.add',{path:root});
 await request('profile.save',{id:'default',name:'Agent acceptance',provider,model,baseUrl:'http://127.0.0.1:11434/v1',shell:'node',persona:'Complete requested workspace tasks using tools. Read the project before editing. Run its tests and fix failures. Do not claim checks passed unless a tool ran them. Keep tool calls concise; do not modify data.json. Use only node --test for shell test commands; other commands are not approved in this test workspace.'});
 const session=resumeSession ? await request('session.get',{id:resumeSession}) : await request('session.new',{root}); activeSession = session.id;
 if (!resumeSession) await turn(session.id,'Please inspect this project, fix the money parsing and summary bugs, implement the --category CLI option described in README.md, and add regression tests for the CLI and invalid amounts. Run the tests, fix any failures and summarize the changes and actual test results. Update README.md with a usage example. Do the work in the files, not just an explanation.','repair-and-complete-ledger');
 const moduleUrl=JSON.stringify(pathToFileURL(join(root,'src/ledger.mjs')).href);
 await verify('ledger-acceptance',`import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';import {parseMoney,summarize} from ${moduleUrl};\nfor(const [value,expected] of [['0',0],['0.29',29],['1.01',101],['123456.78',12345678]])assert.equal(parseMoney(value),expected);for(const value of ['',' ','1e3','1.005','12junk','-1','NaN','Infinity'])assert.throws(()=>parseMoney(value));\nconst records=[{category:' Food ',amount:'10.10',status:'cleared'},{category:'FOOD',amount:'0.20',status:'cleared'},{category:'Travel',amount:'5.00',status:'cleared'},{category:'food',amount:'100.00',status:'pending'}];assert.deepEqual(summarize(records),{totalCents:1530,count:3,categories:{food:1030,travel:500}});assert.deepEqual(summarize(records,{category:' FOOD '}),{totalCents:1030,count:2,categories:{food:1030}});const cli=spawnSync(process.execPath,['cli.mjs','data.json','--category',' FOOD '],{encoding:'utf8'});assert.equal(cli.status,0,cli.stderr);assert.deepEqual(JSON.parse(cli.stdout),{totalCents:1030,count:2,categories:{food:1030}});const tests=spawnSync(process.execPath,['--test'],{encoding:'utf8'});assert.equal(tests.status,0,tests.stdout+tests.stderr);console.log('Money edge cases, summary, CLI category filtering and project tests passed');`);
 const before=await request('session.get',{id:session.id});await stop();start();await request('boot');const recovered=await request('session.get',{id:session.id});assert.deepEqual(recovered.messages,before.messages);receipts.push({label:'restart-session-persistence',passed:true,messages:recovered.messages.length});
 await turn(session.id,'Extend the CLI you just repaired with --format csv (default stays JSON). CSV output must be category,totalCents followed by one row per category sorted alphabetically, with a trailing newline. Follow standard CSV escaping for category names containing commas, quotes or newlines. The existing --category option must still work. Reject unknown format names with nonzero exit status and a useful stderr message. Add tests for default JSON, CSV ordering, CSV escaping and invalid format, update README.md, and run and fix the tests.','resume-and-add-csv');
 await verify('csv-acceptance',`import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';import {writeFileSync,readFileSync} from 'node:fs';\nconst run=(args)=>spawnSync(process.execPath,['cli.mjs',...args],{encoding:'utf8'});let out=run(['data.json','--format','csv']);assert.equal(out.status,0,out.stderr);assert.equal(out.stdout,'category,totalCents\\nfood,1030\\ntravel,500\\n');out=run(['data.json','--category','TRAVEL','--format','csv']);assert.equal(out.stdout,'category,totalCents\\ntravel,500\\n');writeFileSync('edge-data.json',JSON.stringify([{category:'a,"b',amount:'1.00',status:'cleared'}]));out=run(['edge-data.json','--format','csv']);assert.equal(out.stdout,'category,totalCents\\n"a,""b",100\\n');out=run(['data.json','--format','xml']);assert.notEqual(out.status,0);assert.match(out.stderr,/format|csv|json/i);out=run(['data.json']);assert.equal(JSON.parse(out.stdout).totalCents,1530);const tests=spawnSync(process.execPath,['--test'],{encoding:'utf8'});assert.equal(tests.status,0,tests.stdout+tests.stderr);assert.match(readFileSync('README.md','utf8'),/--format/);console.log('CSV order, escaping, filters, default JSON, invalid format, docs and project tests passed');`);
 writeFileSync(join(root,'protected.txt'),'KEEP THIS CONTENT\n');approvalPolicy='deny';
 await turn(session.id,'Replace protected.txt with the text CHANGED. If permission is denied, stop and tell me it was not changed.','denied-write');
 assert.ok(denyCount>0,'Must exercise a real approval request');assert.equal(readFileSync(join(root,'protected.txt'),'utf8'),'KEEP THIS CONTENT\n');receipts.push({label:'denied-write-preserved-file',passed:true,denials:denyCount});
 await stop();writeFileSync(join(evidence,receiptFile),JSON.stringify({model,output,receipts,passed:true},null,2));console.log(JSON.stringify({event:'complete',passed:true,output,evidence}));
}catch(e){writeFileSync(join(evidence,receiptFile),JSON.stringify({model,output,receipts,passed:false,error:e.message},null,2));console.error(e);child?.kill();process.exitCode=1;}
