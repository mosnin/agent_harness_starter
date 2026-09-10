import test from 'node:test';
import assert from 'node:assert/strict';
import {realpathSync,mkdtempSync,mkdirSync,readFileSync,writeFileSync,copyFileSync,symlinkSync,rmSync} from 'node:fs';
import {join,dirname,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
function fixture(t,compiler){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'hades-sidecar-failure-')));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const put=(path,value)=>{mkdirSync(dirname(join(root,path)),{recursive:true});writeFileSync(join(root,path),value);};
 mkdirSync(join(root,'scripts'));copyFileSync(resolve('scripts/build-sidecar.mjs'),join(root,'scripts/build-sidecar.mjs'));
 put('node_modules/esbuild/package.json',JSON.stringify({name:'esbuild',type:'module',exports:'./index.js'}));
 put('node_modules/esbuild/index.js',compiler);
 put('src/desktop/sidecar-entry.ts','#!/usr/bin/env node\nconsole.log("current");\n');
 put('dist/desktop/sidecar-entry.js','stale bundle sentinel');
 return {root,run:()=>spawnSync(process.execPath,[join(root,'scripts/build-sidecar.mjs')],{cwd:root,encoding:'utf8',timeout:10000}),prior:()=>readFileSync(join(root,'dist/desktop/sidecar-entry.js'),'utf8')};
}
test('CLI refuses compiler import failure instead of accepting stale bundle',t=>{
 const f=fixture(t,'throw new Error("compiler unavailable fixture");');const result=f.run();
 assert.notEqual(result.status,0);assert.match(result.stderr,/esbuild is not installed/);assert.equal(f.prior(),'stale bundle sentinel');
});
test('CLI refuses compiler build failure and preserves prior bundle',t=>{
 const f=fixture(t,'export async function build(){throw new Error("compile failed fixture");}');const result=f.run();
 assert.notEqual(result.status,0);assert.match(result.stderr,/compile failed fixture/);assert.equal(f.prior(),'stale bundle sentinel');
});

test('CLI invoked through a symlink still runs and reports compiler failure',t=>{
 const f=fixture(t,'throw new Error("compiler unavailable fixture");');const alias=join(f.root,'build-alias.mjs');
 symlinkSync(join(f.root,'scripts/build-sidecar.mjs'),alias);
 const result=spawnSync(process.execPath,[alias],{cwd:f.root,encoding:'utf8',timeout:10000});
 assert.notEqual(result.status,0);assert.match(result.stderr,/esbuild is not installed/);
});
