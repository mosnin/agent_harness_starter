import { writeFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import Database from '/Users/preston/Documents/Codex/2026-09-06/orca-usage-integration/src/main/sqlite/sync-database.ts'
import { createJournalTablesSql } from '/Users/preston/Documents/Codex/2026-09-06/orca-usage-integration/src/main/native-chat/agent-session-journal/journal-database-schema.ts'
import { JournalUsageObservations } from '/Users/preston/Documents/Codex/2026-09-06/orca-usage-integration/src/main/native-chat/agent-session-journal/journal-usage-observations.ts'
import { parseClaudeResultUsage } from '/Users/preston/Documents/Codex/2026-09-06/orca-usage-integration/src/shared/provider-usage-observation.ts'
import { readWorkerUsageObservations } from '/Users/preston/Documents/Codex/2026-09-06/orca-usage-integration/src/main/runtime/rpc/methods/orchestration/worker/worker-usage-observations.ts'
it('produces actual current v2 pagination and v1 projection evidence', async () => {
 const db = new Database(':memory:')
 try {
 db.exec(createJournalTablesSql())
 db.prepare('INSERT INTO journal_rows VALUES (?,?,?,?,?)').run('session','epoch',1,1,JSON.stringify({fence:7}))
 let now = 123
 const store = new JournalUsageObservations({identity:{sessionId:'session',workspaceId:'workspace',hostId:'host',agent:'claude',providerHandle:{kind:'claude',sessionId:'provider',leafUuid:null}},now:()=>now,serialize: fn=>fn(),database:()=>({db}),readOnly:()=>false,highestFence:()=>7})
 const parsed = parseClaudeResultUsage({type:'result',uuid:'result',session_id:'provider',usage:{input_tokens:0,output_tokens:3},total_cost_usd:0.012,num_turns:1},{sessionId:'session',runtimeId:'host',dispatchId:'client-operation',acquisitionGeneration:'acq',fence:7,providerSessionId:'provider',turnId:null})
 if(parsed.kind!=='observation') throw Error('parser refused')
 for(let n=0;n<105;n++) await store.append({...parsed.observation,eventId:'event-'+n},7)
 const common={dispatchId:'worker-dispatch',exact:true,sessionId:'session',local:true,read:(_session:string,limit:number)=>store.read(limit),readPage:(_session:string,limit:number,cursor?:string)=>store.readPage(limit,cursor)}
 const first=readWorkerUsageObservations({...common,cursor:null})
 if(first.state!=='available' || !('nextCursor' in first)) throw Error('first page failed')
 expect(first.observations).toHaveLength(100)
 const second=readWorkerUsageObservations({...common,cursor:first.nextCursor})
 if(second.state!=='available' || !('nextCursor' in second)) throw Error('second page failed')
 expect(second.observations).toHaveLength(5)
 const caughtUp=readWorkerUsageObservations({...common,cursor:second.nextCursor})
 if(caughtUp.state!=='available' || !('nextCursor' in caughtUp)) throw Error('caught up failed')
 expect(caughtUp.observations).toHaveLength(0)
 now = 0
 await store.append({...parsed.observation,eventId:'event-late'},7)
 const late=readWorkerUsageObservations({...common,cursor:caughtUp.nextCursor})
 expect(late.state).toBe('available')
 if(late.state!=='available')throw Error('late failed')
 expect(late.observations.map(row=>row.observation.eventId)).toEqual(['event-late'])
 const legacy=readWorkerUsageObservations(common)
 expect(legacy.version).toBe(1)
 writeFileSync('/tmp/orca-pagination-cross-fixture.json',JSON.stringify({first,second,caughtUp,late,legacy},null,2)+'\n')
 } finally {db.close()}
})
