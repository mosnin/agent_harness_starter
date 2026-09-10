import test from 'node:test';
import assert from 'node:assert/strict';
import { realpathSync, mkdtempSync, mkdirSync, writeFileSync, symlinkSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const helper = resolve('script/build-output.sh');
function fixture(t) {
 const root = realpathSync(mkdtempSync(join(tmpdir(), 'hades output test ')));
 t.after(() => rmSync(root, {recursive:true, force:true}));
 return {root, run(output) {
  const env = {...process.env}; delete env.HADES_APP_OUTPUT;
  if (output !== undefined) env.HADES_APP_OUTPUT=output;
  return spawnSync('/bin/bash', ['-c', 'set -eu; source "$1"; hades_select_build_output "$2"', 'test', helper, root], {env,encoding:'utf8'});
 }};
}
test('default candidates are unique and leave old app untouched', t=>{
 const f=fixture(t); const old=join(f.root,'dist-mac/Hades.app'); mkdirSync(old,{recursive:true});
 writeFileSync(join(old,'sentinel'),'preserved');
 const a=f.run(), b=f.run(); assert.equal(a.status,0,a.stderr); assert.equal(b.status,0,b.stderr);
 assert.notEqual(a.stdout,b.stdout); assert.ok(a.stdout.trim().startsWith(join(f.root,'dist-mac/candidates/candidate.')));
 assert.ok(existsSync(join(old,'sentinel')));
});
test('explicit fresh path with spaces is retained', t=>{
 const f=fixture(t), dest=join(f.root,'fresh destination/Hades.app');
 const r=f.run(dest); assert.equal(r.status,0,r.stderr); assert.equal(r.stdout.trim(),dest); assert.ok(!existsSync(dest));
});
for(const kind of ['directory','file','dangling link','empty','newline']) test(`reject ${kind} output`,t=>{
 const f=fixture(t); let dest=join(f.root,'existing');
 if(kind==='directory') mkdirSync(dest);
 if(kind==='file') writeFileSync(dest,'preserved');
 if(kind==='dangling link') symlinkSync(join(f.root,'missing'),dest);
 if(kind==='empty') dest='';
 if(kind==='newline') dest=join(f.root,'wrong\nHades.app');
 const r=f.run(dest); assert.notEqual(r.status,0); assert.equal(r.stdout,'');
});
for(const alias of [false,true]) test(`reject existing app ancestor, alias=${alias}`,t=>{
 const f=fixture(t), app=join(f.root,'Installed.app'); mkdirSync(app);
 let base=app; if(alias){base=join(f.root,'alias');symlinkSync(app,base);}
 assert.notEqual(f.run(join(base,'new/Hades.app')).status,0); assert.ok(!existsSync(join(app,'new')));
});
test('default path cannot create candidates inside an app through a symlink',t=>{
 const f=fixture(t), app=join(f.root,'Installed.app'); mkdirSync(app); mkdirSync(join(f.root,'dist-mac'));
 symlinkSync(app,join(f.root,'dist-mac/candidates'));
 assert.notEqual(f.run().status,0);
});
