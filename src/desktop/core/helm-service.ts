import conversationSkills from "../../../third_party/conversation-skills/bundle.json";
import { validateSpatialImage } from "./spatial-context";
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, lstatSync, readlinkSync, realpathSync, openSync, closeSync, fsyncSync, unlinkSync, rmdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { HELM_AGENTS, helmArgs, helmBinary, helmEnv, helmProviderError, helmAgentEnv } from './helm-adapters.js';
import { probeHelmAgent } from './helm-provider-readiness.js';
import { materializeOrcaImport, type HelmOrcaImportDescriptor } from './helm-orca-import.js';
import type { HelmAgent, HelmCheck, HelmDiff, HelmOptions, HelmRun, HelmStart, HelmWorkOrigin } from './helm-types.js';
const LIMIT = 200_000;
const WORKTREE_QUEUES = new Map<string,Promise<void>>();
const ACTIVE = new Set(['starting', 'running']);
interface Live { controller: AbortController; done?: Promise<void>; timer?: ReturnType<typeof setTimeout> }
export class HelmService {
  private runs = new Map<string, HelmRun>();
  private live = new Map<string, Live>();
  private directory: string;
  private env: NodeJS.ProcessEnv;
  private closed = false;
  private shutdown?: Promise<void>;
  private agentCache?: {expires: number; value: HelmAgent[]};
  private agentPending?: Promise<HelmAgent[]>;
  private agentPendingRefresh = false;
  private outputTicks = new Map<string,number>();
  constructor(dataDir: string, private emit: (event: {kind: 'helm.changed'; runId?: string}) => void, private options: HelmOptions = {}) {
    this.directory = join(resolve(dataDir), 'helm');
    this.env = helmEnv(options.env ?? process.env);
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    this.directory = realpathSync(this.directory);
    mkdirSync(join(this.directory,'empty-hooks'),{recursive:true,mode:0o700});
    const file = join(this.directory, 'runs.json');
    if (existsSync(file)) {
      const saved: HelmRun[] = JSON.parse(readFileSync(file, 'utf8'));
      for (const run of saved) {
        if (ACTIVE.has(run.status)) { run.status = 'interrupted'; run.error = 'Hades restarted. Inspect the retained workspace before starting new work.'; run.updatedAt = Date.now(); }
        this.runs.set(run.id, run);
      }
      this.persist();
    }
  }
  private persist(): void {
    const file = join(this.directory, 'runs.json');
    const temp = `${file}.${randomUUID()}.tmp`;
    const fd=openSync(temp,'wx',0o600);try{writeFileSync(fd,JSON.stringify([...this.runs.values()]));fsyncSync(fd);}finally{closeSync(fd);}
    renameSync(temp, file);
    const directoryFd=openSync(this.directory,'r');try{fsyncSync(directoryFd);}finally{closeSync(directoryFd);}
  }
  private changed(run: HelmRun): void { run.updatedAt = Date.now(); this.persist(); try { this.emit({kind: 'helm.changed', runId: run.id}); } catch { /* observers cannot kill execution */ } }
  private require(id: string): HelmRun { const run = this.runs.get(id); if (!run) throw new Error('Helm run not found'); return run; }
  get(id: string): HelmRun { return structuredClone(this.require(id)); }
  list(root?: string): HelmRun[] { return [...this.runs.values()].filter(r => !root || r.root === resolve(root)).sort((a,b) => b.createdAt-a.createdAt).map(r => structuredClone(r)); }
  hasActiveWork(): boolean { return this.live.size > 0; }
  ownsWorkspace(root: string): boolean {
    try { const canonical=realpathSync(root);return [...this.runs.values()].some(r => r.workspace === canonical && realpathSync(r.workspace) === r.workspace && !!r.workspaceIdentity && JSON.stringify(this.workspaceIdentity(r.workspace)) === JSON.stringify(r.workspaceIdentity)); } catch { return false; }
  }
  private workspaceIdentity(workspace: string): {dev: number; ino: number; gitFileDigest: string} {
    const stat=lstatSync(workspace),gitFile=join(workspace,'.git');
    if(!stat.isDirectory() || !lstatSync(gitFile).isFile())throw new Error('Workspace identity changed');
    return {dev:stat.dev,ino:stat.ino,gitFileDigest:createHash('sha256').update(readFileSync(gitFile)).digest('hex')};
  }
  async agents(refresh=false): Promise<HelmAgent[]> {
    if(this.agentPending) {
      if(refresh && !this.agentPendingRefresh) { await this.agentPending; return this.agents(true); }
      return structuredClone(await this.agentPending);
    }
    if(!refresh && this.agentCache && this.agentCache.expires>Date.now())return structuredClone(this.agentCache.value);
    this.agentPendingRefresh=refresh;
    this.agentPending=Promise.all(HELM_AGENTS.map(async id => {
      if(refresh) {
        const readiness=await probeHelmAgent(id,this.env,{cwd:this.directory,builtinAvailable:!!this.options.runBuiltin});
        return {id,name:id==='hades'?'Hades':id,installed:readiness.installed,auth:readiness.auth,version:readiness.version,readiness};
      }
      if (id === 'hades') return {id, name:'Hades', installed: !!this.options.runBuiltin, auth:'unknown' as const};
      const binary = helmBinary(id, this.env);
      if (!binary) return {id, name:id, installed:false, auth:'unknown' as const};
      const result = await this.process(binary, ['--version'], this.directory, new AbortController().signal, 5000);
      return {id, name:id, installed:true, auth:'unknown' as const, ...(result.code === 0 ? {version:result.output.trim().slice(0,200)} : {error:'Version check failed'})};
    }));
    try{const value=await this.agentPending;this.agentCache={expires:refresh?Infinity:Date.now()+30000,value};return structuredClone(value);}finally{this.agentPending=undefined;this.agentPendingRefresh=false;}
  }
  private checks(checks: HelmCheck[] | undefined): HelmCheck[] {
    if (!checks) return [];
    if (!Array.isArray(checks) || checks.length > 12 || checks.some(c => !c || typeof c.command !== 'string' || !c.command.trim() || c.command.includes('\0') || !Array.isArray(c.args) || c.args.length > 100 || c.args.some(a => typeof a !== 'string' || a.includes('\0') || a.length > 10000))) throw new Error('Checks must contain bounded command and argument arrays');
    return structuredClone(checks);
  }
  private prepareStart(input: HelmStart): {minutes:number;requestedChecks:HelmCheck[];root:string} {
    if (this.closed) throw new Error('Helm is closed');
    if(this.runs.size>=500)throw new Error('Helm has reached its 500 retained run limit');
    if (this.live.size >= 4) throw new Error('Helm can run four jobs at a time');
    if (!HELM_AGENTS.includes(input.agent) || !input.prompt?.trim() || input.prompt.includes('\0') || input.prompt.length > 100000 || (input.context?.length ?? 0) > 100000) throw new Error('Choose an agent and provide a bounded task prompt');
    if(input.images!==undefined){if(!Array.isArray(input.images)||input.images.length>5)throw new Error("Choose at most five reviewed images");input.images.forEach(validateSpatialImage);}
    const minutes = input.maxMinutes ?? 15;
    if (!Number.isFinite(minutes) || minutes < 0.01 || minutes > 240) throw new Error('Duration must be between 0.01 and 240 minutes');
    if (input.model && (input.model.startsWith('-') || input.model.length > 200 || input.model.includes('\0'))) throw new Error('Invalid model');
    const requestedChecks = this.checks(input.checks);
    const root = realpathSync(input.root);
    return {minutes,requestedChecks,root};
  }
  validateStart(input: HelmStart): void { this.prepareStart(input); }
  /** Host-only import. The descriptor comes from the owned Orca service, never RPC arguments.
   * A stopped worker becomes a retained review snapshot, not a verified coding result. */
  async importOrca(descriptor: HelmOrcaImportDescriptor, input: {agent:'codex'|'claude'|'opencode';prompt:string;owner:string;title?:string;workOrigin?:HelmWorkOrigin}, signal?:AbortSignal): Promise<HelmRun> {
    if(this.closed)throw new Error('Helm is closed');signal?.throwIfAborted();
    if(input.workOrigin && (input.workOrigin.ownerProfile!==input.owner || input.workOrigin.taskProfile!==descriptor.profile || input.workOrigin.requestId!==descriptor.intentId))throw new Error('Orca Work import ownership mismatch');
    if(!input.workOrigin && input.owner!==descriptor.profile)throw new Error('Orca import ownership mismatch');
    const binding=createHash('sha256').update(JSON.stringify({descriptor,owner:input.owner,workOrigin:input.workOrigin})).digest('hex');
    const id=`${binding.slice(0,8)}-${binding.slice(8,12)}-${binding.slice(12,16)}-${binding.slice(16,20)}-${binding.slice(20,32)}`;
    const prior=this.runs.get(id);
    if(prior){
      if(JSON.stringify(prior.orcaOrigin)!==JSON.stringify(descriptor)||JSON.stringify(prior.workOrigin)!==JSON.stringify(input.workOrigin)||prior.owner!==input.owner)throw new Error('Orca import identity conflict');
      if(!this.ownsWorkspace(prior.workspace))throw new Error('Retained Orca import is incomplete or its workspace identity changed. Inspect it; no import was replayed.');
      return this.get(id);
    }
    if(this.runs.size>=500||this.live.size>=4)throw new Error('Helm retained run or active job limit reached');
    const directory=join(this.directory,'orca-imports');mkdirSync(directory,{recursive:true,mode:0o700});
    const claim=join(directory,id+'.json');let fd:number;
    try{fd=openSync(claim,'wx',0o600);}catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')throw new Error('Orca import already claimed. Inspect its retained run after refresh; no snapshot was replayed.');throw error;}
    try{writeFileSync(fd,JSON.stringify({schema:1,id,binding,descriptor,owner:input.owner,workOrigin:input.workOrigin,status:'importing'}));fsyncSync(fd);}finally{closeSync(fd);}
    const directoryFd=openSync(directory,'r');try{fsyncSync(directoryFd);}finally{closeSync(directoryFd);}
    const run:HelmRun={id,root:descriptor.root,workspace:join(this.directory,'workspaces',id),branch:'detached',baseSha:descriptor.baseSha,agent:input.agent,title:(input.title??'Orca output for review').slice(0,200),prompt:input.prompt,status:'starting',createdAt:Date.now(),updatedAt:Date.now(),output:'Imported output needs explicit verification, patch review, and fresh source checks.',maxMinutes:15,sourceDirty:false,exclusions:['Ignored files and local dependencies are excluded from this review snapshot.','Provider token usage remains unknown. Importing output does not dispatch another worker.'],owner:input.owner,orcaOrigin:structuredClone(descriptor),workOrigin:input.workOrigin?structuredClone(input.workOrigin):undefined};
    const live:Live={controller:new AbortController()},abort=()=>live.controller.abort(signal?.reason);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    this.runs.set(id,run);this.live.set(id,live);
    live.done=(async()=>{
      try{
        this.changed(run);mkdirSync(join(this.directory,'workspaces'),{recursive:true,mode:0o700});
        const snapshot=await materializeOrcaImport(descriptor,run.workspace,live.controller.signal);live.controller.signal.throwIfAborted();
        run.workspaceIdentity=snapshot.workspaceIdentity;run.status='needs_review';this.changed(run);
      }catch(error){run.status=live.controller.signal.aborted?'interrupted':'failed';run.error='Orca snapshot import did not complete. Inspect the retained destination; no automatic replay. '+String(error);this.changed(run);throw error;}
      finally{signal?.removeEventListener('abort',abort);this.live.delete(id);}
    })();
    await live.done;return this.get(id);
  }
  async start(input: HelmStart): Promise<HelmRun> {
    const {minutes,requestedChecks,root}=this.prepareStart(input);
    const id = randomUUID();
    const run: HelmRun = {id,root,handoffId:input.handoffId,workspace:join(this.directory,'workspaces',id),branch:'detached',baseSha:'',agent:input.agent,title:(input.title?.trim() || input.prompt.trim().slice(0,80)).slice(0,200),prompt:input.prompt,status:'starting',createdAt:Date.now(),updatedAt:Date.now(),output:'',maxMinutes:minutes,sourceDirty:false,exclusions:[],requestedChecks,contextSnapshot:input.context,images:input.images,parentSession:input.parentSession,owner:input.owner,model:input.model};
    const live: Live = {controller:new AbortController()};
    this.live.set(id, live); this.runs.set(id,run); try{this.changed(run);}catch(error){this.live.delete(id);this.runs.delete(id);throw error;}
    live.timer=setTimeout(()=>{run.error='Task time limit reached';live.controller.abort();},minutes*60000);
    live.done = this.execute(run, live).catch(error=>{if(ACTIVE.has(run.status))run.status='failed';run.error=`Could not persist run state: ${String(error)}`;try{this.emit({kind:'helm.changed',runId:id});}catch{}}).finally(() => {clearTimeout(live.timer);this.live.delete(id);});
    // Start returns the persisted job immediately. Preparation errors are visible on the run.
    return this.get(id);
  }
  private async git(root: string, args: string[], signal = new AbortController().signal): Promise<string> {
    const result = await this.process('git', ['--no-pager', '-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${join(this.directory,'empty-hooks')}`, ...args], root, signal, 30000, 8_000_000);
    if (result.error === 'Task time limit reached') throw new Error('Git repository access timed out before the command completed.' + (process.platform === 'darwin' ? ' Check that Hades has access to this project folder in macOS Privacy & Security settings, or choose a project folder Hades can already access, then retry.' : ' Check project access and Git availability, then retry.'));
    if (result.code !== 0 || result.truncated) throw new Error(result.error ?? result.output.slice(-2000) ?? 'Git operation failed');
    return result.output;
  }
  private async addWorktree(run: HelmRun, signal: AbortSignal): Promise<void> {
    const common=realpathSync(resolve(run.root,(await this.git(run.root,['rev-parse','--git-common-dir'],signal)).trim()));
    const previous=WORKTREE_QUEUES.get(common) ?? Promise.resolve();
    const task=previous.catch(()=>{}).then(async()=>{if(signal.aborted)throw new Error('Task cancelled');await this.git(run.root,['worktree','add','--detach',run.workspace,run.baseSha],signal);});
    WORKTREE_QUEUES.set(common,task);
    void task.finally(()=>{if(WORKTREE_QUEUES.get(common)===task)WORKTREE_QUEUES.delete(common);}).catch(()=>{});
    await new Promise<void>((resolveTask,rejectTask)=>{const abort=()=>rejectTask(new Error('Task cancelled'));signal.addEventListener('abort',abort,{once:true});task.then(resolveTask,rejectTask).finally(()=>signal.removeEventListener('abort',abort));if(signal.aborted)abort();});
  }
  private async execute(run: HelmRun, live: Live): Promise<void> {
    const signal = live.controller.signal;
    try {
      run.baseSha = (await this.git(run.root,['rev-parse','--verify','HEAD'],signal)).trim();
      const dirty = await this.git(run.root,['status','--porcelain=v1'],signal);
      run.sourceDirty = !!dirty.trim();
      run.exclusions = ['Ignored files and local dependencies are excluded from the HEAD workspace and source diff.',...(dirty.trim() ? ['Uncommitted and untracked source changes are excluded; workspace starts from HEAD.',dirty.slice(0,12000)] : [])];
      mkdirSync(join(this.directory,'workspaces'),{recursive:true,mode:0o700});
      await this.addWorktree(run,signal);
      run.workspaceIdentity=this.workspaceIdentity(run.workspace);
      if (signal.aborted) return;
      run.status='running'; this.changed(run);
      let prompt = `${run.prompt}\n\n${run.contextSnapshot ? `Explicit task context:\n${run.contextSnapshot}\n\n` : ''}Work only in this isolated workspace. Do not commit, push, merge, or remove worktrees. Report changes and verification honestly.`;
      prompt += "\n\nCoding discipline (user instructions take precedence; scope ends with this task):\n" + conversationSkills.skills.find(skill => skill.name === "ponytail")!.content;
      if (run.agent === 'hades') {
        if (!this.options.runBuiltin) throw new Error('Hades executor is unavailable');
        const timer = setTimeout(() => { run.error='Task time limit reached'; live.controller.abort(); }, run.maxMinutes*60000);
        try {
          const result = await this.options.runBuiltin({root:run.workspace,prompt,context:run.contextSnapshot,images:run.images,model:run.model,maxMinutes:run.maxMinutes,parentSession:run.parentSession,owner:run.owner},signal,update=>{if(update.sessionId)run.sessionId=update.sessionId;if(update.output){run.output=(run.output+update.output).slice(-LIMIT);run.outputTruncated ||= run.output.length>=LIMIT;}this.changed(run);});
          run.output=result.output.slice(-LIMIT); run.outputTruncated=result.output.length>LIMIT; if(result.sessionId)run.sessionId=result.sessionId;
          if (result.error) throw new Error(result.error);
        } finally { clearTimeout(timer); }
        run.exitCode=0;
      } else {
        const binary=helmBinary(run.agent,this.env); if(!binary) throw new Error(`${run.agent} is not installed`);
        const imagePaths: string[]=[];
        let imageDirectoryIdentity: {dev:number;ino:number}|undefined;
        const imageDirectory=join(run.workspace,`.hades-spatial-${run.id}`);
        try {
          if(run.images?.length){
            mkdirSync(imageDirectory,{mode:0o700});
            const original=lstatSync(imageDirectory);imageDirectoryIdentity={dev:original.dev,ino:original.ino};
            for(const [index,image] of run.images.entries()){
              const mime=/^data:image\/(png|jpeg|gif|webp);base64,/.exec(image)![1];
              const file=join(imageDirectory,`${index+1}.${mime==='jpeg'?'jpg':mime}`);
              writeFileSync(file,Buffer.from(image.slice(image.indexOf(',')+1),'base64'),{flag:'wx',mode:0o600});imagePaths.push(file);
            }
            prompt+='\n\nReviewed spatial image files (read these as images; do not modify):\n'+imagePaths.join('\n');
          }
        const result=await this.process(binary,helmArgs(run.agent,prompt,run.model,!!this.env.HADES_CODEX_HOME,run.workspace,imagePaths),run.workspace,signal,run.maxMinutes*60000,LIMIT,chunk => {
          run.output=(run.output+chunk).slice(-LIMIT); run.outputTruncated=(run.outputTruncated || run.output.length >= LIMIT); if(Date.now()-(this.outputTicks.get(run.id)??0)>250){this.outputTicks.set(run.id,Date.now());this.changed(run);}
        },helmAgentEnv(run.agent,this.env));
        run.output=result.output; run.outputTruncated=result.truncated; run.exitCode=result.code;
        const error=result.error ?? helmProviderError(result.output);
        if (error || result.code !== 0) throw new Error(error ?? `Agent exited with code ${result.code}`);
        } finally {
          // Remove only the input files this task created, never other agent output.
          const owned=()=>{try{const current=lstatSync(imageDirectory);return !current.isSymbolicLink() && current.isDirectory() && current.dev===imageDirectoryIdentity?.dev && current.ino===imageDirectoryIdentity?.ino && realpathSync(imageDirectory)===imageDirectory;}catch{return false;}};
          for(const path of imagePaths)if(owned())try{unlinkSync(path);}catch{}
          if(imagePaths.length && owned())try{rmdirSync(imageDirectory);}catch{}
        }
      }
      if (signal.aborted) throw new Error(run.error ?? 'Task cancelled');
      run.status='needs_review'; this.changed(run);
      if (run.requestedChecks?.length) await this.verifyInternal(run,run.requestedChecks,live);
    } catch(error) {
      if (run.status !== 'cancelled' && run.status !== 'interrupted') { run.status='failed'; run.error=run.error ?? String(error instanceof Error ? error.message : error).slice(0,2000); }
    } finally { if(signal.aborted && ACTIVE.has(run.status)){run.status='failed';run.error ??='Task time limit reached';}this.changed(run); }
  }
  async cancel(id: string): Promise<HelmRun> {
    const run=this.require(id); const live=this.live.get(id);
    if (live) { run.status='cancelled'; run.error='Cancelled by user'; live.controller.abort(); try{this.changed(run);}catch{run.error='Cancelled; state could not be persisted';}await live.done; }
    return this.get(id);
  }
  private async snapshot(run: HelmRun, signal = new AbortController().signal): Promise<HelmDiff> {
    if(!this.ownsWorkspace(run.workspace))throw new Error('Workspace identity changed; refuse redirected repository access');
    const text=await this.git(run.workspace,['diff','--no-ext-diff','--no-textconv','--binary',run.baseSha,'--'],signal);
    const tracked=(await this.git(run.workspace,['diff','--name-only','-z',run.baseSha,'--'],signal)).split('\0').filter(Boolean);
    const untracked=(await this.git(run.workspace,['ls-files','--others','--exclude-standard','-z'],signal)).split('\0').filter(Boolean).sort();
    const hash=createHash('sha256').update(run.baseSha).update(text);
    let display=text;
    let total=0;
    for (const file of untracked) {
      const path=join(run.workspace,file); const stat=lstatSync(path);
      if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error('Unsupported untracked file type');
      total+=stat.size; if(total>32_000_000) throw new Error('Untracked content exceeds 32 MB verification limit');
      const content=stat.isSymbolicLink()?Buffer.from(readlinkSync(path)):readFileSync(path);
      hash.update('\0'+file+'\0'+stat.mode+'\0').update(content);
      if(display.length<LIMIT) display+=`\nUntracked: ${file}\n${content.subarray(0,Math.max(0,LIMIT-display.length)).toString('utf8')}\n`;
    }
    const revision=hash.digest('hex');
    return {text:display.slice(0,LIMIT),files:[...tracked,...untracked],revision,truncated:display.length>LIMIT || text.length>LIMIT || total>LIMIT,stale:!!run.verificationRevision && run.verificationRevision!==revision};
  }
  async diff(id: string): Promise<HelmDiff> {
    const run=this.require(id); const diff=await this.snapshot(run);
    if(diff.stale && run.status==='verified') {run.status='needs_review';run.error='Workspace changed since verification';this.changed(run);}
    return diff;
  }
  async verify(id: string, checks?: HelmCheck[]): Promise<HelmRun> {
    if(this.closed) throw new Error('Helm is closed');
    const run=this.require(id); if(this.live.has(id)) throw new Error('Run is still active');
    if(this.live.size>=4) throw new Error('Helm can run four jobs at a time');
    if(!['needs_review','verified'].includes(run.status)) throw new Error('Inspect interrupted or cancelled work before starting a new run');
    const selected=this.checks(checks ?? run.requestedChecks); if(!selected.length) throw new Error('Provide at least one explicit verification command');
    const live:Live={controller:new AbortController()};this.live.set(id,live);
    live.timer=setTimeout(()=>{run.error='Verification time limit reached';live.controller.abort();},run.maxMinutes*60000);
    live.done=this.verifyInternal(run,selected,live).catch(e=>{if(run.status!=='cancelled' && run.status!=='interrupted'){run.status='needs_review';run.error=String(e);}this.changed(run);}).finally(()=>{clearTimeout(live.timer);if(run.status==='running'){run.status='needs_review';this.changed(run);}this.live.delete(id);});
    await live.done; return this.get(id);
  }
  private async verifyInternal(run: HelmRun, checks: HelmCheck[], live: Live): Promise<void> {
    run.status='running';run.error=undefined;this.changed(run); const before=await this.snapshot(run,live.controller.signal); if(live.controller.signal.aborted)return;run.checks=[];
    for(const check of checks) {
      if(live.controller.signal.aborted) return;
      const startedAt=Date.now();
      const result=await this.process(check.command,check.args,run.workspace,live.controller.signal,Math.min(run.maxMinutes*60000,300000));
      run.checks.push({...check,exitCode:result.code,output:result.output,passed:result.code===0 && !result.error,startedAt,finishedAt:Date.now(),outputTruncated:result.truncated,revision:before.revision});this.changed(run);
    }
    if(live.controller.signal.aborted) return;
    const after=await this.snapshot(run,live.controller.signal);if(live.controller.signal.aborted)return;
    run.verificationRevision=before.revision;
    run.status=run.checks.every(c=>c.passed) && before.revision===after.revision?'verified':'needs_review';
    if(before.revision!==after.revision)run.error='Verification changed the workspace. Review and verify the new revision.';
    else if(run.checks.some(c=>!c.passed))run.error='One or more verification commands failed';
    this.changed(run);
  }
  close(): Promise<void> {
    if (this.shutdown) return this.shutdown;
    this.closed=true;
    const workers = [...this.live];
    for (const [, live] of workers) live.controller.abort();
    let checkpointFailed = false;
    for (const [id] of workers) {
      try { const run=this.require(id);run.status='interrupted';run.error='Hades closed; work was interrupted';this.changed(run); }
      catch { checkpointFailed = true; }
    }
    this.shutdown = Promise.allSettled(workers.map(([, live]) => live.done)).then(() => {
      if (checkpointFailed) throw new Error('Helm workers stopped but the interruption checkpoint could not be saved');
    });
    void this.shutdown.catch(() => {});
    return this.shutdown;
  }
  private process(command:string,args:string[],cwd:string,signal:AbortSignal,timeout:number,limit=LIMIT,onOutput?:(chunk:string)=>void,env=this.env):Promise<{code:number|null;output:string;truncated:boolean;error?:string}> {
    if(signal.aborted)return Promise.resolve({code:null,output:'',truncated:false,error:'Task cancelled'});
    return new Promise(resolveResult=>{
      let output='';let truncated=false;let error:string|undefined;let providerFailure:string|undefined;let parseBuffer='';let prefix='';let killTimer:ReturnType<typeof setTimeout>|undefined;
      const childEnv={...env,PWD:cwd,INIT_CWD:cwd};
      const child=spawn(command,args,{cwd,env:childEnv,detached:process.platform!=='win32',shell:false,stdio:['ignore','pipe','pipe']});
      const watchdog=process.platform==='win32'||!child.pid?undefined:spawn(process.execPath,['-e',`const parent=Number(process.argv[1]),group=Number(process.argv[2]);const stop=()=>{try{process.kill(-group,'SIGKILL')}catch{}process.exit(0)};process.stdin.on('end',stop);process.stdin.on('error',stop);process.stdin.resume();setInterval(()=>{try{process.kill(parent,0)}catch{stop()}},250)`,String(process.pid),String(child.pid)],{cwd:this.directory,detached:true,stdio:['pipe','ignore','ignore'],env:{...childEnv,PWD:this.directory,INIT_CWD:this.directory}});
      watchdog?.unref();watchdog?.stdin?.on('error',()=>{});watchdog?.on('error',()=>{error='Process watchdog failed';kill();});
      const kill=()=>{try{if(child.pid && process.platform!=='win32')process.kill(-child.pid,'SIGTERM');else child.kill('SIGTERM');}catch{} killTimer=setTimeout(()=>{try{if(child.pid && process.platform!=='win32')process.kill(-child.pid,'SIGKILL');else child.kill('SIGKILL');}catch{}},250);};
      const abort=()=>{error='Task cancelled';kill();};
      const timer=setTimeout(()=>{error='Task time limit reached';kill();},timeout);
      const append=(buffer:Buffer)=>{const text=buffer.toString('utf8');prefix=(prefix+text).slice(0,limit);providerFailure ??= helmProviderError(prefix);parseBuffer+=text;const lines=parseBuffer.split('\n');parseBuffer=lines.pop()!.slice(-limit);for(const line of lines)providerFailure ??= helmProviderError(line);output+=text;if(output.length>limit){truncated=true;output=output.slice(-limit);}try{onOutput?.(text);}catch(e){error=`Could not persist process output: ${String(e)}`;kill();}};
      child.stdout.on('data',append);child.stderr.on('data',append);
      signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
      child.on('error',e=>{error=e.message;});
      child.on('close',code=>{if(child.pid && process.platform!=='win32'){try{process.kill(-child.pid,'SIGKILL');}catch{}}watchdog?.stdin?.end();watchdog?.kill();clearTimeout(timer);signal.removeEventListener('abort',abort);const finish=()=>resolveResult({code,output,truncated,error:error ?? providerFailure ?? helmProviderError(output)});if(killTimer)setTimeout(finish,260);else finish();});
    });
  }
}
