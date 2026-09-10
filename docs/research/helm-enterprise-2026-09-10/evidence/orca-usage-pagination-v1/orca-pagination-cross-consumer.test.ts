import { readFileSync } from 'node:fs'
import { expect,it } from 'vitest'
import { decodeHelmOrcaUsage } from '/Users/preston/Documents/Codex/2026-09-06/hades-repair/src/desktop/core/helm-orca-usage.ts'
it('Hades validates actual Orca pages and canonical hashes across caught-up/backdated arrival',()=>{
 const pages=JSON.parse(readFileSync('/tmp/orca-pagination-cross-fixture.json','utf8'))
 const ids:string[]=[]
 for(const name of ['first','second','caughtUp','late','legacy']) {
   const decoded=decodeHelmOrcaUsage(pages[name],{dispatchId:'worker-dispatch',sessionId:'session'})
   expect(decoded).toEqual(pages[name])
   if(decoded.state!=='available')throw Error('decode failed: '+name)
   expect(decoded.version).toBe(name==='legacy'?1:2)
   if(name!=='legacy') {
     expect(decoded.nextCursor).toEqual(pages[name].nextCursor)
     ids.push(...decoded.observations.map(row=>row.observation.eventId))
   }
 }
 expect(ids).toHaveLength(106)
 expect(new Set(ids).size).toBe(106)
 expect(ids.at(-1)).toBe('event-late')
 expect(pages.late.observations[0].observedAt).toBe(0)
 expect(pages.first.truncated).toBe(true)
 expect(pages.second.truncated).toBe(false)
 expect(pages.caughtUp.nextCursor).toBe(pages.second.nextCursor)
})
