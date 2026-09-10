import { writeFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import Database from '/Users/preston/Documents/Codex/2026-09-06/orca-usage-integration/src/main/sqlite/sync-database.ts'
import { createJournalTablesSql } from '/Users/preston/Documents/Codex/2026-09-06/orca-usage-integration/src/main/native-chat/agent-session-journal/journal-database-schema.ts'
import { JournalUsageObservations } from '/Users/preston/Documents/Codex/2026-09-06/orca-usage-integration/src/main/native-chat/agent-session-journal/journal-usage-observations.ts'
import { parseClaudeResultUsage } from '/Users/preston/Documents/Codex/2026-09-06/orca-usage-integration/src/shared/provider-usage-observation.ts'
import { readWorkerUsageObservations } from '/Users/preston/Documents/Codex/2026-09-06/orca-usage-integration/src/main/runtime/rpc/methods/orchestration/worker/worker-usage-observations.ts'
it('produces actual pinned parser/store/worker projection evidence', async () => {
 const db = new Database(':memory:')
 try {
 db.exec(createJournalTablesSql())
 db.prepare('INSERT INTO journal_rows VALUES (?,?,?,?,?)').run('session','epoch',1,1,JSON.stringify({fence:7}))
 const store = new JournalUsageObservations({identity:{sessionId:'session',workspaceId:'workspace',hostId:'host',agent:'claude',providerHandle:{kind:'claude',sessionId:'provider',leafUuid:null}},now:()=>123,serialize: fn=>fn(),database:()=>({db}),readOnly:()=>false,highestFence:()=>7})
 const parsed = parseClaudeResultUsage({type:'result',uuid:'result',session_id:'provider',usage:{input_tokens:0,output_tokens:3},total_cost_usd:0.012,num_turns:1},{sessionId:'session',runtimeId:'host',dispatchId:'client-operation',acquisitionGeneration:'acq',fence:7,providerSessionId:'provider',turnId:null})
 if(parsed.kind!=='observation') throw Error('parser refused')
 await store.append(parsed.observation,7)
 await store.append({...parsed.observation,inputTokens:9},7)
 const projected=readWorkerUsageObservations({dispatchId:'worker-dispatch',exact:true,sessionId:'session',local:true,read:(_session,limit)=>store.read(limit)})
 expect(projected.state).toBe('available')
 writeFileSync('/tmp/orca-cross-usage-fixture.json',JSON.stringify(projected,null,2)+'\n')
 } finally {db.close()}
})
