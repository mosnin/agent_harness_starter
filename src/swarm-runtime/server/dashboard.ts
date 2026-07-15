/**
 * The swarm dashboard — a single self-contained HTML document (no external
 * assets, no build step) served by {@link SwarmServer}. It renders a live view
 * of the manager, its worker containers, the task graph, and — critically — the
 * verification verdicts, so an operator can see at a glance that no worker's
 * output was accepted without clearing the anti-hallucination gate.
 */
export const DASHBOARD_HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Hermes-Swarm · Control</title>
<style>
  :root {
    --bg:#0b0e14; --panel:#131722; --panel2:#1b2130; --border:#252b3b;
    --txt:#e6e9ef; --muted:#8b93a7; --accent:#5eead4; --accent2:#7c9cff;
    --ok:#4ade80; --warn:#fbbf24; --bad:#f87171; --kill:#fb7185;
  }
  * { box-sizing:border-box; }
  body { margin:0; font:14px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
    background:var(--bg); color:var(--txt); }
  header { display:flex; align-items:center; gap:12px; padding:14px 20px;
    border-bottom:1px solid var(--border); background:var(--panel); position:sticky; top:0; z-index:5; }
  header h1 { font-size:16px; margin:0; letter-spacing:.5px; }
  header .badge { font:600 11px ui-monospace,monospace; padding:3px 8px; border-radius:6px;
    background:var(--panel2); color:var(--accent); border:1px solid var(--border); }
  header .dot { width:9px; height:9px; border-radius:50%; background:var(--bad); }
  header .dot.live { background:var(--ok); box-shadow:0 0 8px var(--ok); }
  main { display:grid; grid-template-columns: 320px 1fr 380px; gap:14px; padding:14px; align-items:start; }
  .panel { background:var(--panel); border:1px solid var(--border); border-radius:12px; overflow:hidden; }
  .panel h2 { font-size:12px; text-transform:uppercase; letter-spacing:.8px; color:var(--muted);
    margin:0; padding:12px 14px; border-bottom:1px solid var(--border); }
  .panel .body { padding:12px 14px; }
  textarea { width:100%; min-height:80px; resize:vertical; background:var(--panel2); color:var(--txt);
    border:1px solid var(--border); border-radius:8px; padding:10px; font:13px ui-monospace,monospace; }
  button { background:linear-gradient(180deg,var(--accent2),#5a7cff); color:#0b0e14; border:0;
    padding:10px 14px; border-radius:8px; font-weight:700; cursor:pointer; width:100%; margin-top:10px; }
  button:disabled { opacity:.5; cursor:default; }
  .stat-row { display:grid; grid-template-columns:repeat(3,1fr); gap:8px; margin-top:12px; }
  .stat { background:var(--panel2); border:1px solid var(--border); border-radius:8px; padding:10px; text-align:center; }
  .stat .n { font:700 20px ui-monospace,monospace; }
  .stat .l { font-size:10px; color:var(--muted); text-transform:uppercase; letter-spacing:.5px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(120px,1fr)); gap:10px; }
  .agent { background:var(--panel2); border:1px solid var(--border); border-radius:10px; padding:12px; }
  .agent .id { font:700 12px ui-monospace,monospace; }
  .agent .st { font-size:11px; margin-top:6px; display:inline-block; padding:2px 7px; border-radius:20px; }
  .st.idle{ background:#1e3a5f; color:#93c5fd;} .st.busy{ background:#3b2f16; color:var(--warn);}
  .st.starting{ background:#242a3a; color:var(--muted);} .st.killed{ background:#4a1220; color:var(--kill);}
  .st.dead{ background:#2a2a2a; color:#999;}
  .agent .cap { font-size:10px; color:var(--muted); margin-top:8px; word-break:break-word; }
  .task { border:1px solid var(--border); border-radius:8px; padding:10px; margin-bottom:8px; background:var(--panel2); }
  .task .d { font-size:12px; }
  .task .meta { display:flex; gap:8px; margin-top:6px; font:11px ui-monospace,monospace; color:var(--muted); }
  .tag { padding:1px 7px; border-radius:20px; font:600 10px ui-monospace,monospace; }
  .tag.verified{background:#12351f;color:var(--ok);} .tag.rejected{background:#3a1414;color:var(--bad);}
  .tag.dispatched{background:#242a3a;color:var(--accent2);} .tag.pending{background:#242a3a;color:var(--muted);}
  .tag.reported{background:#3b2f16;color:var(--warn);} .tag.failed{background:#4a1220;color:var(--kill);}
  .feed { max-height:calc(100vh - 180px); overflow:auto; }
  .ver { border-left:3px solid var(--border); padding:8px 10px; margin-bottom:8px; background:var(--panel2); border-radius:0 8px 8px 0; }
  .ver.accept{ border-left-color:var(--ok);} .ver.reject{ border-left-color:var(--bad);} .ver.revise{ border-left-color:var(--warn);}
  .ver .h { display:flex; justify-content:space-between; font:600 11px ui-monospace,monospace; }
  .ver .score { color:var(--accent); }
  .ver .chk { font-size:11px; color:var(--muted); margin-top:4px; }
  .ver .chk .x{color:var(--bad);} .ver .chk .ok{color:var(--ok);}
  .log { font:11px ui-monospace,monospace; color:var(--muted); max-height:160px; overflow:auto; white-space:pre-wrap; }
  .empty { color:var(--muted); font-size:12px; padding:8px 0; }
  .dag { display:flex; flex-direction:column; gap:6px; }
  .dag-level { display:flex; gap:6px; flex-wrap:wrap; align-items:center; }
  .dag-level .lvl { font:10px ui-monospace,monospace; color:var(--muted); width:26px; flex:none; }
  .dag-node { font:10px ui-monospace,monospace; padding:3px 7px; border-radius:6px; border:1px solid var(--border);
    background:var(--panel2); }
  .dag-node.verified{ border-color:var(--ok); color:var(--ok);} .dag-node.failed{ border-color:var(--kill); color:var(--kill);}
  .dag-node.dispatched,.dag-node.reported{ border-color:var(--accent2); color:var(--accent2);}
</style>
</head>
<body>
<header>
  <span class="dot" id="dot"></span>
  <h1>HERMES·SWARM</h1>
  <span class="badge" id="mode">mode —</span>
  <span class="badge" id="conn">connecting…</span>
</header>
<main>
  <section class="panel">
    <h2>Launch Goal</h2>
    <div class="body">
      <textarea id="objective" placeholder="Describe the objective for the swarm…"></textarea>
      <button id="run">▶ Dispatch to Swarm</button>
      <div class="stat-row">
        <div class="stat"><div class="n" id="s-workers">0</div><div class="l">Workers</div></div>
        <div class="stat"><div class="n" id="s-verified">0</div><div class="l">Verified</div></div>
        <div class="stat"><div class="n" id="s-rejected">0</div><div class="l">Rejected</div></div>
      </div>
    </div>
    <h2>Goal History</h2>
    <div class="body"><div id="history"><div class="empty">no goals yet</div></div></div>
    <h2>Worker Agents (isolated)
      <span style="float:right;font-weight:400">
        <button style="width:auto;margin:0;padding:2px 8px;font-size:11px" onclick="scalePool(-1)">−</button>
        <button style="width:auto;margin:0;padding:2px 8px;font-size:11px" onclick="scalePool(1)">＋</button>
      </span>
    </h2>
    <div class="body"><div class="grid" id="agents"><div class="empty">no workers yet</div></div></div>
    <h2>Activity Log</h2>
    <div class="body"><div class="log" id="log"></div></div>
  </section>

  <section class="panel">
    <h2>Task Graph (DAG)</h2>
    <div class="body"><div id="dag" class="dag"><div class="empty">no tasks yet</div></div></div>
    <h2>Tasks</h2>
    <div class="body" id="tasks"><div class="empty">no tasks yet — launch a goal</div></div>
  </section>

  <section class="panel">
    <h2>Verification Gate · anti-hallucination <span id="grounding" class="badge"></span></h2>
    <div class="body feed" id="verifs"><div class="empty">no verifications yet</div></div>
    <h2>Evidence &amp; Provenance</h2>
    <div class="body feed" id="prov"><div class="empty">no accepted evidence yet</div></div>
  </section>
</main>
<script>
const $ = (id) => document.getElementById(id);
let state = { workers:[], tasks:[], verifications:[], mode:"—" };

function render() {
  $("mode").textContent = "mode " + state.mode;
  const workers = state.workers || [];
  $("s-workers").textContent = workers.filter(w=>w.status!=="killed"&&w.status!=="dead").length;
  const vers = state.verifications || [];
  $("s-verified").textContent = (state.tasks||[]).filter(t=>t.status==="verified").length;
  $("s-rejected").textContent = vers.filter(v=>v.verdict!=="accept").length;

  // agents
  const ag = $("agents");
  ag.innerHTML = workers.length ? "" : '<div class="empty">no workers yet</div>';
  for (const w of workers) {
    const el = document.createElement("div");
    el.className = "agent";
    el.style.cursor = "pointer";
    el.title = "click to view this worker's logs";
    el.onclick = () => showWorkerLogs(w.workerId);
    const killBtn = (w.status==="killed"||w.status==="dead") ? "" :
      '<button style="width:auto;margin:6px 0 0;padding:2px 7px;font-size:10px;background:#4a1220;color:#fb7185" '+
      'onclick="event.stopPropagation();killWorker(\\''+w.workerId+'\\')">✗ kill</button>';
    el.innerHTML = '<div class="id">'+w.workerId+'</div>'+
      '<span class="st '+w.status+'">'+w.status+'</span>'+
      '<div class="cap">['+(w.capabilities||[]).join(", ")+']'+(w.killReason?'<br>⚠ '+w.killReason:'')+'</div>'+killBtn;
    ag.appendChild(el);
  }

  // DAG: group tasks by topological level and render columns.
  renderDag(state.tasks || []);

  // tasks
  const tk = $("tasks");
  const tasks = state.tasks || [];
  tk.innerHTML = tasks.length ? "" : '<div class="empty">no tasks yet — launch a goal</div>';
  for (const t of tasks) {
    const el = document.createElement("div");
    el.className = "task";
    el.innerHTML = '<div class="d">'+esc(t.description)+'</div>'+
      '<div class="meta"><span class="tag '+t.status+'">'+t.status+'</span>'+
      '<span>caps: '+(t.requiredCapabilities||[]).join(",")+'</span>'+
      '<span>try '+t.attempts+'/'+t.maxAttempts+'</span></div>';
    tk.appendChild(el);
  }

  // goal history with replay/cancel controls
  renderHistory(state.goals || []);

  // grounding rate + provenance/evidence viewer
  if (typeof state.groundingRate === "number") {
    $("grounding").textContent = "grounded " + Math.round(state.groundingRate*100) + "%";
  }
  renderProvenance(state.provenance || []);

  // verifications
  const vf = $("verifs");
  vf.innerHTML = vers.length ? "" : '<div class="empty">no verifications yet</div>';
  for (const v of [...vers].reverse()) {
    const el = document.createElement("div");
    el.className = "ver " + v.verdict;
    const checks = (v.checks||[]).map(c=>'<div class="chk"><span class="'+(c.passed?"ok":"x")+'">'+(c.passed?"✓":"✗")+'</span> '+esc(c.name)+' — '+esc(c.detail)+'</div>').join("");
    el.innerHTML = '<div class="h"><span>'+v.verdict.toUpperCase()+' · '+v.workerId+'</span><span class="score">'+(v.score*100|0)+'%</span></div>'+checks;
    vf.appendChild(el);
  }
}

function dagLevels(tasks){
  const byId = {}; tasks.forEach(t=>byId[t.id]=t);
  const cache = {}; const seen = {};
  function lvl(id){ if(cache[id]!=null)return cache[id]; if(seen[id])return 0; seen[id]=1;
    const t=byId[id]; const deps=(t&&t.dependsOn||[]).filter(d=>byId[d]);
    const v = deps.length? 1+Math.max.apply(null,deps.map(lvl)) : 0; cache[id]=v; return v; }
  const levels=[]; tasks.forEach(t=>{ const l=lvl(t.id); (levels[l]=levels[l]||[]).push(t); });
  return levels;
}
function renderDag(tasks){
  const el=$("dag");
  if(!tasks.length){ el.innerHTML='<div class="empty">no tasks yet</div>'; return; }
  el.innerHTML="";
  dagLevels(tasks).forEach((tasksAtLevel,i)=>{
    const row=document.createElement("div"); row.className="dag-level";
    let html='<span class="lvl">L'+i+'</span>';
    for(const t of (tasksAtLevel||[])){
      const c = t.consensus? ' ×'+t.consensus.replicas : '';
      html += '<span class="dag-node '+t.status+'" title="'+esc(t.description)+'">'+t.status+c+'</span>';
    }
    row.innerHTML=html; el.appendChild(row);
  });
}
function renderHistory(goals){
  const el=$("history");
  if(!goals.length){ el.innerHTML='<div class="empty">no goals yet</div>'; return; }
  el.innerHTML="";
  for(const g of goals){
    const div=document.createElement("div"); div.className="task";
    const running = g.status==="running";
    const btn = running
      ? '<button style="width:auto;margin:0;padding:4px 8px;font-size:11px" onclick="cancelGoal(\\''+g.id+'\\')">✗ cancel</button>'
      : '<button style="width:auto;margin:0;padding:4px 8px;font-size:11px" onclick="replayGoal(\\''+g.id+'\\')">↻ replay</button>';
    div.innerHTML='<div class="d">'+esc(g.objective)+'</div>'+
      '<div class="meta"><span class="tag '+(g.status==="completed"?"verified":g.status==="running"?"dispatched":"failed")+'">'+g.status+'</span>'+btn+'</div>';
    el.appendChild(div);
  }
}
async function killWorker(id){ try{ await fetch("/api/workers/"+id+"/kill",{method:"POST"}); logLine("✗ killed worker "+id); refresh(); }catch{} }
async function scalePool(delta){
  try{ const live=(state.workers||[]).filter(w=>w.status!=="killed"&&w.status!=="dead").length;
    const r=await (await fetch("/api/pool/scale",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({size:Math.max(0,live+delta)})})).json();
    logLine("⚖ scaled pool → "+r.size); refresh();
  }catch{} }
async function replayGoal(id){ try{ await fetch("/api/goals/"+id+"/replay",{method:"POST"}); logLine("↻ replayed "+id.slice(0,8)); refresh(); }catch{} }
async function cancelGoal(id){ try{ await fetch("/api/goals/"+id+"/cancel",{method:"POST"}); logLine("✗ cancelled "+id.slice(0,8)); refresh(); }catch{} }
function renderProvenance(records){
  const el=$("prov");
  el.innerHTML = records.length ? "" : '<div class="empty">no accepted evidence yet</div>';
  for(const r of [...records].reverse()){
    const div=document.createElement("div"); div.className="ver accept";
    const claims=(r.claims||[]).map(c=>{
      const ev=(c.tracedEvidence&&c.tracedEvidence.length? c.tracedEvidence : c.evidence||[]).map(e=>'<div class="chk">↳ '+esc(String(e))+'</div>').join("");
      const mark = c.grounded? '<span class="ok">✓</span>' : '<span class="x">✗</span>';
      return '<div class="chk">'+mark+' '+esc(c.statement)+'</div>'+ev;
    }).join("");
    div.innerHTML='<div class="h"><span>'+esc(r.workerId||"")+'</span><span class="score">'+Math.round((r.score||0)*100)+'%</span></div>'+claims;
    el.appendChild(div);
  }
}
async function showWorkerLogs(workerId){
  try {
    const logs = await (await fetch("/api/workers/"+encodeURIComponent(workerId)+"/logs")).json();
    const body = (logs||[]).map(l=>"["+new Date(l.at).toLocaleTimeString()+"] "+l.line).join("\\n") || "(no logs yet)";
    $("log").textContent = "── worker "+workerId+" ──\\n"+body;
  } catch { /* ignore */ }
}
function esc(s){ return String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }
function logLine(s){ const l=$("log"); l.textContent = (s+"\\n"+l.textContent).split("\\n").slice(0,200).join("\\n"); }

function upsert(arr, item, key){ const i=arr.findIndex(x=>x[key]===item[key]); if(i>=0)arr[i]=item; else arr.push(item); }

const es = new EventSource("/api/events");
es.addEventListener("snapshot", e => { state = JSON.parse(e.data); render(); });
es.onopen = () => { $("conn").textContent="live"; $("dot").classList.add("live"); };
es.onerror = () => { $("conn").textContent="reconnecting…"; $("dot").classList.remove("live"); };
es.addEventListener("worker:spawned", e => { upsert(state.workers, JSON.parse(e.data), "workerId"); render(); logLine("worker spawned"); });
es.addEventListener("worker:killed", e => { const d=JSON.parse(e.data); upsert(state.workers,d.worker,"workerId"); render(); logLine("⚠ worker KILLED: "+d.reason); });
es.addEventListener("goal:planned", e => { const d=JSON.parse(e.data); state.tasks=d.tasks; render(); logLine("goal planned → "+d.tasks.length+" tasks"); });
es.addEventListener("task:dispatched", e => { upsert(state.tasks, JSON.parse(e.data), "id"); render(); });
es.addEventListener("task:verified", e => { const d=JSON.parse(e.data); upsert(state.tasks,d.task,"id"); state.verifications.push(d.report); render(); logLine("✓ verified: "+d.task.id.slice(0,8)); });
es.addEventListener("task:rejected", e => { const d=JSON.parse(e.data); upsert(state.tasks,d.task,"id"); state.verifications.push(d.report); render(); logLine("✗ rejected: "+d.task.id.slice(0,8)); });
es.addEventListener("task:failed", e => { const d=JSON.parse(e.data); upsert(state.tasks,d.task,"id"); render(); logLine("✗ FAILED: "+d.task.id.slice(0,8)); });
es.addEventListener("goal:completed", e => { logLine("✅ goal completed"); refresh(); });
es.addEventListener("goal:failed", e => { logLine("❌ goal failed"); refresh(); });
es.addEventListener("log", e => { const d=JSON.parse(e.data); logLine("["+d.workerId+"] "+d.line); });

async function refresh(){ try{ state = await (await fetch("/api/state")).json(); render(); }catch{} }

$("run").onclick = async () => {
  const objective = $("objective").value.trim();
  if(!objective) return;
  $("run").disabled = true;
  try {
    await fetch("/api/goals", { method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({objective}) });
    logLine("▶ dispatched: "+objective);
  } finally { setTimeout(()=>{$("run").disabled=false;}, 800); }
};

refresh();
</script>
</body>
</html>`;
