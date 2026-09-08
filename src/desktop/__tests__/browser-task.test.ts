import {describe,it,expect} from 'vitest';
import {BrowserEvidence,parseBrowserTask,READ_ONLY_BROWSER_TOOLS} from '../core/browser-task';
const task=()=>({goal:'Compare sources',plan:[{id:'read',text:'Read pages',status:'pending'}],budget:{maxTokens:4000,maxDurationMs:30000},allowedOrigins:['https://example.com']});
describe('browser task boundary',()=>{
 it('rejects invalid budgets, duplicated steps, non-origins and invalid recovery',()=>{
  for(const candidate of [{...task(),budget:{maxTokens:NaN,maxDurationMs:30}},{...task(),plan:[task().plan[0],task().plan[0]]},{...task(),allowedOrigins:['https://example.com/path']},{...task(),recovery:{previousRunId:''}}]) expect(()=>parseBrowserTask(candidate)).toThrow();
  const input=task(),parsed=parseBrowserTask(input)!;input.plan[0].text='altered';expect(parsed.plan[0].text).toBe('Read pages');
 });
 it('read-only watches cannot type, submit, click, or persist memory',()=>{for(const name of ['page.click','page.type','page.press','context.write','collections.create']) expect(READ_ONLY_BROWSER_TOOLS.has(name)).toBe(false);});
 it('records only actual readable page evidence and saved artifacts',()=>{
  const evidence=new BrowserEvidence();evidence.observe('page.click',{url:'https://example.com',text:'claimed source'},1);expect(evidence.sources).toEqual([]);
  evidence.observe('browser.readPage',{url:'https://example.com',title:'Example',content:'Observed text',tabId:'tab'},2);
  expect(evidence.sources).toEqual([{url:'https://example.com/',label:'Example',excerpt:'Observed text',tabId:'tab',retrievedAt:2}]);
  const before=evidence.fingerprint();evidence.observe('page.extract',{url:'https://example.com',text:'Changed text'},3);expect(evidence.fingerprint()).not.toBe(before);expect(evidence.sources).toHaveLength(1);
  evidence.observe('context.write',{record:{id:'note',title:'Saved'}});expect(evidence.artifacts).toEqual([{kind:'context',id:'note',label:'Saved'}]);
  evidence.observe('browser.readPage',{url:'https://user:password@example.com',content:'secret'});expect(evidence.sources).toHaveLength(1);
 });
});
