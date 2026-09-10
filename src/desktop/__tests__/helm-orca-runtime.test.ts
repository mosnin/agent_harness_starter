import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { HelmOrcaRuntime } from '../core/helm-orca-runtime';
const dirs:string[]=[];afterEach(()=>{for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
function fixture(){const root=mkdtempSync(join(tmpdir(),'helm-orca-preflight-'));dirs.push(root);const artifact=join(root,'artifact');mkdirSync(artifact);return {root,artifact,runtime:new HelmOrcaRuntime(join(root,'private'),artifact)};}
it('missing artifact refuses before any runtime launch',async()=>{const f=fixture();await expect(f.runtime.connect({root:f.root,profile:'p'},new AbortController().signal)).rejects.toThrow();f.runtime.close();});
it('empty or wrong revision manifest cannot authorize runtime execution',async()=>{const f=fixture();writeFileSync(join(f.artifact,'helm-orca-build.json'),JSON.stringify({sourceRevision:'bf4e2705046cf9ef9c915929a9646da85717af07',files:[]}));await expect(f.runtime.connect({root:f.root,profile:'p'},new AbortController().signal)).rejects.toThrow('Pinned');f.runtime.close();});
it('cancelled runtime startup performs no artifact or process work',async()=>{const f=fixture();const c=new AbortController();c.abort();await expect(f.runtime.connect({root:f.root,profile:'p'},c.signal)).rejects.toThrow();f.runtime.close();});
