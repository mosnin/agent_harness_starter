import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,chmodSync,rmSync,realpathSync,existsSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync,spawn} from 'node:child_process';
// Executes actual shell control flow in a disposable repository. Compiler,
// signing, process-control and archive commands are inert trace fixtures.
function fixture(t) {
 const root=realpathSync(mkdtempSync(join(tmpdir(),'hades build flow ')));
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 const put=(p,s='fixture')=>{mkdirSync(dirname(join(root,p)),{recursive:true});writeFileSync(join(root,p),s);};
 const bin=join(root,'fakebin');mkdirSync(bin);
 for(const name of ['build-output.sh','build_and_run.sh','package_mac.sh','release_mac.sh']) {
  let source=readFileSync(resolve('script',name),'utf8');
  source=source.replaceAll('/usr/bin/open',`"${bin}/open"`).replaceAll('/usr/bin/log',`"${bin}/log"`);
  put('script/'+name,source);chmodSync(join(root,'script',name),0o755);
 }
 put('fake-cli.mjs', `import fs from 'node:fs';import path from 'node:path';
const [name,...args]=process.argv.slice(2);fs.appendFileSync(process.env.FLOW_TRACE,JSON.stringify({name,args})+'\\n');
const put=(p,s='fixture')=>{fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,s)};
if(name==='uname')console.log(args[0]==='-s'?'Darwin':'arm64');
if(name==='npm'&&process.env.FLOW_FAIL==='npm')process.exit(9);
if(name==='pgrep'||name==='kill'||name==='open'||name==='log')process.exit(88);
if(name==='node'&&args[0]==='scripts/package-codex-runtime.mjs')put(path.join(args[1],'codex'));
if(name==='node'&&args[0]==='scripts/package-helm-orca.mjs'&&args[1]==='--stage')put(path.join(args[3],'fixture'));
if(name==='git'&&args[0]==='rev-parse')console.log('a'.repeat(40));
if(name==='security')console.log('Developer ID Application: Fixture');
if(name==='xcrun'&&args[0]==='notarytool')console.log(JSON.stringify({status:'Accepted'}));
if(name==='ditto'){const src=args.at(-2);if(!fs.existsSync(src))process.exit(7);put(args.at(-1),JSON.stringify({src}));}
if(name==='hdiutil'){const src=args[args.indexOf('-srcfolder')+1];if(!fs.existsSync(src))process.exit(7);put(args.at(-1),JSON.stringify({src}));}
`);
 const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
 for(const name of ['uname','node','npm','xcrun','cc','cargo','codesign','pgrep','kill','open','log','ditto','hdiutil','security','spctl','git','swift','iconutil']) {
  put('fakebin/'+name,`#!/bin/bash\nexec ${quote(process.execPath)} ${quote(join(root,'fake-cli.mjs'))} ${quote(name)} "$@"\n`);chmodSync(join(bin,name),0o755);
 }
 put('bash-env',`kill() { "${bin}/kill" "$@"; }\n`);
 for(const p of ['dist/helm-ui/index.html','dist/runtime/helm-opencode','dist/runtime/hades-pty','dist/runtime/hades-computer','dist/desktop/sidecar-entry.js','dist/desktop/team-server.js','dist-hades/hades.js','src-tauri/target/debug/hades-desktop','src-tauri/icons/icon.icns','src-tauri/runtime-package.json','third_party/company-os/bundle.json','third_party/company-os/manifest.json'])put(p);
 put('dist-mac/Hades.app/sentinel','original');
 return {root,run(script='build_and_run.sh',args=['--build-only'],overrides={}) {
  const env={...process.env,PATH:bin+':/usr/bin:/bin',BASH_ENV:join(root,'bash-env'),FLOW_TRACE:join(root,'trace'),HADES_SIGN_IDENTITY:'',HADES_MAUS_SOURCE_APP:join(root,'absent')};
  delete env.HADES_APP_OUTPUT;delete env.FLOW_FAIL;
  return spawnSync('/bin/bash',[join(root,'script',script),...args],{cwd:root,env:{...env,...overrides},encoding:'utf8',timeout:20000});
 },trace(){return existsSync(join(root,'trace'))?readFileSync(join(root,'trace'),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];},preserved(){assert.equal(readFileSync(join(root,'dist-mac/Hades.app/sentinel'),'utf8'),'original');}};
}
function successful(f,r){assert.equal(r.status,0,r.stderr);f.preserved();assert.ok(!f.trace().some(x=>['pgrep','kill','open','log'].includes(x.name)));return r.stdout.match(/^Built: (.+)$/m)?.[1];}
test('build-only completes in fresh candidate without app control',t=>{const f=fixture(t),app=successful(f,f.run());assert.ok(app.includes('/candidates/candidate.'));assert.ok(existsSync(join(app,'Contents/Resources/helm-orca/fixture')));});
test('explicit candidate used throughout build',t=>{const f=fixture(t),app=join(f.root,'my candidate/Hades.app');assert.equal(successful(f,f.run(undefined,undefined,{HADES_APP_OUTPUT:app})),app);});
test('existing output refused before tool execution',t=>{const f=fixture(t);assert.notEqual(f.run(undefined,undefined,{HADES_APP_OUTPUT:join(f.root,'dist-mac/Hades.app')}).status,0);assert.deepEqual(f.trace(),[]);f.preserved();});
test('mixed launch and build-only options refused before tool execution',t=>{const f=fixture(t);assert.equal(f.run(undefined,['--build-only','--verify']).status,2);assert.deepEqual(f.trace(),[]);});
test('packaging archives exact fresh candidate',t=>{const f=fixture(t),app=successful(f,f.run('package_mac.sh',[]));for(const ext of ['zip','dmg'])assert.equal(JSON.parse(readFileSync(join(f.root,`dist-mac/Hades-mac-arm64.${ext}`))).src,app);});
test('failed build preserves previous app and does not archive',t=>{const f=fixture(t),r=f.run('package_mac.sh',[],{FLOW_FAIL:'npm'});assert.notEqual(r.status,0);f.preserved();assert.ok(!f.trace().some(x=>['ditto','hdiutil','pgrep','kill','open'].includes(x.name)));});
test('release routes signing and archives to same candidate using inert credentials',t=>{const f=fixture(t),app=successful(f,f.run('release_mac.sh',[],{HADES_SIGN_IDENTITY:'Developer ID Application: Fixture',HADES_NOTARY_PROFILE:'fixture-only'}));const archives=f.trace().filter(x=>x.name==='ditto');assert.equal(archives.length,2);for(const row of archives)assert.equal(row.args.at(-2),app);assert.ok(f.trace().some(x=>x.name==='spctl'&&x.args.at(-1)===app));});

test('two simultaneous reservations admit only one build',async t=>{
 const f=fixture(t),app=join(f.root,'race/Hades.app');
 const env={...process.env,PATH:join(f.root,'fakebin')+':/usr/bin:/bin',BASH_ENV:join(f.root,'bash-env'),FLOW_TRACE:join(f.root,'trace'),HADES_APP_OUTPUT:app,HADES_SIGN_IDENTITY:'',HADES_MAUS_SOURCE_APP:join(f.root,'absent')};delete env.FLOW_FAIL;
 const start=()=>new Promise((resolve,reject)=>{const child=spawn('/bin/bash',[join(f.root,'script/build_and_run.sh'),'--build-only'],{cwd:f.root,env,stdio:'ignore',timeout:20000});child.on('error',reject);child.on('close',resolve);});
 const statuses=await Promise.all([start(),start()]);assert.equal(statuses.filter(x=>x===0).length,1);
 assert.equal(f.trace().filter(x=>x.name==='npm'&&x.args.includes('desktop:build')).length,1);f.preserved();
 assert.ok(!f.trace().some(x=>['pgrep','kill','open','log'].includes(x.name)));
});
