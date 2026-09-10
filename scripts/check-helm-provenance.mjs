#!/usr/bin/env node
import { existsSync,readFileSync } from 'node:fs';
import { dirname,resolve,join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyHelm } from './helm-provenance.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export function checkHelmProvenance(){return verifyHelm({assets:join(root,'dist/helm-ui'),runtime:join(root,'dist/runtime/helm-opencode'),pin:JSON.parse(readFileSync(join(root,'third_party/helm-opencode.json'),'utf8')),source:process.env.HADES_HELM_OPENCODE_SOURCE??(existsSync(join(root,'vendor/opencode'))?join(root,'vendor/opencode'):undefined)});}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){try{const p=checkHelmProvenance();console.log('Verified Helm source/UI/runtime provenance: '+p.revision);}catch(e){console.error(e.message);process.exitCode=1;}}
