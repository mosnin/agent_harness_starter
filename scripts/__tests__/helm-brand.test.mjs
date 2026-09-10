import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve,join } from 'node:path';
import { build } from 'esbuild';
const source=resolve(process.env.HADES_HELM_OPENCODE_SOURCE??'../helm-opencode');
async function load(file){const result=await build({entryPoints:[file],bundle:true,write:false,platform:'node',format:'esm',logLevel:'silent'});return import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].text).toString('base64'));}
const {helmDictionary,helmTemplate}=await load(join(source,'packages/app/src/helm-brand.ts'));
const {dict}=await load(join(source,'packages/app/src/i18n/en.ts'));
test('actual fork product dictionary brands sidebar and app while retaining providers/config/attribution',()=>{const branded=helmDictionary(dict,true);assert.equal(branded['sidebar.gettingStarted.line1'],'Helm includes free models so you can start immediately.');assert.match(branded['wsl.onboarding.windowsRestartRequired'],/reopen Helm/);assert.equal(branded['app.name.desktop'],'Helm Desktop');assert.match(branded['provider.connect.apiKey.description'],/\{\{provider\}\} models in Helm/);for(const key of ['provider.connect.opencodeZen.line1','dialog.model.unpaid.freeModels.title','dialog.plugins.empty','error.chain.checkConfig','error.page.report.prefix','settings.desktop.wsl.description'])assert.equal(branded[key],dict[key]);});
test('upstream mode and technical/unlisted localized strings remain exact',()=>{assert.equal(helmDictionary(dict,false),dict);assert.equal(helmTemplate('<title>OpenCode</title>',false),'<title>OpenCode</title>');assert.deepEqual(helmDictionary({'desktop.menu.ariaLabel':'Menu OpenCode','provider.id':'opencode','unknown.credit':'OpenCode contributors'},true),{'desktop.menu.ariaLabel':'Menu Helm','provider.id':'opencode','unknown.credit':'OpenCode contributors'});});
