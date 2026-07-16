/**
 * The swarm control room — a single self-contained HTML document (no external
 * assets, no build step) served by {@link SwarmServer}. A premium, spacious dark
 * "Pro app" surface: an elevated sidebar, a trust hero built around the
 * verification verdict, soft elevation instead of hard borders, generous open
 * space, and motion with a purpose (titles decrypt on open, panels rise in, the
 * live pulse breathes). It renders a live view of the manager, its isolated
 * workers, the task graph, and the anti hallucination gate so an operator sees
 * at a glance that no worker output was accepted without clearing verification.
 */
export const DASHBOARD_HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>HERMES·SWARM · Control</title>
<style>
  :root {
    --bg:#07080c;
    --surface:rgba(255,255,255,0.028); --surface2:rgba(255,255,255,0.05);
    --hair:rgba(255,255,255,0.06);
    --txt:#f3f5fa; --muted:#9aa0b4; --faint:#626880;
    --accent:#34e0c4; --accent2:#7aa2ff;
    --ok:#3ad07f; --warn:#e5b567; --bad:#ef6b6b;
    --radius:20px; --radius-sm:14px;
    --shadow:0 1px 0 rgba(255,255,255,0.03) inset, 0 20px 50px -20px rgba(0,0,0,0.7);
    --ease:cubic-bezier(0.22,1,0.36,1);
    --s1:8px; --s2:16px; --s3:24px; --s4:36px;
  }
  * { box-sizing:border-box; }
  html,body { height:100%; }
  body {
    margin:0; color:var(--txt);
    font:400 15px/1.6 ui-sans-serif,system-ui,-apple-system,"SF Pro Text","Segoe UI",Roboto,sans-serif;
    letter-spacing:-0.011em;
    background:
      radial-gradient(1000px 600px at 82% -8%, rgba(52,224,196,0.10), transparent 60%),
      radial-gradient(900px 600px at 10% 108%, rgba(122,162,255,0.09), transparent 55%),
      var(--bg);
    -webkit-font-smoothing:antialiased;
  }
  ::selection { background:rgba(52,224,196,0.24); }
  .mono { font-family:ui-monospace,"SF Mono",monospace; letter-spacing:0; }

  .app { display:grid; grid-template-columns: 280px 1fr; min-height:100vh; }

  aside {
    position:sticky; top:0; align-self:start; height:100vh; overflow-y:auto;
    padding:var(--s3) var(--s3) var(--s4);
    display:flex; flex-direction:column; gap:var(--s3);
    background:linear-gradient(180deg, rgba(255,255,255,0.03), rgba(255,255,255,0.008));
    border-right:1px solid var(--hair);
  }
  .brand { display:flex; align-items:center; gap:12px; }
  .brand .mark {
    width:34px; height:34px; border-radius:11px; flex:none;
    background:linear-gradient(145deg,var(--accent),var(--accent2));
    box-shadow:0 6px 20px -6px rgba(52,224,196,0.6); position:relative;
  }
  .brand .mark::after { content:""; position:absolute; inset:9px; border-radius:5px; background:var(--bg); }
  .brand h1 { font-size:15px; margin:0; font-weight:600; letter-spacing:0.06em; }
  .brand .sub { font-size:11px; color:var(--faint); letter-spacing:0.14em; text-transform:uppercase; }

  .status { display:flex; align-items:center; gap:9px; font-size:12.5px; color:var(--muted); font-weight:500; }
  .dot { width:8px; height:8px; border-radius:50%; background:var(--faint); flex:none; }
  .dot.live { background:var(--ok); animation:pulse 2.4s var(--ease) infinite; }
  @keyframes pulse { 0%{box-shadow:0 0 0 0 rgba(58,208,127,0.45)} 70%{box-shadow:0 0 0 8px rgba(58,208,127,0)} 100%{box-shadow:0 0 0 0 rgba(58,208,127,0)} }

  .side-label { font-size:11px; text-transform:uppercase; letter-spacing:0.14em; color:var(--faint); font-weight:600; margin:0 0 8px 2px; }
  textarea {
    width:100%; min-height:96px; resize:vertical; color:var(--txt);
    background:var(--surface); border:1px solid var(--hair); border-radius:var(--radius-sm);
    padding:14px; font:400 14px/1.5 ui-sans-serif,system-ui,sans-serif; outline:none;
    transition:border-color .2s var(--ease), background .2s var(--ease);
  }
  textarea:focus { border-color:rgba(52,224,196,0.5); background:var(--surface2); }
  textarea::placeholder { color:var(--faint); }
  .cta {
    background:linear-gradient(180deg,var(--accent),#22c7ac); color:#04120f; border:0;
    padding:13px 16px; border-radius:var(--radius-sm); font-weight:650; font-size:14px; cursor:pointer; width:100%; margin-top:12px;
    box-shadow:0 10px 24px -10px rgba(52,224,196,0.7); transition:transform .2s var(--ease), box-shadow .2s var(--ease), opacity .2s;
  }
  .cta:hover { transform:translateY(-1px); box-shadow:0 16px 30px -12px rgba(52,224,196,0.8); }
  .cta:disabled { opacity:.45; cursor:default; transform:none; }

  .pool { display:flex; align-items:center; justify-content:space-between; gap:10px; }
  .pill-btn {
    width:34px; height:34px; border-radius:11px; border:1px solid var(--hair); background:var(--surface);
    color:var(--txt); font-size:17px; cursor:pointer; display:grid; place-items:center;
    transition:background .18s var(--ease), transform .18s var(--ease);
  }
  .pill-btn:hover { background:var(--surface2); transform:translateY(-1px); }

  .side-log { font:400 11px/1.5 ui-monospace,monospace; color:var(--muted); max-height:200px; overflow:auto; white-space:pre-wrap; }

  main { padding:var(--s3) var(--s4) var(--s4); display:flex; flex-direction:column; gap:var(--s3); min-width:0; }
  .topline { display:flex; align-items:baseline; justify-content:space-between; gap:var(--s2); flex-wrap:wrap; }
  .topline h2 { font-size:26px; margin:0; font-weight:600; }
  .chip { font:600 11px ui-monospace,monospace; color:var(--muted); background:var(--surface); padding:6px 12px; border-radius:999px; border:1px solid var(--hair); }

  .hero { background:var(--surface); border:1px solid var(--hair); border-radius:var(--radius); box-shadow:var(--shadow); padding:var(--s3);
    display:grid; grid-template-columns:1.3fr 1fr 1fr 1fr; gap:var(--s3); align-items:center; }
  .hero .big { font:700 46px/1 ui-sans-serif,system-ui,sans-serif; letter-spacing:-0.03em;
    background:linear-gradient(180deg,#fff,var(--accent)); -webkit-background-clip:text; background-clip:text; -webkit-text-fill-color:transparent; }
  .hero .big-l { font-size:12px; color:var(--muted); text-transform:uppercase; letter-spacing:0.1em; margin-top:6px; }
  .metric .n { font:600 30px ui-sans-serif,system-ui,sans-serif; letter-spacing:-0.02em; transition:color .3s var(--ease); }
  .metric .l { font-size:11.5px; color:var(--muted); text-transform:uppercase; letter-spacing:0.08em; margin-top:4px; }

  .cols { display:grid; grid-template-columns: 1fr 400px; gap:var(--s3); align-items:start; }
  @media (max-width:1180px){ .cols{ grid-template-columns:1fr; } .hero{ grid-template-columns:1fr 1fr; } .app{ grid-template-columns:1fr; } aside{ height:auto; position:static; } }

  .card { background:var(--surface); border:1px solid var(--hair); border-radius:var(--radius); box-shadow:var(--shadow); overflow:hidden; }
  .card + .card { margin-top:var(--s3); }
  .card > h3 { font-size:13px; font-weight:600; letter-spacing:0.02em; color:var(--txt); margin:0; padding:18px var(--s3) 0; display:flex; align-items:center; gap:10px; }
  .card > h3 .sub { font-size:11px; color:var(--faint); font-weight:500; letter-spacing:0.06em; }
  .card .body { padding:16px var(--s3) var(--s3); }

  .empty { color:var(--faint); font-size:13px; padding:6px 0; }

  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(130px,1fr)); gap:12px; }
  .agent { background:var(--surface2); border-radius:var(--radius-sm); padding:14px; cursor:pointer; transition:transform .18s var(--ease), background .18s var(--ease); animation:rise .5s var(--ease) both; }
  .agent:hover { transform:translateY(-2px); background:rgba(255,255,255,0.07); }
  .agent .id { font:600 12px ui-monospace,monospace; }
  .agent .st { font-size:11px; margin-top:8px; display:inline-block; padding:3px 9px; border-radius:999px; font-weight:600; }
  .st.idle{ background:rgba(122,162,255,0.16); color:#a9c0ff;} .st.busy{ background:rgba(229,181,103,0.16); color:var(--warn);}
  .st.starting{ background:var(--surface2); color:var(--muted);} .st.killed{ background:rgba(239,107,107,0.16); color:var(--bad);}
  .st.dead{ background:rgba(255,255,255,0.06); color:var(--faint);}
  .agent .cap { font-size:10.5px; color:var(--faint); margin-top:10px; word-break:break-word; }

  .task { border-radius:var(--radius-sm); padding:14px; margin-bottom:10px; background:var(--surface2); animation:rise .45s var(--ease) both; }
  .task:last-child{ margin-bottom:0; }
  .task .d { font-size:13.5px; }
  .task .meta { display:flex; gap:10px; align-items:center; margin-top:9px; font:11px ui-monospace,monospace; color:var(--faint); }
  .tag { padding:3px 9px; border-radius:999px; font:600 10.5px ui-monospace,monospace; }
  .tag.verified{background:rgba(58,208,127,0.15);color:var(--ok);} .tag.rejected{background:rgba(239,107,107,0.15);color:var(--bad);}
  .tag.dispatched{background:rgba(122,162,255,0.15);color:#a9c0ff;} .tag.pending{background:var(--surface2);color:var(--muted);}
  .tag.reported{background:rgba(229,181,103,0.15);color:var(--warn);} .tag.failed{background:rgba(239,107,107,0.15);color:var(--bad);}

  .feed { max-height:calc(100vh - 260px); overflow:auto; }
  .ver { padding:14px 16px; margin-bottom:10px; background:var(--surface2); border-radius:var(--radius-sm); border-left:3px solid var(--hair); animation:rise .45s var(--ease) both; }
  .ver.accept{ border-left-color:var(--ok);} .ver.reject{ border-left-color:var(--bad);} .ver.revise{ border-left-color:var(--warn);}
  .ver .h { display:flex; justify-content:space-between; align-items:center; font:600 12px ui-monospace,monospace; }
  .ver .score { color:var(--accent); font-weight:700; }
  .ver .chk { font-size:11.5px; color:var(--muted); margin-top:6px; line-height:1.5; }
  .ver .chk .x{color:var(--bad);} .ver .chk .ok{color:var(--ok);}

  .barwrap { margin:12px 0 4px; }
  .barwrap .lab { font-size:11.5px; color:var(--muted); display:flex; justify-content:space-between; margin-bottom:6px; }
  .bar { height:7px; background:rgba(255,255,255,0.06); border-radius:99px; overflow:hidden; }
  .bar > i { display:block; height:100%; background:linear-gradient(90deg,var(--accent),var(--accent2)); border-radius:99px; transition:width .6s var(--ease); }

  .dag { display:flex; flex-direction:column; gap:8px; }
  .dag-level { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
  .dag-level .lvl { font:10px ui-monospace,monospace; color:var(--faint); width:26px; flex:none; }
  .dag-node { font:10.5px ui-monospace,monospace; padding:5px 9px; border-radius:9px; background:var(--surface2); color:var(--muted); transition:transform .18s var(--ease); }
  .dag-node:hover { transform:translateY(-1px); }
  .dag-node.verified{ background:rgba(58,208,127,0.16); color:var(--ok);} .dag-node.failed{ background:rgba(239,107,107,0.16); color:var(--bad);}
  .dag-node.dispatched,.dag-node.reported{ background:rgba(122,162,255,0.16); color:#a9c0ff;}

  @keyframes rise { from{ opacity:0; transform:translateY(10px); } to{ opacity:1; transform:translateY(0); } }
  .stagger { animation:rise .55s var(--ease) both; }
  @media (prefers-reduced-motion: reduce){ *{ animation:none !important; transition:none !important; } }
</style>
</head>
<body>
<div class="app">
  <aside>
    <div class="brand">
      <div class="mark"></div>
      <div>
        <h1 data-text="HERMES·SWARM">HERMES·SWARM</h1>
        <div class="sub">control room</div>
      </div>
    </div>
    <div class="status">
      <span class="dot" id="dot"></span>
      <span id="conn">connecting</span>
      <span class="chip mono" id="mode" style="margin-left:auto">mode</span>
    </div>

    <div>
      <div class="side-label">Launch goal</div>
      <textarea id="objective" placeholder="Describe the objective for the swarm"></textarea>
      <button class="cta" id="run">Dispatch to swarm</button>
    </div>

    <div>
      <div class="side-label">Worker pool</div>
      <div class="pool">
        <span class="mono" style="font-size:12px;color:var(--muted)"><span id="pool-count">0</span> live workers</span>
        <span style="display:flex;gap:8px">
          <button class="pill-btn" onclick="scalePool(-1)">−</button>
          <button class="pill-btn" onclick="scalePool(1)">+</button>
        </span>
      </div>
    </div>

    <div style="flex:1">
      <div class="side-label">Activity</div>
      <div class="side-log mono" id="log"></div>
    </div>
  </aside>

  <main>
    <div class="topline">
      <h2 data-text="Overview">Overview</h2>
      <span class="chip" id="grounding"></span>
    </div>

    <section class="hero stagger" id="hero">
      <div>
        <div class="big" id="s-grounded">0%</div>
        <div class="big-l">grounded evidence</div>
      </div>
      <div class="metric"><div class="n" id="s-workers">0</div><div class="l">Workers</div></div>
      <div class="metric"><div class="n" id="s-verified" style="color:var(--ok)">0</div><div class="l">Verified</div></div>
      <div class="metric"><div class="n" id="s-rejected" style="color:var(--bad)">0</div><div class="l">Rejected</div></div>
    </section>

    <div class="cols">
      <div>
        <div class="card stagger">
          <h3 data-text="Task Graph (DAG)">Task Graph (DAG)</h3>
          <div class="body"><div id="dag" class="dag"><div class="empty">no tasks yet</div></div></div>
        </div>
        <div class="card">
          <h3 data-text="Tasks">Tasks</h3>
          <div class="body" id="tasks"><div class="empty">Launch a goal to begin.</div></div>
        </div>
        <div class="card">
          <h3 data-text="Metrics">Metrics</h3>
          <div class="body" id="metrics"><div class="empty">no data yet</div></div>
        </div>
        <div class="card">
          <h3 data-text="Worker agents">Worker agents <span class="sub">isolated</span></h3>
          <div class="body"><div class="grid" id="agents"><div class="empty">no workers yet</div></div></div>
        </div>
      </div>

      <div>
        <div class="card stagger">
          <h3 data-text="Verification gate">Verification gate <span class="sub">accept or decline</span></h3>
          <div class="body feed" id="verifs"><div class="empty">no verifications yet</div></div>
        </div>
        <div class="card">
          <h3 data-text="Evidence &amp; Provenance">Evidence &amp; Provenance</h3>
          <div class="body feed" id="prov"><div class="empty">no accepted evidence yet</div></div>
        </div>
        <div class="card">
          <h3 data-text="Goal history">Goal history</h3>
          <div class="body" id="history"><div class="empty">no goals yet</div></div>
        </div>
      </div>
    </div>
  </main>
</div>

<script>
const $ = (id) => document.getElementById(id);
let state = { workers:[], tasks:[], verifications:[], mode:"—" };

function decryptTitle(el){
  const target = el.getAttribute("data-text"); if(!target) return;
  const pool = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789/<>#";
  let frame = 0; const frames = 10;
  const iv = setInterval(()=>{
    frame++;
    const revealed = Math.floor(target.length * frame / frames);
    el.textContent = target.split("").map((c,i)=> c===" " ? " " : (i < revealed ? c : pool[Math.floor(Math.random()*pool.length)])).join("");
    if(frame >= frames){ clearInterval(iv); el.textContent = target; }
  }, 34);
}
window.addEventListener("load", ()=>{
  document.querySelectorAll("[data-text]").forEach((el,i)=> setTimeout(()=>decryptTitle(el), 90*i));
});

function render() {
  $("mode").textContent = "mode " + state.mode;
  const workers = state.workers || [];
  const live = workers.filter(w=>w.status!=="killed"&&w.status!=="dead").length;
  $("s-workers").textContent = live;
  $("pool-count").textContent = live;
  const vers = state.verifications || [];
  $("s-verified").textContent = (state.tasks||[]).filter(t=>t.status==="verified").length;
  $("s-rejected").textContent = vers.filter(v=>v.verdict!=="accept").length;
  if (typeof state.groundingRate === "number") {
    $("s-grounded").textContent = Math.round(state.groundingRate*100) + "%";
    $("grounding").textContent = "grounded " + Math.round(state.groundingRate*100) + "%";
  }

  const ag = $("agents");
  ag.innerHTML = workers.length ? "" : '<div class="empty">no workers yet</div>';
  for (const w of workers) {
    const el = document.createElement("div");
    el.className = "agent";
    el.title = "view this worker's logs";
    el.onclick = () => showWorkerLogs(w.workerId);
    const killBtn = (w.status==="killed"||w.status==="dead") ? "" :
      '<button style="margin-top:10px;padding:3px 9px;font-size:10px;border:0;border-radius:8px;cursor:pointer;background:rgba(239,107,107,0.16);color:#ef6b6b" '+
      'onclick="event.stopPropagation();killWorker(\\''+w.workerId+'\\')">kill</button>';
    el.innerHTML = '<div class="id">'+w.workerId+'</div>'+
      '<span class="st '+w.status+'">'+w.status+'</span>'+
      '<div class="cap">'+(w.capabilities||[]).join(", ")+(w.killReason?'<br>'+esc(w.killReason):'')+'</div>'+killBtn;
    ag.appendChild(el);
  }

  if (state.metrics) renderMetrics(state.metrics);
  renderDag(state.tasks || []);

  const tk = $("tasks");
  const tasks = state.tasks || [];
  tk.innerHTML = tasks.length ? "" : '<div class="empty">Launch a goal to begin.</div>';
  for (const t of tasks) {
    const el = document.createElement("div");
    el.className = "task";
    el.innerHTML = '<div class="d">'+esc(t.description)+'</div>'+
      '<div class="meta"><span class="tag '+t.status+'">'+t.status+'</span>'+
      '<span>caps '+(t.requiredCapabilities||[]).join(",")+'</span>'+
      '<span>try '+t.attempts+'/'+t.maxAttempts+'</span></div>';
    tk.appendChild(el);
  }

  renderHistory(state.goals || []);
  renderProvenance(state.provenance || []);

  const vf = $("verifs");
  vf.innerHTML = vers.length ? "" : '<div class="empty">no verifications yet</div>';
  for (const v of [...vers].reverse()) {
    const el = document.createElement("div");
    el.className = "ver " + v.verdict;
    const checks = (v.checks||[]).map(c=>'<div class="chk"><span class="'+(c.passed?"ok":"x")+'">'+(c.passed?"✓":"✗")+'</span> '+esc(c.name)+' '+esc(c.detail)+'</div>').join("");
    el.innerHTML = '<div class="h"><span>'+v.verdict.toUpperCase()+' · '+v.workerId+'</span><span class="score">'+(v.score*100|0)+'%</span></div>'+checks;
    vf.appendChild(el);
  }
}

function renderMetrics(m){
  const el=$("metrics");
  const barh = (label, ok, bad) => {
    const total = ok+bad || 1; const pct = Math.round(ok/total*100);
    return '<div class="barwrap"><div class="lab"><span>'+label+'</span><span class="mono">'+ok+'/'+(ok+bad)+'</span></div><div class="bar"><i style="width:'+pct+'%"></i></div></div>';
  };
  el.innerHTML =
    '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px">'
    +'<div class="metric"><div class="n" style="font-size:22px">'+m.goals.completed+'/'+m.goals.total+'</div><div class="l">Goals</div></div>'
    +'<div class="metric"><div class="n" style="font-size:22px">'+Math.round(m.verification.groundingRate*100)+'%</div><div class="l">Grounded</div></div>'
    +'<div class="metric"><div class="n mono" style="font-size:22px">$'+(m.usage.costUsd||0).toFixed(3)+'</div><div class="l">Cost</div></div>'
    +'</div>'
    + barh("Verification accepted", m.verification.accepted, m.verification.rejected)
    + barh("Tasks verified", m.tasks.verified, m.tasks.failed)
    + '<div style="font-size:11.5px;color:var(--faint);margin-top:10px" class="mono">avg score '+Math.round((m.verification.avgScore||0)*100)+'% · '+m.usage.toolCalls+' tool calls · '+m.workers.total+' workers</div>';
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
      ? '<button style="padding:5px 11px;font-size:11px;border:0;border-radius:8px;cursor:pointer;background:var(--surface2);color:var(--txt)" onclick="cancelGoal(\\''+g.id+'\\')">cancel</button>'
      : '<button style="padding:5px 11px;font-size:11px;border:0;border-radius:8px;cursor:pointer;background:var(--surface2);color:var(--txt)" onclick="replayGoal(\\''+g.id+'\\')">replay</button>';
    div.innerHTML='<div class="d">'+esc(g.objective)+'</div>'+
      '<div class="meta"><span class="tag '+(g.status==="completed"?"verified":g.status==="running"?"dispatched":"failed")+'">'+g.status+'</span>'+btn+'</div>';
    el.appendChild(div);
  }
}
async function killWorker(id){ try{ await fetch("/api/workers/"+id+"/kill",{method:"POST"}); logLine("killed worker "+id); refresh(); }catch{} }
async function scalePool(delta){
  try{ const live=(state.workers||[]).filter(w=>w.status!=="killed"&&w.status!=="dead").length;
    const r=await (await fetch("/api/pool/scale",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({size:Math.max(0,live+delta)})})).json();
    logLine("scaled pool to "+r.size); refresh();
  }catch{} }
async function replayGoal(id){ try{ await fetch("/api/goals/"+id+"/replay",{method:"POST"}); logLine("replayed "+id.slice(0,8)); refresh(); }catch{} }
async function cancelGoal(id){ try{ await fetch("/api/goals/"+id+"/cancel",{method:"POST"}); logLine("cancelled "+id.slice(0,8)); refresh(); }catch{} }
function renderProvenance(records){
  const el=$("prov");
  el.innerHTML = records.length ? "" : '<div class="empty">no accepted evidence yet</div>';
  for(const r of [...records].reverse()){
    const div=document.createElement("div"); div.className="ver accept";
    const claims=(r.claims||[]).map(c=>{
      const ev=(c.tracedEvidence&&c.tracedEvidence.length? c.tracedEvidence : c.evidence||[]).map(e=>'<div class="chk">'+esc(String(e))+'</div>').join("");
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
    $("log").textContent = "worker "+workerId+"\\n"+body;
  } catch { /* ignore */ }
}
function esc(s){ return String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }
function logLine(s){ const l=$("log"); l.textContent = (s+"\\n"+l.textContent).split("\\n").slice(0,200).join("\\n"); }
function upsert(arr, item, key){ const i=arr.findIndex(x=>x[key]===item[key]); if(i>=0)arr[i]=item; else arr.push(item); }

const es = new EventSource("/api/events");
es.addEventListener("snapshot", e => { state = JSON.parse(e.data); render(); });
es.onopen = () => { $("conn").textContent="live"; $("dot").classList.add("live"); };
es.onerror = () => { $("conn").textContent="reconnecting"; $("dot").classList.remove("live"); };
es.addEventListener("worker:spawned", e => { upsert(state.workers, JSON.parse(e.data), "workerId"); render(); logLine("worker spawned"); });
es.addEventListener("worker:killed", e => { const d=JSON.parse(e.data); upsert(state.workers,d.worker,"workerId"); render(); logLine("worker killed "+d.reason); });
es.addEventListener("goal:planned", e => { const d=JSON.parse(e.data); state.tasks=d.tasks; render(); logLine("goal planned into "+d.tasks.length+" tasks"); });
es.addEventListener("task:dispatched", e => { upsert(state.tasks, JSON.parse(e.data), "id"); render(); });
es.addEventListener("task:verified", e => { const d=JSON.parse(e.data); upsert(state.tasks,d.task,"id"); state.verifications.push(d.report); render(); logLine("verified "+d.task.id.slice(0,8)); });
es.addEventListener("task:rejected", e => { const d=JSON.parse(e.data); upsert(state.tasks,d.task,"id"); state.verifications.push(d.report); render(); logLine("rejected "+d.task.id.slice(0,8)); });
es.addEventListener("task:failed", e => { const d=JSON.parse(e.data); upsert(state.tasks,d.task,"id"); render(); logLine("failed "+d.task.id.slice(0,8)); });
es.addEventListener("goal:completed", e => { logLine("goal completed"); refresh(); });
es.addEventListener("goal:failed", e => { logLine("goal failed"); refresh(); });
es.addEventListener("log", e => { const d=JSON.parse(e.data); logLine("["+d.workerId+"] "+d.line); });

async function refresh(){ try{ state = await (await fetch("/api/state")).json(); render(); }catch{} }

$("run").onclick = async () => {
  const objective = $("objective").value.trim();
  if(!objective) return;
  $("run").disabled = true;
  try {
    await fetch("/api/goals", { method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({objective}) });
    logLine("dispatched "+objective);
  } finally { setTimeout(()=>{$("run").disabled=false;}, 800); }
};

refresh();
</script>
</body>
</html>`;
