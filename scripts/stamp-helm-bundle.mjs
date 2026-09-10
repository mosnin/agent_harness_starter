#!/usr/bin/env node
import { existsSync,readFileSync,writeFileSync } from 'node:fs';
import { dirname,join,resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256,uiFiles,verifyHelm,runtimePayloadSha256 } from './helm-provenance.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
if(!process.argv[2])throw new Error('Provide the bundle Resources directory');
const resources=resolve(process.argv[2]),assets=join(root,'dist/helm-ui'),runtime=join(root,'dist/runtime/helm-opencode');
const built=verifyHelm({assets,runtime,pin:JSON.parse(readFileSync(join(root,'third_party/helm-opencode.json'),'utf8')),source:process.env.HADES_HELM_OPENCODE_SOURCE??(existsSync(join(root,'vendor/opencode'))?join(root,'vendor/opencode'):undefined)});
const path=join(resources,'helm-ui/helm-provenance.json'),data=JSON.parse(readFileSync(path,'utf8'));
if(data.revision!==built.revision||data.sourceSha256!==built.sourceSha256||JSON.stringify(uiFiles(join(resources,'helm-ui')))!==JSON.stringify(built.uiFiles))throw new Error('Copied Helm assets differ from verified build; signing stamp refused');
for(const key of Object.keys(built))if(key!=='runtimeSha256'&&JSON.stringify(data[key])!==JSON.stringify(built[key]))throw new Error('Copied Helm provenance differs from verified build');
if(runtimePayloadSha256(runtime)!==runtimePayloadSha256(join(resources,'helm-opencode')))throw new Error('Code signing changed Helm executable payload; stamp refused');
// A signing stamp records the transformed bytes; it cannot upgrade legacy/dirty/source-stale UI provenance.
data.buildRuntimeSha256=built.runtimeSha256;
data.runtimeSha256=sha256(join(resources,'helm-opencode'));
data.signingTransformation='Packaging-stage runtime hash after code signing; source and UI verified against original build';
writeFileSync(path,JSON.stringify(data,null,2)+'\n');
