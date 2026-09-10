import { expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import ts from 'typescript';
it('keeps Hades sources and tests in the compiler while excluding the separately built fork',()=>{
 const root=mkdtempSync(join(tmpdir(),'hades-typecheck-scope-'));
 try {
  for(const file of ['src/desktop/core/owned.ts','src/desktop/__tests__/owned.test.ts','scripts/owned.ts','vendor/opencode/packages/app/fork.ts','vendor/other/retained.ts']) {
   const path=join(root,file);mkdirSync(join(path,'..'),{recursive:true});writeFileSync(path,'export const fixture = true;');
  }
  const config=JSON.parse(readFileSync(resolve('tsconfig.json'),'utf8'));
  const parsed=ts.parseJsonConfigFileContent(config,ts.sys,root);
  expect(parsed.errors).toEqual([]);
  const files=parsed.fileNames.map(file=>file.slice(root.length+1));
  expect(files).toEqual(expect.arrayContaining(['src/desktop/core/owned.ts','src/desktop/__tests__/owned.test.ts','scripts/owned.ts','vendor/other/retained.ts']));
  expect(files.some(file=>file.startsWith('vendor/opencode/'))).toBe(false);
 } finally {rmSync(root,{recursive:true,force:true});}
});
