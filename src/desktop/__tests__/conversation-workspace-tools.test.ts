import {expect,it} from 'vitest';
import {realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {conversationWorkspaceTools} from '../core/conversation-workspace-tools';
import {workspaceTools} from '../../hades/runtime/tools';
it('offers desktop command proposals without enabling the standalone runtime shell',()=>{
 expect(conversationWorkspaceTools(tmpdir()).names()).toContain('shell');
 expect(workspaceTools(tmpdir()).names()).not.toContain('shell');
});
it('rejects directory overrides and preserves an explicit command restriction',async()=>{
 expect((await conversationWorkspaceTools(tmpdir()).run({tool:'shell',input:JSON.stringify({cmd:'node',args:[],cwd:'/'})})).ok).toBe(false);
 expect((await conversationWorkspaceTools(tmpdir(),['git']).run({tool:'shell',input:JSON.stringify({cmd:'node',args:['--version']})})).ok).toBe(false);
});
it('executes structured argv from the conversation directory',async()=>{
 const result=await conversationWorkspaceTools(tmpdir()).run({tool:'shell',input:JSON.stringify({cmd:process.execPath,args:['-e','process.stdout.write(process.cwd())']})});
 expect(result.ok).toBe(true);expect(JSON.parse(result.output).stdout).toBe(realpathSync(tmpdir()));
});
