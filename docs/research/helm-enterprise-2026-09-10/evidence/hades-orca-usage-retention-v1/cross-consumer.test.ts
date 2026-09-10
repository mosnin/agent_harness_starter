import { readFileSync } from 'node:fs'
import { expect,it } from 'vitest'
import { decodeHelmOrcaUsage } from '/Users/preston/Documents/Codex/2026-09-06/hades-repair/src/desktop/core/helm-orca-usage.ts'
it('Hades decodes actual Orca generated canonical hashes with conflict preserved',()=>{
 const input=JSON.parse(readFileSync('/tmp/orca-cross-usage-fixture.json','utf8'))
 const decoded=decodeHelmOrcaUsage(input,{dispatchId:'worker-dispatch',sessionId:'session'})
 expect(decoded).toEqual(input)
 expect(decoded.state).toBe('available')
 if(decoded.state!=='available')throw Error('decode failed')
 expect(decoded.observations).toHaveLength(2)
 expect(decoded.conflict).toBe(true)
 expect(decoded.observations.map(r=>r.observation.inputTokens).sort((a,b)=>a!-b!)).toEqual([0,9])
})
