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
  const before=evidence.fingerprint();evidence.observe('page.extract',{url:'https://example.com',text:'Focused text'},3,{selector:'td'});expect(evidence.fingerprint()).toBe(before);evidence.observe('browser.readPage',{url:'https://example.com',content:'Changed page'},4);expect(evidence.fingerprint()).not.toBe(before);expect(evidence.sources).toHaveLength(1);
  evidence.observe('context.write',{record:{id:'note',title:'Saved'}});expect(evidence.artifacts).toEqual([{kind:'context',id:'note',label:'Saved'}]);
  evidence.observe('browser.readPage',{url:'https://user:password@example.com',content:'secret'});expect(evidence.sources).toHaveLength(1);
 });
});

it('preserves broad supplier evidence and fingerprint when focused cell reads follow',()=>{
 const evidence=new BrowserEvidence(),url='https://example.com/suppliers';
 const page='Supplier | Monthly price | Seats\nAlpha | $18 | 5\nBeta | $24 | 8\nVerification marker: EVIDENCE_OK';
 evidence.observe('browser.readPage',{url,title:'Suppliers',content:page},1);const before=evidence.fingerprint();
 evidence.observe('page.extract',{url,text:'8'},2,{selector:'tr:nth-child(3) td:nth-child(3)'});
 expect(evidence.sources[0].excerpt).toContain('$18');expect(evidence.sources[0].excerpt).toContain('$24');expect(evidence.sources[0].excerpt).toContain('EVIDENCE_OK');expect(evidence.sources[0].excerpt).toContain('Focused extract');expect(evidence.fingerprint()).toBe(before);
 const changed=new BrowserEvidence();changed.observe('browser.readPage',{url,content:page.replace('$18','$19')},3);changed.observe('page.extract',{url,text:'8'},4,{selector:'tr:nth-child(3) td:nth-child(3)'});expect(changed.fingerprint()).not.toBe(before);
});
it('combines bounded focused evidence deterministically when no broad page read exists',()=>{
 const a=new BrowserEvidence(),b=new BrowserEvidence(),url='https://example.com/table';
 for(const [selector,text] of [['.price','$18'],['.seats','5']])a.observe('page.extract',{url,text},1,{selector});
 for(const [selector,text] of [['.seats','5'],['.price','$18']])b.observe('page.extract',{url,text},1,{selector});
 expect(a.fingerprint()).toBe(b.fingerprint());expect(a.sources[0].excerpt).toContain('$18');expect(a.sources[0].excerpt).toContain('5');
 a.observe('browser.readPage',{url,content:'x'.repeat(4000)},2);a.observe('page.extract',{url,text:'y'.repeat(4000)},3,{selector:'td'});expect(a.sources[0].excerpt.length).toBeLessThanOrEqual(2000);
});

it('ignores volatile snapshot refs in focused-only fingerprints and deduplicates repeated content',()=>{
 const a=new BrowserEvidence(),b=new BrowserEvidence(),url='https://example.com/price';
 a.observe('page.extract',{url,text:'Price $18'},1,{ref:'s100r0'});a.observe('page.extract',{url,text:'Price $18'},2,{ref:'s101r7'});
 b.observe('page.extract',{url,text:'Price $18'},1,{ref:'s200r0'});
 expect(a.fingerprint()).toBe(b.fingerprint());expect(a.sources[0].excerpt).toBe(b.sources[0].excerpt);expect(a.sources[0].excerpt).not.toContain('s100r0');
});
it('hashes complete focused text before shortening display excerpts',()=>{
 const a=new BrowserEvidence(),b=new BrowserEvidence(),url='https://example.com/price';
 a.observe('page.extract',{url,text:'x'.repeat(400)+'$18'},1,{ref:'s100r0'});
 b.observe('page.extract',{url,text:'x'.repeat(400)+'$19'},1,{ref:'s200r0'});
 expect(a.fingerprint()).not.toBe(b.fingerprint());expect(a.sources[0].excerpt).toContain('[Excerpt shortened]');
 const c=new BrowserEvidence(),d=new BrowserEvidence();c.observe('page.extract',{url,text:'x'.repeat(400)+'$18'},1,{selector:'.price'});d.observe('page.extract',{url,text:'x'.repeat(400)+'$19'},1,{selector:'.price'});expect(c.fingerprint()).not.toBe(d.fingerprint());
});
it('reserves display space for focused facts after a full broad excerpt',()=>{
 const evidence=new BrowserEvidence(),url='https://example.com/price';
 evidence.observe('browser.readPage',{url,content:'a'.repeat(2000)},1);evidence.observe('page.extract',{url,text:'Price $18'},2,{ref:'s100r0'});
 expect(evidence.sources[0].excerpt).toContain('Price $18');expect(evidence.sources[0].excerpt).toContain('[Excerpt shortened]');expect(evidence.sources[0].excerpt.length).toBeLessThanOrEqual(2000);
 const focusedOnly=new BrowserEvidence();for(let i=0;i<10;i++)focusedOnly.observe('page.extract',{url,text:String(i)+'x'.repeat(400)},i,{selector:'.cell-'+i});expect(focusedOnly.sources[0].excerpt.length).toBeLessThanOrEqual(2000);
});
