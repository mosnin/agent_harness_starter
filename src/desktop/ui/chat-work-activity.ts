import { captureFocus, restoreFocus } from "./focus";
import { actionSummary } from "./action-summary";
import { HelmView } from "./helm";
type Row = Record<string, any>;
type Rpc = (method: string, args?: Row) => Promise<any>;
type Scope = { id: string; profile: string; root: string; delegatedWork?: string[]; helmRuns?: string[]; orcaIntents?: Array<{id:string}> };
const esc = (value: unknown) => String(value ?? "").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]!);
const label = (value: string) => ({running:"Working",starting:"Starting",ready:"Working",completed:"Finished",needs_review:"Needs review",failed:"Needs attention",cancelled:"Stopped",interrupted:"Interrupted",verified:"Checks passed",stopping:"Stopping",unknown:"Outcome uncertain",draft:"Planned"} as Row)[value] ?? value;
export class ChatWorkActivity {
  private host?: HTMLElement; private scope?: Scope; private version=0; private reviewVersion=0;
  private rows: Array<{kind:"work"|"helm"|"orca";value:Row}>=[]; private error=""; private busy=new Set<string>();
  private inFlight?: Promise<void>; private again=false; private review?: HelmView; private reviewNode?: HTMLElement;
  private timer?: ReturnType<typeof setTimeout>;
  private openDetails = new Set<string>();
  private outputs = new Map<string,string>();
  constructor(private readonly rpc:Rpc,private readonly openSession:(id:string)=>void,private readonly draft:(value:string)=>void) {}
  mount(host:HTMLElement|undefined,scope?:Scope) {
    const changed = JSON.stringify(this.scope) !== JSON.stringify(scope);
    if(changed) {clearTimeout(this.timer);this.timer=undefined;this.version++;this.reviewVersion++;this.review?.detachReview();this.review=undefined;this.reviewNode=undefined;this.rows=[];this.error="";this.busy.clear();this.openDetails.clear();this.outputs.clear();this.scope=scope;}
    this.host=host;this.render();if(changed&&scope&&host)void this.refresh();
  }
  dispose(){this.mount(undefined,undefined);}
  async reviewRun(run: Row) {
    if (!this.scope || run.owner !== this.scope.profile || run.root !== this.scope.root) throw new Error("Open a conversation in this project before reviewing its changes.");
    if (!this.rows.some(row => row.kind === "helm" && row.value.id === run.id)) this.rows.push({kind:"helm",value:run});
    this.render(); await this.action("review",run.id);
  }
  refresh():Promise<void> {
    if(this.inFlight){this.again=true;return this.inFlight;}
    const scope=this.scope,version=this.version;
    if(!scope||!this.host)return Promise.resolve();
    this.inFlight=(async()=>{
      try {
        const session=await this.rpc("session.get",{id:scope.id,profile:scope.profile});
        if(version!==this.version)return;
        if(session.id!==scope.id||session.root!==scope.root)throw new Error("Conversation scope changed; reopen this conversation.");
        const requests=[...(session.delegatedWork??[]).slice(0,64).map((id:string)=>({kind:"work" as const,id})),...(session.helmRuns??[]).slice(0,64).map((id:string)=>({kind:"helm" as const,id})),...(session.orcaIntents??[]).slice(0,4).map((item:{id:string})=>({kind:"orca" as const,id:item.id}))];
        const rows:typeof this.rows=[];
        for(let offset=0;offset<requests.length;offset+=4){
          if(version!==this.version)return;
          rows.push(...await Promise.all(requests.slice(offset,offset+4).map(async item=>{
            let value=await this.rpc(item.kind==="work"?"work.get":item.kind==="orca"?"helm.orca.get":"helm.get",{id:item.id,root:scope.root,profile:scope.profile});
            if(value.id!==item.id||value.root!==scope.root)throw new Error("Task scope mismatch");
            if(item.kind==="work") {
              value={...value,tasks:await Promise.all((value.tasks??[]).map(async(task:Row)=>{
                if(!task.pendingApproval || !task.session)return task;
                const child=await this.rpc("session.get",{id:task.session,profile:task.profile??scope.profile});
                if(child.id!==task.session || child.root!==scope.root || child.workGoal!==item.id)throw new Error("Worker approval scope mismatch");
                return {...task,approval:child.progress?.approval};
              }))};
            }
            if(item.kind==="orca"){
              if(version!==this.version)return {kind:item.kind,value};
              if(["ready","stopping","unknown"].includes(value.state)&&value.dispatchId)value=await this.rpc("helm.orca.refresh",{id:item.id,root:scope.root,profile:scope.profile});
              if(value.id!==item.id||value.root!==scope.root)throw new Error("Task scope mismatch");
              value={...value,status:value.state,title:value.input?.prompt,output:this.outputs.get(item.id)};
            }
            return {kind:item.kind,value};
          })));
        }
        if(version!==this.version)return;this.rows=rows;this.error="";
      }catch(error){if(version===this.version)this.error=error instanceof Error?error.message:"Could not refresh work";}
      finally{if(version===this.version){this.render();clearTimeout(this.timer);if(this.rows.some(row=>["running","starting","stopping","ready","unknown"].includes(row.value.status)))this.timer=setTimeout(()=>{void this.refresh();},15000);}}
    })().finally(()=>{this.inFlight=undefined;if(this.again){this.again=false;void this.refresh();}});
    return this.inFlight;
  }
  private render(){
    if(!this.host)return;
    const focus=captureFocus(this.host);
    this.host.querySelectorAll<HTMLDetailsElement>("details[data-task]").forEach(el=>{if(el.open)this.openDetails.add(el.dataset.task!);else this.openDetails.delete(el.dataset.task!);});
    this.host.innerHTML=`${this.error?`<p role="alert">${esc(this.error)} <button type="button" data-chat-work="retry">Try again</button></p>`:""}${this.rows.length?`<section class="chat-work-progress" aria-label="Work in this conversation"><h3>Work in this conversation</h3>${this.rows.map(({kind,value:r})=>`<article class="chat-work-card"><div><strong>${esc(r.title||r.objective||r.prompt?.slice(0,120)||"Task")}</strong><span>${esc(label(r.status))}</span></div>${r.error?`<p>${esc(r.error)}</p>`:""}${kind==="work"?`<ul class="chat-team-members">${(r.tasks??[]).map((task:Row)=>`<li><span class="task-state" data-state="${esc(task.status)}"></span><span>${esc(task.title||task.id)}</span><small>${esc(task.approval?"Needs approval":label(task.status))}</small></li>`).join("")}</ul>${(r.tasks??[]).filter((task:Row)=>task.approval).map((task:Row)=>`<div class="approval" role="alert"><strong>${esc(task.title||"Worker")} needs approval</strong>${actionSummary(task.approval.tool,task.approval.input,{peer:true})}<button type="button" data-chat-work="allow" data-id="${esc(r.id)}" data-task="${esc(task.id)}">Allow once</button><button type="button" data-chat-work="deny" data-id="${esc(r.id)}" data-task="${esc(task.id)}">Deny</button></div>`).join("")}`:""}<details data-task="${esc(r.id)}" ${this.openDetails.has(r.id)?"open":""}><summary>Progress and result</summary>${kind==="work"?(r.tasks??[]).map((task:Row)=>`<section><strong>${esc(task.title||task.prompt||task.id)}</strong><p>${esc(label(task.status))}</p>${task.error?`<p role="alert">${esc(task.error)}</p>`:""}${task.evidence?.length?`<ul>${task.evidence.map((e:Row)=>`<li>${esc(e.path)}</li>`).join("")}</ul>`:""}${task.messages?.length?`<p class="help">${task.messages.length} pending team ${task.messages.length===1?"message":"messages"}</p>`:""}${task.answer?`<pre>${esc(String(task.answer).slice(-12000))}</pre>`:""}</section>`).join(""):`<pre>${esc(String(r.output||"No output yet.").slice(-12000))}</pre>`}</details><div class="chat-work-actions">${kind==="orca"?`<button type="button" data-chat-work="read" data-id="${esc(r.id)}">Read output</button>`:kind==="helm"?`<button type="button" data-chat-work="review" data-id="${esc(r.id)}">Review changes</button>`:`<button type="button" data-chat-work="discuss" data-id="${esc(r.id)}">Discuss results</button><button type="button" data-chat-work="steer" data-id="${esc(r.id)}">Message team</button>${["cancelled","interrupted","failed","paused","needs_review"].includes(r.status)?`<button type="button" data-chat-work="resume" data-id="${esc(r.id)}">Continue work</button>`:""}`}${["running","starting","stopping","ready","unknown"].includes(r.status)?`<button type="button" data-chat-work="stop" data-id="${esc(r.id)}" ${this.busy.has(r.id)?"disabled":""}>${this.busy.has(r.id)?"Requesting stop…":"Stop task"}</button>`:""}</div></article>`).join("")}<button type="button" data-chat-work="refresh">Refresh progress</button></section>`:""}<div class="chat-work-review-host"></div>`;
    if(this.reviewNode)this.host.querySelector(".chat-work-review-host")?.append(this.reviewNode);
    this.host.querySelectorAll<HTMLElement>("[data-chat-work]").forEach(el=>{el.id=`chat-work-${el.dataset.chatWork}-${el.dataset.id ?? "all"}${el.dataset.task ? "-"+el.dataset.task : ""}`;const version=this.version;el.onclick=()=>{void this.action(el.dataset.chatWork!,el.dataset.id,el.dataset.task).catch(error=>{if(version!==this.version)return;this.error=String(error instanceof Error?error.message:error);this.render();});};});
    this.host.querySelectorAll<HTMLDetailsElement>("details[data-task]").forEach(el=>{el.ontoggle=()=>{if(el.open)this.openDetails.add(el.dataset.task!);else this.openDetails.delete(el.dataset.task!);};});
    restoreFocus(this.host,focus);
  }
  private async action(action:string,id?:string,taskId?:string){
    if(action==="refresh"||action==="retry")return this.refresh();
    const scope=this.scope,version=this.version,row=this.rows.find(row=>row.value.id===id);
    if(!scope||!row||this.busy.has(id!))return;
    if(action==="allow"||action==="deny") {
      const task=row.value.tasks?.find((task:Row)=>task.id===taskId);
      if(!task?.approval || !task.session)return;
      this.busy.add(id!);
      try {await this.rpc("approval.reply",{id:task.approval.id,allow:action==="allow"});}
      finally {if(version===this.version){this.busy.delete(id!);await this.refresh();}}
      return;
    }
    if(action==="steer"){this.draft(`Send this guidance to the team working on “${row.value.objective||row.value.title||"this task"}”: `);return;}
    if(action==="resume"){this.draft(`Inspect and resume unfinished work for “${row.value.objective||row.value.title||"this task"}” (plan ${row.value.id}) using its existing budget. Report any review or budget decision needed here.`);return;}
    if(action==="discuss"){this.draft(`Review the results of “${row.value.objective||row.value.title||"this task"}” and explain what is done and what still needs attention.`);return;}
    if(action==="stop") {this.busy.add(id!);this.render();try{await this.rpc(row.kind==="helm"?"helm.cancel":row.kind==="orca"?"helm.orca.stop":"work.stop",{id,profile:scope.profile,root:scope.root});}finally{if(version===this.version){this.busy.delete(id!);await this.refresh();}}return;}
    if(action==="read" && row.kind==="orca") {const result=await this.rpc("helm.orca.read",{id,profile:scope.profile,root:scope.root});if(version!==this.version)return;row.value.output=typeof result.output==="string"?result.output:"No output available";this.outputs.set(id!,row.value.output);const currentRow=this.rows.find(item=>item.kind==="orca"&&item.value.id===id);if(currentRow)currentRow.value.output=row.value.output;this.openDetails.add(id!);this.render();return;}
    if(action!=="review"||row.kind!=="helm")return;
    this.review?.detachReview();const reviewVersion=++this.reviewVersion;
    const guardedRpc:Rpc=async(method,args)=>{if(reviewVersion!==this.reviewVersion)throw new Error("Conversation changed");const result=await this.rpc(method,args);if(reviewVersion!==this.reviewVersion)throw new Error("Conversation changed");return result;};
    this.review=new HelmView(guardedRpc,{chooseProject(){},async selectProject(){throw new Error("Choose the project in the conversation");},async openWorkspace(){throw new Error("Use the conversation file and terminal controls");},openSession:this.openSession});
    this.reviewNode=document.createElement("section");this.reviewNode.className="chat-work-review";
    const close=document.createElement("button");close.type="button";close.textContent="Close review";close.onclick=()=>{this.reviewVersion++;this.review?.detachReview();this.review=undefined;this.reviewNode=undefined;this.render();document.getElementById(`chat-work-review-${id}`)?.focus();};
    const contents=document.createElement("div");this.reviewNode.append(close,contents);this.render();this.review.mount(contents);
    await this.review.openReview({root:scope.root,profile:scope.profile,projects:[scope.root]},row.value as any);
    if(reviewVersion===this.reviewVersion){close.focus({preventScroll:true});this.reviewNode?.scrollIntoView?.({block:"nearest",behavior:"instant"});}
  }
}
