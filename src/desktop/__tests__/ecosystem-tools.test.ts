import { expect,it,vi } from 'vitest';
import { ecosystemTools } from '../core/ecosystem-tools';
import type { EcosystemService } from '../core/ecosystem-service';

function fixture(data:unknown) {
  const record=vi.fn(async()=>({record:{id:'doc',collection:'document',title:'Document',revision:'1',data},account:{id:'human',tenantId:'team',name:'Team'},source:'service' as const}));
  const service={record} as unknown as EcosystemService;
  const controller=new AbortController();
  const tool=ecosystemTools(service,'fixed-profile',controller.signal).find(tool=>tool.name==='plugins_record')!;
  const read=(args:Record<string,unknown>={})=>tool.run(JSON.stringify({pluginId:'company-os',collection:'document',id:'doc',...args}));
  return {record,controller,read};
}
it('reads large JSON completely in bounded, version-fenced Unicode chunks',async()=>{
  const data={text:'flame 🔥\n'.repeat(12_000),other:'final field'};
  const f=fixture(data);let args:Record<string,unknown>={},chunks='',requests=0;
  for(;;){const result=await f.read(args);expect(result.ok).toBe(true);expect(Buffer.byteLength(result.output)).toBeLessThan(128*1024);const value=JSON.parse(result.output);expect(value.record).not.toHaveProperty('data');chunks+=value.dataChunk.text;requests++;if(value.dataChunk.nextOffset===undefined)break;args={offset:value.dataChunk.nextOffset,expectedContentHash:value.dataChunk.contentHash};}
  expect(requests).toBeGreaterThan(1);expect(JSON.parse(chunks)).toEqual(data);
  expect(f.record.mock.calls.every(call=>(call as unknown[])[0]==='fixed-profile')).toBe(true);
});
it('refuses record drift and incomplete chunk identity rather than mixing data',async()=>{
  const f=fixture({text:'x'.repeat(70_000)}),first=JSON.parse((await f.read()).output);
  expect((await f.read({offset:first.dataChunk.nextOffset})).ok).toBe(false);
  f.record.mockResolvedValueOnce({record:{id:'doc',collection:'document',title:'Document',revision:'2',data:{text:'changed'}},account:{id:'human',tenantId:'team',name:'Team'},source:'service'});
  const result=await f.read({offset:first.dataChunk.nextOffset,expectedContentHash:first.dataChunk.contentHash});expect(result.ok).toBe(false);expect(result.output).toContain('changed between chunks');
});
it('keeps small records intact and never accepts profile authority from tool input',async()=>{
  const f=fixture({text:'small'});expect(JSON.parse((await f.read()).output).record.data).toEqual({text:'small'});
  const calls=f.record.mock.calls.length;expect((await f.read({profile:'foreign'})).ok).toBe(false);expect(f.record.mock.calls).toHaveLength(calls);
  f.controller.abort();expect((await f.read()).ok).toBe(false);expect(f.record.mock.calls).toHaveLength(calls);
});
